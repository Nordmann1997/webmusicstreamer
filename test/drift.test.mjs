// Simulerer en mottaker med lydkort som gar litt for fort/sakte, og sjekker at
// driftkorreksjonen holder avviket nede uten aa bryte tidslinja.
import { DriftCorrector, applySampleCorrection } from '../public/drift.js';

let fail = 0;
const check = (ok, w) => { console.log(`  [${ok?' OK ':'FEIL'}] ${w}`); if(!ok) fail++; };
const SR = 48000, FRAMES = 1024;
const PACKET_SEC = FRAMES / SR;

/**
 * Kjorer `sekunder` med lyd gjennom korrigereren.
 * driftPpm > 0: mottakerens lydkort gar for FORT, sa den tommer bufferet og
 * havner for tidlig ute — feilen blir negativ uten korreksjon.
 */
function run(driftPpm, seconds, { correct = true } = {}) {
  const dc = new DriftCorrector();
  let error = 0;             // sekunder vi ligger for sent (positivt = henger etter)
  let worst = 0, totalCorrected = 0;
  const packets = Math.round(seconds / PACKET_SEC);

  for (let i = 0; i < packets; i++) {
    // Klokkeforskjellen samler seg opp for hver pakke
    error += -driftPpm / 1e6 * PACKET_SEC;

    if (correct) {
      const n = dc.update(error, FRAMES, SR);
      // Aa fjerne n samples betyr at vi hopper framover i innholdet, altsa
      // TAR IGJEN etterslepet. Etterslepet minker.
      error -= n / SR;
      totalCorrected += Math.abs(n);
    }
    if (i > packets * 0.2) worst = Math.max(worst, Math.abs(error));  // hopp over innsvinging
  }
  return { worst, totalCorrected, dc, finalError: error };
}

console.log('\n=== 1. Uten korreksjon vokser avviket ubegrenset ===');
{
  const r = run(30, 600, { correct: false });   // 30 ppm, 10 minutter
  console.log(`  etter 10 min: ${(r.finalError*1000).toFixed(1)} ms`);
  check(Math.abs(r.finalError*1000) > 15, 'avviket passerer 15 ms uten korreksjon');
}

console.log('\n=== 2. Med korreksjon holder det seg lite ===');
for (const ppm of [10, 30, 50, -30, -80]) {
  const r = run(ppm, 600);
  console.log(`  ${String(ppm).padStart(4)} ppm i 10 min → verste avvik ${(r.worst*1000).toFixed(3)} ms, ` +
              `${r.totalCorrected} samples rettet`);
  check(r.worst * 1000 < 2, `${ppm} ppm holdes under 2 ms`);
}

console.log('\n=== 3. Korreksjonen overstiger aldri taket (0,05 %) ===');
{
  // Per pakke ma korreksjonen vaere et helt antall samples, sa den veksler
  // mellom 0 og 1. Det er SNITTET over tid som er den faktiske hastigheten.
  const dc = new DriftCorrector();
  let total = 0, maxPerPacket = 0;
  const packets = 2000;
  for (let i = 0; i < packets; i++) {
    const n = dc.update(1.0, FRAMES, SR);      // absurd stor feil: 1 sekund
    total += Math.abs(n);
    maxPerPacket = Math.max(maxPerPacket, Math.abs(n));
  }
  const avgRatio = total / (packets * FRAMES);
  console.log(`  snitt ${(avgRatio*100).toFixed(4)} % (maks ${maxPerPacket} sample i én pakke)`);
  check(avgRatio <= 0.0005 * 1.02, 'gjennomsnittlig korreksjonstakt innenfor 0,05 %');
  check(maxPerPacket <= 1, 'aldri mer enn ett sample om gangen');
}

console.log('\n=== 4. Tar ikke av paa nettverksstoy ===');
{
  // Ingen ekte drift, bare ±3 ms tilfeldig svingning i malingen.
  const dc = new DriftCorrector();
  let s = 3; const rnd = () => ((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff-0.5)*0.006;
  let total = 0;
  for (let i = 0; i < 2000; i++) total += Math.abs(dc.update(rnd(), FRAMES, SR));
  const perSec = total / (2000 * PACKET_SEC);
  console.log(`  ${total} samples rettet paa ${(2000*PACKET_SEC).toFixed(0)} s = ${perSec.toFixed(1)}/s`);
  check(perSec < 5, 'lar seg ikke rive med av stoy uten ekte drift');
}

console.log('\n=== 5. Sampledropp bevarer lyden ===');
{
  const n = 512;
  const ch0 = Float32Array.from({length:n}, (_,i) => Math.sin(2*Math.PI*440*i/SR));
  const ch1 = Float32Array.from({length:n}, (_,i) => Math.cos(2*Math.PI*440*i/SR));

  for (const drop of [1, 2, 5]) {
    const r = applySampleCorrection(ch0, ch1, drop);
    check(r.frames === n - drop, `dropp ${drop}: lengde ${r.frames} (ventet ${n-drop})`);
    // Storste sprang mellom nabosamples skal ikke bli dramatisk storre
    let maxJump = 0;
    for (let i=1;i<r.frames;i++) maxJump = Math.max(maxJump, Math.abs(r.ch0[i]-r.ch0[i-1]));
    let origJump = 0;
    for (let i=1;i<n;i++) origJump = Math.max(origJump, Math.abs(ch0[i]-ch0[i-1]));
    check(maxJump < origJump * 3, `dropp ${drop}: ingen stygt sprang (${maxJump.toExponential(1)} mot ${origJump.toExponential(1)})`);
  }

  for (const dup of [1, 3]) {
    const r = applySampleCorrection(ch0, ch1, -dup);
    check(r.frames === n + dup, `duplisering ${dup}: lengde ${r.frames} (ventet ${n+dup})`);
  }

  const same = applySampleCorrection(ch0, ch1, 0);
  check(same.ch0 === ch0 && same.frames === n, 'n=0 gir samme array tilbake, ingen kopiering');
}

console.log('\n=== 6. Hvor lenge holder det? ===');
{
  const r = run(50, 3600);      // 50 ppm i en TIME
  console.log(`  50 ppm i 1 time → verste avvik ${(r.worst*1000).toFixed(3)} ms, ` +
              `${r.totalCorrected} samples rettet (${(r.totalCorrected/3600).toFixed(1)}/s)`);
  check(r.worst*1000 < 2, 'holder seg under 2 ms gjennom en hel time');
}

console.log(`\n${fail===0?'ALLE TESTER BESTATT':'TESTER FEILET'}  (${fail} feil)\n`);
process.exit(fail===0?0:1);
