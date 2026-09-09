// ===========================================================================
//  Nordlys — lydstyrt bakgrunn
// ===========================================================================
// Trekkene hentes ut av DET SOM FAKTISK SPILLES, ikke av en analysenode paa
// utgangen. Hver blokk faar tiden den skal spilles paa (i AudioContext-tid),
// og tegninga slaar opp i den lista med ctx.currentTime. Da beveger bildet
// seg i takt paa alle enheter av samme grunn som lyden gjor det: de deler
// presentasjonstid, ikke ankomsttid.
//
// Kostnaden er ti enpolsfiltre per sample og fire flate fyll per bilde.

const BLOCK_MS = 20;
const KEEP_SEC = 8;

const PALETTE = {
  sky: '#f4d3ae', l1: '#e2a077', l2: '#b47a8c', l3: '#584a72',
};

const LAYERS = [
  { lvl:'air',  hit:'hitAir',  col:'l1', y:0.34, lift:0.11, amp:0.055, sp:0.055,
    w1:1.7, w2:3.9, ph:0.0, snap:0.030 },
  { lvl:'mid',  hit:'hitMid',  col:'l2', y:0.60, lift:0.10, amp:0.048, sp:0.043,
    w1:2.2, w2:4.6, ph:2.1, snap:0.026 },
  { lvl:'kick', hit:'hitKick', col:'l3', y:0.84, lift:0.12, amp:0.042, sp:0.034,
    w1:1.5, w2:3.3, ph:4.2, snap:0.038 },
];

/** Anslagsdetektor for ett baand. Strommende utgave av den vi testet i lab. */
class HitDetector {
  constructor(up, down, thr, gate) {
    this.up = up; this.down = down; this.thr = thr; this.gate = gate;
    this.fast = 0; this.floor = 0; this.peak = 0;
  }
  push(v) {
    this.fast += (v > this.fast ? this.up : this.down) * (v - this.fast);
    // Bunnlinja maa folge STOYGULVET, ikke snittet: med et vanlig snitt drar
    // aatte hi-hat i sekundet den opp, og slagene gjemmer seg bak sin egen
    // bakgrunn. Derfor stiger den tregt og faller raskt.
    this.floor += (v > this.floor ? 0.006 : 0.050) * (v - this.floor);
    if (this.fast > this.peak) this.peak = this.fast;
    else this.peak += 0.0015 * (this.fast - this.peak);

    const rel = Math.max(0, (this.fast - this.floor * this.thr) / (this.floor + 1e-4));
    // ...men ren normalisering gjor stoy til slag: bredbaandsstoyen i en
    // skarptromme har litt energi under 100 Hz, og med lavt gulv teller den
    // som stortromme. Derfor skaleres alt smaatt ned mot baandets egen topp.
    return rel * Math.min(1, this.fast / (this.peak * this.gate + 1e-5));
  }
}

export class AudioVisual {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts  gain, smooth, fps, pressure() -> tall som stiger naar
   *                       lyden sliter (typisk receiver.late)
   */
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.gain   = opts.gain   ?? 0.6;
    this.smooth = opts.smooth ?? 0.69;
    this.fps    = opts.fps    ?? 30;
    this.pressure = opts.pressure || null;

    // --- filtertilstand, sammenhengende over pakkegrenser -----------------
    this.sr = 0;
    this.r = 0; this.k1 = 0; this.k2 = 0; this.k3 = 0; this.k4 = 0;
    this.lo1 = 0; this.lo2 = 0; this.hi1 = 0; this.hi2 = 0; this.t1 = 0; this.t2 = 0;
    this.acc = { n: 0, sK: 0, sM: 0, sA: 0 };

    this.det = {
      kick: new HitDetector(0.85, 0.30, 1.15, 0.55),
      mid:  new HitDetector(0.88, 0.32, 1.20, 0.35),
      air:  new HitDetector(0.95, 0.40, 1.20, 0.25),
    };

    // --- ringbuffer med trekk, sortert paa avspillingstid ------------------
    this.cap = Math.ceil(KEEP_SEC * 1000 / BLOCK_MS);
    this.qT = new Float64Array(this.cap);
    this.qKick = new Float32Array(this.cap); this.qMid = new Float32Array(this.cap);
    this.qAir = new Float32Array(this.cap);
    this.qHK = new Float32Array(this.cap); this.qHM = new Float32Array(this.cap);
    this.qHA = new Float32Array(this.cap);
    this.head = 0; this.count = 0;

