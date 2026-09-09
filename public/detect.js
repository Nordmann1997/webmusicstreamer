// ============================================================================
//  detect.js — finner naar et klikk faktisk kom ut av hoyttaleren.
//
//  Enhetene klikker ANNENHVER takt paa samme frekvens, ikke samtidig paa hver
//  sin. Da slipper vi at de to tonene lekker inn i hverandres demodulator, og
//  hvert klikk faar hele signal/stoy-forholdet for seg selv. Klikkene ligger
//  ett sekund fra hverandre, sa klokkedrift mellom dem er ~0,05 ms — langt
//  under det vi prover aa maale.
//
//  Metode: kompleks demodulasjon rundt baerefrekvensen gir en glatt innhylling,
//  og toppen finnes med parabolsk interpolasjon (opplosning under ett sample).
//  Vi maler TOPPEN, ikke anslaget: anslaget er uskarpt fordi filteret har
//  stigetid, mens toppen er skarpt definert. Filterets egen forsinkelse er
//  identisk for begge enheter og forsvinner i differansen.
// ============================================================================

/**
 * Innhylling i et smalt baand rundt f0.
 * `poles` kaskaderte enpolsfiltre gir 6·poles dB/oktav — nok demping til at
 * romstoy og naboharmoniske ikke drar toppen ut av posisjon.
 */
export function envelopeAt(samples, sampleRate, f0, { lpHz = 100, poles = 3 } = {}) {
  const n = samples.length;
  const env = new Float32Array(n);
  const w = 2 * Math.PI * f0 / sampleRate;
  const alpha = 1 - Math.exp(-2 * Math.PI * lpHz / sampleRate);

  const li = new Float64Array(poles);
  const lq = new Float64Array(poles);

  for (let k = 0; k < n; k++) {
    let i = samples[k] * Math.cos(w * k);
    let q = -samples[k] * Math.sin(w * k);
    for (let p = 0; p < poles; p++) {
      li[p] += alpha * (i - li[p]); i = li[p];
      lq[p] += alpha * (q - lq[p]); q = lq[p];
    }
    env[k] = Math.sqrt(i * i + q * q);
  }
  return env;
}

/**
 * Toppens posisjon i sekunder, med parabolsk interpolasjon.
 * Returnerer null naar toppen ikke er tydelig nok — bedre aa avvise en maling
 * enn aa rapportere et tall som egentlig er romstoy.
 */
export function peakTime(env, sampleRate, { minRatio = 6 } = {}) {
  let peak = 0, idx = -1;
  for (let k = 0; k < env.length; k++) {
    if (env[k] > peak) { peak = env[k]; idx = k; }
  }
  if (idx <= 0 || idx >= env.length - 1 || peak <= 0) return null;

  const sorted = Float32Array.from(env).sort();
  const floorLevel = sorted[Math.floor(sorted.length / 2)] || 1e-12;
  const ratio = peak / floorLevel;
  if (ratio < minRatio) return null;

  const y0 = env[idx - 1], y1 = env[idx], y2 = env[idx + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : 0.5 * (y0 - y2) / denom;

  return {
    time:  (idx + Math.max(-1, Math.min(1, delta))) / sampleRate,
    peak,
    ratio,
  };
}

/** Finner klikket i ett opptaksvindu. Returnerer sekunder inn i vinduet. */
export function findClick(samples, sampleRate, freq, opts) {
  return peakTime(envelopeAt(samples, sampleRate, freq), sampleRate, opts);
}
