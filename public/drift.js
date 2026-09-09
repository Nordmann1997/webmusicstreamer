// ============================================================================
//  drift.js — holder mottakeren i takt over lang tid.
//
//  Problemet: lydkortene i to maskiner teller ikke like fort. 30 ppm hores
//  ikke ut av noe, men det er 108 ms per time. Uten korreksjon vokser avviket
//  til tidslinja ma brytes og legges paa nytt, og hvert brudd er et horbart
//  knepp.
//
//  Losningen er Snapcasts: i stedet for aa la feilen samle seg og fikse den
//  med et hopp, fjerner eller dupliserer vi ETT sample av gangen, spredt
//  utover. Ett sample ved 48 kHz varer 0,02 ms — det hores ikke.
//
//  Hvorfor ikke bare resample med playbackRate: hver pakke ville da blitt
//  resamplet for seg, og fasen nullstilles i hver pakkegrense. Det gir en
//  liten artefakt 47 ganger i sekundet. Sampledropp har ingen slik grense.
// ============================================================================

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class DriftCorrector {
  constructor(opts = {}) {
    // Maks korreksjonstakt, som andel av avspillingshastigheten.
    // 0,0005 = 0,05 %, samme tak som Snapcast bruker.
    this.maxRatio = opts.maxRatio ?? 0.0005;

    // Hvor lang tid vi bruker paa aa fjerne et gitt avvik. Kort = rask
    // korreksjon, men da folger vi ogsaa maalestoyen. 10 s er rolig.
    this.timeConstant = opts.timeConstant ?? 10;

    this.window = opts.window ?? 48;     // ~1 sekund ved 1024-frames pakker
    this.errors = [];
    this.acc = 0;                        // brokdels-samples vi skylder
    this.corrected = 0;                  // totalt antall samples droppet/duplisert
  }

  /**
   * @param errorSec  hvor mye for SENT vi ligger (positivt = vi henger etter)
   * @param frames    lengden paa pakken vi skal rette i
   * @param sampleRate
   * @returns antall samples aa fjerne (+) eller duplisere (−) i denne pakken
   */
  update(errorSec, frames, sampleRate) {
    this.errors.push(errorSec);
    if (this.errors.length > this.window) this.errors.shift();

    // Median, ikke snitt: nettverkssvingninger er ikke normalfordelte, og et
    // snitt lar enkeltutslag styre korreksjonen.
    const m = median(this.errors);

    // Hvor mange samples per sekund vi vil rette, med tak.
    const cap = this.maxRatio * sampleRate;
    const perSec = Math.max(-cap, Math.min(cap, m * sampleRate / this.timeConstant));

    this.acc += perSec * frames / sampleRate;

    const n = Math.trunc(this.acc);
    this.acc -= n;
    this.corrected += Math.abs(n);
    return n;
  }

  get medianErrorMs() { return median(this.errors) * 1000; }
  reset() { this.errors = []; this.acc = 0; }
}

/**
 * Fjerner eller dupliserer `n` samples, spredt jevnt utover blokka.
 * Positiv n fjerner (spiller fortere), negativ dupliserer (spiller saktere).
 *
 * Spredt utover, ikke samlet: fjerner man fem samples paa rad blir det et
 * lite klikk, mens fem enkeltsamples fordelt over blokka forsvinner helt.
 */
export function applySampleCorrection(ch0, ch1, n) {
  if (n === 0) return { ch0, ch1, frames: ch0.length };

  const inLen = ch0.length;
  const outLen = inLen - n;
  if (outLen < 1 || Math.abs(n) > inLen / 2) return { ch0, ch1, frames: inLen };

  const o0 = new Float32Array(outLen);
  const o1 = new Float32Array(outLen);

  if (n > 0) {
    // Fjern n samples: hopp over hvert (inLen/n)-te.
    const step = inLen / n;
    let next = step / 2, r = 0, w = 0, dropped = 0;
    while (w < outLen) {
      if (dropped < n && r >= next) { r++; dropped++; next += step; continue; }
      o0[w] = ch0[r]; o1[w] = ch1[r]; r++; w++;
    }
  } else {
    // Dupliser -n samples, jevnt fordelt.
    const dup = -n;
    const step = inLen / dup;
    let next = step / 2, r = 0, w = 0, added = 0;
    while (w < outLen) {
      o0[w] = ch0[Math.min(r, inLen - 1)];
      o1[w] = ch1[Math.min(r, inLen - 1)];
      w++;
      if (added < dup && r >= next) { added++; next += step; continue; }  // ikke oke r
      r++;
    }
  }
  return { ch0: o0, ch1: o1, frames: outLen };
}
