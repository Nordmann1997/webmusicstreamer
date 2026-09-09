# Kjøre på Mac Mini-en

## Flytt filene

Kopier hele prosjektmappa, men **ikke `node_modules`** — den installeres på
nytt på Mini-en. Kjør fra en lokal mappe, ikke fra en delt nettverksmappe:
serveren leser filer mens den kjører, og stopper hvis delingen faller ut.

```bash
# på Mini-en, med prosjektet i den delte mappa:
cp -R "/Volumes/<delt mappe>/musicstreamerweb" ~/musicstreamermacmini
cd ~/musicstreamermacmini
rm -rf node_modules
```

Mappenavnet spiller ingen rolle. `install.sh` finner prosjektmappa ut fra sin
egen plassering, så den virker uansett hva du kaller den og hvor du kjører den
fra.

Bedre på sikt: legg det på GitHub og kjør `git pull` på Mini-en. Da er en
oppdatering én kommando i stedet for en ny kopiering.

## Sett opp

```bash
cd ~/musicstreamermacmini
brew install node cloudflared     # hvis de mangler
bash deploy/install.sh
```

Skriptet installerer avhengigheter, registrerer serveren og tunnelen som
`launchd`-tjenester, starter dem, og skriver ut den offentlige adressen.

Etter dette:

- serveren starter av seg selv når Mini-en slås på
- den kommer opp igjen hvis den krasjer (`KeepAlive`)
- `caffeinate -s` hindrer at maskinen sovner mens den kjører

## Adressen

`cloudflared tunnel --url` gir en gratis adresse på `trycloudflare.com`, men
**den endrer seg hver gang tunnelen starter på nytt**. Greit for testing.

Vil du ha en fast adresse, trenger du et domene lagt inn i Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create musicstreamer
cloudflared tunnel route dns musicstreamer lyd.dittdomene.no
```

Bytt så ut `--url http://localhost:8080` i
`~/Library/LaunchAgents/no.musicstreamerweb.tunnel.plist` med
`run musicstreamer`, og last tjenesten på nytt.

## Når noe skurrer

```bash
bash deploy/status.sh     # tjenester, adresse, versjon, om repoet er bak
bash deploy/reset.sh      # full opprydding og ny installasjon
```

`reset.sh` stopper og fjerner begge tjenestene, dreper løsrevne
`cloudflared`-prosesser som peker på porten vår, tømmer loggene, henter siste
kode og installerer på nytt. Bruk den når du er usikker på hva som står igjen
fra tidligere forsøk.

### Ingen adresse fra tunnelen

`trycloudflare` er en gratis best-effort-tjeneste uten oppetidsgaranti, og den
er ratebegrenset per IP. Henger `cloudflared` på «Requesting new quick Tunnel»,
er det tjenesten som ikke svarer — ikke nettet ditt. Vent noen minutter og kjør
`reset.sh` på nytt.

Sjekk gjerne først at det ikke er ditt eget nett:

```bash
curl -sS -m 15 -o /dev/null -w 'HTTP %{http_code}\n' https://api.trycloudflare.com/tunnel
```

`405` er riktig svar — endepunktet lever, og `curl` sendte bare feil metode.

Merk også at `logs/`-mappa må finnes *før* tunnelen starter. Gjør den ikke det,
kjører `cloudflared` videre uten å kunne skrive loggen, og adressen blir
usynlig selv om alt egentlig virker. Skriptene oppretter mappa selv nå.

## Sjekke at det går

```bash
cd ~/musicstreamermacmini
tail -f logs/server.log      # tilkoblinger, sendere, roller
tail -f logs/tunnel.log      # adressen og tunnelens tilstand
launchctl list | grep musicstreamerweb
```

Tjenestene heter `no.musicstreamerweb.server` og `.tunnel` uavhengig av hva
mappa heter — navnet er bare en fast identifikator, og at det ligger stille
gjør at `uninstall.sh` finner dem igjen selv om du flytter eller døper om
mappa senere.

## Stoppe

```bash
bash deploy/uninstall.sh
```

## Hvorfor tunnel og ikke portåpning

`cloudflared` lager en **utgående** forbindelse fra Mini-en, så du trenger
ingen portåpning i ruteren og ingenting endret i NAT. Trafikken går på port
443 med vanlig TLS, altså ikke til å skille fra annen nettrafikk — som er det
som faktisk slipper gjennom en skolebrannmur.

Og siden ingenting i systemet snakker direkte enhet-til-enhet, spiller det
ingen rolle at skolenettet isolerer klientene fra hverandre. Alle kobler til
én kjent adresse.
