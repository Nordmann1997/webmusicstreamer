# Synk-målerigg

Første steg mot nettleser-basert lydstreaming med felles avspillingstid.
Denne riggen streamer **ingen lyd** — den svarer på det ene spørsmålet alt
annet hviler på: *klarer to enheter å treffe samme øyeblikk?*

Serveren deler ut en klikk-tidsplan i servertid. Hver enhet regner selv om til
sin egen lydklokke. Faller klikkene sammen til ett, holder tidsbasen.

## Kjør

```bash
npm install
npm start
```

Skal den stå permanent på en maskin (f.eks. en Mac Mini), se
[`deploy/README.md`](deploy/README.md) — `bash deploy/install.sh` setter den
opp som en tjeneste med offentlig HTTPS-adresse.

Åpne adressen på to enheter på samme nett. Trykk **Start lyd** på begge.

```bash
npm test                          # klokkematematikken mot simulerte klokker
node test/detect.test.mjs         # klikk-deteksjonen mot syntetiske opptak
node test/integration.test.mjs    # to ekte klienter mot serveren (krever at den kjører)
node test/twofreq.test.mjs         # at to samtidige tonehøyder ikke forstyrrer hverandre
node test/schedule.test.mjs       # tidsplan og rolletildeling (krever at den kjører)
node test/stream.test.mjs         # lydpakkenes koding, dekoding og tidslinje
node test/drift.test.mjs          # driftkorreksjonen over simulerte timer
node test/relay.test.mjs          # at serveren relayer lyd uendret (krever at den kjører)
node test/reconnect.test.mjs      # at sending overlever en serveromstart (krever at den kjører)
```

## Spille musikk

Trykk **Del lyden fra denne maskinen** på den maskinen lyden skal komme fra, og
huk av for **«Del fanens lyd»** i Chromes dialog — uten den følger det ingen lyd
med. Alle andre enheter begynner å spille automatisk.

Del helst en **fane**, ikke hele skjermen. Bare da kan nettleseren dempe den
direkte lyden, og senderen kan selv være høyttaler uten ekko. Skal lyden komme
fra en skrivebords-app, se «Loopback-enhet» under.

Hver lydpakke bærer tidspunktet den ble *fanget*, i servertid. Hver mottaker
legger til den samme bufferforsinkelsen og planlegger avspilling gjennom
nøyaktig samme `SyncedPlayer` som allerede planlegger klikkene. Derfor treffer
alle samme øyeblikk: de regner seg ikke fram til «nå», men til et **felles**
tidspunkt.

**Bufferforsinkelse** (standard 1000 ms) er hvor lenge etter fangst lyden
spilles. Alle mottakere må bruke samme verdi. Større tåler mer svingning i
nettverket, men gir lengre forsinkelse. Ser du mange «kom for sent», øk den.

Standarden er satt for internett. På et lokalt nett holder 300–400 ms fint, og
gir tydelig kjappere respons når du starter og stopper.

### Senderen må også vente — og kilden må bli stille

Kilden spiller live. Ingenting forteller den at den skal vente på bufferet, så
uten videre ligger den et helt buffer foran alle andre. Løsningen er at senderen spiller
sin **egen** strøm gjennom samme buffer som resten — avkrysningen *«Spill av her
også»* — og at den direkte lyden ikke når høyttalerne.

Det siste er ikke trivielt, fordi **kilden og nettleseren deler samme utgang**.
Å skru ned volumet demper begge to, og da er maskinen ikke lenger høyttaler.
Det finnes to veier rundt:

**Del en fane.** `getDisplayMedia` har `suppressLocalAudioPlayback` (Chrome
109+), og den virker for fane-lyd. Chrome demper da den direkte lyden selv,
mens du fortsatt fanger den. Enklest, og krever ingenting installert.
UI-et leser av `getSettings()` og sier om det faktisk slo til — det gjettes ikke.

