// ============================================================================
//  sync.js — felles tidsbase for flere enheter i samme rom
//
//  Tre uavhengige problemer loses her:
//
//   1. Enhetene har ingen felles nullpunkt. performance.now() teller fra
//      sidelasting, Date.now() er veggklokke som NTP kan STEPPE midt i drift.
//      Losning: vi sammenligner aldri absolutte klokker. Vi maler differansen
//      med en NTP-utveksling, og all lokal timing bruker performance.now(),
//      som er monoton og aldri hopper.
//
//   2. Malingen har selv forsinkelse. Losningen er formelen under: den
//      symmetriske delen av nettverksforsinkelsen KANSELLERER. Vi trenger
//      aldri vite hvor lang forsinkelsen er.
//
//   3. Lydklokka er ikke systemklokka. Selv med perfekt synkroniserte
//      systemklokker gar lydkortets krystall i sin egen takt.
//      AudioClockTracker maler det direkte.
// ============================================================================


// ---------------------------------------------------------------------------
//  Minste kvadraters rett linje gjennom (x, y). Returnerer {a, b}: y = a + b*x
// ---------------------------------------------------------------------------
function linearFit(points) {
  const n = points.length;
  if (n === 0) return { a: 0, b: 0 };
  if (n === 1) return { a: points[0].y, b: 0 };

  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;

  let sxy = 0, sxx = 0;
  for (const p of points) {
    const dx = p.x - mx;
    sxy += dx * (p.y - my);
    sxx += dx * dx;
  }
  if (sxx === 0) return { a: my, b: 0 };

  const b = sxy / sxx;
  return { a: my - b * mx, b };
}


// ===========================================================================
//  ClockSync — estimerer serverens klokke ut fra den lokale monotone klokka.
// ===========================================================================
export class ClockSync {
  constructor(opts = {}) {
    // 120 sekunder og de 24 beste, ikke 30 og 8. Malt paa simulert nett med
    // 60 ms ko gikk verste feil i estimert servertid ett sekund fram fra
    // 9,2 ms til 3,4 ms, og taktestimatet fra 46 ppm (sant 20) til 22.
    // Et lengre vindu koster bare at et EKTE sprang tar lenger tid aa
    // vaske ut — derfor oppdager vi sprang i stedet, se under.
    this.windowMs   = opts.windowMs   ?? 120000; // hvor lenge en maling teller
    this.keepBest   = opts.keepBest   ?? 24;     // hvor mange lav-RTT-malinger vi tilpasser
    this.minSamples = opts.minSamples ?? 4;

    // Serveren teller fra null hver gang den starter. Etter en omstart er
    // alle gamle malinger feil med hele oppetida til den forrige serveren,
    // og de blir liggende og odelegge til de faller ut av vinduet. Tre
    // malinger paa rad som spriker fra modellen er et sprang, ikke stoy.
    this.stepGuard = opts.stepGuard ?? 3;
    this._offSpree = 0;
    this.steps = 0;

    this.samples = [];     // { local, offset, rtt }
    this._fit    = { a: 0, b: 0 };
    this._t0     = null;
    this.ready   = false;
  }

