// Verifiserer at lydpakkene overlever koding og dekoding uendret.
import { encodePacket, decodePacket, HEADER_BYTES, PlaybackTimeline } from '../public/stream.js';

let fail = 0;
const check = (ok, w) => { console.log(`  [${ok?' OK ':'FEIL'}] ${w}`); if(!ok) fail++; };

function makeBlock(n, fn) { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=fn(i); return a; }

console.log('\n=== 1. Rundtur med ekte lydinnhold ===');
{
  const frames = 1024;
  const ch0 = makeBlock(frames, i => Math.sin(2*Math.PI*440*i/48000) * 0.8);
  const ch1 = makeBlock(frames, i => Math.sin(2*Math.PI*660*i/48000) * 0.5);

  const buf = encodePacket({ seq: 12345, serverTime: 1699999999.5,
    sampleRate: 48000, channels: 2, frames, ch0, ch1 });
  const p = decodePacket(buf);

  console.log(`  pakkestorrelse ${buf.byteLength} bytes (${HEADER_BYTES} header + ${frames}×2×2)`);
  check(buf.byteLength === HEADER_BYTES + frames*2*2, 'riktig storrelse');
  check(p.seq === 12345, 'sekvensnummer bevart');
  check(p.serverTime === 1699999999.5, 'servertid bevart med desimaler');
  check(p.sampleRate === 48000 && p.channels === 2 && p.frames === frames, 'header bevart');

  let worst = 0;
  for (let i=0;i<frames;i++) {
    worst = Math.max(worst, Math.abs(p.ch0[i]-ch0[i]), Math.abs(p.ch1[i]-ch1[i]));
  }
  console.log(`  storste avvik etter 16-bits kvantisering: ${worst.toExponential(2)}`);
  check(worst < 4e-5, 'lyden er bevart innenfor 16-bits opplosning');
}

console.log('\n=== 2. Servertid maa ha nok presisjon ===');
{
  // Servertid kan vaere hundretusener av ms. Float32 ville mistet
  // brokdelen helt — derfor float64 i headeren.
  for (const t of [0.5, 12345.678, 987654321.125, 1e9 + 0.0625]) {
    const buf = encodePacket({ seq:0, serverTime:t, sampleRate:48000,
      channels:2, frames:2, ch0:new Float32Array(2), ch1:new Float32Array(2) });
    const got = decodePacket(buf).serverTime;
    check(got === t, `servertid ${t} bevart eksakt (fikk ${got})`);
  }
}

console.log('\n=== 3. Klipping i stedet for overfoldning ===');
{
  // Uten klipping folder verdier over 1.0 rundt til motsatt fortegn.
  // Det hores som kraftig forvrengning, ikke som litt for hoyt.
  const ch0 = Float32Array.from([1.5, -1.5, 3.0, -3.0, 0.5]);
  const buf = encodePacket({ seq:0, serverTime:0, sampleRate:48000,
    channels:2, frames:5, ch0, ch1:ch0 });
  const p = decodePacket(buf);
  console.log(`  inn [${[...ch0]}] → ut [${[...p.ch0].map(v=>v.toFixed(3))}]`);
  check(p.ch0[0] > 0.99 && p.ch0[1] < -0.99, 'over 1.0 klippes, ikke folder rundt');
  check(p.ch0[2] > 0.99 && p.ch0[3] < -0.99, 'langt over 1.0 klippes ogsa');
  check(Math.abs(p.ch0[4] - 0.5) < 1e-4, 'normale verdier upaavirket');
}

console.log('\n=== 4. Mono blir til stereo ===');
{
  const ch0 = makeBlock(64, i => i/64 - 0.5);
  const buf = encodePacket({ seq:0, serverTime:0, sampleRate:44100,
    channels:1, frames:64, ch0, ch1:ch0 });
  const p = decodePacket(buf);
  check(p.channels === 1 && p.frames === 64, 'mono-header');
  check(p.ch1.every((v,i) => v === p.ch0[i]), 'hoyre kanal duplisert fra venstre');
  check(buf.byteLength === HEADER_BYTES + 64*2, 'mono bruker halve datamengden');
}

