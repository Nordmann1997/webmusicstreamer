#!/bin/bash
# ============================================================================
#  Full opprydding og ny installasjon.
#
#      bash deploy/reset.sh
#
#  Stopper og fjerner tjenestene, dreper losrevne cloudflared-prosesser,
#  tommer loggene, henter siste kode, og installerer alt paa nytt.
#
#  Bruk denne naar du er usikker paa hva som staar igjen fra tidligere forsok.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
AGENTS="$HOME/Library/LaunchAgents"
PORT="${PORT:-8080}"

TUNNEL_NAME=""; TUNNEL_HOST=""
[ -f deploy/tunnel.conf ] && . deploy/tunnel.conf

echo "Rydder opp i: $DIR"
echo

# --- 1. Stopp og fjern tjenestene -----------------------------------------
for L in no.musicstreamerweb.server no.musicstreamerweb.tunnel; do
  if launchctl print "gui/$UID/$L" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID/$L" 2>/dev/null
    # bootout er asynkron — vent til tjenesten faktisk er borte
    for _ in $(seq 1 50); do
      launchctl print "gui/$UID/$L" >/dev/null 2>&1 || break
      sleep 0.2
    done
    echo "  stoppet   $L"
  else
    echo "  kjorte ikke  $L"
  fi
  rm -f "$AGENTS/$L.plist" && echo "  fjernet   $L.plist"
done

# --- 2. Losrevne cloudflared-prosesser ------------------------------------
# Manuelle forsok i et terminalvindu lever videre og holder pa hver sin
# tunnel. Vi treffer bare de som peker paa VAR port.
# To former: hurtigtunnel (--url) og navngitt tunnel (tunnel run <navn>).
PATTERNS=("cloudflared tunnel --url http://localhost:$PORT")
[ -n "$TUNNEL_NAME" ] && PATTERNS+=("cloudflared.*tunnel run $TUNNEL_NAME")
FOUND=0
for PAT in "${PATTERNS[@]}"; do
  STRAY="$(pgrep -f "$PAT" 2>/dev/null | tr '\n' ' ')"
  if [ -n "${STRAY// /}" ]; then
    echo "  dreper losrevne cloudflared: $STRAY"
    pkill -f "$PAT" 2>/dev/null
    FOUND=1
  fi
done
[ "$FOUND" -eq 1 ] && sleep 2
[ "$FOUND" -eq 0 ] && echo "  ingen losrevne cloudflared-prosesser"
# Nokkel og config i ~/.cloudflared rores ikke — de er hele poenget med
# den faste adressen, og maa overleve en reset.

# --- 3. Logger -------------------------------------------------------------
mkdir -p logs
rm -f logs/*.log logs/*.err
echo "  tommet    logs/"

# --- 4. Siste kode ---------------------------------------------------------
echo
if [ -d .git ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  echo "Henter siste kode (gren: $BRANCH)..."
  if git fetch origin "$BRANCH" >/dev/null 2>&1 && git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
    echo "  oppdatert"
  else
    echo "  ADVARSEL: kunne ikke oppdatere fra git. Fortsetter med koden som ligger her."
    echo "            Sjekk med:  git status"
  fi
else
  echo "Ikke et git-repo — bruker koden som ligger her."
fi

# --- 5. Installer paa nytt -------------------------------------------------
echo
echo "Installerer paa nytt..."
echo "------------------------------------------------------------"
bash deploy/install.sh
