// Avspillingsforsinkelsen MAA vaere lik paa alle enheter. Har den ene 400 ms
// og den andre 1000, spiller de noyaktig 600 ms fra hverandre — og alt annet
// ser riktig ut, saa feilen er vanskelig aa se. Derfor eier senderen verdien.
import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:8080';
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };

function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on('message', (d, bin) => { if (!bin) { try { ws.inbox.push(JSON.parse(d)); } catch {} } });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const lastBuffer = (ws) => [...ws.inbox].reverse().find(m => m.type === 'buffer')?.ms;

console.log('\nSenderen bestemmer');
{
  const a = await open(), b = await open();
  await wait(120);
  // A blir sender ved aa sende en lydpakke
  a.send(Buffer.from([1, 2, 3, 4]), { binary: true });
  await wait(120);
  a.send(JSON.stringify({ type: 'buffer', ms: 700 }));
  await wait(150);
  check(lastBuffer(b) === 700, `lytteren fikk 700 ms (fikk ${lastBuffer(b)})`);
  check(lastBuffer(a) === 700, 'senderen faar den ogsaa, saa alle viser det samme');

  console.log('\nEn lytter kan ikke dra rommet ut av takt');
  b.send(JSON.stringify({ type: 'buffer', ms: 250 }));
  await wait(150);
  check(lastBuffer(b) === 700, `verdien staar fortsatt paa 700 (${lastBuffer(b)})`);

  console.log('\nDen som kommer sent faar verdien med en gang');
  const c = await open();
  await wait(200);
  check(lastBuffer(c) === 700, `ny klient fikk 700 ms uten aa spore (${lastBuffer(c)})`);

  console.log('\nTullverdier avvises');
  a.send(JSON.stringify({ type: 'buffer', ms: 99999 }));
  a.send(JSON.stringify({ type: 'buffer', ms: -5 }));
  a.send(JSON.stringify({ type: 'buffer', ms: 'aa' }));
  await wait(200);
  check(lastBuffer(c) === 700, `fortsatt 700 etter tre ugyldige forsok (${lastBuffer(c)})`);

  a.close(); b.close(); c.close();
}

await wait(150);
console.log(fail === 0 ? '\nAlt gikk gjennom.\n' : `\n${fail} feil.\n`);
process.exit(fail ? 1 : 0);