  /**
   * En fullfort NTP-utveksling.
   *   t1 — lokal tid da vi sendte      (performance.now())
   *   t2 — servertid ved mottak
   *   t3 — servertid ved svar
   *   t4 — lokal tid da svaret kom     (performance.now())
   *
   * offset = ((t2-t1) + (t3-t4)) / 2
   *
   * Skriver man den ut med reell forsinkelse d_opp og d_ned og sann
   * klokkeforskjell O, blir den til:
   *
   *   maalt = O + (d_opp - d_ned) / 2
   *
   * Den symmetriske delen forsvinner helt. Det som star igjen er halvparten
   * av ASYMMETRIEN i banen — derfor beholder vi malingene med lavest RTT:
   * lav RTT betyr lite koforsinkelse, altsa minst asymmetri.
   */
  addExchange(t1, t2, t3, t4) {
    const rtt    = (t4 - t1) - (t3 - t2);
    const offset = ((t2 - t1) + (t3 - t4)) / 2;

    if (rtt < 0) return;                      // umulig maling, kast den

    // Sprang? En koforsinkelse kan bare skyve offset med halve RTT-en, saa
    // et avvik paa mange ganger det er noe annet enn nett.
    if (this.ready && this.samples.length >= this.minSamples) {
      const grense = Math.max(100, 10 * this.minRtt);
      if (Math.abs(offset - this._fit.a - this._fit.b * (t4 - this._t0)) > grense) {
        if (++this._offSpree >= this.stepGuard) { this.reset(); this.steps++; }
      } else {
        this._offSpree = 0;
      }
    }

    if (this._t0 === null) this._t0 = t4;
    this.samples.push({ local: t4, offset, rtt });

    // Behold bare det siste vinduet
    const cutoff = t4 - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].local < cutoff) {
      this.samples.shift();
    }
    this._refit();
  }

  _refit() {
    if (this.samples.length < this.minSamples) {
      // For fa malinger: bruk den beste enkeltmalingen forelopig
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a), this.samples[0]);
      if (best) {
        this._fit  = { a: best.offset, b: 0 };
        this._t0   = best.local;
        this.ready = this.samples.length >= 2;
      }
      return;
    }

    // Velg de N malingene med lavest RTT. Ikke gjennomsnitt av alt —
    // et snitt drar med seg nettopp de daarlige malingene vi vil bli kvitt.
    const best = [...this.samples]
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, Math.min(this.keepBest, this.samples.length));

    // Tilpass en LINJE, ikke et punkt: stigningstallet fanger opp at de to
    // krystallene gaar i ulik takt, sa estimatet holder mellom malingene.
    this._fit = linearFit(best.map(s => ({ x: s.local - this._t0, y: s.offset })));
    this.ready = true;
  }

  /** Glem alt. Kalles ved gjenoppkobling: serveren kan ha startet paa nytt,
   *  og da er hver eneste gamle maling feil. */
  reset() {
    this.samples = [];
    this._fit = { a: 0, b: 0 };
    this._t0 = null;
    this.ready = false;
    this._offSpree = 0;
  }

  /** Estimert servertid (ms) for et gitt lokalt performance.now()-tidspunkt. */
  serverTimeAt(localMs) {
    const { a, b } = this._fit;
    return localMs + a + b * (localMs - this._t0);
  }

  /** Estimert servertid akkurat naa. */
  serverNow() {
    return this.serverTimeAt(performance.now());
  }

  /** Lokal performance.now()-tid som svarer til en gitt servertid. */
  localTimeAt(serverMs) {
    // serverMs = L + a + b*(L - t0)  =>  L = (serverMs - a + b*t0) / (1 + b)
    const { a, b } = this._fit;
    return (serverMs - a + b * this._t0) / (1 + b);
  }

  /**
   * Den lokale klokkas taktavvik mot serveren, i ppm.
   * POSITIVT = min klokke gaar for fort.
   *
   * (Tilpasningen gir d(offset)/dt, og offset = server - lokal, sa en lokal
   *  klokke som gaar for fort gir NEGATIVT stigningstall. Vi snur fortegnet
   *  her sa verdien betyr det man intuitivt forventer.)
   */
  get skewPpm()  { return -this._fit.b * 1e6; }
  get offsetMs() { return this._fit.a; }
  get minRtt()   { return this.samples.length ? Math.min(...this.samples.map(s => s.rtt)) : NaN; }
  get lastRtt()  { return this.samples.length ? this.samples[this.samples.length - 1].rtt : NaN; }

  /**
   * Grov usikkerhet: halve den laveste RTT-en er den teoretiske grensa for
   * hvor godt vi kan vite offset uten a kjenne baneasymmetrien.
   */
  get uncertaintyMs() { return this.minRtt / 2; }
}


// ===========================================================================
//  AudioClockTracker — maler lydklokka mot systemklokka.
//
//  Dette er problemet som drepte synctest: to lydkort teller ikke like fort.
//  getOutputTimestamp() gir oss par av (contextTime, performanceTime) referert
//  til selve DAC-en, sa stigningstallet mellom dem ER driften — malt direkte,
//  ikke utledet fra kolengde.
// ===========================================================================
export class AudioClockTracker {
  constructor(audioContext, opts = {}) {
    this.ctx = audioContext;

    // Takten er en egenskap ved krystallen — den endrer seg ikke fra sekund
    // til sekund. Derfor tilpasses den over LANG tid. Et kort vindu her er
    // nettopp det som gir "driften hopper mellom -5 og +14 ppm": det er ikke
    // drift man ser, det er maalestoy forsterket av en for kort linje.
    this.rateWindowMs    = opts.rateWindowMs    ?? 120000;
    this.minRateSpreadMs = opts.minRateSpreadMs ?? 20000;

    // Offset skal derimot folge raskt — men taale trinnstoy. Derfor median.
    this.offsetWindowMs  = opts.offsetWindowMs  ?? 4000;

    // Et brudd i lydklokka er ikke drift. Naar en ny maling spretter mer enn
    // dette fra modellen, har noe stanset eller hoppet — og da er historikken
    // verdilos, ikke stoyete.
    this.jumpMs = opts.jumpMs ?? 40;

    this.samples = [];       // { p: performanceTime ms, c: contextTime ms }
    this.source  = null;     // 'timestamp' | 'fallback'
    this.resets  = 0;        // hvor mange brudd vi har sett
    this._p0     = null;
    this._rate   = 1;        // ms lydklokke per ms systemklokke
    this._offset = 0;        // ms
    this.ready   = false;
  }