**Loopback-enhet.** For lyd fra en skrivebords-app virker ikke suppression.
Sett maskinens utgang til en virtuell enhet (BlackHole, Loopback, VB-Cable),
velg den som *lydkilde* i appen, og la nettleseren spille ut på de ekte
høyttalerne med `AudioContext.setSinkId()` (Chrome 110+). Da går kilden aldri
til høyttalerne, og bare den forsinkede utgaven høres.

Utgangsvelgeren i UI-et er nettopp `setSinkId`. Enhetsnavnene krever
mikrofontillatelse for å vises — uten den lister nettleseren bare «standard».

### Sammenhengende avspilling

Det felles tidsestimatet beveger seg litt hele tiden. Regner man ut tidspunktet
for hver pakke for seg, blir nabopakker liggende en brøkdels millisekund fra
hverandre — et hull eller en overlapp i hver eneste pakkegrense. Med 47 pakker i
sekundet blir det sammenhengende skurring.

`PlaybackTimeline` bruker derfor estimatet til å legge ut tidslinja *én* gang,
og lar hver pakke følge rett etter den forrige, sample for sample. Bare når
avviket passerer 30 ms brytes tidslinja og legges på nytt. Testen kjører 200
pakker med ±1,5 ms skjelving og krever eksakt skjøt uten en eneste
resynkronisering, men at et reelt hopp på 500 ms fortsatt fanges opp.

**Samplingsrate må være lik.** Er senderen på 48 kHz og mottakeren på 44,1 kHz,
resamples hver pakke for seg, og da får du artefakter i hver pakkegrense
uansett hvor god timingen er. UI-et sier fra hvis de ikke stemmer.

**Deling krever sikker kontekst.** `getDisplayMedia` og mikrofonen virker bare
på `localhost` eller over HTTPS. Kjør derfor senderen på maskinen som kjører
serveren. Skal en annen maskin kunne dele eller måle, må du enten sette opp
HTTPS eller legge adressen inn under
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

### Opus

Lyden komprimeres med Opus via WebCodecs, ~134 kbit/s per lytter inkludert
header — **11,5× mindre** enn rå PCM. Fire lyttere går fra 6,2 til 0,54 Mbit/s.
Det er forskjellen på å kunne hoste dette og ikke.

Tidsstempelet legges i `AudioData.timestamp` og følger med uendret gjennom både
koder og dekoder, så vi slipper å holde styr på hvilken pakke som hører til
hvilken tid. Presentasjonstiden kommer ut på andre siden av kompresjonen helt
av seg selv.

Mangler nettleseren WebCodecs, faller senderen tilbake til rå 16-bits PCM. De
to formatene har hver sin magic i headeren og kan ikke forveksles — begge
dekoderne avviser den andres pakker, og det er testet.

**Alt kjører på 48 kHz.** Opus støtter bare 8/12/16/24/48 kHz, og når alle
enheter bruker samme rate slipper vi resampling i hver pakkegrense. Lydkonteksten
opprettes derfor eksplisitt med `sampleRate: 48000`.

## Hvorfor tonehøyde og ikke annenhver takt

Første forsøk lot enhetene dele taktene mellom seg i målemodus. Det var feil av
tre grunner:

- Rytmen endret seg, og det hørtes ut som om den andre enheten sluttet å spille.
- Modusbyttet endret taktavstanden, som endret takt-nummereringen — og det ga
  to stygge feil (se under).
- Verst: med vekselvise takter må søkevinduet være smalere enn halve
  taktavstanden, ellers forveksles enhetene. Et klikk som ligger 100 ms feil
  faller da **utenfor vinduet og blir aldri funnet** — som er nettopp det man
  prøver å måle.

Nå klikker begge på hver takt, samtidig, på hver sin tonehøyde. Rytmen er
uendret, flam høres direkte, og søkevinduet kan være ±400 ms uten forveksling.

Et tidligere forsøk på to tonehøyder feilet fordi detektoren bare hadde ett
filterpol og tonene lekket inn i hverandre. Med tre pol er lekkasjen borte:
`test/twofreq.test.mjs` måler under 0,08 ms feil ved forskyvninger opp til
±200 ms.

