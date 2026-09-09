// Sjekker at serveren relayer lydpakker til alle ANDRE, uendret, og at bare
// én sender slipper til om gangen.
import { WebSocket } from 'ws';
import { encodePacket, decodePacket } from '../public/stream.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok?' OK ':'FEIL'}] ${w}`); if(!ok) fail++; };

function client(name) {
  const st = { name, audio: [], broadcastMsgs: [] };
  const ws = new WebSocket('ws://127.0.0.1:8080');
  ws.binaryType = 'arraybuffer';
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Med binaryType='arraybuffer' er `raw` allerede en ArrayBuffer;
      // ellers er det en Node-Buffer som ma pakkes ut.
      st.audio.push(raw instanceof ArrayBuffer
        ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    } else {
      const m = JSON.parse(raw);
      if (m.type === 'broadcast') st.broadcastMsgs.push(m.active);
    }
  });
  st.ws = ws;
  return st;
}

const tone = new Float32Array(512);
for (let i=0;i<512;i++) tone[i] = Math.sin(2*Math.PI*440*i/48000)*0.7;

const a = client('sender'), b = client('lytter1'), c = client('lytter2');
await sleep(1200);

console.log('\n=== Sender 10 lydpakker ===');
for (let i=0;i<10;i++) {
  a.ws.send(encodePacket({ seq:i, serverTime: 1000+i*10.6666, sampleRate:48000,
    channels:2, frames:512, ch0:tone, ch1:tone }));
  await sleep(30);
}
await sleep(600);

console.log(`  lytter1 fikk ${b.audio.length}, lytter2 fikk ${c.audio.length}, sender fikk ${a.audio.length}`);
check(b.audio.length === 10 && c.audio.length === 10, 'begge lyttere fikk alle 10 pakkene');
check(a.audio.length === 0, 'senderen far ikke sin egen lyd i retur');

console.log('\n=== Innholdet er uendret ===');
{
  const p = decodePacket(b.audio[3]);
  check(p !== null, 'pakken kan dekodes');
  check(p.seq === 3, `sekvensnummer bevart (${p.seq})`);
  check(Math.abs(p.serverTime - (1000+3*10.6666)) < 1e-9, 'servertid bevart eksakt');
  let worst = 0;
  for (let i=0;i<512;i++) worst = Math.max(worst, Math.abs(p.ch0[i]-tone[i]));
  console.log(`  storste avvik i lyden: ${worst.toExponential(2)}`);
  check(worst < 4e-5, 'lyden kom uendret gjennom serveren');
}

console.log('\n=== Alle fikk beskjed om at sendingen startet ===');
check(b.broadcastMsgs[0] === true && c.broadcastMsgs[0] === true, 'lytterne varslet');

console.log('\n=== Bare én sender slipper til ===');
{
  const before = b.audio.length;
  c.ws.send(encodePacket({ seq:999, serverTime:0, sampleRate:48000,
    channels:2, frames:512, ch0:tone, ch1:tone }));
  await sleep(500);
  check(b.audio.length === before, 'pakke fra en ANNEN klient ble ikke relayet');
}

console.log('\n=== Senderen kobler fra ===');
a.ws.close();
await sleep(800);
check(b.broadcastMsgs[b.broadcastMsgs.length-1] === false, 'lytterne varslet om at sendingen stoppet');

// ...og da skal neste klient kunne overta
{
  const before = b.audio.length;
  c.ws.send(encodePacket({ seq:1, serverTime:0, sampleRate:48000,
    channels:2, frames:512, ch0:tone, ch1:tone }));
  await sleep(500);
  check(b.audio.length === before + 1, 'ny sender kan overta etterpa');
}

b.ws.close(); c.ws.close();
console.log(`\n${fail===0?'BESTATT':'FEILET'} (${fail} feil)\n`);
process.exit(fail===0?0:1);
