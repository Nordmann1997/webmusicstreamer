// ============================================================================
//  measure.js — maler den FAKTISKE synkfeilen med mikrofonen.
//
//  Enhetene klikker SAMTIDIG, men paa hver sin frekvens (A = 900 Hz,
//  B = 2100 Hz). Denne enheten tar opp begge og sammenligner naar hvert klikk
//  kom mot naar det var planlagt:
//
//     feil_egen  = faktisk − planlagt   for min egen frekvens
//     feil_andre = faktisk − planlagt   for den andres frekvens
//     synkfeil   = feil_andre − feil_egen
//
//  Alt som er felles — mikrofonens inngangsforsinkelse, filterets
//  gruppeforsinkelse, hele opptakskjeden — staar i BEGGE ledd og forsvinner i
//  differansen. Det som ikke forsvinner er lydens gangtid, sa mikrofonen bor
//  staa omtrent like langt fra begge (34 cm ≈ 1 ms).
//
//  Hvorfor frekvens og ikke annenhver takt: da kan sokevinduet vaere BREDT.
//  Med vekselvise takter maatte vinduet vaere smalere enn halve taktavstanden,
//  ellers forvekslet man enhetene — og da fant den ikke et klikk som laa
//  100 ms feil, som er nettopp det man vil maale. Med hver sin frekvens er
//  det ingen forveksling, og vi kan lete ±400 ms.
// ============================================================================

import { findClick } from './detect.js';

export const FREQ = [900, 2100];     // etter rolle: A, B
const WINDOW_MS   = 800;             // ±400 ms — takes er 1000 ms fra hverandre
const KEEP_BLOCKS = 80;              // ~7 s rullende opptak

export class MicMeasurer {
  constructor(audioContext, myRole) {
    this.ctx = audioContext;
    this.myFreq    = FREQ[myRole] ?? FREQ[0];
    this.otherFreq = FREQ[myRole === 0 ? 1 : 0] ?? FREQ[1];

    this.blocks = [];
    this.selfErrors  = [];
    this.otherErrors = [];
    this.pending = [];
    this.running = false;
    this.lastResult = null;

    // Sa brukeren kan se om mikrofonen i det hele tatt horer noe.
    this.expected = 0;
    this.foundSelf = 0;
    this.foundOther = 0;
    this.ratioSelf = 0;
    this.ratioOther = 0;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // MAA vaere av. Ekkokansellering fjerner nettopp klikkene vi maaler.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });

    await this.ctx.audioWorklet.addModule('./recorder-worklet.js');

    const src  = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'recorder');
    const mute = this.ctx.createGain();
    mute.gain.value = 0;

    node.port.onmessage = (e) => {
      this.blocks.push(e.data);
      if (this.blocks.length > KEEP_BLOCKS) this.blocks.shift();
      this._drain();
    };

    src.connect(node).connect(mute).connect(this.ctx.destination);
    this.running = true;
    this.stream = stream;
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.blocks = [];
    this.pending = [];
  }

  /** Meld fra om en takt: naar den skulle komme, i AudioContext-tid. */
  expect(contextTime) {
    if (!this.running) return;
    this.expected++;
    this.pending.push({ contextTime });
    if (this.pending.length > 40) this.pending.shift();
  }

  _drain() {
    const latest = this._recordedUntil();
    const half = WINDOW_MS / 2000;

    this.pending = this.pending.filter(p => {
      if (latest < p.contextTime + half) return true;   // opptaket har ikke nadd fram

      const win = this._extract(p.contextTime - half, p.contextTime + half);
      if (win) {
        const sr = this.ctx.sampleRate;
        const mine  = findClick(win.samples, sr, this.myFreq);
        const other = findClick(win.samples, sr, this.otherFreq);

        if (mine) {
          this.foundSelf++;
          this.ratioSelf = mine.ratio;
          this._push(this.selfErrors, (win.startTime + mine.time - p.contextTime) * 1000);
        }
        if (other) {
          this.foundOther++;
          this.ratioOther = other.ratio;
          this._push(this.otherErrors, (win.startTime + other.time - p.contextTime) * 1000);
        }
        if (mine || other) this._update();
      }
      return false;
    });
  }

  _push(list, v) { list.push(v); if (list.length > 12) list.shift(); }

  _recordedUntil() {
    const last = this.blocks[this.blocks.length - 1];
    return last ? last.t + last.data.length / this.ctx.sampleRate : 0;
  }

  _extract(from, to) {
    if (this.blocks.length === 0) return null;
    const sr = this.ctx.sampleRate;
    if (from < this.blocks[0].t) return null;          // rullet ut av bufferet

    const n = Math.round((to - from) * sr);
    const out = new Float32Array(n);
    let written = 0;

    for (const b of this.blocks) {
      const bEnd = b.t + b.data.length / sr;
      if (bEnd <= from) continue;
      if (b.t >= to) break;

      const startIdx = Math.max(0, Math.round((from - b.t) * sr));
      const endIdx   = Math.min(b.data.length, Math.round((to - b.t) * sr));
      const dst      = Math.max(0, Math.round((b.t - from) * sr));

      for (let i = startIdx; i < endIdx && dst + (i - startIdx) < n; i++) {
        out[dst + (i - startIdx)] = b.data[i];
        written++;
      }
    }
    return written > n * 0.8 ? { samples: out, startTime: from } : null;
  }

  _update() {
    const med = (a) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const self = med(this.selfErrors), other = med(this.otherErrors);
    if (self === null || other === null) return;

    this.lastResult = {
      syncErrorMs: other - self,
      selfMs: self,
      otherMs: other,
      samples: Math.min(this.selfErrors.length, this.otherErrors.length),
    };
  }
}
