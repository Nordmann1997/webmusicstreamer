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

Uten oppsett kjører tunnelen i **hurtigmodus**: `cloudflared tunnel --url`
gir en gratis adresse på `trycloudflare.com`. Den er grei til testing, men har
to problemer: den endrer seg hver gang tunnelen starter på nytt, og hele
`trycloudflare.com` er svartelistet hos flere mobiloperatører (Telenor
Nettvern blokkerer den som «utrygg nettside») fordi domenet misbrukes til
svindel.

### Fast adresse: multiroom.jwk.no

En **navngitt tunnel** fikser begge deler. Den bruker et domene du eier, så
adressen står stille og ingen filtrerer den.

**1. Legg `jwk.no` inn i Cloudflare** (gratisplanen holder)

Cloudflare må være autoritativ for domenet — det er ikke nok å ha en konto.

- Opprett konto på cloudflare.com, velg *Add a site*, skriv `jwk.no`, velg Free.
- Cloudflare skanner dagens DNS og viser en liste med importerte oppføringer.
  **Gå gjennom lista mot Domeneshop før du fortsetter.** Sammenlign med
  DNS-oversikten i Domeneshop-panelet, oppføring for oppføring. Skanningen
  tar det den finner, og den finner ikke alt: navn som ikke er vanlige
  (`mail`, `autodiscover`, verifikasjonsposter) kan mangle. Mangler noe,
  legg det inn manuelt nå.
- Særlig viktig: **MX-oppføringer og TXT/SPF/DKIM**. Mister du dem, slutter
  e-post på domenet å virke — det er den vanligste smellen ved flytting.
- Sett hjemmesidas oppføringer til «DNS only» (grå sky) hvis du er usikker på
  om den tåler å ligge bak Cloudflares proxy. Det kan skrus på senere.

**2. Bytt navnetjenere hos Domeneshop**

Cloudflare gir deg to navnetjenere (`xxx.ns.cloudflare.com`). I
Domeneshop: domenet → *Navnetjenere* → bytt fra Domeneshops egne til de to
fra Cloudflare.

Hjemmesida fortsetter å virke gjennom hele byttet, så lenge oppføringene i
steg 1 stemmer — det er de samme svarene, bare fra en annen server. Regn med
alt fra noen minutter til noen timer før det har spredd seg. Cloudflare sender
e-post når domenet er aktivt.

**3. Sett opp tunnelen på Mini-en**

```bash
cd ~/musicstreamermacmini
git pull
bash deploy/tunnel-setup.sh    # én gang
bash deploy/install.sh
```

`tunnel-setup.sh` logger deg inn (nettleseren åpner seg — velg `jwk.no` i
lista), lager tunnelen, peker `multiroom.jwk.no` på den, og skriver
`~/.cloudflared/musicstreamer.yml`. `install.sh` oppdager konfigurasjonen og
starter tjenesten i navngitt modus i stedet for hurtigmodus.

Adressen står i `deploy/tunnel.conf`. Vil du ha en annen, endre den der og
kjør `tunnel-setup.sh` på nytt.

### Hvorfor et subdomene og ikke jwk.no/webmultiroom

En underkatalog ville krevd tre endringer i koden: WebSocket-en kobler til
roten (`wss://<vert>/`), `server.js` bygger filstier rett fra URL-en, og
`index.html` importerer moduler relativt (`./sync.js`) — som peker feil hvis
adressen mangler skråstrek på slutten. Subdomenet krever null kodeendringer:
én DNS-oppføring og én ingress-regel.

Vil du likevel ha en inngang fra hjemmesida, legg en lenke til
`https://multiroom.jwk.no` på `jwk.no/webmultiroom`.

### Nøkkelen

`tunnel-setup.sh` legger `cert.pem` og `<uuid>.json` i `~/.cloudflared/` på
Mini-en. De skal **aldri** inn i git — `<uuid>.json` er nøkkelen som lar
hvem som helst kjøre tunnelen din. `reset.sh` rører dem ikke.

Flytter du til en annen maskin, kjør `tunnel-setup.sh` der. Finnes tunnelen
allerede uten at nøkkelen ligger lokalt, sier skriptet fra hvordan du lager
den på nytt.

## Når noe skurrer

```bash
bash deploy/status.sh        # tjenester, adresse, versjon, om repoet er bak
bash deploy/reset.sh         # full opprydding og ny installasjon
bash deploy/tunnel-setup.sh  # sette opp / reparere den faste adressen
```

`reset.sh` stopper og fjerner begge tjenestene, dreper løsrevne
`cloudflared`-prosesser som peker på porten vår, tømmer loggene, henter siste
kode og installerer på nytt. Bruk den når du er usikker på hva som står igjen
fra tidligere forsøk.

### Adressen svarer 530 eller «Error 1033»

Cloudflare fant ingen tunnel bak navnet. Enten kjører ikke `cloudflared` på
Mini-en, eller så peker DNS-oppføringen på en tunnel som ikke finnes lenger
(typisk hvis tunnelen er slettet og laget på nytt). Sjekk:

```bash
bash deploy/status.sh
tail -20 logs/tunnel.log
cloudflared tunnel list
```

Stemmer ikke id-en i `~/.cloudflared/musicstreamer.yml` med den i lista, kjør
`bash deploy/tunnel-setup.sh` på nytt.

### Ingen adresse fra hurtigtunnelen

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