## Mål den faktiske feilen

Slå på **Mål med mikrofon** på én av enhetene. Rytmen endrer seg ikke —
enhetene klikker samtidig på hver sin tonehøyde (A = 900 Hz, B = 2100 Hz), og
den målende enheten tar opp begge:

```
feil_egen  = faktisk − planlagt   for min egen tonehøyde
feil_andre = faktisk − planlagt   for den andres tonehøyde
synkfeil   = feil_andre − feil_egen
```

Alt som er felles — mikrofonens inngangsforsinkelse, filterets
gruppeforsinkelse, hele opptakskjeden — står i begge ledd og forsvinner i
differansen. Det som ikke forsvinner er lydens gangtid, så sett mikrofonen
omtrent like langt fra begge høyttalerne. **34 cm skjevt = 1 ms feil.**

Deteksjonen er testet mot syntetiske opptak: under 0,01 ms feil i stillhet,
under 0,5 ms med kraftig romstøy, og den avviser opptak uten klikk i stedet
for å gjette.

## De tre klokkeproblemene

**1. Ingen felles nullpunkt.** `performance.now()` teller fra sidelasting, så
to enheter har hvert sitt nullpunkt. `Date.now()` er veggklokke — den kan
**steppe** når maskinen synkroniserer mot NTP, og et steg midt i drift river
i stykker enhver tidsplan.

Løsningen er å aldri sammenligne absolutte klokker. All lokal timing bruker
`performance.now()`, som er monoton og aldri hopper, og avstanden til serveren
måles fortløpende.

**2. Målingen har selv forsinkelse.** Fire tidsstempler per utveksling:

```
offset = ((t2 − t1) + (t3 − t4)) / 2
rtt    = (t4 − t1) − (t3 − t2)
```

Skriver man `offset` ut med reell forsinkelse hver vei, blir den til
`O + (d_opp − d_ned) / 2`. **Den symmetriske delen kanselleres.** Du trenger
aldri vite hvor lang forsinkelsen er — bare at den er nogenlunde lik begge
veier.

Det som står igjen er halve asymmetrien. Derfor beholder vi målingene med
**lavest RTT** og forkaster resten: lav RTT betyr lite køforsinkelse, altså
minst asymmetri. Ikke gjennomsnitt — et snitt drar med seg nettopp de dårlige
målingene.

**3. Lydklokka er ikke systemklokka.** Selv med perfekt synkroniserte
systemklokker går lydkortets krystall i sin egen takt — 10–100 ppm er vanlig,
altså 36–360 ms per time. Det var dette som drepte synken i synctest.

`getOutputTimestamp()` gir par av `contextTime` (lydklokka) og
`performanceTime` (systemklokka), referert til selve DAC-en. Stigningstallet
mellom dem **er** driften, målt direkte — ikke utledet fra kølengde.

## Takt-ID og takt-tidspunkt er ikke det samme

En tidligere versjon regnet takt-ID-en ut av tida: `n = tid / intervall`. Med
et intervall som kunne endre seg ga det to feil: nummer ble gjenbrukt (klienten
hopper over dupliserte nummer, så *alt* ble hoppet over og begge enheter ble
stille), og tidsmarkøren ble nullstilt oppå det som alt var delt ut, så to
tidsplaner spilte oppå hverandre.

Nå er `seq` en teller som aldri gjenbrukes, og `nextAt` en tidsmarkør som bare
går framover — uavhengig av hverandre.

## Rollene deles ut på nytt ved hver endring

Roller bestemmer tonehøyde. Deles de ut fra en teller, kan en side som lastes
på nytt kollidere med sin egen gamle tilkobling: den nye socketen kommer inn
før `close` for den gamle er behandlet, begge får samme rolle — og da klikker
enhetene på samme tonehøyde og målingen finner aldri «den andre».
`reassignRoles()` fordeler rollene på nytt hver gang noen kommer eller går.
`test/schedule.test.mjs` gjør nettopp den reload-racen.

