#!/bin/bash
# ============================================================================
#  Henter siste versjon og starter tjenesten pa nytt.
#
#      bash deploy/update.sh
#
#  Erstatter manuell filkopiering. Skriver ut versjonsnummeret til slutt, sa
#  du kan sammenligne med det som vises nederst pa sida i nettleseren — da vet
#  du sikkert at enhetene kjorer det du tror de kjorer.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

if [ ! -d .git ]; then
  echo "FEIL: $DIR er ikke et git-repo enna."
  echo "  Se 'Forste gang' i deploy/README.md"
  exit 1
fi

echo "Henter oppdateringer..."
if ! git pull --ff-only; then
  echo
  echo "git pull feilet. Har du lokale endringer her? Sjekk med:  git status"
  echo "Vil du kaste dem og folge fjernversjonen:  git reset --hard origin/main"
  exit 1
fi

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
