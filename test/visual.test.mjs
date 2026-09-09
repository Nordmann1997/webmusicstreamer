// Sjekker at bakgrunnsvisualen henter trekk fra det som FAKTISK spilles, og at
// den merker hver blokk med riktig avspillingstid. Det er den merkinga som gjor
// at bildet gaar i takt mellom enheter: alle slaar opp i lista med sin egen
// ctx.currentTime, og finner samme blokk.
import { AudioVisual } from '../public/visual.js';

let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Minimal erstatning for canvas: vi tester analysen, ikke pikslene.
const stubCanvas = () => ({
  width: 0, height: 0,
  getContext: () => new Proxy({}, { get: () => () => {} }),
});
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.innerWidth = 800; globalThis.innerHeight = 600;
globalThis.devicePixelRatio = 1;

const SR = 48000;

/** Et takt-monster: stortromme paa slaget, hi-hat paa aattendedeler, pad under. */
function drums(seconds) {
  const d = new Float32Array(Math.round(SR * seconds));
  const kicks = [], hats = [];
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    d[i] = Math.sin(2 * Math.PI * 220 * t) * 0.09 + Math.sin(2 * Math.PI * 330 * t) * 0.07;
  }
  const add = (at, fn) => {
    const s0 = Math.round(at * SR);
    for (let i = 0; i < SR * 0.4 && s0 + i < d.length; i++) d[s0 + i] += fn(i / SR);
  };
  for (let bar = 0; bar * 0.5 < seconds - 0.5; bar++) {
    const T = bar * 0.5;
    kicks.push(T); add(T, x => Math.sin(2 * Math.PI * 52 * x) * Math.exp(-x * 18) * 0.9);
    for (let k = 0; k < 4; k++) {
      const h = T + k * 0.125;
      if (h >= seconds) break;
      hats.push(h); add(h, x => (Math.random() * 2 - 1) * Math.exp(-x * 160) * 0.20);
    }
  }
  return { d, kicks, hats };
}

console.log('\nTidsmerking');
{
  const v = new AudioVisual(stubCanvas());
  const START = 12.5;                       // vilkaarlig AudioContext-tid
  const frames = 960;                       // 20 ms per pakke
  const buf = new Float32Array(frames);
  for (let p = 0; p < 50; p++) v.feed(buf, buf, SR, START + p * frames / SR);

  check(v.count === 50, `50 blokker i lista (fikk ${v.count})`);
  const first = v.qT[0];
  check(near(first, START, 1e-6), `forste blokk merket ${first.toFixed(4)}, ventet ${START}`);
  const last = v.qT[(v.head - 1 + v.cap) % v.cap];
  check(near(last, START + 49 * 0.02, 1e-6), `siste blokk merket ${last.toFixed(4)}`);

  // Oppslaget skal gi blokka som skulle spilt, ikke den nyeste vi har.
  check(v._at(START + 0.25) !== null, 'finner en blokk midt i strommen');
  const idx = v._at(START + 0.25);
  check(v.qT[idx] <= START + 0.25 && START + 0.25 - v.qT[idx] < 0.02,
        'blokka som velges er den som spilte akkurat da');
  check(v._at(START - 1) === null, 'ingen blokk for lyden har begynt');
  check(v._at(START + 100) === null, 'ingen blokk naar lista er gammel');
}

console.log('\nPakkegrenser');
{
  // Pakker er sjelden hele blokker. Filtrene og oppsamlinga maa gaa
  // sammenhengende over grensene, ellers faar man et falskt anslag i hver
  // pakkeovergang.
  const v = new AudioVisual(stubCanvas());
  const { d } = drums(4);
  let at = 0, when = 5.0;
  const sizes = [1024, 512, 1536, 960, 700];
  let si = 0;
  while (at + 2048 < d.length) {
    const n = sizes[si++ % sizes.length];
    const chunk = d.subarray(at, at + n);
    v.feed(chunk, chunk, SR, when);
    at += n; when += n / SR;
  }
  const blocks = Math.floor(at / v.block);
  check(Math.abs(v.count - Math.min(blocks, v.cap)) <= 1,
        `blokker teller opp uavhengig av pakkestorrelse (${v.count})`);

  // Tidene skal vaere jevnt fordelt, uten hopp i pakkegrensene.
  let worst = 0;
  for (let j = 1; j < 40; j++) {
    const a = v.qT[(v.head - 1 - j + v.cap * 2) % v.cap];
    const b = v.qT[(v.head - j + v.cap * 2) % v.cap];
    worst = Math.max(worst, Math.abs((b - a) - v.block / SR));
  }
  check(worst < 1e-6, `jevn avstand mellom blokker (storste avvik ${(worst*1e6).toFixed(2)} µs)`);
}

console.log('\nAnslag treffer trommene');
{
  const v = new AudioVisual(stubCanvas());
  const { d, kicks, hats } = drums(6);
  const N = 960;
  for (let at = 0; at + N < d.length; at += N) {
    const c = d.subarray(at, at + N);
    v.feed(c, c, SR, at / SR);
  }
  const peaks = (arr, thr) => {
    const out = [];
    for (let j = 1; j < v.count - 1; j++) {
      const i0 = (v.head - v.count + j - 1 + v.cap * 2) % v.cap;
      const i1 = (v.head - v.count + j + v.cap * 2) % v.cap;
      const i2 = (v.head - v.count + j + 1 + v.cap * 2) % v.cap;
      if (arr[i1] > thr && arr[i1] >= arr[i0] && arr[i1] > arr[i2]) out.push(v.qT[i1]);
    }
    return out;
  };
  const hit = (found, want) => want.filter(w => found.some(x => Math.abs(x - w) < 0.06)).length;

  const pk = peaks(v.qHK, 0.6), pa = peaks(v.qHA, 0.6);
  check(hit(pk, kicks) >= kicks.length - 2,
        `stortromme: ${hit(pk, kicks)} av ${kicks.length}`);
  const falseKick = pk.filter(x => !kicks.some(kk => Math.abs(x - kk) < 0.06)).length;
  check(falseKick <= 2, `falske stortrommer: ${falseKick}`);
  check(hit(pa, hats) >= hats.length * 0.9,
        `hi-hat: ${hit(pa, hats)} av ${hats.length}`);
}

console.log('\nStillhet');
{
  const v = new AudioVisual(stubCanvas());
  const q = new Float32Array(4800);
  for (let p = 0; p < 60; p++) v.feed(q, q, SR, p * 0.1);
  let mx = 0;
  for (let i = 0; i < v.count; i++) mx = Math.max(mx, v.qHK[i], v.qHM[i], v.qHA[i]);
  check(mx === 0, `ingen anslag i stillhet (storste ${mx})`);
}

console.log(fail === 0 ? '\nAlt gikk gjennom.\n' : `\n${fail} feil.\n`);
process.exit(fail ? 1 : 0);
