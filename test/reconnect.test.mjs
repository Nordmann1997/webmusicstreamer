// Reproduserer feilen: etter en SERVEROMSTART sluttet lytterne aa faa lyd,
// mens senderen selv horte alt fint. To arsaker, begge testet her.
import { WebSocket } from 'ws';
import { AudioSender, encodePacket, decodePacket } from '../public/stream.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok?' OK ':'FEIL'}] ${w}`); if(!ok) fail++; };

console.log('\n=== 1. Senderen ma folge med naar socketen byttes ut ===');
{
  const mk = () => ({ readyState: 1, sent: 0, send(){ this.sent++; } });

  // Hver sender har sin EGEN socket, ellers deler de teller og testen lyver.
  const sockOld = mk();          // den som faller
  let   sockCur = mk();          // den som byttes ut ved reconnect

  const clock = { ready: true, serverTimeAt: () => 12345 };
  const ctx = { sampleRate: 48000, currentTime: 0 };

  // Slik det var FOR: socketen laast som verdi ved konstruksjon
  const before = new AudioSender(ctx, clock, sockOld, {});
  before.running = true; before.codec = 'pcm';

  // Slik det er NA: socketen hentes gjennom en funksjon
  const after = new AudioSender(ctx, clock, () => sockCur, {});
  after.running = true; after.codec = 'pcm';

  const blk = { t: 0, ch0: new Float32Array(960), ch1: new Float32Array(960) };
  before._onBlock(blk);
  after._onBlock(blk);
  check(sockOld.sent === 1 && sockCur.sent === 1, 'begge sender mens forbindelsen lever');

  // Forbindelsen faller, klienten lager en ny socket
  sockOld.readyState = 3;        // CLOSED
  sockCur.readyState = 3;
  const sockNew = mk();
  sockCur = sockNew;

  before._onBlock(blk);
  after._onBlock(blk);

  console.log(`  etter reconnect: laast referanse sendte ${sockOld.sent - 1} nye, ` +
              `funksjonsreferanse sendte ${sockNew.sent}`);
  check(sockOld.sent === 1, 'den laaste referansen sender ingenting mer — dette var feilen');
  check(sockNew.sent === 1, 'funksjonsreferansen treffer den NYE socketen');
}

console.log('\n=== 2. Takt-ID-er ma glemmes naar serveren starter paa nytt ===');
{
  // Serveren teller fra 0 ved hver oppstart. Klienten hopper over ID-er den
  // har sett for — sa uten opprydding avvises ALT etter en omstart.
  const scheduled = new Set();
  const play = (clicks) => clicks.filter(n => {
    if (scheduled.has(n)) return false;
    scheduled.add(n); return true;
  });

  const first = play([0,1,2,3,4]);
  check(first.length === 5, 'forste okt: alle fem takter spilles');

  // Serveromstart uten opprydding:
  const afterRestartNoClear = play([0,1,2,3,4]);
  check(afterRestartNoClear.length === 0, 'uten opprydding avvises ALT — dette var feilen');

  // Med opprydding, slik ws.onopen gjor det na:
  scheduled.clear();
  const afterRestartCleared = play([0,1,2,3,4]);
  check(afterRestartCleared.length === 5, 'med opprydding spilles taktene igjen');
}

console.log('\n=== 3. Ende til ende mot en ekte server som starter paa nytt ===');
{
  const tone = new Float32Array(960);
  const heard = [];
  const listener = new WebSocket('ws://127.0.0.1:8080');
  listener.binaryType = 'arraybuffer';
  listener.on('message', (raw, isBin) => { if (isBin) heard.push(raw); });

  let senderWs = new WebSocket('ws://127.0.0.1:8080');
  const clock = { ready: true, serverTimeAt: () => Date.now() % 1e6 };
  const ctx = { sampleRate: 48000, currentTime: 0 };
  const sender = new AudioSender(ctx, clock, () => senderWs, {});
  sender.running = true; sender.codec = 'pcm';

  await sleep(800);
  for (let i=0;i<5;i++) { sender._onBlock({t:0, ch0:tone, ch1:tone}); await sleep(40); }
  await sleep(300);
  const beforeCount = heard.length;
  console.log(`  for reconnect: lytteren hørte ${beforeCount} pakker`);

  // Simuler at forbindelsen faller og klienten kobler til paa nytt
  senderWs.close();
  await sleep(300);
  senderWs = new WebSocket('ws://127.0.0.1:8080');
  await sleep(800);

  for (let i=0;i<5;i++) { sender._onBlock({t:0, ch0:tone, ch1:tone}); await sleep(40); }
  await sleep(400);
  const afterCount = heard.length - beforeCount;
  console.log(`  etter reconnect: lytteren hørte ${afterCount} pakker`);

  check(beforeCount === 5, 'alle pakker kom fram for reconnect');
  check(afterCount === 5, 'alle pakker kom fram OGSA etter reconnect');

  listener.close(); senderWs.close();
}

console.log(`\n${fail===0?'BESTATT':'FEILET'} (${fail} feil)\n`);
process.exit(fail===0?0:1);
