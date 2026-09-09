// Integrasjonstest: kobler to simulerte klienter til serveren, gjor ekte
// NTP-utvekslinger over WebSocket, og sjekker at de blir enige om tida.
import { WebSocket } from 'ws';
import { ClockSync } from '../public/sync.js';

function client(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:8080');
    const clock = new ClockSync();
    let pings = 0, clickBatches = 0, totalClicks = 0, role = null;

    ws.on('open', () => {
      const iv = setInterval(() => {
        ws.send(JSON.stringify({ type: 'ping', t1: performance.now() }));
        if (++pings >= 25) clearInterval(iv);
      }, 60);
    });

    ws.on('message', (raw) => {
      const t4 = performance.now();
      const m = JSON.parse(raw);
      if (m.type === 'pong') clock.addExchange(m.t1, m.t2, m.t3, t4);
      else if (m.type === 'role') role = m.role;
      else if (m.type === 'clicks') { clickBatches++; totalClicks += m.clicks.length; }
    });

    setTimeout(() => { ws.close(); resolve({ name, clock, pings, clickBatches, totalClicks, role }); }, 4000);
  });
}

const [a, b] = await Promise.all([client('A'), client('B')]);

let fail = 0;
const check = (ok, what) => { console.log(`  [${ok?' OK ':'FEIL'}] ${what}`); if(!ok) fail++; };

check(a.role !== b.role, `de to klientene fikk ULIKE roller (${a.role} og ${b.role})`);

for (const c of [a, b]) {
  console.log(`\nKlient ${c.name}: ${c.pings} pings, ${c.totalClicks} klikk i ${c.clickBatches} pakker`);
  console.log(`  offset = ${c.clock.offsetMs.toFixed(3)} ms, min-RTT = ${c.clock.minRtt.toFixed(3)} ms`);
  check(c.clock.ready, `${c.name}: klokkeestimat klart`);
  check(c.totalClicks > 0, `${c.name}: mottok klikk-tidsplan`);
  check(c.role === 0 || c.role === 1, `${c.name}: fikk tildelt rolle (${c.role})`);
}

// Det avgjorende: er de to enige om NAAR en gitt servertid er, lokalt?
const targetServer = a.clock.serverNow() + 2000;
const localA = a.clock.localTimeAt(targetServer);
const localB = b.clock.localTimeAt(targetServer);
// Begge kjorer i samme prosess her, sa performance.now() er felles referanse.
const spread = Math.abs(localA - localB);
console.log(`\nInnbyrdes avvik for samme servertid: ${spread.toFixed(3)} ms`);
check(spread < 5, 'to klienter er enige innenfor 5 ms');

console.log(`\n${fail===0?'INTEGRASJONSTEST BESTATT':'FEILET'} (${fail} feil)\n`);
process.exit(fail===0?0:1);
