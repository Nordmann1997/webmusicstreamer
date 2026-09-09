// Kan de to enhetene klikke SAMTIDIG paa hver sin frekvens, sa vi slipper
// vekselvise takter? Da kan sokevinduet vaere bredt uten forveksling.
// Forsoket forrige gang feilet med ETT filterpol; naa har detektoren tre.
import { envelopeAt, peakTime } from '../public/detect.js';
const SR = 48000;

function addClick(buf, atSec, freq, gain=0.3) {
  const start = Math.round(atSec*SR), len = Math.round(0.025*SR);
  for (let k=0;k<len;k++){
    const t=k/SR, e=Math.min(1,t/0.002)*Math.exp(-t*140);
    if (start+k<buf.length && start+k>=0) buf[start+k]+=gain*e*Math.sin(2*Math.PI*freq*t);
  }
}
function noise(buf, amp, seed=1){let s=seed;const r=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff)*2-1;
  for(let k=0;k<buf.length;k++)buf[k]+=amp*r();}

let fail=0;
const check=(ok,w)=>{console.log(`  [${ok?' OK ':'FEIL'}] ${w}`);if(!ok)fail++;};

for (const [fa, fb] of [[900,2100],[800,2400],[1000,1600]]) {
  console.log(`\n=== ${fa} Hz mot ${fb} Hz ===`);
  let worst = 0, rejects = 0;
  for (const offset of [0, 5, 25, 60, 120, -120, 200, -200]) {
    // Bredt vindu: 900 ms, begge klikk inni, B forskjovet med `offset`
    const buf = new Float32Array(Math.round(SR*0.9));
    addClick(buf, 0.400, fa);
    addClick(buf, 0.400 + offset/1000, fb);
    noise(buf, 0.01, 3);

    const a = peakTime(envelopeAt(buf, SR, fa), SR);
    const b = peakTime(envelopeAt(buf, SR, fb), SR);
    if (!a || !b) { rejects++; console.log(`  offset ${offset}: AVVIST`); continue; }
    const err = (b.time - a.time)*1000 - offset;
    worst = Math.max(worst, Math.abs(err));
    console.log(`  offset ${String(offset).padStart(5)} ms → feil ${err.toFixed(3)} ms`);
  }
  check(rejects===0 && worst < 0.5, `${fa}/${fb}: verste feil ${worst.toFixed(3)} ms`);
}
console.log(`\n${fail===0?'BESTATT':'FEILET'} (${fail} feil)\n`);
process.exit(fail===0?0:1);
