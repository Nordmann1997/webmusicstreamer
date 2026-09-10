#!/bin/bash
# ============================================================================
#  Viser tilstanden til serveren, tunnelen og koden.
#
#      bash deploy/status.sh
#
#  Kjor denne forst naar noe ikke virker. Den svarer paa: korer tjenestene,
#  hvilken adresse har tunnelen NA, og hvilken versjon serveres.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
PORT="${PORT:-8080}"

TUNNEL_NAME=""; TUNNEL_HOST=""
[ -f deploy/tunnel.conf ] && . deploy/tunnel.conf

# Uten denne kan tunnelen kore uten aa skrive loggen — og da er den
# offentlige adressen usynlig, selv om alt egentlig virker.
mkdir -p logs

line() { printf '%s\n' "------------------------------------------------------------"; }

echo "Mappe: $DIR"
line

# --- Tjenester -------------------------------------------------------------
for L in no.musicstreamerweb.server no.musicstreamerweb.tunnel; do
  if OUT="$(launchctl print "gui/$UID/$L" 2>/dev/null)"; then
    PID="$(echo "$OUT"  | awk '/^\tpid = /{print $3}')"
    CODE="$(echo "$OUT" | awk '/last exit code = /{print $NF}')"
    if [ -n "${PID:-}" ]; then
      printf "%-34s KORER (pid %s)\n" "$L" "$PID"
    else
      printf "%-34s LASTET, men korer ikke (siste exit: %s)\n" "$L" "${CODE:-ukjent}"
    fi
  else
    printf "%-34s IKKE LASTET\n" "$L"
  fi
done
line

# --- Svarer serveren? ------------------------------------------------------
if curl -s -o /dev/null -m 4 -w '' "http://localhost:$PORT/" 2>/dev/null; then
  echo "http://localhost:$PORT              svarer"
else
  echo "http://localhost:$PORT              SVARER IKKE"
fi

# --- Tunneladressen --------------------------------------------------------
# Modusen leses av plist-en som faktisk korer, ikke av hva vi haper er satt
# opp — det er den eneste kilden som ikke kan lyve.
PLIST="$HOME/Library/LaunchAgents/no.musicstreamerweb.tunnel.plist"
if grep -q '<string>run</string>' "$PLIST" 2>/dev/null; then
  echo "Tunnelmodus:                        navngitt (fast adresse)"
  if [ -n "$TUNNEL_HOST" ]; then
    CODE="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$TUNNEL_HOST/" 2>/dev/null)"
    case "$CODE" in
      200) echo "https://$TUNNEL_HOST                svarer" ;;
      000) echo "https://$TUNNEL_HOST                NAR IKKE FREM (DNS eller nett)" ;;
      530|502|503)
           echo "https://$TUNNEL_HOST                SVARER $CODE — tunnelen korer ikke"
           echo "  → tail -20 logs/tunnel.log" ;;
      *)   echo "https://$TUNNEL_HOST                svarer $CODE" ;;
    esac
  fi
  CFG="$HOME/.cloudflared/$TUNNEL_NAME.yml"
  [ -f "$CFG" ] || echo "  ADVARSEL: $CFG mangler — kjor: bash deploy/tunnel-setup.sh"
else
  echo "Tunnelmodus:                        hurtig (tilfeldig adresse)"
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log 2>/dev/null | tail -1)"
  if [ -n "$URL" ]; then
    echo "Tunneladresse:                      $URL"
    echo "  (ny ved hver omstart av tunnelen — bruk alltid den siste)"
  else
    echo "Tunneladresse:                      ikke funnet i logs/tunnel.log"
  fi
  [ -n "$TUNNEL_HOST" ] && \
    echo "  → fast adresse https://$TUNNEL_HOST: bash deploy/tunnel-setup.sh"
fi
line

# --- Deling ----------------------------------------------------------------
KEY_FILE="$HOME/.musicstreamerweb-key"
if [ -f "$KEY_FILE" ]; then
  echo "Deling:                             laast med nokkel"
  [ -n "$TUNNEL_HOST" ] && echo "  din lenke: https://$TUNNEL_HOST/#k=$(cat "$KEY_FILE")"
  echo "  (slett $KEY_FILE og kjor install.sh paa nytt for aa apne for alle)"
else
  echo "Deling:                             APEN — alle med lenka kan dele"
fi
line

# --- Koden -----------------------------------------------------------------
VER="$(grep -o "const VERSION = '[^']*'" public/index.html 2>/dev/null | head -1 | cut -d\' -f2)"
echo "Versjon paa disk:                   ${VER:-ukjent}"

if [ -d .git ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  git fetch origin "$BRANCH" >/dev/null 2>&1
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo '?')"
  DIRTY="$(git status --porcelain 2>/dev/null | grep -vc '^??' || true)"
  echo "Git:                                gren $BRANCH, $BEHIND commit(er) bak origin, $DIRTY endrede filer"
  [ "${BEHIND:-0}" != "0" ] && echo "  → kjor: bash deploy/update.sh"
fi
line

# --- Siste feil ------------------------------------------------------------
if [ -s logs/server.err ]; then
  echo "Siste linjer i logs/server.err:"
  tail -6 logs/server.err | sed 's/^/  /'
else
  echo "logs/server.err er tom — ingen feil registrert."
fi
line
echo "Starter ikke tjenestene? Kjor:  bash deploy/install.sh"
echo
echo "MERK: tjenestene er LaunchAgents og korer i din innloggede brukerokt."
echo "      Etter en omstart starter de forst naar du har logget INN paa"
echo "      maskinen. Staar den paa innloggingsskjermen, korer ingenting."