## Om «-108 ms»-funnet

Første versjon opprettet lydkonteksten med `latencyHint: 'playback'`, som ber
nettleseren om et **stort** utgangsbuffer. På macOS kan det bli over 100 ms.

Det var feil her. Vi planlegger uansett sekunder fram i tid, så vi har ingen
nytte av bufferet — men hvert millisekund i det er forsinkelse vi må gjette
oss til igjen på veien ut. Treffer ikke gjettingen, spiller enheten hele
bufferet for tidlig. Det ser ut som drift, men er en konstant.

Nå brukes `'interactive'` (5–15 ms), og `getOutputTimestamp()` valideres før
den brukes: rapporterer den ~0 etterslep mot `currentTime`, er den ikke
DAC-referert og blir forkastet til fordel for `outputLatency`. Rута
**Tidskilde** sier hvilken som er i bruk.

## Automatisk kalibrering

Med mikrofonmålingen på: trykk **Kalibrer denne enheten automatisk**. Den
leser av den målte synkfeilen og setter justeringen som opphever den.
Verdien lagres per enhet i nettleseren, så den overlever en omstart.

Fortegnet følger synctest: **positiv = spill senere**.

## Les av «Kompensasjon»

Den viktigste ruta i avlesningen. Den viser hvor mye utgangsforsinkelse som
faktisk kompenseres, og **bør ligge nær `outputLatency` rett over den**.

Gjør den ikke det, er ikke utgangsforsinkelsen kompensert — og da spiller to
enheter ut av synk med nettopp differansen i `outputLatency`. Er den ene
16 ms og den andre 1,8 ms, er det 14 ms rett i fanget, som er mer enn hele
budsjettet.

`Tidskilde` sier hvor tallet kommer fra. `getOutputTimestamp` er referert til
selve DAC-en og er den vi vil ha; `outputLatency (reserve)` er et anslag.

## Feilbudsjett

Grensa for at det skal låte som én lydkilde i et rom er rundt 20 ms.

| Kilde | Bidrag |
|---|---|
| Klokkesynk, LAN | < 1 ms |
| Lydklokkedrift, korrigert | < 1 ms |
| Web Audio render-kvantum (128 samples) | ~3 ms |
| `outputLatency`, kablet | 5–20 ms |
| `outputLatency`, Bluetooth | 150–300 ms, upålitelig rapportert |

Kablet lander innenfor. Bluetooth gjør det ikke, og nettleseren rapporterer
sjelden riktig verdi — derfor er den manuelle justeringen i UI-et ikke pynt,
men nødvendig. (Samme escape hatch som `+`/`-`-kommandoene i synctest.)

**Én ting som ikke er et problem:** konstant baneasymmetri gir et fast avvik
på `(d_opp − d_ned) / 2`. Men klienter på samme nett får omtrent *likt* avvik,
så det forskyver alle likt og påvirker ikke den innbyrdes synken — som er det
eneste øret merker. Testen måler dette eksplisitt.

## Målt så langt

Simulert, 40 ms tilfeldig køforsinkelse: **1,3 ms** feil i tidsestimatet.
To simulerte klienter med ±35/−50 ppm klokkeavvik: **1,1 ms** innbyrdes.
To ekte WebSocket-klienter mot serveren på loopback: **0,16 ms** innbyrdes.

Ekte WiFi blir dårligere. Det er det du skal måle nå.

## Filer