    // --- tilstand for tegninga --------------------------------------------
    this.S = { kick:0, mid:0, air:0, hitKick:0, hitMid:0, hitAir:0 };
    this.AG = { kick: 0.02, mid: 0.01, air: 0.003 };
    this.AS = [0, 0, 0];
    this.AJ = [0, 0, 0];
    this.phase = 0;

    this.W = 0; this.H = 0; this.dpr = 1;
    this.running = false;
    this.lastFrame = 0;
    this.frameMs = 0;
    this.lastPressure = null;
    this.throttled = false;

    this._resize = this._resize.bind(this);
    this._tick = this._tick.bind(this);
    addEventListener('resize', this._resize);
    this._resize();
  }

  _resize() {
    // Tak paa opplosning: en telefon med dpr 3 har ni ganger sa mange piksler
    // som du trenger. Dette er den storste enkeltbesparelsen.
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.W = Math.round(innerWidth  * this.dpr);
    this.H = Math.round(innerHeight * this.dpr);
    this.cv.width = this.W; this.cv.height = this.H;
  }

  /**
   * Mat inn en blokk som er planlagt avspilt.
   * @param {Float32Array} ch0
   * @param {Float32Array} ch1
   * @param {number} sampleRate
   * @param {number} when  AudioContext-tid da blokka begynner aa spille
   */
  feed(ch0, ch1, sampleRate, when) {
    if (sampleRate !== this.sr) { this._retune(sampleRate); }
    const n = ch0.length;
    const block = this.block;
    const a = this.acc;

    for (let i = 0; i < n; i++) {
      const x = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];

      this.r  += this.a20 * (x - this.r);                         // under 20 Hz
      this.k1 += this.a100 * (x - this.k1); this.k2 += this.a100 * (this.k1 - this.k2);
      this.k3 += this.a100 * (this.k2 - this.k3); this.k4 += this.a100 * (this.k3 - this.k4);
      const kick = this.k4 - this.r;                              // 20-100 Hz

      this.lo1 += this.a250 * (x - this.lo1); this.lo2 += this.a250 * (this.lo1 - this.lo2);
      this.hi1 += this.a900 * (x - this.hi1); this.hi2 += this.a900 * (this.hi1 - this.hi2);
      const mid = this.hi2 - this.lo2;                             // 250-900 Hz

      this.t1 += this.a8k * (x - this.t1); this.t2 += this.a8k * (this.t1 - this.t2);
      const air = x - this.t2;                                     // over 8 kHz

      a.sK += kick * kick; a.sM += mid * mid; a.sA += air * air; a.n++;

      if (a.n >= block) {
        // Tida blokka BEGYNTE paa, ikke tida vi regnet den ut.
        this._push(when + (i + 1 - block) / sampleRate,
                   Math.sqrt(a.sK / block), Math.sqrt(a.sM / block), Math.sqrt(a.sA / block));
        a.n = 0; a.sK = 0; a.sM = 0; a.sA = 0;
      }
    }
  }

  _retune(sampleRate) {
    this.sr = sampleRate;
    const c = f => 1 - Math.exp(-2 * Math.PI * f / sampleRate);
    this.a20 = c(20); this.a100 = c(100); this.a250 = c(250);
    this.a900 = c(900); this.a8k = c(8000);
    this.block = Math.max(64, Math.round(sampleRate * BLOCK_MS / 1000));
    this.acc.n = 0; this.acc.sK = 0; this.acc.sM = 0; this.acc.sA = 0;
  }

  _push(t, kick, mid, air) {
    const i = this.head;
    this.qT[i] = t;
    this.qKick[i] = kick; this.qMid[i] = mid; this.qAir[i] = air;
    this.qHK[i] = this.det.kick.push(kick);
    this.qHM[i] = this.det.mid.push(mid);
    this.qHA[i] = this.det.air.push(air);
    this.head = (i + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  /** Nyeste blokk som skulle vaert spilt for tida `now`. */
  _at(now) {
    let best = -1, bestT = -Infinity;
    for (let j = 0; j < this.count; j++) {
      const i = (this.head - 1 - j + this.cap * 2) % this.cap;
      const t = this.qT[i];
      if (t <= now) { best = i; bestT = t; break; }
    }
    if (best < 0 || now - bestT > 0.5) return null;
    return best;
  }

  start(nowFn) {
    if (this.running) return;
    this.nowFn = nowFn;
    this.running = true;
    this.lastFrame = 0;
    requestAnimationFrame(this._tick);
  }

  stop() { this.running = false; }

  destroy() { this.stop(); removeEventListener('resize', this._resize); }

  _tick(ts) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    const interval = 1000 / this.fps;
    if (ts - this.lastFrame < interval - 1) return;
    const dt = this.lastFrame ? ts - this.lastFrame : interval;
    this.lastFrame = ts;
    const t0 = performance.now();

    // Synken er forsteprioritet: hvis lyden begynner aa komme for sent,
    // gir bildet fra seg rammer for det.
    if (this.pressure) {
      const p = this.pressure();
      if (this.lastPressure !== null && p > this.lastPressure && !this.throttled) {
        this.throttled = true;
        this.fps = Math.max(15, this.fps - 10);
      }
      this.lastPressure = p;
    }

    const now = this.nowFn ? this.nowFn() : 0;
    const i = this._at(now);
    const k = this.smooth;
    if (i === null) {
      for (const key of ['kick','mid','air']) this.S[key] *= 0.9;
      for (const key of ['hitKick','hitMid','hitAir']) this.S[key] *= 0.8;
    } else {
      this.S.kick = this.S.kick + (1 - k) * (this.qKick[i] - this.S.kick);
      this.S.mid  = this.S.mid  + (1 - k) * (this.qMid[i]  - this.S.mid);
      this.S.air  = this.S.air  + (1 - k) * (this.qAir[i]  - this.S.air);
      // Anslag glattes IKKE som nivaa — det er hele poenget med dem.
      const dk = Math.pow(0.86, dt / 16.7);
      this.S.hitKick = Math.max(this.S.hitKick * dk, this.qHK[i]);
      this.S.hitMid  = Math.max(this.S.hitMid  * dk, this.qHM[i]);
      this.S.hitAir  = Math.max(this.S.hitAir  * dk, this.qHA[i]);
    }

    this.phase += dt * 0.0006;
    this._draw(dt);
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  _rel(key) {
    const raw = this.S[key];
    if (raw > this.AG[key]) this.AG[key] = raw;
    else this.AG[key] += (raw - this.AG[key]) * 0.004;
    return Math.min(1, raw / (this.AG[key] + 1e-4));
  }

  _draw(dt) {
    const g = this.g, W = this.W, H = this.H, t = this.phase;
    // Ro-verdien styrer tidskonstanten: 0,3 s naar den er lav, to naar hoy.
    const kk = 1 - Math.exp(-dt / (300 + this.smooth * 1900));
    const kj = 1 - Math.exp(-dt / 90);

    g.fillStyle = PALETTE.sky; g.fillRect(0, 0, W, H);

    const step = Math.max(6, Math.round(W / 110));
    for (let i = 0; i < 3; i++) {
      const b = LAYERS[i];
      this.AS[i] += (this._rel(b.lvl) - this.AS[i]) * kk;
      this.AJ[i] += (Math.min(1.4, this.S[b.hit]) - this.AJ[i]) * kj;
      const e = this.AS[i], j = this.AJ[i];

      const cy  = b.y - (b.lift * e + b.snap * j) * this.gain;
      const amp = b.amp * (0.75 + e * 0.9 * this.gain + j * 0.35);

      g.fillStyle = PALETTE[b.col];
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W + step; x += step) {
        const u = x / W;
        const y = H * (cy
          + Math.sin(u * b.w1 * Math.PI + t * b.sp * 6 + b.ph) * amp
          + Math.sin(u * b.w2 * Math.PI - t * b.sp * 4 + b.ph * 1.7) * amp * 0.45);
        g.lineTo(x, y);
      }
      g.lineTo(W + step, H); g.closePath(); g.fill();
    }
  }
}
