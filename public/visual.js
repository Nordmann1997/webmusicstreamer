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

// Elleve delefrekvenser gir ti baand, logaritmisk fordelt slik oret hoerer.
// Brukes av Lava, Bars og Rave. Kostnaden er 22 enpolsfiltre per sample —
// noen faa multiplikasjoner, promiller av en kjerne selv paa telefon.
const EDGES = [45, 90, 160, 280, 480, 820, 1400, 2400, 4100, 7000, 14000];
const NB = EDGES.length - 1;

const PALETTE = {
  sky: '#ead7bb', l1: '#cfa480', l2: '#8f7691', l3: '#4e4a70', accent: '#c2744a',
};

const LAYERS = [
  { lvl:'air',  hit:'hitAir',  col:'l1', y:0.42, lift:0.14, amp:0.055, sp:0.058,
    w1:1.9, w2:4.1, w3:7.3, ph:0.0, snap:0.034 },
  { lvl:'mid',  hit:'hitMid',  col:'l2', y:0.66, lift:0.13, amp:0.050, sp:0.046,
    w1:2.4, w2:5.1, w3:8.7, ph:2.1, snap:0.030 },
  { lvl:'kick', hit:'hitKick', col:'l3', y:0.86, lift:0.15, amp:0.044, sp:0.036,
    w1:1.5, w2:3.3, w3:6.1, ph:4.2, snap:0.042 },
];
const TOP_LIMIT = 0.22;          // tittelen skal aldri bli spist av en flate

/** Tre romlige frekvenser, hver sin driftretning: formen ENDRER seg over
 *  bredden i stedet for bare aa flytte paa seg. */
function aurWave(b, u, t, amp) {
  return Math.sin(u * b.w1 * Math.PI + t * b.sp * 6.5 + b.ph) * amp
       + Math.sin(u * b.w2 * Math.PI - t * b.sp * 4.2 + b.ph * 1.7) * amp * 0.50
       + Math.sin(u * b.w3 * Math.PI + t * b.sp * 2.3 + b.ph * 0.6) * amp * 0.26;
}

const LAVA_W = 132;
const LAVA_STOPS = [0.90, 1.45, 2.40];

