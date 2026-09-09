#!/bin/bash
# ============================================================================
#  Henter siste versjon og starter tjenesten pa nytt.
#
#      bash deploy/update.sh
#
#  Skriver ut versjonsnummeret til slutt. Sammenlign med det som staar nederst
#  pa sida i nettleseren — stemmer de, kjorer enheten det du tror.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

if [ ! -d .git ]; then
  echo "FEIL: $DIR er ikke et git-repo enna."
  echo "  Se 'Forste gang' i deploy/README.md"
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# Uten denne kan tunnelen kore uten aa skrive loggen — og da er den
# offentlige adressen usynlig, selv om alt egentlig virker.
mkdir -p logs

echo "Henter oppdateringer (gren: $BRANCH)..."

# Hent og flett EKSPLISITT mot origin, ikke via upstream-konfigurasjon.
# `git reset --hard origin/main` flytter grena uten aa sette upstream, sa et
# bart `git pull` feiler med "no tracking information" — en forvirrende feil
# som ikke har noe med lokale endringer aa gjore.
if ! FETCH_ERR="$(git fetch origin "$BRANCH" 2>&1)"; then
  echo
  echo "Kunne ikke hente fra origin:"
  echo "$FETCH_ERR" | sed 's/^/  /'
  exit 1
fi

if ! MERGE_ERR="$(git merge --ff-only "origin/$BRANCH" 2>&1)"; then
  echo
  echo "Kunne ikke oppdatere. Git sier:"
  echo "$MERGE_ERR" | sed 's/^/  /'

  CHANGED="$(git status --porcelain | grep -v '^??' || true)"
  if [ -n "$CHANGED" ]; then
    echo
    echo "Du har lokale endringer i disse filene:"
    echo "$CHANGED" | sed 's/^/  /'
    echo
    echo "Kaste dem og folge fjernversjonen:"
    echo "  git reset --hard origin/$BRANCH && bash deploy/update.sh"
  fi
  exit 1
fi

# Sett upstream hvis den mangler, sa vanlig `git pull` ogsa virker heretter.
git rev-parse --abbrev-ref "$BRANCH@{upstream}" >/dev/null 2>&1 \
  || git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1

echo "Oppdaterer avhengigheter..."
npm install --omit=dev --silent

if launchctl kickstart -k "gui/$UID/no.musicstreamerweb.server" 2>/dev/null; then
  echo "Serveren startet pa nytt."
else
  echo "MERK: fant ingen kjorende tjeneste — kjor 'bash deploy/install.sh' forst."
fi

VER="$(grep -o "const VERSION = '[^']*'" public/index.html 2>/dev/null | head -1 | cut -d"'" -f2)"
echo
echo "Versjon na: ${VER:-ukjent}"
echo "Last sidene pa nytt (Cmd+Shift+R) og sjekk at det samme staar nederst."
