// Bare den som har nokkelen skal kunne DELE. Aa skjule knappen i nettleseren
// er ikke en sperre — hvem som helst kan kalle koden fra utviklerverktoyet.
// Derfor maa serveren nekte selve lydpakkene, og det er det denne maaler.
//
// Kjor med:  SHARE_KEY=hemmelig123 PORT=8099 node server.js
//            node test/sharegate.test.mjs
import WebSocket from 'ws';

const URL = process.env.URL || 'ws://127.0.0.1:8099';
const KEY = process.env.SHARE_KEY || 'hemmelig123';
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.inbox = []; ws.lyd = 0;
    ws.on('message', (d, bin) => {
      if (bin) { ws.lyd++; return; }
      try { ws.inbox.push(JSON.parse(d)); } catch {}
    });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const gate = ws => [...ws.inbox].reverse().find(m => m.type === 'sharegate');

console.log('\nDelingssperre');
{
  const lytter = await open(), gjest = await open(), eier = await open();
  await wait(120);

  check(gate(lytter)?.locked === true && gate(lytter)?.ok === false,
        'ingen far dele for de har vist nokkelen');

  gjest.send(JSON.stringify({ type: 'auth', key: 'feil' }));
  await wait(80);
  check(gate(gjest)?.ok === false, 'feil nokkel gir avslag');

  gjest.send(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), { binary: true });
  await wait(150);
  check(lytter.lyd === 0, 'lyd fra gjest slipper IKKE gjennom');

  eier.send(JSON.stringify({ type: 'auth', key: KEY }));
  await wait(80);
  check(gate(eier)?.ok === true, 'riktig nokkel gir lov');

  eier.send(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]), { binary: true });
  await wait(150);
  check(lytter.lyd === 1, 'lyd fra eier naar fram');

  gjest.send(Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]), { binary: true });
  await wait(150);
  check(lytter.lyd === 1, 'gjesten kommer ikke inn mens eieren sender heller');

  for (const w of [lytter, gjest, eier]) w.close();
}

console.log('\nGjetting');
{
  const b = await open();
  await wait(80);
  for (let i = 0; i < 7; i++) { b.send(JSON.stringify({ type: 'auth', key: 'gjett' + i })); await wait(40); }
  b.send(JSON.stringify({ type: 'auth', key: KEY }));
  await wait(100);
  check(gate(b)?.ok === false, 'fem forsok per tilkobling er taket — riktig nokkel etter det teller ikke');
  b.close();
}

console.log(fail ? `\n${fail} feil\n` : '\nAlt i orden\n');
process.exit(fail ? 1 : 0);