console.log('\n=== 5. Avviser sopp i stedet for aa spille det ===');
{
  check(decodePacket(new ArrayBuffer(8)) === null, 'for kort pakke avvist');
  const bad = new ArrayBuffer(HEADER_BYTES + 100);
  new DataView(bad).setUint32(0, 0xDEADBEEF, true);
  check(decodePacket(bad) === null, 'feil magic avvist');
  const trunc = new ArrayBuffer(HEADER_BYTES + 10);
  const dv = new DataView(trunc);
  dv.setUint32(0, 0x41554449, true); dv.setUint16(20, 2, true); dv.setUint16(22, 1024, true);
  check(decodePacket(trunc) === null, 'avkortet pakke avvist (lover 1024 frames, har 10 bytes)');
}

console.log('\n=== 6. Baandbredde ===');
{
  const perSec = 48000/1024;
  const bytes = (HEADER_BYTES + 1024*2*2) * perSec;
  console.log(`  ${(bytes*8/1e6).toFixed(2)} Mbit/s per lytter ved 48 kHz stereo`);
  check(bytes*8/1e6 < 2, 'under 2 Mbit/s — greit paa LAN');
}

console.log('\n=== 7. Avspillingen skal vaere SAMMENHENGENDE ===');
{
  // Dette er skurringen. Det felles tidsestimatet beveger seg litt hele tida,
  // sa "riktig" tidspunkt for hver pakke skjelver med noen brokdels ms.
  // Planlegger man hver pakke for seg, blir det et hull eller en overlapp i
  // HVER pakkegrense — 47 knepp i sekundet.
  const dur = 1024 / 48000;                 // 21,33 ms per pakke
  const tl = new PlaybackTimeline();
  let now = 0, target = 1.0;
  const whens = [];
  let s2 = 5;
  const jitter = () => ((s2 = (s2*1103515245+12345) & 0x7fffffff)/0x7fffffff - 0.5) * 0.003; // ±1,5 ms

  const spots = [];
  for (let i = 0; i < 200; i++) {
    const spot = tl.place(target + jitter(), 1024, 48000, now);
    if (spot) { whens.push(spot.when); spots.push(spot); }
    target += dur;
    now += dur;
  }

  // Pakkene kan bli ett sample kortere eller lengre naar drift korrigeres, sa
  // invarianten er at neste pakke starter der forrige FAKTISK slutter.
  let worstGap = 0;
  for (let i = 1; i < whens.length; i++) {
    const actualDur = (1024 - spots[i-1].correction) / 48000;
    worstGap = Math.max(worstGap, Math.abs((whens[i] - whens[i-1]) - actualDur));
  }
  const corrections = spots.reduce((a, s) => a + Math.abs(s.correction), 0);
  console.log(`  ${whens.length} pakker, storste avvik fra perfekt skjot: ${(worstGap*1e6).toFixed(3)} µs`);
  console.log(`  resynkroniseringer: ${tl.resyncs - 1}, samples rettet: ${corrections}`);
  check(worstGap < 1e-9, 'pakkene skjotes eksakt — ingen hull, ingen overlapp');
  check(tl.resyncs - 1 === 0, 'ingen unodvendig resynkronisering ved smaa skjelvinger');
  check(corrections < 10, 'nesten ingen korreksjon naar det bare er stoy uten drift');
}

console.log('\n=== 8. ...men den skal folge etter ved EKTE forskyvning ===');
{
  const dur = 1024 / 48000;
  const tl = new PlaybackTimeline({ resyncSec: 0.030 });
  let now = 0, target = 1.0;
  for (let i = 0; i < 20; i++) { tl.place(target, 1024, 48000, now); target += dur; now += dur; }
  const before = tl.resyncs;

  target += 0.5;                            // 500 ms hopp — senderen startet paa nytt
  const spot = tl.place(target, 1024, 48000, now);
  console.log(`  etter 500 ms hopp: resynkroniserte = ${tl.resyncs > before}`);
  check(tl.resyncs > before, 'stort hopp gir resynkronisering');
  check(Math.abs(spot.when - target) < 1e-9, 'og lander paa det nye tidspunktet');
}

console.log('\n=== 9. For sen pakke kastes, den spilles ikke bakover ===');
{
  const tl = new PlaybackTimeline();
  const r = tl.place(0.5, 1024, 48000, 1.0);       // onsket tid 0,5 s, men klokka er 1,0
  console.log(`  onsket 0,5 s mens ctx.currentTime er 1,0 s → ${r === null ? 'kastet' : 'planlagt (feil!)'}`);
  check(r === null && tl.late === 1, 'for sen pakke kastes og telles');
}

console.log(`\n${fail===0?'ALLE TESTER BESTATT':'TESTER FEILET'}  (${fail} feil)\n`);
process.exit(fail===0?0:1);
