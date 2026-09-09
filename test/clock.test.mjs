// Lydklokka maa taale BRUDD. Stopper den mens systemklokka gaar videre —
// fanestruping, bytte av utgangsenhet, Bluetooth, et oyeblikks dvale — legges
// det en knekk midt i linja som gjor hele takten feil.
import { AudioClockTracker } from '../public/sync.js';

let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };

const TRUE_PPM = 25;

function rig() {
  let p = 0, c = 0;
  const ctx = { currentTime: 0, outputLatency: 0.02,
                getOutputTimestamp: () => ({ performanceTime: p, contextTime: c / 1000 }) };
  const tr = new AudioClockTracker(ctx);
  return {
    tr,
    tick(ms = 250) { p += ms; c += ms * (1 + TRUE_PPM / 1e6); ctx.currentTime = c / 1000 + 0.05; tr.sample(); },
    run(sec) { for (let i = 0; i < sec * 4; i++) this.tick(); },
    stall(sec) { p += sec * 1000; ctx.currentTime = c / 1000 + 0.05; tr.sample(); },
    get p() { return p; },
  };
}

console.log('\nVanlig drift');
{
  const r = rig();
  r.run(90);
  check(Math.abs(r.tr.driftPpm - TRUE_PPM) < 0.5,
        `takt ${r.tr.driftPpm.toFixed(2)} ppm, sant ${TRUE_PPM}`);
  check(r.tr.resets === 0, `ingen falske brudd paa 90 s (${r.tr.resets})`);
  check(r.tr.ready, 'klar');
}

console.log('\nBrudd av ulik lengde');
for (const stall of [0.2, 0.5, 1, 3, 10, 60]) {
  const r = rig();
  r.run(60);
  const before = r.tr.driftPpm;
  r.stall(stall);
  r.run(20);
  const feilPerMin = Math.abs(r.tr.driftPpm - TRUE_PPM) * 60 / 1000;
  check(feilPerMin < 1 && r.tr.resets === 1,
        `stans ${String(stall).padStart(4)} s: ${before.toFixed(1)} → ${r.tr.driftPpm.toFixed(1)} ppm, ` +
        `${feilPerMin.toFixed(2)} ms feil per minutt, ${r.tr.resets} brudd`);
}

console.log('\nHvor fort er den brukbar igjen');
{
  const r = rig();
  r.run(60);
  r.stall(2);
  check(!r.tr.ready, 'ikke klar rett etter bruddet — sier fra i stedet for aa gjette');
  let n = 0;
  while (!r.tr.ready && n < 40) { r.tick(); n++; }
  check(r.tr.ready && n <= 8, `klar igjen etter ${n} malinger (${(n * 0.25).toFixed(2)} s)`);
}

console.log('\nOffset stemmer etter bruddet');
{
  const r = rig();
  r.run(60);
  r.stall(5);
  r.run(10);
  // contextTimeAt(naa) skal treffe den ekte lydklokka
  const sant = (r.tr.samples[r.tr.samples.length - 1].c) / 1000;
  const est = r.tr.contextTimeAt(r.p);
  check(Math.abs(est - sant) * 1000 < 2,
        `contextTimeAt bommer med ${(Math.abs(est - sant) * 1000).toFixed(2)} ms`);
}

console.log('\nStoy skal IKKE utlose brudd');
{
  const r = rig();
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let p = 0, c = 0;
  const ctx = { currentTime: 0, outputLatency: 0.02,
                getOutputTimestamp: () => ({ performanceTime: p, contextTime: c / 1000 }) };
  const tr = new AudioClockTracker(ctx);
  for (let i = 0; i < 4 * 120; i++) {
    p += 250;
    // trinnstoy: lydklokka oppdateres i kvanter, opptil ~12 ms
    c = p * (1 + TRUE_PPM / 1e6) - rnd() * 12;
    ctx.currentTime = c / 1000 + 0.05;
    tr.sample();
  }
  check(tr.resets === 0, `ingen brudd av 12 ms trinnstoy over to minutter (${tr.resets})`);
  check(Math.abs(tr.driftPpm - TRUE_PPM) < 5, `takt ${tr.driftPpm.toFixed(1)} ppm tross stoy`);
}

console.log(fail === 0 ? '\nAlt gikk gjennom.\n' : `\n${fail} feil.\n`);
process.exit(fail ? 1 : 0);
