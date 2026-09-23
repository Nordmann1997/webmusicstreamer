#!/bin/bash
# ============================================================================
#  Setter romkoden — den som gir lov til aa DELE lyd og styre rommet.
#
#  Kjor paa maskinen som kjorer serveren (Mac Mini-en):
#     bash deploy/set-key.sh humle
#     bash deploy/set-key.sh            (spor etter koden)
#
#  Koden skal kunne huskes og skrives paa mobil: store og smaa bokstaver
#  teller ikke, og mellomrom rundt blir fjernet. Serveren sperrer en adresse
#  i ti minutter etter ti feil, saa et vanlig ord er greit.
#
#  Lyttere trenger ingen kode — bare den som deler.
# ============================================================================
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="$HOME/.musicstreamerweb-key"

if [ -n "$1" ]; then KEY="$*"; else read -r -p "Ny romkode: " KEY; fi
KEY="$(printf '%s' "$KEY" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

if [ "${#KEY}" -lt 4 ]; then
  echo "Koden maa vaere minst 4 tegn."; exit 1
fi
# Koden havner i en plist (XML). Tegn som & og < ville oedelagt den.
if ! printf '%s' "$KEY" | LC_ALL=en_US.UTF-8 grep -Eq '^[[:alnum:] æøåÆØÅ_-]+$'; then
  echo "Bruk bare bokstaver, tall, mellomrom, - og _."; exit 1
fi

printf '%s' "$KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
echo "Romkoden er satt. Starter tjenesten paa nytt ..."
echo
bash "$DIR/deploy/install.sh"
echo
echo "Ny romkode: $KEY"
echo "Enheter som hadde den gamle koden maa skrive inn den nye under Share."