| Fil | Hva det er |
|---|---|
| `public/sync.js` | Kjernen — `ClockSync`, `AudioClockTracker`, `SyncedPlayer` |
| `public/index.html` | Målerigg og avlesning |
| `public/detect.js` | Klikk-deteksjon (demodulasjon + toppunkt) |
| `public/measure.js` | Mikrofonmålingen |
| `public/stream.js` | Lydpakker inn og ut — `AudioSender`, `AudioReceiver`, `PlaybackTimeline` |
| `public/drift.js` | Driftkorreksjon — `DriftCorrector`, `applySampleCorrection` |
| `public/capture-worklet.js` | Fanger systemlyden med tidsstempel |
| `public/recorder-worklet.js` | Opptak med tidsstempel i AudioContext-tid |
| `server.js` | Tidssvar + felles klikk-tidsplan |
| `test/sync.test.mjs` | Estimatoren mot simulerte klokker med kjent fasit |
| `test/integration.test.mjs` | To ekte klienter mot serveren |
| `test/twofreq.test.mjs` | At to samtidige tonehøyder ikke forstyrrer hverandre |
| `test/schedule.test.mjs` | Tidsplan, jevn takt og rolletildeling ved reload |
| `test/stream.test.mjs` | Lydpakkenes koding, presisjon, klipping og tidslinje |
| `test/drift.test.mjs` | Driftkorreksjonen — simulerte timer med kjent klokkeavvik |
| `test/relay.test.mjs` | At serveren relayer lyd uendret, og bare fra én sender |
| `test/reconnect.test.mjs` | At sending og klikk overlever at forbindelsen faller |
| `deploy/install.sh` | Setter opp server + tunnel som tjenester på en Mac |

## Driftkorreksjon

Lydkortene i to maskiner teller ikke like fort. 30 ppm høres ikke ut av noe,
men det er 108 ms per time. Uten korreksjon vokser avviket til tidslinja må
brytes og legges på nytt — og hvert brudd er et hørbart knepp.

Løsningen er Snapcasts: i stedet for å la feilen samle seg og fikse den med et
hopp, fjernes eller dupliseres **ett sample av gangen**, spredt jevnt utover.
Ett sample ved 48 kHz varer 0,02 ms. Taket er 0,05 % av avspillingshastigheten,
samme som Snapcast.

Hvorfor ikke `playbackRate` i stedet: da ville hver pakke blitt resamplet for
seg, og resamplingsfasen nullstilles i hver pakkegrense. Det gir en liten
artefakt 47 ganger i sekundet. Sampledropp har ingen slik grense.

`test/drift.test.mjs` kjører simulerte timer med kjent klokkeavvik:

| Avvik | Uten korreksjon | Med korreksjon |
|---|---|---|
| 30 ppm, 10 min | 18 ms og voksende | 0,31 ms |
| 50 ppm, 1 time | 180 ms | **0,51 ms**, 2,4 samples/s |

Den sjekker også at korreksjonen aldri overstiger taket, og at ren
nettverksstøy uten reell drift ikke får den til å ta av.

## Etter en serveromstart

Faller forbindelsen — serveromstart, WiFi-hikke — lager klienten en ny
WebSocket. To ting må da ryddes, ellers ser alt riktig ut mens ingenting
virker:

**Senderen må følge med på den nye socketen.** `AudioSender` henter den
gjennom en funksjon i stedet for å låse referansen ved oppstart. Uten det
sendte den inn i en lukket socket i det uendelige: senderen hørte lyden fint
selv, via sin egen lokale avspilling, mens ingen av lytterne fikk noe.

**Takt-ID-ene må glemmes.** Serveren teller takter fra 0 hver gang den starter.
Husket klienten ID-ene fra før, ble alle nye takter avvist som duplikater.
`ws.onopen` tømmer derfor listen og nullstiller tidslinja.

Begge er testet i `test/reconnect.test.mjs`, inkludert ende-til-ende mot en
kjørende server.

## Neste steg

1. **Opus** via WebCodecs, når det skal ut av det lokale nettet.
2. **WebTransport** i stedet for WebSocket — lavere forsinkelse, og upålitelig
   levering passer lyd bedre enn TCPs videresending av gamle pakker.
3. **Romkode** så flere kan koble seg til uten å dele nett.
4. **Spotify Connect-modus** som alternativ: synkronisér tidslinja i stedet for
   lyden, med Web Playback SDK på hver enhet. Løser lisensspørsmålet over
   internett, men når ikke rom-nøyaktighet (`seek`/`resume` er ikke
   sample-nøyaktige — regn med ±50–200 ms).
