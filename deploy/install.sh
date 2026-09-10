#!/bin/bash
# ============================================================================
#  Setter opp musicstreamerweb som en tjeneste pa denne maskinen.
#
#  Kjor fra prosjektmappa:   bash deploy/install.sh
#
#  Etter dette starter serveren av seg selv ved oppstart, kommer opp igjen
#  hvis den krasjer, og holder maskinen vaken sa lenge den korer.
#
#  Tunnelen kjores navngitt (fast adresse) hvis deploy/tunnel-setup.sh er
#  kjort. Er den ikke det, brukes en hurtigtunnel med tilfeldig adresse.
# ============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"
AGENTS="$HOME/Library/LaunchAgents"
LABEL_SRV="no.musicstreamerweb.server"
LABEL_TUN="no.musicstreamerweb.tunnel"
PORT="${PORT:-8080}"

TUNNEL_NAME=""; TUNNEL_HOST=""
[ -f "$DIR/deploy/tunnel.conf" ] && . "$DIR/deploy/tunnel.conf"

echo "Prosjektmappe: $DIR"

# --- Node ------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "FEIL: node er ikke installert."
  echo "  Installer med:  brew install node"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "FEIL: Node $NODE_MAJOR er for gammel. Trenger 18 eller nyere."
  exit 1
fi
echo "Node:          $NODE_BIN (v$NODE_MAJOR)"

# --- Avhengigheter ---------------------------------------------------------
echo "Installerer avhengigheter..."
( cd "$DIR" && npm install --omit=dev --silent )

mkdir -p "$AGENTS" "$DIR/logs"

# --- Serveren --------------------------------------------------------------
# caffeinate -s hindrer at maskinen sovner mens tjenesten korer. Uten det
# stopper serveren neste gang Mac-en legger seg, og da er den utilgjengelig
# akkurat naar du trenger den.
cat > "$AGENTS/$LABEL_SRV.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_SRV</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>$NODE_BIN</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/server.err</string>
</dict>
</plist>
PLIST

# --- Tunnelen --------------------------------------------------------------
# To moduser:
#   navngitt  — fast adresse, krever ~/.cloudflared/<navn>.yml fra
#               deploy/tunnel-setup.sh
#   hurtig    — ny tilfeldig trycloudflare-adresse ved hver omstart
TUN_MODE="ingen"
CFG=""
[ -n "$TUNNEL_NAME" ] && CFG="$HOME/.cloudflared/$TUNNEL_NAME.yml"

if command -v cloudflared >/dev/null 2>&1; then
  CF_BIN="$(command -v cloudflared)"

  if [ -n "$CFG" ] && [ -f "$CFG" ]; then
    TUN_MODE="navngitt"
    # --no-autoupdate: en autooppdatering midt i en okt starter cloudflared
    # pa nytt og river tunnelen. Vi oppdaterer heller med brew naar det passer.
    TUN_ARGS="    <string>--config</string>
    <string>$CFG</string>
    <string>--no-autoupdate</string>
    <string>tunnel</string>
    <string>run</string>
    <string>$TUNNEL_NAME</string>"
  else
    TUN_MODE="hurtig"
    TUN_ARGS="    <string>tunnel</string>
    <string>--url</string>
    <string>http://localhost:$PORT</string>"
  fi

  cat > "$AGENTS/$LABEL_TUN.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_TUN</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CF_BIN</string>
$TUN_ARGS
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/tunnel.log</string>
</dict>
</plist>
PLIST
  echo "cloudflared:   $CF_BIN ($TUN_MODE tunnel)"
  [ "$TUN_MODE" = "hurtig" ] && [ -n "$TUNNEL_HOST" ] && \
    echo "               Vil du ha https://$TUNNEL_HOST: bash deploy/tunnel-setup.sh"
else
  echo "cloudflared:   IKKE installert — hopper over tunnelen."
  echo "               Installer med:  brew install cloudflared"
fi

# --- Start -----------------------------------------------------------------
for L in "$LABEL_SRV" "$LABEL_TUN"; do
  [ -f "$AGENTS/$L.plist" ] || continue
  launchctl bootout "gui/$UID/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$AGENTS/$L.plist"
  echo "Startet:       $L"
done

# --- Svarer serveren? ------------------------------------------------------
echo
printf "Venter pa at serveren svarer"
OK=0
for _ in $(seq 1 20); do
  if curl -s -o /dev/null -m 2 "http://localhost:$PORT/" 2>/dev/null; then OK=1; break; fi
  printf "."
  sleep 1
done
echo
if [ "$OK" -eq 1 ]; then
  echo "Serveren svarer paa http://localhost:$PORT"
else
  echo "SERVEREN SVARER IKKE paa http://localhost:$PORT"
  echo "  Se:  tail -20 $DIR/logs/server.err"
  exit 1
fi

# --- Tunneladressen --------------------------------------------------------
if [ "$TUN_MODE" = "navngitt" ]; then
  echo
  printf "Venter pa at https://$TUNNEL_HOST svarer"
  UP=0
  for _ in $(seq 1 45); do
    CODE="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "https://$TUNNEL_HOST/" 2>/dev/null)"
    if [ "$CODE" = "200" ]; then UP=1; break; fi
    printf "."
    sleep 2
  done
  echo
  if [ "$UP" -eq 1 ]; then
    echo
    echo "   ADRESSE:  https://$TUNNEL_HOST"
    echo
    echo "Fast adresse — den samme etter omstart. Apne den paa alle enhetene."
  else
    echo
    echo "Adressen svarte ikke (siste svar: ${CODE:-ingen})."
    echo "  530 / 1033  = tunnelen korer ikke. Se: tail -20 $DIR/logs/tunnel.log"
    echo "  navneoppslag feiler = DNS har ikke rukket aa spre seg enna, vent litt"
    echo "  404         = ingress i ~/.cloudflared/$TUNNEL_NAME.yml peker feil"
    echo
    echo "  Serveren virker uansett lokalt: http://localhost:$PORT"
  fi

elif [ "$TUN_MODE" = "hurtig" ]; then
  echo
  printf "Venter pa adressen fra tunnelen"
  URL=""
  for _ in $(seq 1 60); do
    URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$DIR/logs/tunnel.log" 2>/dev/null | tail -1)"
    [ -n "$URL" ] && break
    printf "."
    sleep 1
  done
  echo

  if [ -n "$URL" ]; then
    echo
    echo "   ADRESSE:  $URL"
    echo
    echo "Apne den paa alle enhetene. Den endrer seg hver gang tunnelen"
    echo "starter pa nytt — se deploy/README.md for fast adresse."
  else
    echo
    echo "Fant ingen adresse etter 60 sekunder."
    if pgrep -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null 2>&1; then
      echo "  cloudflared KORER, men har ikke skrevet noen adresse."
      echo "  Henger den paa 'Requesting new quick Tunnel', er det tjenesten"
      echo "  hos Cloudflare som ikke svarer — vent noen minutter og kjor"
      echo "  'bash deploy/reset.sh' pa nytt. Gratistunneler er ratebegrenset."
    else
      echo "  cloudflared korer IKKE. Se:  tail -20 $DIR/logs/tunnel.log"
    fi
    echo
    echo "  Serveren virker uansett lokalt: http://localhost:$PORT"
  fi
fi
