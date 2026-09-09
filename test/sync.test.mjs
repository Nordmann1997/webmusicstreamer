// Verifiserer offset-estimatoren mot simulerte klokker med kjent sannhet.
// Kjor: node test/sync.test.mjs
import { ClockSync } from '../public/sync.js';

let failures = 0;
const check = (ok, what) => {
  console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${what}`);
  if (!ok) failures++;
};

/**
 * Simulerer en klient med:
 *   offset0  — hvor mye klienten ligger foran/bak serveren ved start (ms)
 *   skewPpm  — hvor mye raskere/saktere klientens krystall gar
 *   upMs/downMs — grunnforsinkelse hver vei
 *   jitterMs — tilfeldig ekstra koforsinkelse (bare positiv, som i ekte nett)
 */
function simulate({ offset0, skewPpm, upMs, downMs, jitterMs, exchanges = 60, seed = 1 }) {
  // Deterministisk pseudo-tilfeldighet, sa testen ikke flakker
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const cs = new ClockSync({ windowMs: 60000, keepBest: 8 });

  // sann servertid -> klientens lokale klokke
  const toLocal = (server) => (server - offset0) * (1 + skewPpm / 1e6);

  let serverTime = 1000;
  const truth = [];

  for (let i = 0; i < exchanges; i++) {
    serverTime += 500;                                  // en utveksling hvert halve sekund

    const up   = upMs   + rand() * jitterMs;
    const down = downMs + rand() * jitterMs;

    const t1 = toLocal(serverTime);                     // klient sender
    const t2 = serverTime + up;                         // server mottar
    const t3 = t2 + 0.1;                                // server svarer
    const t4 = toLocal(t3 + down);                      // klient mottar

    cs.addExchange(t1, t2, t3, t4);
    truth.push({ local: t4, server: t3 + down });
  }
  return { cs, truth, toLocal };
}

console.log('\n=== 1. Ideelt nett: gjenfinner offset og skew eksakt ===');
{
  const { cs, truth } = simulate({ offset0: 12345.6, skewPpm: 40, upMs: 5, downMs: 5, jitterMs: 0 });
  const last = truth[truth.length - 1];
  const err = cs.serverTimeAt(last.local) - last.server;
  // Konvensjon: positiv skewPpm = klientens klokke gaar for fort.
  console.log(`  estimert skew = ${cs.skewPpm.toFixed(1)} ppm (sann +40, klient gaar fort)`);
  console.log(`  feil i tidsestimat = ${err.toFixed(4)} ms`);
  check(Math.abs(err) < 0.05, 'tidsestimat innenfor 0,05 ms');
  check(Math.abs(cs.skewPpm - 40) < 5, 'skew estimert innenfor 5 ppm');
}

console.log('\n=== 2. Realistisk WiFi: 8 ms grunn, opptil 40 ms tilfeldig ko ===');
{
  const { cs, truth } = simulate({ offset0: -800.25, skewPpm: -25, upMs: 8, downMs: 8, jitterMs: 40 });
  const last = truth[truth.length - 1];
  const err = cs.serverTimeAt(last.local) - last.server;
  console.log(`  min-RTT = ${cs.minRtt.toFixed(2)} ms, usikkerhet ~${cs.uncertaintyMs.toFixed(2)} ms`);
  console.log(`  feil i tidsestimat = ${err.toFixed(3)} ms`);
  check(Math.abs(err) < 5, 'feil under 5 ms tross 40 ms jitter');
}

console.log('\n=== 3. Min-RTT-utvalg slaar naivt gjennomsnitt ===');
{
  const cfg = { offset0: 500, skewPpm: 0, upMs: 5, downMs: 5, jitterMs: 60, exchanges: 80 };
  const { cs, truth } = simulate(cfg);
  const last = truth[truth.length - 1];
  const minRttErr = Math.abs(cs.serverTimeAt(last.local) - last.server);

  // Samme malinger, men gjennomsnitt av ALLE
  const avgOffset = cs.samples.reduce((a, s) => a + s.offset, 0) / cs.samples.length;
  const avgErr = Math.abs((last.local + avgOffset) - last.server);

  console.log(`  min-RTT-utvalg: ${minRttErr.toFixed(2)} ms feil`);
  console.log(`  snitt av alle:  ${avgErr.toFixed(2)} ms feil`);
  check(minRttErr < avgErr, 'min-RTT gir mindre feil enn gjennomsnitt');
}

console.log('\n=== 4. Konstant baneasymmetri: den kjente grensa ===');
{
  // 30 ms opp, 6 ms ned. Teorien sier bias = (30-6)/2 = 12 ms, og den er
  // IKKE mulig a fjerne uten a vite noe ekstra om banen.
  const { cs, truth } = simulate({ offset0: 0, skewPpm: 0, upMs: 30, downMs: 6, jitterMs: 2 });
  const last = truth[truth.length - 1];
  const err = cs.serverTimeAt(last.local) - last.server;
  console.log(`  malt bias = ${err.toFixed(2)} ms (teoretisk (30-6)/2 = 12 ms)`);
  check(Math.abs(err - 12) < 2, 'bias er som teorien forutsier');
  console.log('  MERK: like klienter pa samme nett far LIKT bias, sa den');
  console.log('        forskyver alle likt og pavirker ikke innbyrdes synk.');
}

console.log('\n=== 5. To klienter pa samme nett: innbyrdes avvik ===');
{
  // Det er DETTE tallet som avgjor om det later bra i et rom.
  const a = simulate({ offset0:  4000, skewPpm:  35, upMs: 7, downMs: 7, jitterMs: 30, seed: 7 });
  const b = simulate({ offset0: -9000, skewPpm: -50, upMs: 9, downMs: 9, jitterMs: 30, seed: 99 });

  // Begge skal spille en tone pa samme servertid
  const targetServer = 25000;
  const localA = a.cs.localTimeAt(targetServer);
  const localB = b.cs.localTimeAt(targetServer);

  // Naar traff de egentlig, malt i sann servertid?
  const trueServerA = localA / (1 + 35 / 1e6) + 4000;
  const trueServerB = localB / (1 - 50 / 1e6) - 9000;
  const spread = Math.abs(trueServerA - trueServerB);

  console.log(`  innbyrdes avvik = ${spread.toFixed(2)} ms  (budsjett: 20 ms)`);
  check(spread < 20, 'to klienter innenfor 20 ms av hverandre');
}

console.log('\n=== 6. Estimatet holder seg mellom malingene ===');
{
  const { cs, truth, toLocal } = simulate({ offset0: 100, skewPpm: 60, upMs: 5, downMs: 5, jitterMs: 10 });
  // Ekstrapoler 10 sekunder forbi siste maling
  const futureServer = 1000 + 60 * 500 + 10000;
  const futureLocal  = toLocal(futureServer);
  const err = cs.serverTimeAt(futureLocal) - futureServer;
  console.log(`  feil 10 s etter siste maling = ${err.toFixed(2)} ms`);
  check(Math.abs(err) < 5, 'ekstrapolerer 10 s uten a lope lopsk');
}

console.log('\n=== 7. Fortegn paa manuell justering: positiv = SENERE ===');
{
  const { SyncedPlayer } = await import('../public/sync.js');

  // Falsk AudioContext og lydklokke, sa vi kan teste ren tidsregning
  const fakeCtx   = { currentTime: 0, outputLatency: 0 };
  const fakeClock = { ready: true, localTimeAt: (s) => s };            // 1:1
  const fakeAudio = { ready: true, contextTimeAt: (p) => p / 1000 };   // ms -> s

  const p = new SyncedPlayer(fakeCtx, fakeClock, fakeAudio);

  p.manualOffsetMs = 0;
  const base = p.scheduleTimeFor(10000);

  p.manualOffsetMs = 100;      // 100 ms forsinkelse
  const later = p.scheduleTimeFor(10000);

  p.manualOffsetMs = -100;
  const earlier = p.scheduleTimeFor(10000);

  console.log(`  0 ms → ${base.toFixed(3)} s, +100 ms → ${later.toFixed(3)} s, -100 ms → ${earlier.toFixed(3)} s`);
  check(Math.abs((later - base) - 0.1) < 1e-9,   'positiv justering spiller 100 ms SENERE');
  check(Math.abs((earlier - base) + 0.1) < 1e-9, 'negativ justering spiller 100 ms TIDLIGERE');
}

console.log(`\n${failures === 0 ? 'ALLE TESTER BESTATT' : 'TESTER FEILET'}  (${failures} feil)\n`);
process.exit(failures === 0 ? 0 : 1);
