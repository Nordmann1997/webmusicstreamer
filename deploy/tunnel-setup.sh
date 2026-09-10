#!/bin/bash
# ============================================================================
#  Setter opp en NAVNGITT tunnel med fast adresse. Kjores EN gang, pa
#  maskinen som skal kjore serveren.
#
#      bash deploy/tunnel-setup.sh
#
#  Adressen leses fra deploy/tunnel.conf. Etterpa peker den adressen paa
#  denne maskinen for godt — ogsa etter omstart, i motsetning til
#  hurtigtunnelen som gir ny tilfeldig trycloudflare-adresse hver gang.
#
#  Krever at domenet allerede ligger inne i Cloudflare (navnetjenerne maa
#  peke dit). Se "Fast adresse" i deploy/README.md.
# ============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1
PORT="${PORT:-8080}"

TUNNEL_NAME=""; TUNNEL_HOST=""
[ -f deploy/tunnel.conf ] && . deploy/tunnel.conf
if [ -z "$TUNNEL_NAME" ] || [ -z "$TUNNEL_HOST" ]; then
  echo "FEIL: deploy/tunnel.conf mangler TUNNEL_NAME eller TUNNEL_HOST."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "FEIL: cloudflared er ikke installert."
  echo "  Installer med:  brew install cloudflared"
  exit 1
fi
CF="$(command -v cloudflared)"

echo "Tunnel:  $TUNNEL_NAME"
echo "Adresse: https://$TUNNEL_HOST"
echo "Peker paa: http://localhost:$PORT"
echo "------------------------------------------------------------"

# --- 1. Innlogging ---------------------------------------------------------
# Apner nettleseren. Velg domenet i lista — det gir cloudflared lov til aa
# lage DNS-oppforinger under akkurat det domenet, ingenting annet.
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo
  echo "1/4  Logger inn hos Cloudflare (nettleseren apner seg)..."
  "$CF" tunnel login || exit 1
else
  echo "1/4  Allerede innlogget ($HOME/.cloudflared/cert.pem finnes)."
fi

# --- 2. Tunnelen -----------------------------------------------------------
echo
if "$CF" tunnel list 2>/dev/null | awk 'NR>1{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "2/4  Tunnelen '$TUNNEL_NAME' finnes fra for."
else
  echo "2/4  Lager tunnelen '$TUNNEL_NAME'..."
  "$CF" tunnel create "$TUNNEL_NAME" || exit 1
fi

UUID="$("$CF" tunnel list --output json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const t=JSON.parse(s).find(x=>x.name===process.argv[1]);
          process.stdout.write(t ? t.id : ""); } catch { }
  });' "$TUNNEL_NAME")"

if [ -z "$UUID" ]; then
  echo "FEIL: fant ikke id-en til tunnelen. Sjekk:  cloudflared tunnel list"
  exit 1
fi
echo "     id: $UUID"

CRED="$HOME/.cloudflared/$UUID.json"
if [ ! -f "$CRED" ]; then
  echo "FEIL: nokkelfila mangler: $CRED"
  echo "  Tunnelen finnes hos Cloudflare, men nokkelen ligger ikke paa denne"
  echo "  maskinen. Slett den og lag den paa nytt her:"
  echo "      cloudflared tunnel delete $TUNNEL_NAME && bash deploy/tunnel-setup.sh"
  exit 1
fi

# --- 3. DNS ----------------------------------------------------------------
# Lager en CNAME <host> -> <uuid>.cfargotunnel.com hos Cloudflare.
echo
echo "3/4  Peker $TUNNEL_HOST paa tunnelen..."
if OUT="$("$CF" tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOST" 2>&1)"; then
  echo "     ok"
else
  case "$OUT" in
    *"already exists"*|*"record with that host already exists"*)
      echo "     oppforingen finnes fra for — lar den staa."
      echo "     (peker den et annet sted, ma den fjernes i Cloudflare forst)" ;;
    *)
      echo "$OUT" | sed 's/^/     /'
      echo
      echo "FEIL: fikk ikke satt DNS. Ligger $TUNNEL_HOST sitt domene inne i"
      echo "      Cloudflare, og valgte du riktig domene under innloggingen?"
      exit 1 ;;
  esac
fi

# --- 4. Konfigurasjonen ----------------------------------------------------
# ingress leses ovenfra og ned; siste linje er en sikkerhetsvegg som svarer
# 404 paa alt annet enn var egen adresse. Uten den ville tunnelen sendt
# hva som helst inn paa localhost.
CFG="$HOME/.cloudflared/$TUNNEL_NAME.yml"
echo
echo "4/4  Skriver $CFG"
cat > "$CFG" <<YML
tunnel: $UUID
credentials-file: $CRED

ingress:
  - hostname: $TUNNEL_HOST
    service: http://localhost:$PORT
  - service: http_status:404
YML

if ! "$CF" tunnel --config "$CFG" ingress validate >/dev/null 2>&1; then
  echo "FEIL: cloudflared godtok ikke konfigurasjonen:"
  "$CF" tunnel --config "$CFG" ingress validate 2>&1 | sed 's/^/  /'
  exit 1
fi
echo "     godkjent"

echo
echo "------------------------------------------------------------"
echo "Klart. Kjor naa:"
echo
echo "    bash deploy/install.sh"
echo
echo "Da starter tjenesten med den navngitte tunnelen, og adressen"
echo "https://$TUNNEL_HOST peker hit — ogsa etter omstart."
