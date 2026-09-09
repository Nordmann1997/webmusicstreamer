// Verifiserer klikk-deteksjonen mot syntetiske opptak med kjent fasit.
import { envelopeAt, peakTime, findClick } from '../public/detect.js';

let fail = 0;
const check = (ok, what) => { console.log(`  [${ok?' OK ':'FEIL'}] ${what}`); if(!ok) fail++; };
const SR = 48000, FREQ = 1200;

// Samme bolgeform som sync.js faktisk spiller: rask attack, eksponentiell hale.
function addClick(buf, sr, atSec, freq, gain = 0.3, durMs = 25) {
  const start = Math.round(atSec * sr), len = Math.round(durMs/1000*sr);
  for (let k = 0; k < len; k++) {
    const t = k / sr;
    const env = Math.min(1, t/0.002) * Math.exp(-t*140);
    if (start+k < buf.length && start+k >= 0) buf[start+k] += gain*env*Math.sin(2*Math.PI*freq*t);
  }
}
function noise(buf, amp, seed=1) {
  let s = seed;
  const r = () => ((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff)*2-1;
  for (let k=0;k<buf.length;k++) buf[k] += amp*r();
}
// Ett opptaksvindu med ett klikk lagt `offsetMs` fra vinduets forventede punkt.
function window_(offsetMs, {gain=0.3, noiseAmp=0, seed=1} = {}) {
  const buf = new Float32Array(Math.round(SR*0.25));   // 250 ms vindu
  addClick(buf, SR, 0.100 + offsetMs/1000, FREQ, gain);  // forventet paa 100 ms
  if (noiseAmp) noise(buf, noiseAmp, seed);
  return buf;
}

console.log('\n=== 1. Biaset fra filteret er konstant (det er det som lar oss maale) ===');
{
  const times = [0.1, 0.3, 0.5].map(g => findClick(window_(0, {gain:g}), SR, FREQ).time*1000);
  console.log(`  ved gain 0,1 / 0,3 / 0,5:  ${times.map(t=>t.toFixed(3)).join(' / ')} ms`);
  const spread = Math.max(...times) - Math.min(...times);
  console.log(`  spredning = ${spread.toFixed(3)} ms`);
  check(spread < 0.1, 'toppunktet flytter seg ikke med niva');
}

console.log('\n=== 2. Differanse mellom to enheter (vekselvise takter) ===');
for (const truth of [0, 1.5, 2.5, -4, 8, 17.3, -11, 25]) {
  const a = findClick(window_(0),     SR, FREQ);
  const b = findClick(window_(truth), SR, FREQ);
  const measured = (b.time - a.time) * 1000;
  const err = measured - truth;
  console.log(`  fasit ${String(truth).padStart(6)} ms  →  malt ${measured.toFixed(3)} ms  (feil ${err.toFixed(3)})`);
  check(Math.abs(err) < 0.2, `${truth} ms gjenfunnet innenfor 0,2 ms`);
}

console.log('\n=== 3. Romstoy ===');
for (const amp of [0.005, 0.02, 0.05, 0.1]) {
  const a = findClick(window_(0,   {noiseAmp:amp, seed:11}), SR, FREQ);
  const b = findClick(window_(9.4, {noiseAmp:amp, seed:77}), SR, FREQ);
  if (!a || !b) { console.log(`  stoy ${amp}: avvist`); check(false, `stoy ${amp}`); continue; }
  const err = (b.time-a.time)*1000 - 9.4;
  console.log(`  stoy ${String(amp).padEnd(6)} → feil ${err.toFixed(3)} ms  (SNR-forhold ${a.ratio.toFixed(0)})`);
  check(Math.abs(err) < 0.5, `stoy ${amp}: innenfor 0,5 ms`);
}

console.log('\n=== 4. Avviser i stedet for aa gjette ===');
{
  for (const [amp, seed] of [[0.01,7],[0.05,21],[0.2,99]]) {
    const buf = new Float32Array(Math.round(SR*0.25));
    noise(buf, amp, seed);
    const r = findClick(buf, SR, FREQ);
    console.log(`  bare stoy (${amp}) → ${r ? 'GODTATT, forhold '+r.ratio.toFixed(1)+' (feil!)' : 'avvist'}`);
    check(r === null, `stoy ${amp} avvist`);
  }
  // ...men et svakt ekte klikk skal fortsatt godtas
  const weak = findClick(window_(0, {gain:0.03, noiseAmp:0.01, seed:5}), SR, FREQ);
  console.log(`  svakt klikk (gain 0,03 i stoy 0,01) → ${weak ? 'godtatt, forhold '+weak.ratio.toFixed(1) : 'AVVIST (for strengt)'}`);
  check(weak !== null, 'svakt men ekte klikk godtas');
}

console.log(`\n${fail===0?'ALLE TESTER BESTATT':'TESTER FEILET'}  (${fail} feil)\n`);
process.exit(fail===0?0:1);