  /** Glem alt. Kalles naar utgangen byttes: da endres bade forsinkelsen og
   *  selve pipelinen, og maalingene fra for gjelder ikke lenger. */
  reset() {
    this.samples = [];
    this._p0 = null;
    this._offset = 0;
    this.ready = false;
    this.resets++;
    // Takten beholdes — krystallen er den samme selv om utgangen byttes.
  }

  _read() {
    if (typeof this.ctx.getOutputTimestamp === 'function') {
      const ts = this.ctx.getOutputTimestamp();
      if (ts && isFinite(ts.performanceTime) && ts.performanceTime > 0 && ts.contextTime > 0) {
        // Sanity: contextTime skal ALLTID ligge bak currentTime, for lyden som
        // kommer ut naa ble rendret for en stund siden. Er etterslepet ~0, gir
        // ikke nettleseren en DAC-referert verdi — den speiler bare currentTime.
        // Stoler vi paa den da, kompenserer vi ingenting, og enheten spiller
        // hele utgangsbufferet for tidlig. Det er lett aa forveksle med drift.
        const lagMs = (this.ctx.currentTime - ts.contextTime) * 1000;
        if (lagMs > 0.5) {
          return { p: ts.performanceTime, c: ts.contextTime * 1000, src: 'timestamp' };
        }
        this.timestampRejected = true;
      }
    }
    return {
      p: performance.now(),
      c: (this.ctx.currentTime - (this.ctx.outputLatency || 0)) * 1000,
      src: 'fallback',
    };
  }

  /** Kall denne jevnlig — 4 ganger i sekundet er passe. */
  sample() {
    const s = this._read();

    // De to kildene maler IKKE det samme: getOutputTimestamp er referert til
    // DAC-en, reserven trekker fra outputLatency for hand. Blander man dem i
    // samme tilpasning blir resultatet sopp. Bytter kilden, starter vi paa nytt.
    if (this.source !== s.src) {
      this.source  = s.src;
      this.samples = [];
      this._p0     = null;
      this._rate   = 1;
      this._offset = 0;
      this.ready   = false;
    }

    if (this._p0 === null) this._p0 = s.p;

    // getOutputTimestamp oppdateres i trinn — samme verdi flere ganger paa rad
    // sier ingenting nytt og skjevfordeler tilpasningen.
    const last = this.samples[this.samples.length - 1];
    if (last && s.p === last.p) return;

    // BRUDD. Stopper lydklokka mens systemklokka gaar videre — fanestruping,
    // bytte av utgangsenhet, Bluetooth som kobler seg paa, et oyeblikks dvale
    // — legges det en knekk midt i linja, og HELE takten blir feil. Malt paa
    // en simulert klokke med sant avvik +25 ppm ga ett sekunds stans et
    // estimat paa -9900 ppm, altsa et halvt sekund feil per minutt, og
    // tilstanden varte til malingen falt ut av vinduet to minutter senere.
    //
    // Vi kan ikke glatte oss ut av dette. Et brudd maa oppdages og
    // historikken kastes: modellen fra for bruddet gjelder ikke lenger.
    if (this.ready && last) {
      const forventet = this._offset + this._rate * (s.p - this._p0);
      if (Math.abs(s.c - forventet) > this.jumpMs) {
        this.samples = [];
        this._p0 = s.p;
        this._offset = 0;
        this.ready = false;
        this.resets++;
        // Takten beholdes: krystallen er den samme etter et brudd, og et
        // gammelt takt-estimat er langt bedre enn ingen mens vi bygger opp
        // et nytt tidsspenn.
      }
    }

    this.samples.push({ p: s.p, c: s.c });

    const cutoff = s.p - this.rateWindowMs;
    while (this.samples.length > 2 && this.samples[0].p < cutoff) this.samples.shift();

    this._recompute();
  }

