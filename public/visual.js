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

// --- lavalampe (WebGL) -----------------------------------------------------
// Kulene henger i en fjaer festet i bassnivaaet. Baandet er smalt med vilje:
// 18-35 Hz og 50-85 Hz, altsaa selve slaget — ingen bassgang, ingen stemmer.
// Maalt paa ekte laater ligger medianen paa 0,04-0,07 og toppene rundt 0,13.
const LAVA_N    = 22;
const LAVA_REF  = 0.11;    // nivaaet som gir fullt utslag
const LAVA_K    = 142;     // fjaerstivhet
const LAVA_ZETA = 0.82;    // demping; under 1 gir litt ettersleng
const LAVA_SIZE = 0.55;    // hvor mye utslaget oeker stoerrelsen
const LAVA_LIFT = 0.90;    // hvor mye det dytter kula oppover
const LAVA_BASE = 0.60;    // fart uten musikk
const LAVA_T    = 1.15;    // feltverdien der lavaen begynner

const LAVA_VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Feltet regnes per skjermpiksel paa GPU-en. Hovedtraden gjor bare kule-
// fysikk og ett draw-kall — det er derfor den er billigere enn den gamle,
// som regnet 40 000 punkter i JavaScript. fwidth() gjor kanten noeyaktig én
// piksel bred: skarp, men uten trappetrinn.
function lavaFS(deriv) {
  const kant = deriv
    ? '  float w = max(fwidth(f), 1e-5);\n  float a = smoothstep(T - w, T + w, f);'
    : '  float a = smoothstep(T - 0.045, T + 0.045, f);';
  return (deriv ? '#extension GL_OES_standard_derivatives : enable\n' : '') + `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform vec3 uBlob[${LAVA_N}];
uniform vec3 uTop;
uniform vec3 uBot;
uniform vec3 uBg;
uniform float uAR;
const float T = ${LAVA_T.toFixed(3)};
void main() {
  float fx = vUV.x;
  float fy = vUV.y * uAR;
  float f = 0.0;
  for (int i = 0; i < ${LAVA_N}; i++) {
    float dx = fx - uBlob[i].x;
    float dy = fy - uBlob[i].y * uAR;
    f += uBlob[i].z * uBlob[i].z / (dx * dx + dy * dy + 0.0006);
  }
${kant}
  gl_FragColor = vec4(mix(uBg, mix(uTop, uBot, vUV.y), a), 1.0);
}`;
}

const _frac = v => v - Math.floor(v);
const _hash = (i, k) => _frac(Math.sin(i * 127.1 + k * 311.7) * 43758.5453);

// --- diskokule ---------------------------------------------------------------
// Kula er ekte geometri: fasetter paa en kule, rotert om y-aksen. Bygges en
// gang. Hvert speil sitter litt skjevt, som paa en ekte kule — det sprer
// glansen og flekkene over hele kula.
const DISCO = (() => {
  const step = 12, gap = 0.46;
  const nx = [], ny = [], nz = [], qx = [], qy = [], qz = [];
  const R = Math.PI / 180;
  for (let lat = -84; lat <= 84.1; lat += step) {
    const a = lat * R, cl = Math.cos(a);
    const n = Math.max(4, Math.round(30 * cl));
    const a0 = (lat - step * gap) * R, a1 = (lat + step * gap) * R;
    for (let i = 0; i < n; i++) {
      const om = (i + 0.5) / n * Math.PI * 2;
      nx.push(cl * Math.sin(om)); ny.push(-Math.sin(a)); nz.push(cl * Math.cos(om));
      const o0 = (i + 0.5 - gap) / n * Math.PI * 2, o1 = (i + 0.5 + gap) / n * Math.PI * 2;
      for (const [la, lo] of [[a0, o0], [a0, o1], [a1, o1], [a1, o0]]) {
        const c = Math.cos(la);
        qx.push(c * Math.sin(lo)); qy.push(-Math.sin(la)); qz.push(c * Math.cos(lo));
      }
    }
  }
  const N = nx.length;
  const d = {
    N, nx: Float32Array.from(nx), nz: Float32Array.from(nz),
    qx: Float32Array.from(qx), qy: Float32Array.from(qy), qz: Float32Array.from(qz),
    bias: Float32Array.from({ length: N }, (_, i) => (_hash(i, 21) - 0.5) * 0.26),
    jx: new Float32Array(N), jy: new Float32Array(N), jz: new Float32Array(N),
  };
  for (let i = 0; i < N; i++) {
    const x = nx[i] + (_hash(i, 41) - 0.5) * 0.34;
    const y = ny[i] + (_hash(i, 42) - 0.5) * 0.34;
    const z = nz[i] + (_hash(i, 43) - 0.5) * 0.34;
    const l = Math.hypot(x, y, z);
    d.jx[i] = x / l; d.jy[i] = y / l; d.jz[i] = z / l;
  }
  return d;
})();
// Lyskasterne staar ute paa sidene, litt over: glansen faller paa hver sin
// side av kula, og flere straaler kastes bakover mot veggen.
const D_LIGHTS = [[-0.82, -0.40, 0.41], [0.80, -0.32, 0.51]];
const D_MAXSPOT = 260, D_MAXBEAM = 26, D_MAXGLINT = 9;
// Klassisk kule, hvitt lys: soelv for speil i skygge, hvitt for dem som
// fanger lyskasteren.
const D_SILVER = Array.from({ length: 24 }, (_, i) => {
  const u = i / 23;
  return `hsl(230 ${(8 + u * 4).toFixed(0)}% ${(20 + u * 52).toFixed(0)}%)`;
});
const D_WHITE = Array.from({ length: 24 }, (_, i) => {
  const u = i / 23;
  return `hsl(220 ${(12 - u * 12).toFixed(0)}% ${(62 + u * 38).toFixed(0)}%)`;
});
const rose = (v, prev, thr) => (v > prev + thr && v > thr * 1.6) ? v : 0;

