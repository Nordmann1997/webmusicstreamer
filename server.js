// ============================================================================
//  Maalerigg-server.
//
//  To oppgaver:
//   1. Svare paa tidsforesporsler (t2/t3) sa klientene kan estimere offset.
//   2. Dele ut en FELLES klikk-tidsplan, uttrykt i servertid.
//
//  Serveren har ingen mening om naar en klient skal spille lokalt — den sier
//  bare "klikk nr. 4812 horer hjemme paa servertid T". Hver klient regner selv
//  om til sin egen lydklokke. Det er hele poenget.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// Serverens monotone klokke, i millisekunder. Ikke Date.now() — den kan
// steppe naar maskinen synkroniserer mot NTP, og et steg midt i drift
// odelegger enhver tidsplan.
const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;

// --- Klikk-tidsplan --------------------------------------------------------
const CLICK_INTERVAL_MS = 1000;   // ett klikk i sekundet
const SCHEDULE_AHEAD_MS = 3000;   // del ut 3 sekunder fram i tid
const BAR_LENGTH        = 4;      // hvert 4. klikk er en aksent

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  // En ugyldig adresse (f.eks. «/%E0%A4%A») faar decodeURIComponent til aa
  // kaste. Uten try her tok EN slik forespørsel ned hele serveren — og med en
  // aapen adresse paa nett kommer det skannere som sender akkurat det. Alle
  // lyttere mistet forbindelsen samtidig, og launchd startet den paa nytt.
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (rel === '/') rel = '/index.html';

  const file = path.join(PUBLIC, rel);
  // Med path.sep: ellers slipper «/public-noe-annet» gjennom prefikssjekken.
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Cloudflare mellomlagrer .js og .css som standard. Uten dette kan en
      // enhet kjore ny index.html med GAMMEL stream.js etter en oppdatering —
      // to versjoner av protokollen i samme fane.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const clients = new Set();

// Én sender om gangen. Den forste som sender binaere data eier stromen til den
// kobler fra — ellers ville to sendere blandet lyd hos lytterne.
let bufferMs = null;      // felles avspillingsforsinkelse, eid av senderen
let broadcaster = null;

// Nokkel for aa faa lov til aa dele. Tom = aapent for alle, som for.
// Settes som miljovariabel av deploy/install.sh, som leser den fra
// ~/.musicstreamerweb-key — utenfor repoet, saa den overlever git pull.
//
// Dette er den ekte sperra. Aa skjule knappen i nettleseren stopper ingen som
// aapner utviklerverktoyet; serveren maa nekte selve lydpakkene.
const SHARE_KEY = process.env.SHARE_KEY || '';
let audioPackets = 0;
let lastAudio = 0;        // naar senderen sist sendte noe

