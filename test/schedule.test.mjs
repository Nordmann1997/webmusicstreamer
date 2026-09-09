// Tidsplanen skal vaere ubrutt og jevn, og rollene ulike selv naar en klient
// laster sida pa nytt (kollisjon ga tidligere samme frekvens pa begge enheter).
import { WebSocket } from 'ws';

function client(name) {
  const st = { name, myRole: null, played: [], dupes: [], roleChanges: [] };
  const scheduled = new Set();
  const ws = new WebSocket('ws://127.0.0.1:8080');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'role') { st.myRole = m.role; st.roleChanges.push(m.role); }
    else if (m.type === 'clicks') {
      for (const c of m.clicks) {
        if (scheduled.has(c.n)) { st.dupes.push(c.n); continue; }
        scheduled.add(c.n);
        st.played.push(c);       // begge enheter spiller HVER takt
      }
    }
  });
  st.ws = ws;
  return st;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok?' OK ':'FEIL'}] ${w}`); if(!ok) fail++; };
const gaps = cs => { const t = cs.map(c=>c.at).sort((a,b)=>a-b); const g=[];
  for (let i=1;i<t.length;i++) g.push(t[i]-t[i-1]); return g; };

const a = client('A'), b = client('B');
await sleep(5000);

console.log(`\n  A: rolle ${a.myRole}, ${a.played.length} takter`);
console.log(`  B: rolle ${b.myRole}, ${b.played.length} takter`);
console.log(`  avstander: [${[...new Set(gaps(a.played))].join(', ')}] ms`);

check(a.myRole !== b.myRole, `ulike roller (${a.myRole} / ${b.myRole}) → ulik frekvens`);
check(a.played.length > 3 && b.played.length > 3, 'begge spiller');
check(gaps(a.played).every(g => g === 1000), 'jevn 1000 ms avstand, ingen hopp');
check(a.dupes.length === 0 && b.dupes.length === 0, 'ingen gjenbrukte takt-ID');
const times = a.played.map(c=>c.at);
check(new Set(times).size === times.length, 'ingen to takter deler tidspunkt');

console.log('\n  B laster sida pa nytt (uten a vente pa at den gamle lukkes)...');
const b2 = client('B2');
await sleep(400);
b.ws.close();
await sleep(1500);
console.log(`  A: rolle ${a.myRole}   B2: rolle ${b2.myRole}`);
check(a.myRole !== b2.myRole, 'ingen rollekollisjon etter reload');

a.ws.close(); b2.ws.close();
console.log(`\n${fail===0?'BESTATT':'FEILET'} (${fail} feil)\n`);
process.exit(fail===0?0:1);
