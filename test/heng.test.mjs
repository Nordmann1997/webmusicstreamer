// En TCP-forbindelse kan bli halvaapen: maskinen sovner eller mister nettet,
// og serveren faar ALDRI 'close'. Da staar senderrollen opptatt av noen som
// ikke finnes, enhetstelleren viser folk som er borte, og ingen andre slipper
// til. Det skjedde i drift, og serveren oppdaget det aldri av seg selv.
//
// Kjor med:  PORT=8097 SENDER_IDLE_MS=2000 PULSE_MS=800 node server.js
//            node test/heng.test.mjs
import WebSocket from 'ws';
import net from 'net';

const PORT = Number(process.env.PORT) || 8097;
const URL = `ws://127.0.0.1:${PORT}`;
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function open() {
  return new Promise(res => {
    const ws = new WebSocket(URL);
    ws.inbox = []; ws.lyd = 0;
    ws.on('message', (d, bin) => {
      if (bin) { ws.lyd++; return; }
      try { ws.inbox.push(JSON.parse(d)); } catch {}
    });
    ws.on('open', () => res(ws));
  });
}
const siste = (ws, t) => [...ws.inbox].reverse().find(m => m.type === t);

console.log('\nSender som forsvinner uten aa lukke');
{
  const a = await open(), b = await open();
  await wait(150);
  a.send(Buffer.from([1, 2, 3, 4]), { binary: true });
  await wait(200);
  check(siste(b, 'broadcast')?.active === true, 'A eier senderrollen');

  b.send(Buffer.from([5, 5, 5, 5]), { binary: true });
  await wait(200);
  check(a.lyd === 0, 'B slipper ikke til mens A eier rollen');

  // A slutter aa sende men lukker IKKE — som en maskin som sovner
  await wait(2600);
  check(siste(b, 'broadcast')?.active === false, 'rollen frigjort etter taushet');

  b.send(Buffer.from([7, 7, 7, 7]), { binary: true });
  await wait(250);
  check(a.lyd === 1, 'B kan overta, og lyden naar fram');
  a.close(); b.close();
}

console.log('\nDod forbindelse blir ryddet bort');
{
  const levende = await open();
  await wait(120);
  const f = siste(levende, 'peers')?.count ?? 0;

  // Raa sokkel: fullforer haandtrykket, men svarer aldri paa puls.
  const sock = net.connect(PORT, '127.0.0.1');
  await new Promise(r => sock.on('connect', r));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await wait(400);
  const med = siste(levende, 'peers')?.count ?? 0;
  check(med === f + 1, `den telles med til aa begynne med (${f} -> ${med})`);

  await wait(2200);
  const etter = siste(levende, 'peers')?.count ?? 0;
  check(etter === f, `pulsen river den bort igjen (${med} -> ${etter})`);
  sock.destroy(); levende.close();
}

console.log(fail ? `\n${fail} feil\n` : '\nAlt i orden\n');
process.exit(fail ? 1 : 0);