// --- Puls -----------------------------------------------------------------
// En TCP-forbindelse kan bli halvaapen: maskinen sovner eller mister nettet,
// og serveren faar ALDRI 'close'. Da staar senderrollen opptatt av noen som
// ikke finnes, og enhetstelleren viser folk som for lengst er borte. Uten en
// puls oppdager serveren det aldri.
//
// ws sender en ekte WebSocket-ping. Svarer ikke klienten innen neste runde,
// river vi forbindelsen — og da kjorer 'close', som frigjor senderrollen.
const PULS_MS = Number(process.env.PULSE_MS) || 25000;
setInterval(() => {
  for (const c of clients) {
    if (c.isAlive === false) {
      console.log(`${c.name} svarte ikke paa puls — river forbindelsen`);
      drop(c);
      continue;
    }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}, PULS_MS);

// Puls tar tid — inntil 50 sekunder i verste fall. Senderen skal vi oppdage
// fortere, for det er den som blokkerer alle andre. Mens noen deler kommer
// det rundt femti lydpakker i sekundet, ogsaa i stille partier, saa femten
// sekunders stillhet betyr at senderen er borte uansett hva sokkelen sier.
// Fem sekunder, ikke femten: i femten sekunder trodde alle at det ble
// strommet fra en fane som for lengst var lastet paa nytt.
const SENDER_TAUSHET_MS = Number(process.env.SENDER_IDLE_MS) || 5000;
setInterval(() => {
  if (!broadcaster) return;
  if (Date.now() - lastAudio < SENDER_TAUSHET_MS) return;
  console.log(`Senderen har vaert taus i ${SENDER_TAUSHET_MS / 1000} s — frigjor rollen`);
  releaseSender();
}, Math.min(5000, SENDER_TAUSHET_MS / 3));

// Del ut den rollen som er minst brukt blant dem som faktisk er tilkoblet.
// En teller som bare teller oppover gir kollisjon sa snart en klient laster
// sida pa nytt: begge ender pa samme rolle, og halvparten av taktene blir
// spilt av ingen.
function assignRole() {
  let n0 = 0, n1 = 0;
  for (const c of clients) { if (c.role === 0) n0++; else if (c.role === 1) n1++; }
  return n0 <= n1 ? 0 : 1;
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
}

// --- Delingskode --------------------------------------------------------------
// Koden skal kunne huskes og skrives paa en mobil, saa store/smaa bokstaver og
// mellomrom rundt teller ikke. Det gjor den lettere aa gjette — derfor sperrer
// vi en IP etter for mange bom, i tillegg til taket per tilkobling.
const normKey = k => String(k ?? '').normalize('NFC').trim().toLowerCase();
const KEY_N = normKey(SHARE_KEY);
const BOM_TAK = 10;                  // feil per IP ...
const BOM_SPERRE_MS = 10 * 60000;    // ... gir ti minutter pause
const bom = new Map();               // ip -> { n, until }

function keyOk(ws, key) {
  if (!SHARE_KEY) return true;
  const b = bom.get(ws.ip);
  if (b && b.until > Date.now()) return false;
  if (normKey(key) === KEY_N) { bom.delete(ws.ip); return true; }
  const n = (b && b.until === 0 ? b.n : 0) + 1;
  bom.set(ws.ip, { n, until: n >= BOM_TAK ? Date.now() + BOM_SPERRE_MS : 0 });
  if (n >= BOM_TAK) console.log(`For mange feil kode fra ${ws.ip} — sperret i 10 min`);
  return false;
}

// --- Senderrollen ---------------------------------------------------------------
function releaseSender(why = '') {
  if (!broadcaster) return;
  console.log(`Sender frigjort${why ? ` (${why})` : ''} etter ${audioPackets} lydpakker`);
  broadcaster = null;
  audioPackets = 0;
  broadcast({ type: 'broadcast', active: false, sender: null });
  announcePeers();
}

/**
 * Fjern en klient fra ALL bokforing med en gang, og lukk den etterpaa.
 *
 * close() venter paa at motparten svarer. Er motparten en fane som er lastet
 * paa nytt eller en maskin som har sovnet, svarer den aldri, og ws venter i
 * 30 sekunder for den gir opp. Hele den tida sto den i enhetslista og kunne
 * eie senderrollen. Derfor gjor vi bokforingen for vi lukker.
 */
function drop(c, code, reason) {
  if (!clients.has(c)) return;
  clients.delete(c);
  if (c === broadcaster) releaseSender(reason);
  reassignRoles();
  announcePeers();
  try { code ? c.close(code, reason) : c.terminate(); } catch {}
}

// En lytter paa treg linje faar ikke hope opp lyd i serverens minne. Det som
// ligger mer enn et sekund i ko kommer uansett for sent til aa bli spilt.
const MAX_KO_BYTES = 256 * 1024;

wss.on('connection', (ws, req) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Bak Cloudflare-tunnelen er alle tilkoblinger fra localhost; den ekte
  // adressen staar i headeren.
  ws.ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  ws.clientId = null;
  ws.name = 'Ukjent enhet';
  ws.listening = false;
  ws.since = Date.now();
  ws.role = assignRole();
  console.log(`Klient koblet til som rolle ${ws.role} (${clients.size} totalt)`);
  ws.send(JSON.stringify({ type: 'role', role: ws.role }));
  // ALLTID, ogsaa naar ingen sender. Klienten kan ha en gammel «aktiv» liggende
  // fra for en frakobling, og uten et eksplisitt nei blir den staaende.
  ws.send(JSON.stringify({ type: 'broadcast', active: !!broadcaster,
                           sender: broadcaster?.clientId ?? null }));
  // Uten nokkel er alle sendere, som for. Med nokkel maa klienten sporre.
  ws.mayShare = !SHARE_KEY;
  ws.send(JSON.stringify({ type: 'sharegate', locked: !!SHARE_KEY, ok: !SHARE_KEY }));
  // Bufferet MAA vaere likt paa alle. Har den ene 400 ms og den andre 1000,
  // spiller de noyaktig 600 ms fra hverandre, og alt annet ser riktig ut.
  // Derfor eier senderen verdien, og den som kommer sent faar den med en gang.
  if (bufferMs !== null) ws.send(JSON.stringify({ type: 'buffer', ms: bufferMs }));
  reassignRoles();
  announcePeers();

  ws.on('message', (raw, isBinary) => {
    // Tidsstempel FORST, for parsing — vi vil ikke ha JSON.parse med i malingen.
    const t2 = now();
    if (!clients.has(ws)) return;          // allerede kastet ut, bare ikke lukket

    // Lydpakker er binaere og gaar rett videre til alle andre. Serveren tolker
    // dem ikke: tidsstempelet inni er allerede i servertid, og hver mottaker
    // regner selv om til sin egen lydklokke.
    if (isBinary) {
      if (!broadcaster) {
        if (SHARE_KEY && !ws.mayShare) return;   // ingen nokkel, ingen deling
        broadcaster = ws;
        lastAudio = Date.now();
        console.log(`Sender startet: ${ws.name}`);
        broadcast({ type: 'broadcast', active: true, sender: ws.clientId });
        announcePeers();
      }
      if (ws !== broadcaster) return;
      audioPackets++;
      lastAudio = Date.now();
      for (const c of clients) {
        if (c === ws || c.readyState !== c.OPEN) continue;
        if (c.bufferedAmount > MAX_KO_BYTES) { c.skipped = (c.skipped || 0) + 1; continue; }
        c.send(raw, { binary: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      // Hver fane har en ID som overlever en omlasting. Kommer den samme ID-en
      // inn paa nytt, er den gamle tilkoblingen en fane som ikke finnes lenger
      // — selv om serveren ikke har faatt vite det ennaa. Det var den som
      // gjorde at sida trodde det ble strommet etter en omlasting, og at det
      // saa ut som det var flere enheter enn det var.
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 40) : null;
      ws.name = typeof msg.name === 'string' && msg.name.trim()
        ? msg.name.trim().slice(0, 40) : ws.name;
      ws.listening = !!msg.listening;
      if (id) {
        for (const c of clients) {
          if (c !== ws && c.clientId === id) {
            console.log(`${ws.name}: ny tilkobling fra samme fane — den gamle kastes`);
            // 4000 = «erstattet». Er den gamle fanen faktisk i live (en
            // duplisert fane arver sessionStorage og dermed ID-en), lager den
            // seg en ny ID og kobler til igjen.
            try { c.send(JSON.stringify({ type: 'replaced' })); } catch {}
            drop(c, 4000, 'erstattet');
          }
        }
        ws.clientId = id;
      }
      announcePeers();

    } else if (msg.type === 'state') {
      if ('listening' in msg) ws.listening = !!msg.listening;
      if (typeof msg.name === 'string' && msg.name.trim()) ws.name = msg.name.trim().slice(0, 40);
      announcePeers();

    } else if (msg.type === 'auth') {
      // Fem forsok per tilkobling, og et tak per IP i tillegg.
      ws.authTries = (ws.authTries || 0) + 1;
      if (ws.authTries <= 5) ws.mayShare = keyOk(ws, msg.key);
      ws.send(JSON.stringify({ type: 'sharegate', locked: !!SHARE_KEY, ok: !!ws.mayShare }));

    } else if (msg.type === 'admin') {
      // Kontroll over rommet: stopp den som deler, eller kast ut en enhet.
      // Bare for den som har koden.
      if (SHARE_KEY && !ws.mayShare) return;
      if (msg.action === 'stop-sharing') {
        if (broadcaster && broadcaster !== ws) {
          try { broadcaster.send(JSON.stringify({ type: 'stop-sharing' })); } catch {}
        }
        releaseSender('stoppet av ' + ws.name);
      } else if (msg.action === 'kick') {
        for (const c of clients) {
          if (c !== ws && c.clientId && c.clientId === msg.id) {
            console.log(`${ws.name} kastet ut ${c.name}`);
            try { c.send(JSON.stringify({ type: 'kicked' })); } catch {}
            drop(c, 4001, 'kastet ut');
          }
        }
      }

    } else if (msg.type === 'sharing-stopped') {
      if (ws === broadcaster) releaseSender('stoppet av senderen');

    } else if (msg.type === 'restart') {
      // Tjenesten kjorer under launchd med KeepAlive, saa aa avslutte er det
      // samme som aa starte paa nytt. Klientene kobler seg opp igjen selv.
      if (SHARE_KEY && !ws.mayShare) return;
      console.log('Omstart bedt om utenfra');
      ws.send(JSON.stringify({ type: 'restarting' }));
      setTimeout(() => process.exit(0), 150);

    } else if (msg.type === 'ping') {
      // t1 sendes uendret tilbake sa klienten slipper a holde styr paa den.
      ws.send(JSON.stringify({ type: 'pong', t1: msg.t1, t2, t3: now() }));

    } else if (msg.type === 'buffer') {
      // Bare senderen faar bestemme. Ellers kan en tilfeldig lytter dra
      // hele rommet ut av takt ved aa flytte sin egen skyver.
      if (broadcaster && ws !== broadcaster) return;
      const v = Number(msg.ms);
      if (!isFinite(v) || v < 100 || v > 5000) return;
      bufferMs = Math.round(v);
      broadcast({ type: 'buffer', ms: bufferMs });
    }
  });

  ws.on('close', () => {
    if (!clients.has(ws)) return;          // allerede ryddet av drop()
    console.log(`Klient koblet fra (${clients.size - 1} igjen)`);
    drop(ws);
  });
  ws.on('error', () => drop(ws));
});

// Hvem er her. Sendes til alle, saa hver enhet kan se lista; bare den med
// koden faar lov til aa gjore noe med den.
function announcePeers() {
  const list = [...clients];
  broadcast({
    type: 'peers',
    count: list.length,
    listening: list.filter(c => c.listening || c === broadcaster).length,
    roles: list.map(c => c.role),
    devices: list.map(c => ({
      id: c.clientId, name: c.name, listening: c.listening,
      sender: c === broadcaster, since: c.since,
    })),
  });
}

// Rollene deles ut paa nytt hver gang noen kommer eller gaar. Uten dette kan en
// side som lastes paa nytt kollidere med sin egen gamle tilkobling: den nye
// socketen kommer inn FOR close-hendelsen for den gamle er behandlet, begge
// enheter far samme rolle — og da klikker de paa samme frekvens, og malingen
// finner aldri "den andre".
function reassignRoles() {
  let i = 0;
  for (const c of clients) {
    const r = i++ % 2;
    if (c.role !== r) {
      c.role = r;
      if (c.readyState === c.OPEN) c.send(JSON.stringify({ type: 'role', role: r }));
    }
  }
}

// Del ut kommende klikk til alle. Samme tall til alle — det er det som gjor
// at de treffer samtidig.
// Takt-ID og takt-TIDSPUNKT holdes fra hverandre.
//
// For var ID-en regnet ut av tida: n = tid / intervall. Da endret nummereringen
// seg naar intervallet endret seg, og to ting gikk galt:
//
//   * 500 → 1000 ms halverte alle nummer, sa de nye taktene fikk nummer
//     klienten allerede hadde sett. Klienten hopper over dupliserte nummer,
//     sa ALT ble hoppet over — begge enheter ble stille.
//   * 1000 → 500 ms nullstilte tidspunktet til "naa", oppa de 3 sekundene
//     som allerede var delt ut. Gammel og ny tidsplan spilte samtidig, og
//     rytmen ble ujevn.
//
// Naa er `seq` en teller som aldri gjenbrukes, og `nextAt` en tidsmarkor som
// bare gaar framover. Bytter intervallet, gjelder det fra markoren og utover —
// ingen gjenbrukte nummer, ingen overlapp.
let seq = 0;
let nextAt = Math.ceil(now() / CLICK_INTERVAL_MS) * CLICK_INTERVAL_MS;

setInterval(() => {
  const horizon = now() + SCHEDULE_AHEAD_MS;

  // Har vi sakket akterut (sovnet maskin, pause), hopp fram til naa.
  if (nextAt < now()) nextAt = Math.ceil(now() / CLICK_INTERVAL_MS) * CLICK_INTERVAL_MS;

  const clicks = [];
  while (nextAt < horizon) {
    clicks.push({ n: seq, at: nextAt, accent: seq % BAR_LENGTH === 0 });
    seq++;
    nextAt += CLICK_INTERVAL_MS;
  }

  if (clicks.length === 0) return;

  broadcast({ type: 'clicks', clicks, serverNow: now() });
}, 500);

server.listen(PORT, () => {
  console.log(`\n  Malerigg kjorer.\n`);
  console.log(`  Denne maskinen:  http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  Andre enheter:   http://${a.address}:${PORT}   (${name})`);
      }
    }
  }
  console.log(`\n  Apne lenka pa to enheter. Klikkene skal hores som ETT klikk.\n`);
});
