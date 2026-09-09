#!/bin/bash
# ============================================================================
#  Setter opp musicstreamerweb som en tjeneste pa denne maskinen.
#
#  Kjor fra prosjektmappa:   bash deploy/install.sh
#
#  Etter dette starter serveren av seg selv ved oppstart, kommer opp igjen
#  hvis den krasjer, og holder maskinen vaken sa lenge den korer.
# ============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(whoami)"
AGENTS="$HOME/Library/LaunchAgents"
LABEL_SRV="no.musicstreamerweb.server"
LABEL_TUN="no.musicstreamerweb.tunnel"
PORT="${PORT:-8080}"

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
if command -v cloudflared >/dev/null 2>&1; then
  CF_BIN="$(command -v cloudflared)"
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
    <string>tunnel</string>
    <string>--url</string>
    <string>http://localhost:$PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/tunnel.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/tunnel.log</string>
</dict>
</plist>
PLIST
  echo "cloudflared:   $CF_BIN"
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

echo
echo "Ferdig. Serveren korer pa http://localhost:$PORT"
if [ -f "$AGENTS/$LABEL_TUN.plist" ]; then
  echo
  echo "Venter pa adressen fra tunnelen..."
  for i in $(seq 1 20); do
    URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$DIR/logs/tunnel.log" 2>/dev/null | tail -1)"
    [ -n "$URL" ] && break
    sleep 1
  done
  if [ -n "$URL" ]; then
    echo
    echo "   ►  $URL"
    echo
    echo "Apne den adressen pa alle enhetene. Den endrer seg hver gang"
    echo "tunnelen starter pa nytt — se deploy/README.md for fast adresse."
  else
    echo "Fant den ikke enna. Sjekk:  tail -f $DIR/logs/tunnel.log"
  fi
fi