  _recompute() {
    const n = this.samples.length;
    if (n < 4) return;

    const spread = this.samples[n - 1].p - this.samples[0].p;

    // TAKT — bare naar vi har nok tidsspenn til at stigningstallet betyr noe.
    if (spread >= this.minRateSpreadMs) {
      const fit = linearFit(this.samples.map(x => ({ x: x.p - this._p0, y: x.c })));
      // Vern mot tull. Var grensa 10000 ppm, og den slapp gjennom alt
      // bruddene lagde: ett sekunds stans ga -9900 ppm, rett innenfor.
      // Ingen ekte krystall bommer med mer enn et par hundre ppm.
      if (isFinite(fit.b) && Math.abs(fit.b - 1) < 300e-6) this._rate = fit.b;
    }

    // OFFSET — median av residualene i et kort vindu. Median, ikke snitt:
    // trinnstoyen er ikke normalfordelt, og et snitt lar den slaa gjennom.
    const cut = this.samples[n - 1].p - this.offsetWindowMs;
    const resid = this.samples
      .filter(x => x.p >= cut)
      .map(x => x.c - this._rate * (x.p - this._p0))
      .sort((a, b) => a - b);

    const mid = Math.floor(resid.length / 2);
    this._offset = resid.length % 2 ? resid[mid] : (resid[mid - 1] + resid[mid]) / 2;

    this.ready = true;
  }

  /** AudioContext-tid (sekunder) hvis LYD kommer ut paa gitt performance.now(). */
  contextTimeAt(performanceMs) {
    return (this._offset + this._rate * (performanceMs - this._p0)) / 1000;
  }

  /**
   * Motsatt vei: hvilken performance.now()-tid svarer en AudioContext-tid til.
   * Senderen trenger denne for aa tidsstemple lyd den nettopp fanget. Uten den
   * maa man lese ctx.currentTime paa slump, og den hopper i kvanter — det gir
   * noen millisekunder skjelving i hvert eneste tidsstempel.
   */
  performanceTimeAt(contextSec) {
    return this._p0 + (contextSec * 1000 - this._offset) / this._rate;
  }

  /** Lydklokkas taktavvik mot systemklokka, i ppm. Skal ligge stabilt. */
  get driftPpm() { return (this._rate - 1) * 1e6; }

  /** Hvor mange malinger taktestimatet hviler paa. */
  get rateSpreadMs() {
    const n = this.samples.length;
    return n >= 2 ? this.samples[n - 1].p - this.samples[0].p : 0;
  }

  /**
   * Kompensasjonen som FAKTISK brukes, i ms.
   *
   * Dette er diagnosen: verdien skal ligge nar ctx.outputLatency. Gjor den
   * ikke det, er ikke utgangsforsinkelsen kompensert — og da spiller enheter
   * med ulik outputLatency ut av synk med nettopp den differansen.
   */
  get compensationMs() {
    if (!this.ready) return NaN;
    return (this.ctx.currentTime - this.contextTimeAt(performance.now())) * 1000;
  }
}


// ===========================================================================
//  SyncedPlayer — planlegger lyd pa en FELLES servertid.
//
//  Hele kjeden: servertid → lokal monoton tid → AudioContext-tid.
//  Alle enheter far samme servertid inn, og treffer derfor samme oyeblikk ut,
//  uansett hvor ulike klokkene deres er.
// ===========================================================================
export class SyncedPlayer {
  constructor(audioContext, clockSync, audioClock) {
    this.ctx        = audioContext;
    this.clock      = clockSync;
    this.audioClock = audioClock;
    // Positiv = spill SENERE. Samme fortegn som "+ = add delay" i synctest.
    this.manualOffsetMs = 0;
  }

  /**
   * Regner om en servertid til et tidspunkt a gi til source.start().
   * Returnerer null hvis oyeblikket allerede har passert.
   */
  scheduleTimeFor(serverMs) {
    if (!this.clock.ready) return null;

    const localMs = this.clock.localTimeAt(serverMs + this.manualOffsetMs);

    const when = this.audioClock.ready
      ? this.audioClock.contextTimeAt(localMs)
      // Reserve: ga via currentTime og kompenser for utgangsforsinkelsen
      : this.ctx.currentTime + (localMs - performance.now()) / 1000
                             - (this.ctx.outputLatency || 0);

    return when > this.ctx.currentTime ? when : null;
  }

  /**
   * Kort klikk pa et gitt servertidspunkt.
   * Returnerer AudioContext-tida det ble lagt paa, eller null hvis oyeblikket
   * allerede var passert. Mikrofonmalingen trenger den verdien for aa vite
   * hva den skal sammenligne opptaket mot.
   */
  scheduleClick(serverMs, { freq = 1200, ms = 25, gain = 0.25 } = {}) {
    const when = this.scheduleTimeFor(serverMs);
    if (when === null) return null;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.frequency.value = freq;
    osc.connect(env).connect(this.ctx.destination);

    const dur = ms / 1000;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(gain, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.start(when);
    osc.stop(when + dur + 0.02);
    return when;          // AudioContext-tida klikket ble lagt paa
  }
}