// Aa dele paa en TOPPFOLGER var feil: toppen settes av det hardeste slaget,
// og saa lenge laata fortsetter i samme styrke ligger hvert eneste slag paa
// 1,0 — bildet staar stille paa maks. Naa deles det paa et SNITT, og
// resultatet gaar gjennom en myk kompressor:  e = x / (x + K).
// Den naar aldri 1: snittnivaa gir 0,31, et hardt slag 0,73, et voldsomt
// 0,85. Det er alltid noe igjen aa gi.
const KNEE = 2.2;
function compress(raw, ref) { const x = raw / (ref + 1e-5); return x / (x + KNEE); }

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
    this.bp1 = new Float64Array(EDGES.length);
    this.bp2 = new Float64Array(EDGES.length);
    this.bacc = new Float64Array(NB);

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
    this.qB = Array.from({ length: NB }, () => new Float32Array(this.cap));
    this.head = 0; this.count = 0;

    // --- tilstand for tegninga --------------------------------------------
    this.S = { kick:0, mid:0, air:0, hitKick:0, hitMid:0, hitAir:0 };
    this.AVG = { kick: 0.02, mid: 0.01, air: 0.003 };
    this.AS = [0, 0, 0];
    this.AJ = [0, 0, 0];
    this.phase = 0;
    this.mode = 'aurora';

    // --- baandnivaaer for de tre andre modusene --------------------------
    this.BV  = new Float32Array(NB);
    this.BAV = new Float32Array(NB).fill(0.01);
    this.BY  = new Float32Array(NB);
    this.BPK = new Float32Array(NB);

    // --- lavalampe -------------------------------------------------------
    this.lavaCv = null; this.lavaG = null; this.lavaImg = null; this.lavaH = 0;
    this.blobs = Array.from({ length: 9 }, (_, i) => ({
      x: 0.12 + (i % 3) * 0.32 + (i % 2) * 0.10,
      y: (i * 0.37) % 1,
      vy: (i % 2 ? 1 : -1) * (0.020 + (i % 4) * 0.006),
      r: 0.062 + (i % 3) * 0.020,
      band: i, ph: i * 1.9, rNow: 0.07,
    }));

    // --- rave ------------------------------------------------------------
    this.tunnel = 0; this.rot = 0; this.hue = 312; this.spokeTurn = 0;
    this.strobe = 0; this.lastStrobe = 0; this.prevKick = 0; this.prevAir = 0;

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

      // Filterbanken: ett topassfilter per delefrekvens, baandet er
      // differansen mellom to naboer.
      const p1 = this.bp1, p2 = this.bp2, ae = this.ae, bacc = this.bacc;
      for (let e = 0; e < ae.length; e++) {
        p1[e] += ae[e] * (x - p1[e]);
        p2[e] += ae[e] * (p1[e] - p2[e]);
      }
      for (let n2 = 0; n2 < NB; n2++) {
        const v = p2[n2 + 1] - p2[n2];
        bacc[n2] += v * v;
      }

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
    this.ae = EDGES.map(c);
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
    const bl = this.block, ba = this.bacc;
    for (let n = 0; n < NB; n++) { this.qB[n][i] = Math.sqrt(ba[n] / bl); ba[n] = 0; }
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
      for (let n = 0; n < NB; n++) this.BV[n] *= 0.9;
    } else {
      for (let n = 0; n < NB; n++) this.BV[n] += (1 - k) * (this.qB[n][i] - this.BV[n]);
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
    if      (this.mode === 'lava') this._drawLava(dt);
    else if (this.mode === 'bars') this._drawBars(dt);
    else if (this.mode === 'rave') this._drawRave(dt);
    else                           this._draw(dt);
    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  _rel(key) {
    const raw = this.S[key];
    // Stiger litt raskere enn den faller, saa et stille parti ikke blaser
    // opp stoygulvet til «musikk».
    this.AVG[key] += (raw > this.AVG[key] ? 0.004 : 0.0015) * (raw - this.AVG[key]);
    return compress(raw, this.AVG[key]);
  }

  _bandRel(n) {
    const raw = this.BV[n];
    this.BAV[n] += (raw > this.BAV[n] ? 0.004 : 0.0015) * (raw - this.BAV[n]);
    return compress(raw, this.BAV[n]);
  }

  setMode(m) {
    this.mode = m;
    this.BY.fill(0); this.BPK.fill(0);
    if (m === 'lava') this._lavaSetup();
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

      const amp = b.amp * (0.55 + e * 1.45 * this.gain + j * 0.55);
      let cy = b.y - (b.lift * e + b.snap * j) * this.gain;
      cy = Math.max(cy, TOP_LIMIT + amp * 1.9);

      g.fillStyle = PALETTE[b.col];
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W + step; x += step) {
        g.lineTo(x, H * (cy + aurWave(b, x / W, t, amp)));
      }
      g.lineTo(W + step, H); g.closePath(); g.fill();
    }
  }

  // =========================================================================
  //  Lavalampe — metaballs, regnet i lav opplosning
  // =========================================================================
  // Ekte metaballs betyr aa regne ut et felt for HVER piksel. Paa retina er
  // det fem millioner punkter ganger ni kuler, tretti ganger i sekundet.
  // Utelukket i JavaScript.
  //
  // Feltet er glatt og har ingen detaljer, saa vi regner det i 132 piksler
  // bredde og lar nettleseren strekke bildet. Vi skalerer IKKE selv: forste
  // forsok brukte drawImage, og paa 5,2 megapiksler ga 'high' ni bilder i
  // sekundet, 'medium' atten, 'low' tretti — mens JS-timeren viste 0,4 ms i
  // alle tre, fordi skaleringa skjer utenfor koden. Naar CSS strekker
  // lerretet gjor kompositoren jobben paa GPU, mykt og gratis.
  _lavaSetup() {
    this.lavaH = Math.max(24, Math.round(LAVA_W * this.H / this.W));
    this.lavaCv = document.getElementById('lavaCanvas');
    if (!this.lavaCv) return;
    this.lavaCv.width = LAVA_W; this.lavaCv.height = this.lavaH;
    this.lavaG = this.lavaCv.getContext('2d');
    this.lavaImg = this.lavaG.createImageData(LAVA_W, this.lavaH);
    for (let i = 3; i < this.lavaImg.data.length; i += 4) this.lavaImg.data[i] = 255;
    const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    this.lavaRGB = [hex(PALETTE.sky), hex(PALETTE.l1), hex(PALETTE.l2), hex(PALETTE.l3)];
  }

  _drawLava(dt) {
    const s = Math.min(dt, 50) / 1000;
    if (!this.lavaImg || this.lavaH !== Math.max(24, Math.round(LAVA_W * this.H / this.W)))
      this._lavaSetup();
    if (!this.lavaImg) return;

    const beat = Math.min(1, this.S.hitKick * 0.6);
    for (const b of this.blobs) {
      const e = this._bandRel(b.band);
      b.y += b.vy * s * (0.6 + e * 1.8 * this.gain);
      if (b.y < -0.18) b.y = 1.18;
      if (b.y >  1.18) b.y = -0.18;
      b.x += Math.sin(this.phase * 0.5 + b.ph) * s * 0.02;
      if (b.x < 0.05) b.x = 0.05;
      if (b.x > 0.95) b.x = 0.95;
      b.rNow = b.r * (0.75 + e * 0.65 * this.gain) * (1 + beat * 0.10);
    }

    const d = this.lavaImg.data, lh = this.lavaH, ar = lh / LAVA_W;
    let p = 0;
    for (let py = 0; py < lh; py++) {
      const fy = (py + 0.5) / lh * ar;
      for (let px = 0; px < LAVA_W; px++) {
        const fx = (px + 0.5) / LAVA_W;
        let f = 0;
        for (let i = 0; i < this.blobs.length; i++) {
          const b = this.blobs[i];
          const dx = fx - b.x, dy = fy - b.y * ar;
          // r^2/d^2: ingen kvadratrot, og summen gjor at to kuler smelter
          // sammen naar de naermer seg — det er hele metaball-effekten.
          f += b.rNow * b.rNow / (dx * dx + dy * dy + 0.0006);
        }
        // Myk overgang mellom fargene. Med hardt skille faller trappetrinnene
        // fra lavopplosninga rett i oynene.
        let k = 0, u = 0;
        if (f >= LAVA_STOPS[2]) { k = 3; u = 0; }
        else if (f >= LAVA_STOPS[1]) { k = 2; u = (f - LAVA_STOPS[1]) / (LAVA_STOPS[2] - LAVA_STOPS[1] + 0.70); }
        else if (f >= LAVA_STOPS[0]) { k = 1; u = (f - LAVA_STOPS[0]) / (LAVA_STOPS[1] - LAVA_STOPS[0] + 0.45); }
        else { k = 0; u = f / (LAVA_STOPS[0] + 0.30); }
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        u = u * u * (3 - 2 * u);
        const a = this.lavaRGB[k], b2 = this.lavaRGB[k < 3 ? k + 1 : 3];
        d[p]   = a[0] + (b2[0] - a[0]) * u;
        d[p+1] = a[1] + (b2[1] - a[1]) * u;
        d[p+2] = a[2] + (b2[2] - a[2]) * u;
        p += 4;
      }
    }
    this.lavaG.putImageData(this.lavaImg, 0, 0);
  }

  // =========================================================================
  //  Soyler — klassisk, med topphold
  // =========================================================================
  _drawBars(dt) {
    const g = this.g, W = this.W, H = this.H;
    const s = Math.min(dt, 50) / 1000;
    g.fillStyle = PALETTE.sky; g.fillRect(0, 0, W, H);

    const floor = 0.94, ceil = TOP_LIMIT + 0.04, span = floor - ceil;
    const slot = W * 0.84 / NB, bw = slot * 0.62;
    const x0 = W * 0.08 + (slot - bw) / 2;
    const rad = Math.min(bw * 0.5, H * 0.02);

    for (let n = 0; n < NB; n++) {
      const v = Math.min(1, this._bandRel(n) * this.gain * 1.5);
      this.BY[n] += (v - this.BY[n]) * (1 - Math.exp(-dt / 55));
      // Toppen henger igjen og siger sakte ned. Uten den ser soylene ut som
      // stoy; med den ser man hvor hardt det sist ble slaatt.
      if (this.BY[n] > this.BPK[n]) this.BPK[n] = this.BY[n];
      else this.BPK[n] = Math.max(this.BY[n], this.BPK[n] - s * 0.30);

      const x = x0 + n * slot;
      const h = Math.max(H * 0.012, H * span * this.BY[n]);
      g.fillStyle = n < 3 ? PALETTE.l3 : n < 6 ? PALETTE.l2 : PALETTE.l1;
      g.beginPath(); g.roundRect(x, H * floor - h, bw, h, [rad, rad, 0, 0]); g.fill();

      g.fillStyle = PALETTE.accent;
      g.fillRect(x, H * floor - H * span * this.BPK[n] - H * 0.006, bw, H * 0.006);
    }
  }

  // =========================================================================
  //  Rave — hypnose, ikke konfetti
  // =========================================================================
  // Ett fargepar som driver sakte i nyanse, en tunnel med eksponentiell
  // avstand mellom ringene, og etterslep i stedet for utvisking. Det er de
  // tre tingene som skiller klubb fra barnebursdag.
  _drawRave(dt) {
    const g = this.g, W = this.W, H = this.H;
    const s = Math.min(dt, 50) / 1000, now = performance.now();

    const bass = this._bandRel(0) * 0.6 + this._bandRel(1) * 0.4;
    const mid  = this._bandRel(4) * 0.5 + this._bandRel(5) * 0.5;
    const air  = this._bandRel(8) * 0.5 + this._bandRel(9) * 0.5;

    g.fillStyle = 'rgba(3,2,7,0.34)'; g.fillRect(0, 0, W, H);

    this.hue    += s * 4 * (0.4 + mid);
    this.tunnel += s * (0.35 + bass * 2.2) * this.gain;
    this.rot    += s * (0.10 + mid * 0.55);

    const A = `hsl(${this.hue % 360} 100% 58%)`;
    const B = `hsl(${(this.hue + 168) % 360} 100% 54%)`;
    const cx = W / 2, cy = H / 2, maxR = Math.hypot(W, H) * 0.62;

    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';

    for (let i = 0; i < 18; i++) {
      const f = ((i + this.tunnel) % 18) / 18;
      const r = Math.pow(f, 2.4) * maxR;
      if (r < 6) continue;
      const fade = Math.min(1, f * 5) * Math.min(1, (1 - f) * 3.2);
      g.globalAlpha = (0.10 + bass * 0.34) * fade;
      g.strokeStyle = i % 2 ? A : B;
      g.lineWidth = Math.max(1, H * (0.004 + f * 0.010) * (1 + bass * 0.7));
      const a0 = this.rot + f * 1.9;
      g.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = a0 + k / 6 * Math.PI * 2;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.92;
        k === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }

    const r0 = Math.min(W, H) * 0.13, spokes = NB * 2;
    g.lineCap = 'round';
    for (let k = 0; k < spokes; k++) {
      const n = k < NB ? k : spokes - 1 - k;
      const v = Math.min(1, this._bandRel(n) * this.gain * 1.6);
      this.BY[n] += (v - this.BY[n]) * (1 - Math.exp(-dt / 50));
      const len = Math.min(W, H) * (0.02 + this.BY[n] * 0.30);
      const a = this.spokeTurn + (k + 0.5) / spokes * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      g.globalAlpha = 0.45 + this.BY[n] * 0.5;
      g.strokeStyle = k % 2 ? A : B;
      g.lineWidth = Math.max(2, Math.min(W, H) * 0.012);
      g.beginPath();
      g.moveTo(cx + ca * r0, cy + sa * r0);
      g.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
      g.stroke();
    }
    this.spokeTurn += s * (0.15 + air * 0.9);

    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // Sperren paa 320 ms er ikke pynt. Blink mellom fem og tretti ganger i
    // sekundet er omraadet som utloser anfall hos lysfolsomme; tre i
    // sekundet holder seg trygt under.
    const rose = (v, prev, thr) => (v > prev + thr && v > thr * 1.6) ? v : 0;
    const kickHit = rose(this.S.hitKick, this.prevKick, 0.35); this.prevKick = this.S.hitKick;
    const airHit  = rose(this.S.hitAir,  this.prevAir,  0.50); this.prevAir  = this.S.hitAir;
    if ((kickHit || airHit) && now - this.lastStrobe > 320) {
      this.strobe = kickHit ? 1 : 0.5;
      this.lastStrobe = now;
      this.spokeTurn += Math.PI / NB;
    }
    this.strobe *= Math.pow(0.0012, s);
    if (this.strobe > 0.02) {
      // Farget blink leser som lys; hvitt leser som en feil i skjermen.
      g.fillStyle = `hsla(${(this.hue + 168) % 360} 100% 62% / ${(this.strobe * 0.30).toFixed(3)})`;
      g.fillRect(0, 0, W, H);
    }
  }
}
