// ClockSync maa vaere noyaktig paa et urolig nett OG taale at serveren
// starter paa nytt. Serveren teller fra null hver gang, saa etter en omstart
// er hver eneste gamle maling feil med hele oppetida til den forrige.
import { ClockSync } from '../public/sync.js';

let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };

function nett(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** Kjorer `sek` sekunder med en maling i sekundet. */
function kjor(clock, { jitterMs, skewPpm, minutter, seed, offsetVed = () => 12345.6, fra = 0 }) {
  const rnd = nett(seed);
  let p = fra;
  const feil = [];
  for (let i = 0; i < minutter * 60; i++) {
    p += 1000;
    const t1 = p;
    const opp = 0.4 + jitterMs * Math.pow(rnd(), 3);
    const ned = 0.4 + jitterMs * Math.pow(rnd(), 3);
    const sant = (loc) => loc * (1 - skewPpm / 1e6) + offsetVed(loc);
    const t2 = sant(t1 + opp), t3 = t2 + 0.05;
    const t4 = t1 + opp + 0.05 + ned;
    clock.addExchange(t1, t2, t3, t4);
    if (i > 40) feil.push(Math.abs(clock.serverTimeAt(t4 + 1000) - sant(t4 + 1000)));
  }
  feil.sort((a, b) => a - b);
  return { p, median: feil[feil.length >> 1] || 0, verst: feil[feil.length - 1] || 0,
           p95: feil[Math.floor(feil.length * 0.95)] || 0 };
}

console.log('\nNoyaktighet under stoy');
for (const [navn, jitter, tak] of [['kablet, 1 ms ko', 1, 0.5],
                                   ['wifi, 15 ms ko', 15, 1.5],
                                   ['skolenett, 60 ms ko', 60, 4.0]]) {
  const c = new ClockSync();
  const r = kjor(c, { jitterMs: jitter, skewPpm: 20, minutter: 20, seed: 7 });
  check(r.verst < tak,
        `${navn.padEnd(21)} median ${r.median.toFixed(2)} ms · verst ${r.verst.toFixed(2)} ms (tak ${tak})`);
  check(Math.abs(c.skewPpm - 20) < 6, `  takt ${c.skewPpm.toFixed(1)} ppm, sant 20`);
}

console.log('\nServeren starter paa nytt');
{
  const c = new ClockSync();
  kjor(c, { jitterMs: 5, skewPpm: 20, minutter: 5, seed: 3 });
  const forSprang = c.ready;
  // Ny server: klokka begynner paa null igjen, altsa et sprang paa 300 000 ms
  const r = kjor(c, { jitterMs: 5, skewPpm: 20, minutter: 2, seed: 4, fra: 300000,
                      offsetVed: () => 12345.6 - 300000 });
  check(forSprang, 'klar for spranget');
  check(c.steps === 1, `spranget oppdaget (${c.steps})`);
  check(r.verst < 2, `og estimatet er friskt etterpaa: verst ${r.verst.toFixed(2)} ms`);
}

console.log('\nEn enkelt daarlig maling skal IKKE nullstille');
{
  const c = new ClockSync();
  kjor(c, { jitterMs: 5, skewPpm: 20, minutter: 5, seed: 9 });
  const p = 300000;
  // en utveksling med en halv sekunds ko den ene veien
  c.addExchange(p, p * (1 - 20e-6) + 12345.6 + 500, p * (1 - 20e-6) + 12345.6 + 500.05, p + 1000);
  check(c.steps === 0, `ingen nullstilling av ett utslag (${c.steps})`);
  check(c.ready, 'fortsatt klar');
}

console.log('\nreset() toemmer alt');
{
  const c = new ClockSync();
  kjor(c, { jitterMs: 5, skewPpm: 20, minutter: 3, seed: 11 });
  c.reset();
  check(!c.ready && c.samples.length === 0, 'tom og ikke klar etter reset');
}

console.log(fail === 0 ? '\nAlt gikk gjennom.\n' : `\n${fail} feil.\n`);
process.exit(fail ? 1 : 0);