// --- soyler ---------------------------------------------------------------
const COL_MIN = 28, COL_MAX = 64;
const FLOOR   = 0.985;      // bunnlinja, som andel av skjermhoyden
const G_BALL  = 2.2;        // skjermhoyder per sekund^2
// Hoyden soylene hviler paa naar ingenting spilles. Sida skal ikke vaere tom
// naar du kommer inn, men naar musikken forst gaar faar den hele omraadet.
const IDLE_H  = 0.40;

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
    // Bildefrekvens per modus, valgt etter maalt kostnad. En kule som glir
    // jevnt avsloerer 30 bilder i sekundet med en gang: hver posisjon holdes
    // i to skjermbilder. Flatene og soylene koster under en ms, saa 60 er
    // gratis der. Lavaen regnes paa GPU og diskokula koster under en ms,
    // saa de faar ogsaa 60.
    this.fpsFor = { aurora: 60, bars: 60, rave: 60, lava: 60, disco: 60 };
    this.fps    = opts.fps ?? this.fpsFor.bars;
    this.pressure = opts.pressure || null;

    // --- filtertilstand, sammenhengende over pakkegrenser -----------------
    this.sr = 0;
    this.r = 0; this.k1 = 0; this.k2 = 0; this.k3 = 0; this.k4 = 0;
    this.lo1 = 0; this.lo2 = 0; this.hi1 = 0; this.hi2 = 0; this.t1 = 0; this.t2 = 0;
    this.acc = { n: 0, sK: 0, sM: 0, sA: 0 };
    this.bp1 = new Float64Array(EDGES.length);
    this.bp2 = new Float64Array(EDGES.length);
    this.bacc = new Float64Array(NB);
    // To smale baand rundt 25 og 65 Hz for lavaen — bare selve slaget.
    this.sp1 = new Float64Array(4); this.sp2 = new Float64Array(4);
    this.s1 = 0; this.s2 = 0;

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
    this.qSub = new Float32Array(this.cap);
    this.qB = Array.from({ length: NB }, () => new Float32Array(this.cap));
    this.head = 0; this.count = 0;

    // --- tilstand for tegninga --------------------------------------------
    this.S = { kick:0, mid:0, air:0, hitKick:0, hitMid:0, hitAir:0, sub:0 };
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

    // --- lavalampe (WebGL) -------------------------------------------------
    this.glCv = null; this.gl = null; this.glProg = null; this.glLoc = null;
    this.glLost = false; this.glDead = false;
    this.glBuf = new Float32Array(LAVA_N * 3);
    this.blobs = Array.from({ length: LAVA_N }, (_, i) => ({
      x: 0.06 + _hash(i, 1) * 0.88,
      y: _hash(i, 2),
      vy: (_hash(i, 3) < 0.5 ? -1 : 1) * (0.016 + _hash(i, 4) * 0.022),
      r: 0.034 + _hash(i, 5) * 0.034,
      kick: 0.7 + _hash(i, 6) * 0.6,   // egen fjaerstivhet, saa de ikke gaar i takt
      sp: 0, sv: 0, ph: i * 1.9, rNow: 0.05,
    }));

    // --- diskokule ---------------------------------------------------------
    this.dRot = 0; this.dPulse = 0; this.dFlash = 0; this.dLastFlash = 0;
    this.dPrevKick = 0; this.dPrevAir = 0; this.dRS = 0; this.dCyS = 0;
    this.dBg = null; this.dBgH = 0; this.dBeam = null; this.dBeamKey = '';
    this.dDot = null; this.dStar = null;
    this.dTile = new Int16Array(DISCO.N);
    this.dSX = new Float32Array(D_MAXSPOT); this.dSY = new Float32Array(D_MAXSPOT);
    this.dSS = new Float32Array(D_MAXSPOT); this.dSA = new Float32Array(D_MAXSPOT);
    this.dSFX = new Float32Array(D_MAXSPOT); this.dSFY = new Float32Array(D_MAXSPOT);
    this.dGX = new Float32Array(D_MAXGLINT); this.dGY = new Float32Array(D_MAXGLINT);
    this.dGV = new Float32Array(D_MAXGLINT);

    // --- soyler og baller -------------------------------------------------
    this.COLS = 40;
    this.CH   = new Float32Array(this.COLS);   // tegnet hoyde per soyle
    this.CTOP = new Float32Array(this.COLS).fill(FLOOR);
    this.live = 0;                             // 0 = stille, 1 = musikk
    this.balls = [
      { x: 0.16, vx:  0.055, y: 0.35, vy: 0, r: 0.040 },
      { x: 0.39, vx: -0.045, y: 0.30, vy: 0, r: 0.030 },
      { x: 0.62, vx:  0.035, y: 0.38, vy: 0, r: 0.048 },
      { x: 0.85, vx: -0.060, y: 0.32, vy: 0, r: 0.026 },
    ];

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

      const sp1 = this.sp1, sp2 = this.sp2, sa = this.aSub;
      for (let e = 0; e < 4; e++) { sp1[e] += sa[e] * (x - sp1[e]); sp2[e] += sa[e] * (sp1[e] - sp2[e]); }
      const v1 = sp2[1] - sp2[0], v2 = sp2[3] - sp2[2];
      this.s1 += v1 * v1; this.s2 += v2 * v2;

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
    this.aSub = [c(18), c(35), c(50), c(85)];
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
    const blk = this.block;
    this.qSub[i] = Math.sqrt(this.s1 / blk) * 0.35 + Math.sqrt(this.s2 / blk) * 0.65;
    this.s1 = 0; this.s2 = 0;
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
      this.S.sub *= 0.9;
    } else {
      this.S.sub += (1 - k) * (this.qSub[i] - this.S.sub);
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
    if      (this.mode === 'lava')  this._drawLava(dt);
    else if (this.mode === 'disco') this._drawDisco(dt);
    else if (this.mode === 'bars')  this._drawBars(dt);
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

  /** Returnerer false hvis modusen ikke kan vises her (lava uten WebGL). */
  setMode(m) {
    if (m === 'lava' && !this._lavaInit()) return false;
    this.mode = m;
    this.fps = this.fpsFor[m] || 30;
    this.throttled = false;
    this.BY.fill(0); this.BPK.fill(0);
    return true;
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
  //  Lavalampe — metaballs paa GPU
  // =========================================================================
  // Flat, som i forbildet: ett hardt skille mellom bakgrunn og lava, og en
  // loddrett overgang mellom to farger over hele flata. Hovedtraden gjor bare
  // kulefysikk og ett draw-kall.
  //
  // MERK ved maaling: frameMs teller bare JS-tid, og drawArrays returnerer for
  // GPU-en har begynt. Bildefrekvensen er det aerlige maalet her.
  _lavaInit() {
    if (this.glDead || this.glLost) return false;
    if (this.gl && this.glProg) return true;

    this.glCv = document.getElementById('lavaCanvas');
    if (!this.glCv) { this.glDead = true; return false; }
    if (!this.gl) {
      const gl = this.glCv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false })
        || this.glCv.getContext('experimental-webgl');
      if (!gl) { this.glDead = true; return false; }
      this.gl = gl;
      // Et GPU-reset skal ikke gi svart skjerm: bygg opp igjen naar den kommer tilbake.
      this.glCv.addEventListener('webglcontextlost', e => { e.preventDefault(); this.glLost = true; this.glProg = null; });
      this.glCv.addEventListener('webglcontextrestored', () => { this.glLost = false; this.glProg = null; });
    }
    const gl = this.gl;
    const deriv = !!gl.getExtension('OES_standard_derivatives');
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('shader:', gl.getShaderInfoLog(sh)); return null;
      }
      return sh;
    };
    const vs = shader(gl.VERTEX_SHADER, LAVA_VS), fs = shader(gl.FRAGMENT_SHADER, lavaFS(deriv));
    if (!vs || !fs) { this.glDead = true; return false; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('link:', gl.getProgramInfoLog(prog)); this.glDead = true; return false;
    }
    gl.useProgram(prog);
    this.glProg = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.glLoc = {
      blob: gl.getUniformLocation(prog, 'uBlob'),
      ar:   gl.getUniformLocation(prog, 'uAR'),
    };
    const hex = h => [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255];
    // Sand i bakgrunnen, dyp lilla oeverst som blir lysere nedover.
    gl.uniform3fv(gl.getUniformLocation(prog, 'uTop'), new Float32Array(hex(PALETTE.l3)));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uBot'), new Float32Array(hex(PALETTE.l2)));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uBg'),  new Float32Array(hex(PALETTE.sky)));
    this.glCv.width = 0;   // tvinger ny storrelse i foerste bilde
    return true;
  }

  // Fjaer med demping, per kule: kraften er (maal - posisjon) * stivhet,
  // minus fart * demping. Utslaget kan ikke hoppe — det maa gjennom en
  // akselerasjon foerst — og derfor ser det mykt ut uten aa henge etter.
  _moveBlobs(dt) {
    const s = Math.min(dt, 50) / 1000;
    const D = 2 * LAVA_ZETA * Math.sqrt(LAVA_K);
    const maal = Math.min(1.4, this.S.sub / LAVA_REF);
    for (const b of this.blobs) {
      b.sv += ((maal - b.sp) * LAVA_K * b.kick - b.sv * D) * s;
      b.sp += b.sv * s;
      const e = b.sp < 0 ? 0 : b.sp;
      b.y += b.vy * s * (LAVA_BASE + e * LAVA_LIFT);
      if (b.y < -0.18) b.y = 1.18;
      if (b.y >  1.18) b.y = -0.18;
      b.x += Math.sin(this.phase * 0.5 + b.ph) * s * 0.02;
      if (b.x < 0.05) b.x = 0.05; if (b.x > 0.95) b.x = 0.95;
      b.rNow = b.r * (0.72 + e * LAVA_SIZE);
    }
  }

  _drawLava(dt) {
    if (!this._lavaInit()) { this._draw(dt); return; }
    this._moveBlobs(dt);
    const gl = this.gl, W = this.W, H = this.H;
    if (this.glCv.width !== W || this.glCv.height !== H) {
      this.glCv.width = W; this.glCv.height = H;
      gl.viewport(0, 0, W, H);
    }
    const B = this.glBuf;
    for (let i = 0; i < LAVA_N; i++) {
      const b = this.blobs[i];
      B[i*3] = b.x; B[i*3+1] = b.y; B[i*3+2] = b.rNow;
    }
    gl.uniform3fv(this.glLoc.blob, B);
    gl.uniform1f(this.glLoc.ar, H / W);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // =========================================================================
  //  Diskokule — klassisk, hvitt lys
  // =========================================================================
  // Flekkene paa veggen er ekte refleksjoner: lyset fra de to lyskasterne
  // speiles om hvert speils normal, og der straalen treffer bakveggen blir
  // det en flekk. Naar kula snurrer, feier flekkene over rommet.
  //
  // Tre skalarprodukter per speil og lys, og hver flekk er ETT drawImage av
  // en ferdig tegnet prikk. Ingen gradient per flekk, ingen fargestrenger i
  // sloyfa. Under 1 ms per bilde.
  _discoSprites() {
    const mk = (size) => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
    const dot = mk(64), x = dot.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0,    'rgba(255,253,248,1)');
    gr.addColorStop(0.16, 'rgba(255,248,236,.9)');
    gr.addColorStop(0.42, 'rgba(255,244,228,.20)');
    gr.addColorStop(1,    'rgba(255,240,220,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    this.dDot = dot;

    // Glimtet i et speil som treffer oyet ditt: et firearmet kors med kjerne.
    const star = mk(96), y = star.getContext('2d');
    y.globalCompositeOperation = 'lighter';
    for (const [w, h] of [[96, 3], [3, 96]]) {
      const lg = w > h ? y.createLinearGradient(0, 0, 96, 0) : y.createLinearGradient(0, 0, 0, 96);
      lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,.95)');
      lg.addColorStop(1, 'rgba(255,255,255,0)');
      y.fillStyle = lg; y.fillRect((96 - w) / 2, (96 - h) / 2, w, h);
    }
    const core = y.createRadialGradient(48, 48, 0, 48, 48, 18);
    core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(1, 'rgba(255,255,255,0)');
    y.fillStyle = core; y.fillRect(30, 30, 36, 36);
    this.dStar = star;
  }

  _drawDisco(dt) {
    const g = this.g, W = this.W, H = this.H;
    const s = Math.min(dt, 50) / 1000, now = performance.now();
    const Dm = DISCO, N = Dm.N;

    const bass = this._bandRel(0) * 0.6 + this._bandRel(1) * 0.4;
    const mid  = this._bandRel(4) * 0.5 + this._bandRel(5) * 0.5;
    const air  = this._bandRel(8) * 0.5 + this._bandRel(9) * 0.5;

    const kickHit = rose(this.S.hitKick, this.dPrevKick, 0.33); this.dPrevKick = this.S.hitKick;
    const airHit  = rose(this.S.hitAir,  this.dPrevAir,  0.50); this.dPrevAir  = this.S.hitAir;
    if (kickHit) this.dPulse = Math.min(1.15, this.dPulse + kickHit * 0.8);
    this.dPulse *= Math.pow(0.010, s);
    // Samme sperre paa 300 ms som strobet i Rave — godt under omraadet som
    // utloser anfall.
    if ((kickHit || airHit) && now - this.dLastFlash > 300) {
      this.dFlash = kickHit ? 1 : 0.45; this.dLastFlash = now;
    }
    this.dFlash *= Math.pow(0.004, s);
    const pulse = this.dPulse;

    // Sakte, som en ekte kule. Det er flekkene langt unna som beveger seg fort.
    this.dRot += s * (0.16 + mid * 0.30 + pulse * 0.25) * this.gain;
    if (!this.dDot) this._discoSprites();

    if (!this.dBg || this.dBgH !== H) {
      this.dBg = g.createLinearGradient(0, 0, 0, H);
      this.dBg.addColorStop(0, '#0d0a17'); this.dBg.addColorStop(1, '#05040a');
      this.dBgH = H;
    }
    g.fillStyle = this.dBg; g.fillRect(0, 0, W, H);

    // Kula henger ute i rommet, ikke oppe i taket — men aldri saa lavt at den
    // naar ned i knappene. Den glir til ny plass i stedet for aa hoppe.
    const minWH = Math.min(W, H);
    const tR  = minWH * 0.17;
    const tCy = Math.min(H * 0.50, H * (TOP_LIMIT + 0.05) + tR);
    if (!this.dRS) { this.dRS = tR; this.dCyS = tCy; }
    const kf = 1 - Math.exp(-dt / 220);
    this.dRS += (tR - this.dRS) * kf; this.dCyS += (tCy - this.dCyS) * kf;
    const cx = W / 2, cy = this.dCyS;
    const R = this.dRS * (1 + pulse * 0.05 + bass * 0.04);

    const ca = Math.cos(this.dRot), sa = Math.sin(this.dRot);
    const lightI = 0.42 + bass * 0.55 + pulse * 0.55;
    const WALL = R * 2.4;
    const minSp = minWH * 0.010, maxSp = minWH * 0.060;
    const gl = 1.0 + pulse * 0.8 + air * 0.6;
    const SX = this.dSX, SY = this.dSY, SS = this.dSS, SA = this.dSA, SFX = this.dSFX, SFY = this.dSFY;
    const tile = this.dTile;

    let ns = 0, ng = 0;
    for (let i = 0; i < N; i++) {
      const ax = Dm.jx[i], ay = Dm.jy[i], az = Dm.jz[i];
      const nx = ax * ca + az * sa, ny = ay, nz = az * ca - ax * sa;
      let bestSpec = 0, bestD = 0;

      for (let l = 0; l < 2; l++) {
        const L = D_LIGHTS[l];
        const ndl = nx * L[0] + ny * L[1] + nz * L[2];
        if (ndl <= 0) continue;
        // Refleksjon av lysretningen om normalen: R = 2(n·L)n - L
        const rx = 2 * ndl * nx - L[0], ry = 2 * ndl * ny - L[1], rz = 2 * ndl * nz - L[2];
        if (rz > bestSpec) bestSpec = rz;
        if (ndl > bestD) bestD = ndl;

        // Gaar straalen bakover, treffer den veggen bak kula.
        if (rz < -0.08 && ns < D_MAXSPOT) {
          const t = 1 / -rz;
          const x = cx + nx * R + rx * t * WALL, y = cy + ny * R + ry * t * WALL;
          if (x < -maxSp || x > W + maxSp || y < -maxSp || y > H + maxSp) continue;
          const qx = x - cx, qy = y - cy;
          if (qx * qx + qy * qy < R * R * 1.1) continue;   // skjult bak kula
          const tw = 0.75 + 0.25 * Math.sin(this.phase * 9 + i * 1.7 + l);
          SX[ns] = x; SY[ns] = y; SFX[ns] = cx + nx * R; SFY[ns] = cy + ny * R;
          SS[ns] = Math.min(maxSp, minSp * (0.8 + t * 0.55) * (0.8 + pulse * 0.45));
          // Lengre vei = svakere flekk, som med en ekte lyskaster.
          SA[ns] = Math.min(1, ndl * lightI * tw * (1.25 - Math.min(0.75, t * 0.12)));
          ns++;
        }
      }

      // Synlighet avgjores av den UJUSTERTE normalen, ellers stikker skjeve
      // speil fram paa baksida.
      if (Dm.nz[i] * ca - Dm.nx[i] * sa <= 0.02) { tile[i] = -1; continue; }
      let v = 0.22 + Dm.bias[i] * 1.1 + nz * 0.10 - ny * 0.12 + bestD * 0.22;
      let lit = 0;
      if (bestSpec > 0) {
        const p2 = bestSpec * bestSpec, p4 = p2 * p2, p8 = p4 * p4, p16 = p8 * p8;
        const col = p16 * p4 * gl * 1.3;       // ^20: smal glans
        if (col > 0.10) { lit = 1; v = col; }
        if (bestSpec > 0.985 && ng < D_MAXGLINT) {
          this.dGX[ng] = cx + nx * R; this.dGY[ng] = cy + ny * R;
          this.dGV[ng] = (bestSpec - 0.985) / 0.015; ng++;
        }
      }
      const k = v <= 0 ? 0 : v >= 1 ? 23 : (v * 23) | 0;
      tile[i] = lit * 24 + k;
    }

    g.globalCompositeOperation = 'lighter';

    // --- straaler fra kula ut til flekkene. Én delt gradient.
    const bKey = `${cx|0},${cy|0},${R|0}`;
    if (bKey !== this.dBeamKey) {
      const far = Math.hypot(W, H) * 0.7;
      this.dBeam = g.createRadialGradient(cx, cy, R, cx, cy, far);
      this.dBeam.addColorStop(0, 'rgba(255,250,240,.16)');
      this.dBeam.addColorStop(1, 'rgba(255,250,240,0)');
      this.dBeamKey = bKey;
    }
    g.fillStyle = this.dBeam;
    g.globalAlpha = Math.min(1, 0.35 + bass * 0.6 + pulse * 0.5);
    g.beginPath();
    const step = Math.max(1, Math.ceil(ns / D_MAXBEAM));
    for (let j = 0; j < ns; j += step) {
      if (SA[j] < 0.35) continue;
      const fx = SFX[j], fy = SFY[j], x = SX[j], y = SY[j];
      const dx = x - fx, dy = y - fy, len = Math.hypot(dx, dy) || 1;
      const w = SS[j] * 0.45, px = -dy / len * w, py = dx / len * w;
      g.moveTo(fx, fy); g.lineTo(x + px, y + py); g.lineTo(x - px, y - py); g.closePath();
    }
    g.fill();

    // --- flekkene
    for (let j = 0; j < ns; j++) {
      const sz = SS[j] * 2.6;
      g.globalAlpha = SA[j];
      g.drawImage(this.dDot, SX[j] - sz / 2, SY[j] - sz / 2, sz, sz);
    }
    g.globalAlpha = 1;

    // --- glorie
    const hg = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 2.2);
    hg.addColorStop(0, `rgba(255,248,236,${(0.08 + bass * 0.14).toFixed(3)})`);
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hg;
    g.beginPath(); g.arc(cx, cy, R * 2.2, 0, 6.2832); g.fill();
    g.globalCompositeOperation = 'source-over';

    // --- snor og kropp. Kroppen lyses litt opp, ellers blir fugene svarte hull.
    g.strokeStyle = 'rgba(232,226,246,.26)';
    g.lineWidth = Math.max(1, minWH * 0.003);
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, cy - R * 0.99); g.stroke();
    g.fillStyle = '#16141d';
    g.beginPath(); g.arc(cx, cy, R * 1.01, 0, 6.2832); g.fill();

    // --- speilene
    for (let i = 0; i < N; i++) {
      const tv = tile[i];
      if (tv < 0) continue;
      g.fillStyle = tv >= 24 ? D_WHITE[tv - 24] : D_SILVER[tv];
      const o = i * 4;
      g.beginPath();
      for (let c = 0; c < 4; c++) {
        const X = cx + (Dm.qx[o + c] * ca + Dm.qz[o + c] * sa) * R;
        const Y = cy + Dm.qy[o + c] * R;
        c === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y);
      }
      g.closePath(); g.fill();
    }

    // Fast lyssetting oppaa den roterende kula: lyspunkt oppe til venstre,
    // mork kant rundt. Det er dette som gjor at den leser som en KULE.
    const vg = g.createRadialGradient(cx - R * 0.34, cy - R * 0.38, R * 0.04, cx, cy, R * 1.02);
    vg.addColorStop(0, 'rgba(255,255,255,.10)');
    vg.addColorStop(0.62, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(5,4,10,.60)');
    g.fillStyle = vg;
    g.beginPath(); g.arc(cx, cy, R * 1.02, 0, 6.2832); g.fill();

    // --- glimt der et speil sender lyset rett mot deg
    if (ng) {
      g.globalCompositeOperation = 'lighter';
      for (let j = 0; j < ng; j++) {
        const sz = R * (0.22 + this.dGV[j] * 0.28) * (1 + pulse * 0.6);
        g.globalAlpha = Math.min(1, 0.35 + this.dGV[j] * 0.65);
        g.drawImage(this.dStar, this.dGX[j] - sz / 2, this.dGY[j] - sz / 2, sz, sz);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    if (this.dFlash > 0.02) {
      g.fillStyle = `rgba(255,252,245,${(this.dFlash * 0.10).toFixed(3)})`;
      g.fillRect(0, 0, W, H);
    }
  }

  // =========================================================================
  //  Soyler — hele bredden, med baller som blir slaatt opp
  // =========================================================================
  // Ti baand gir ti soyler, og ti soyler fyller ikke en skjerm. Vi
  // interpolerer mellom baandene i stedet: fire ganger saa mange soyler,
  // samme maaledata. Kurven mellom to baand er en glatt overgang, ikke
  // oppdiktet opplosning.

  /** Hoyden en soyle faktisk tegnes med — hvile og musikk blandet. */
  _colFrac(c) {
    const idle = IDLE_H * (0.82 + 0.18 * Math.sin(c * 0.42 + this.phase * 0.5));
    const span = FLOOR - (TOP_LIMIT + 0.04);
    return Math.max(0.010, idle + (span * this.CH[c] - idle) * this.live);
  }

  /** Flytter ett objekt ett bilde.
   *  rFrac  = radius i hoydeenheter, rxFrac = radius i breddeenheter. */
  _stepBall(o, s, rFrac, rxFrac) {
    o.vy += G_BALL * s;
    o.y  += o.vy * s;
    o.x  += o.vx * s;
    if (o.x < rxFrac)     { o.x = rxFrac;     o.vx =  Math.abs(o.vx); }
    if (o.x > 1 - rxFrac) { o.x = 1 - rxFrac; o.vx = -Math.abs(o.vx); }

    // En ball er bredere enn en soyle og hviler paa flere samtidig. Ser vi
    // bare paa soyla under midten, synker den ned i en hoyere nabo. Loefter
    // vi den med hele radien for den hoyeste soyla innenfor bredden, staar
    // den paa luft saa snart en hoy soyle bare saa vidt roerer kanten.
    // Riktig svar foelger av formen: en sirkel som roerer et stykke ute fra
    // midten ligger lavere, med klaringa r*sqrt(1-u^2). Vi tar den strengeste.
    const c0 = Math.max(0, Math.floor((o.x - rxFrac) * this.COLS));
    const c1 = Math.min(this.COLS - 1, Math.floor((o.x + rxFrac) * this.COLS));
    let yRest = Infinity, c = -1;
    for (let k = c0; k <= c1; k++) {
      const u = ((k + 0.5) / this.COLS - o.x) / rxFrac;
      if (u <= -1 || u >= 1) continue;
      const req = FLOOR - this._colFrac(k) - rFrac * Math.sqrt(1 - u * u);
      if (req < yRest) { yRest = req; c = k; }
    }

    if (c >= 0 && o.y > yRest) {
      const impact = Math.abs(o.vy);
      o.y = yRest;
      const rise = (this.CTOP[c] - (FLOOR - this._colFrac(c))) / s;
      // Taket paa 1,6 gir et toppunkt paa drovt en halv skjerm. Uten det
      // ville et hardt slag sendt ballen ut av bildet.
      const kick = Math.min(1.6, Math.max(0, rise) * 0.85);
      // Tre tilfeller, ikke ett. Med bare ett fikk en ball i ro et lite
      // spark hver eneste ramme av at hvilebolgen steg saa vidt under den.
      if (kick > 0.25)        o.vy = -kick;              // et ekte slag
      else if (impact > 0.25) o.vy = -impact * 0.28;     // sprett etter fall
      else                    o.vy = 0;                  // hviler
    }
    if (o.y < 0.04) { o.y = 0.04; o.vy = Math.abs(o.vy) * 0.4; }
  }

  _drawBars(dt) {
    const g = this.g, W = this.W, H = this.H;
    const s = Math.min(dt, 50) / 1000;
    g.fillStyle = PALETTE.sky; g.fillRect(0, 0, W, H);

    const want = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(W / this.dpr / 26)));
    if (want !== this.COLS) {
      this.COLS = want;
      this.CH = new Float32Array(want);
      this.CTOP = new Float32Array(want).fill(FLOOR);
    }

    // Hvor mye lyd er det? Naar det er stille glir soylene tilbake til
    // hvilehoyden; naar musikken gaar overtar den helt. Overgangen tar drovt
    // et sekund hver vei, saa den ikke rykker i pausen mellom to laater.
    let sum = 0;
    for (let n = 0; n < NB; n++) sum += this.BV[n];
    this.live += ((sum > 0.0025 ? 1 : 0) - this.live) * (1 - Math.exp(-dt / 900));

    for (let n = 0; n < NB; n++) {
      const v = Math.min(1, this._bandRel(n) * this.gain * 1.5);
      this.BY[n] += (v - this.BY[n]) * (1 - Math.exp(-dt / 55));
    }

    const slot = W / this.COLS, bw = slot * 0.72;
    const rad = Math.min(bw * 0.5, H * 0.014);
    for (let c = 0; c < this.COLS; c++) {
      const f = c / (this.COLS - 1) * (NB - 1);
      const i0 = Math.floor(f), i1 = Math.min(NB - 1, i0 + 1), u = f - i0;
      this.CH[c] = this.BY[i0] + (this.BY[i1] - this.BY[i0]) * u;

      const h = Math.max(H * 0.010, H * this._colFrac(c));
      g.fillStyle = c < this.COLS * 0.3 ? PALETTE.l3
                  : c < this.COLS * 0.6 ? PALETTE.l2 : PALETTE.l1;
      g.beginPath();
      g.roundRect(c * slot + (slot - bw) / 2, H * FLOOR - h, bw, h, [rad, rad, 0, 0]);
      g.fill();
    }

    const minWH = Math.min(W, H);
    for (const b of this.balls) {
      this._stepBall(b, s, b.r * (minWH / H), b.r * (minWH / W));
      g.fillStyle = PALETTE.accent;
      g.beginPath(); g.arc(W * b.x, H * b.y, minWH * b.r, 0, Math.PI * 2); g.fill();
    }

    for (let c = 0; c < this.COLS; c++) this.CTOP[c] = FLOOR - this._colFrac(c);
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
