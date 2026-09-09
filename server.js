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

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';

  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const clients = new Set();

// Én sender om gangen. Den forste som sender binaere data eier stromen til den
// kobler fra — ellers ville to sendere blandet lyd hos lytterne.
let bufferMs = null;      // felles avspillingsforsinkelse, eid av senderen
let broadcaster = null;
let audioPackets = 0;

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

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.role = assignRole();
  console.log(`Klient koblet til som rolle ${ws.role} (${clients.size} totalt)`);
  ws.send(JSON.stringify({ type: 'role', role: ws.role }));
  if (broadcaster) ws.send(JSON.stringify({ type: 'broadcast', active: true }));
  // Bufferet MAA vaere likt paa alle. Har den ene 400 ms og den andre 1000,
  // spiller de noyaktig 600 ms fra hverandre, og alt annet ser riktig ut.
  // Derfor eier senderen verdien, og den som kommer sent faar den med en gang.
  if (bufferMs !== null) ws.send(JSON.stringify({ type: 'buffer', ms: bufferMs }));
  reassignRoles();
  announcePeers();

  ws.on('message', (raw, isBinary) => {
    // Tidsstempel FORST, for parsing — vi vil ikke ha JSON.parse med i malingen.
    const t2 = now();

    // Lydpakker er binaere og gaar rett videre til alle andre. Serveren tolker
    // dem ikke: tidsstempelet inni er allerede i servertid, og hver mottaker
    // regner selv om til sin egen lydklokke.
    if (isBinary) {
      if (!broadcaster) {
        broadcaster = ws;
        console.log('Sender startet');
        broadcast({ type: 'broadcast', active: true });
      }
      if (ws !== broadcaster) return;
      audioPackets++;
      for (const c of clients) {
        if (c !== ws && c.readyState === c.OPEN) c.send(raw, { binary: true });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'ping') {
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
    clients.delete(ws);
    console.log(`Klient koblet fra (${clients.size} igjen)`);
    if (ws === broadcaster) {
      broadcaster = null;
      console.log(`Sender koblet fra (${audioPackets} lydpakker relayet)`);
      audioPackets = 0;
      broadcast({ type: 'broadcast', active: false });
    }
    reassignRoles();
    announcePeers();
  });
  ws.on('error', () => clients.delete(ws));
});

function announcePeers() {
  broadcast({ type: 'peers', count: clients.size, roles: [...clients].map(c => c.role) });
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
