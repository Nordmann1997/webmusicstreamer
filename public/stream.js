// ============================================================================
//  stream.js — sender og mottar lyd paa den felles tidsbasen.
//
//  Hver pakke baerer tidspunktet lyden ble FANGET, uttrykt i servertid. Hver
//  mottaker legger til den samme bufferforsinkelsen og planlegger avspilling
//  gjennom noyaktig samme SyncedPlayer som allerede planlegger klikkene.
//
//  Derfor treffer alle mottakere samme oyeblikk: de regner seg ikke fram til
//  "naa", de regner seg fram til et FELLES tidspunkt.
// ============================================================================

import { DriftCorrector, applySampleCorrection } from './drift.js';

const MAGIC      = 0x41554449;   // "AUDI" — raa PCM
const MAGIC_OPUS = 0x4f505553;   // "OPUS" — komprimert
export const HEADER_BYTES = 24;
export const OPUS_HEADER_BYTES = 16;

export const OPUS_CONFIG = {
  codec: 'opus',
  sampleRate: 48000,             // Opus stotter bare 8/12/16/24/48 kHz
  numberOfChannels: 2,
  bitrate: 128000,               // ~12x mindre enn raa PCM, og transparent nok for musikk
};

// Opus-ramme paa 20 ms ved 48 kHz. Vi fanger i noyaktig samme storrelse, sa
// blokkene vaare faller sammen med koderens egne rammer.
export const OPUS_FRAME = 960;

/**
 * Opus-pakke: liten header + koderens egen nyttelast.
 *
 * Tidsstempelet foreres inn i AudioData og folger med gjennom bade koding og
 * dekoding — WebCodecs garanterer at dekoderen gir det tilbake uendret. Derfor
 * trenger vi ikke holde styr paa hvilken pakke som horer til hvilken tid.
 */
export function encodeOpusPacket({ seq, timestampUs, payload }) {
  const buf = new ArrayBuffer(OPUS_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC_OPUS, true);
  dv.setUint32(4, seq, true);
  dv.setFloat64(8, timestampUs, true);
  new Uint8Array(buf, OPUS_HEADER_BYTES).set(new Uint8Array(payload));
  return buf;
}

export function decodeOpusPacket(buf) {
  if (buf.byteLength <= OPUS_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC_OPUS) return null;
  return {
    seq:         dv.getUint32(4, true),
    timestampUs: dv.getFloat64(8, true),
    payload:     buf.slice(OPUS_HEADER_BYTES),
  };
}

/** Hvilket format er dette? Leser bare de fire forste bytene. */
export function packetKind(buf) {
  if (buf.byteLength < 4) return null;
  const m = new DataView(buf).getUint32(0, true);
  return m === MAGIC ? 'pcm' : m === MAGIC_OPUS ? 'opus' : null;
}

/** Finnes WebCodecs med Opus i denne nettleseren? */
export async function opusSupported() {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return false;
  try {
    const enc = await AudioEncoder.isConfigSupported(OPUS_CONFIG);
    const dec = await AudioDecoder.isConfigSupported({
      codec: OPUS_CONFIG.codec,
      sampleRate: OPUS_CONFIG.sampleRate,
      numberOfChannels: OPUS_CONFIG.numberOfChannels,
    });
    return !!(enc.supported && dec.supported);
  } catch { return false; }
}

// Header (little-endian):
//   0  uint32   magic
//   4  uint32   sekvensnummer
//   8  float64  servertid (ms) for forste sample
//  16  uint32   samplingsrate
//  20  uint16   kanaler
//  22  uint16   frames
//  24  int16[]  interleavede samples
export function encodePacket({ seq, serverTime, sampleRate, channels, frames, ch0, ch1 }) {
  const buf = new ArrayBuffer(HEADER_BYTES + frames * channels * 2);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, seq, true);
  dv.setFloat64(8, serverTime, true);
  dv.setUint32(16, sampleRate, true);
  dv.setUint16(20, channels, true);
  dv.setUint16(22, frames, true);

  const pcm = new Int16Array(buf, HEADER_BYTES);
  for (let i = 0, j = 0; i < frames; i++) {
    // Klipp for konvertering — ellers folder verdier over 1.0 rundt til
    // motsatt fortegn, som hores som kraftig forvrengning.
    let a = ch0[i]; if (a > 1) a = 1; else if (a < -1) a = -1;
    pcm[j++] = a * 32767;
    if (channels > 1) {
      let b = ch1[i]; if (b > 1) b = 1; else if (b < -1) b = -1;
      pcm[j++] = b * 32767;
    }
  }
  return buf;
}

export function decodePacket(buf) {
  if (buf.byteLength < HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) return null;

  const channels = dv.getUint16(20, true);
  const frames   = dv.getUint16(22, true);
  if (channels < 1 || channels > 2 || frames < 1) return null;
  if (buf.byteLength < HEADER_BYTES + frames * channels * 2) return null;

  const pcm = new Int16Array(buf, HEADER_BYTES, frames * channels);
  const ch0 = new Float32Array(frames);
  const ch1 = new Float32Array(frames);
  for (let i = 0, j = 0; i < frames; i++) {
    ch0[i] = pcm[j++] / 32767;
    ch1[i] = channels > 1 ? pcm[j++] / 32767 : ch0[i];
  }
  return {
    seq:        dv.getUint32(4, true),
    serverTime: dv.getFloat64(8, true),
    sampleRate: dv.getUint32(16, true),
    channels, frames, ch0, ch1,
  };
}


// ===========================================================================
//  AudioSender — fanger systemlyden og sender den ut.
// ===========================================================================
export class AudioSender {
  constructor(ctx, clock, ws, opts = {}) {
    this.ctx = ctx;
    this.clock = clock;
    this.audioClock = opts.audioClock ?? null;

    // Socketen hentes gjennom en funksjon, ikke lagres som verdi.
    //
    // Faller forbindelsen (serveromstart, WiFi-hikke), lager klienten en NY
    // WebSocket. Hadde vi holdt paa den gamle, ville senderen fortsatt sendt
    // inn i en lukket socket i det uendelige: den selv horer lyden fint via
    // onlocalpacket, mens ingen av lytterne far noe som helst.
    this._getWs = typeof ws === 'function' ? ws : () => ws;

    this.onlocalpacket = null;      // sa senderen kan spille sin egen strom
    this.suppressed = false;
    this.blockSize = opts.blockSize ?? OPUS_FRAME;   // 20 ms, samme som Opus-ramma
    this.seq = 0;
    this.sent = 0;
    this.bytesSent = 0;
    this.running = false;
    this.codec = 'pcm';
    this.encoder = null;
    this.forcePcm = opts.forcePcm ?? false;
  }

  /** Alltid den gjeldende socketen, aldri en utdatert kopi. */
  get ws() { return this._getWs(); }

  /** Setter opp Opus-koderen. Faller stille tilbake til raa PCM hvis den ikke finnes. */
  async _initCodec() {
    // Lytterne kan ha en nettleser som ikke dekoder Opus — WebCodecs
    // AudioDecoder kom forst i Safari 26. Da ma senderen bruke raa PCM, for
    // formatet velges her og forhandles ikke.
    if (this.forcePcm || !(await opusSupported())) {
      this.codec = 'pcm';
      return;
    }
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (!this.running || this.ws.readyState !== WebSocket.OPEN) return;
        const payload = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(payload);
        const buf = encodeOpusPacket({
          seq: this.seq++,
          timestampUs: chunk.timestamp,      // uendret hele veien fra fangst
          payload,
        });
        this.ws.send(buf);
        this.sent++;
        this.bytesSent += buf.byteLength;
        this.onlocalpacket?.(buf);
      },
      error: (e) => {
        console.error('Opus-koder feilet, gaar over til raa PCM:', e);
        this.codec = 'pcm';
        this.encoder = null;
      },
    });
    this.encoder.configure(OPUS_CONFIG);
    this.codec = 'opus';
  }

  /**
   * @param mode      'display' = skjerm/fane, 'input' = en lydinngang
   * @param deviceId  naar mode er 'input': hvilken inngang (f.eks. BlackHole)
   */
  async start({ mode = 'display', deviceId = null } = {}) {
    await this._initCodec();

    const stream = mode === 'input'
      ? await this._openInput(deviceId)
      : await this._openDisplay();

    await this.ctx.audioWorklet.addModule('./capture-worklet.js');

    const src = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'capture', {
      processorOptions: { blockSize: this.blockSize },
      numberOfOutputs: 0,
    });

    node.port.onmessage = (e) => this._onBlock(e.data);
    src.connect(node);

    this.stream = stream;
    this.node = node;
    this.running = true;
    this.mode = mode;

    stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop());
  }

  /**
   * Fanger fra en lydinngang — typisk en virtuell loopback-enhet som BlackHole.
   * Da settes maskinens utgang til BlackHole (og blir stille i hoyttalerne),
   * mens nettleseren spiller den forsinkede utgaven ut paa de EKTE hoyttalerne
   * via setSinkId. Det er den eneste maaten aa faa lyd fra en skrivebords-app
   * uten ekko: suppressLocalAudioPlayback virker bare for fane-lyd.
   */
  async _openInput(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });
    this.suppressed = true;    // kilden naar aldri hoyttalerne
    return stream;
  }

  async _openDisplay() {
    // Chrome krever at video etterspores for aa vise kildevelgeren; vi stopper
    // videosporet med en gang og beholder bare lyden.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // Ber nettleseren la vaere aa spille den fangede lyden lokalt.
        // Virker for FANE-lyd (Chrome 109+); for hele systemlyden gjor den
        // ingenting, og da ma maskinens eget volum ned manuelt.
        suppressLocalAudioPlayback: true,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });

    stream.getVideoTracks().forEach(t => t.stop());
    const audio = stream.getAudioTracks();
    if (audio.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error(
        'Ingen lyd i delingen. Huk av for «Del fanens lyd» (eller «Del systemlyd») i dialogen.');
    }
    // Fikk vi faktisk dempet den lokale avspillingen? Ikke gjett — spor sporet.
    this.suppressed = audio[0].getSettings?.().suppressLocalAudioPlayback === true;
    return stream;
  }

  _onBlock({ t, ch0, ch1 }) {
    if (!this.running || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.clock.ready) return;              // uten klokke er tidsstempelet verdilost

    // AudioContext-tid → lokal monoton tid → servertid.
    const localMs  = this._contextToLocal(t);
    const serverMs = this.clock.serverTimeAt(localMs);

    if (this.encoder && this.codec === 'opus') {
      // Servertida legges i AudioData-tidsstempelet og folger med gjennom
      // koderen. Pakken sendes fra output-tilbakekallet over.
      const planar = new Float32Array(ch0.length * 2);
      planar.set(ch0, 0);
      planar.set(ch1, ch0.length);

      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: OPUS_CONFIG.sampleRate,
        numberOfFrames: ch0.length,
        numberOfChannels: 2,
        timestamp: Math.round(serverMs * 1000),   // mikrosekunder
        data: planar,
      });
      this.encoder.encode(data);
      data.close();
      return;
    }

    const buf = encodePacket({
      seq: this.seq++,
      serverTime: serverMs,
      sampleRate: this.ctx.sampleRate,
      channels: 2,
      frames: ch0.length,
      ch0, ch1,
    });

    this.ws.send(buf);
    this.sent++;
    this.bytesSent += buf.byteLength;

    // Senderen kan spille sin EGEN strom, med samme bufferforsinkelse som alle
    // andre. Da er kilden ogsa i takt — ellers ligger den alltid foran, fordi
    // ingenting forteller den at den skal vente.
    this.onlocalpacket?.(buf);
  }

  _contextToLocal(contextTime) {
    // Bruk det filtrerte estimatet naar vi har det. Aa lese ctx.currentTime
    // paa slump gir noen ms skjelving i hvert tidsstempel, og den skjelvingen
    // blir til hull og overlapp mellom pakkene hos mottakeren — altsaa skurring.
    if (this.audioClock?.ready) return this.audioClock.performanceTimeAt(contextTime);
    return performance.now() + (contextTime - this.ctx.currentTime) * 1000;
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.node?.disconnect(); } catch {}
    try { this.encoder?.close(); } catch {}
    this.encoder = null;
    this.onstopped?.();
  }
}


// ===========================================================================
//  PlaybackTimeline — bestemmer NAAR hver pakke skal starte.
//
//  Naiv losning: regn ut tidspunktet for hver pakke for seg, fra det felles
//  tidsestimatet. Det virker riktig, men estimatet beveger seg litt hele tida,
//  sa nabopakker faar tidspunkt som ikke henger noyaktig sammen. Et hull eller
//  en overlapp paa en brokdel av et millisekund gir et knepp — og med 47
//  pakker i sekundet blir det sammenhengende skurring.
//
//  Losning: bruk tidsestimatet til aa LEGGE UT tidslinja én gang, og la
//  deretter hver pakke folge rett etter den forrige, sample for sample.
//  Bare naar avviket blir stort nok til aa bety noe, synkroniserer vi paa nytt.
// ===========================================================================
export class PlaybackTimeline {
  constructor(opts = {}) {
    this.resyncSec = opts.resyncSec ?? 0.030;   // 30 ms for vi bryter tidslinja
    this.next = null;
    this.resyncs = 0;
    this.late = 0;

    // Uten denne vokser avviket til tidslinja ma brytes — og hvert brudd er
    // et horbart knepp. Med den fjernes eller dupliseres ett sample av gangen,
    // og avviket naar aldri dit.
    this.drift = new DriftCorrector(opts.drift);
  }

  /**
   * @param target  onsket starttidspunkt fra det felles estimatet (sek)
   * @param dur     pakkens lengde (sek)
   * @param now     ctx.currentTime
   * @returns {when, resync} eller null hvis pakken ikke rekker fram
   */
  /**
   * @param target      onsket starttidspunkt fra det felles estimatet (sek)
   * @param frames      antall samples i pakken
   * @param sampleRate
   * @param now         ctx.currentTime
   * @returns {when, resync, correction} eller null hvis pakken ikke rekker fram
   */
  place(target, frames, sampleRate, now) {
    let resync = false;

    if (this.next === null || Math.abs(this.next - target) > this.resyncSec) {
      this.next = target;
      this.drift.reset();
      resync = this.resyncs++ > 0 || false;
    }

    if (this.next <= now) {
      this.late++;
      this.next = null;
      return null;
    }

    // Positivt = vi legger pakken SENERE enn den felles klokka sier, altsa
    // henger vi etter og maa ta igjen ved aa fjerne samples.
    const errorSec = this.next - target;
    const correction = this.drift.update(errorSec, frames, sampleRate);

    const when = this.next;
    // Pakken blir `correction` samples kortere (eller lengre), og neste pakke
    // starter noyaktig der denne faktisk slutter.
    this.next += (frames - correction) / sampleRate;
    return { when, resync, correction };
  }

  reset() { this.next = null; }
}


// ===========================================================================
//  AudioReceiver — planlegger innkommende lyd paa felles tid.
// ===========================================================================
export class AudioReceiver {
  constructor(ctx, player, opts = {}) {
    this.ctx = ctx;
    this.player = player;

    // Hvor lenge etter fangst lyden skal spilles. Alle mottakere bruker
    // SAMME verdi, sa de holder seg sammen. Storre = mer motstandsdyktig
    // mot nettverkssvingninger, men lengre forsinkelse.
    //
    // 1000 ms som standard fordi dette normalt gaar over internett. Paa LAN
    // holder 400 fint; over nett koster ekstra buffer bare forsinkelse, mens
    // for lite buffer koster hakking — sa feilen tas heller paa den trygge sida.
    this.bufferMs = opts.bufferMs ?? 1000;

    this.gain = ctx.createGain();
    this.gain.gain.value = opts.volume ?? 1;
    this.gain.connect(ctx.destination);

    this.timeline = new PlaybackTimeline({ resyncSec: (opts.resyncMs ?? 30) / 1000 });

    this.received = 0;
    this.played = 0;
    this.late = 0;
    this.lastSeq = -1;
    this.gaps = 0;
    this.lastRate = 0;
    this.rateMismatch = false;
    this.bytesReceived = 0;
    this.codec = null;
    this.decoder = null;
    this.decodeErrors = 0;    // dekoderen selv sa fra
    this.copyErrors   = 0;    // dekodet fint, men vi klarte ikke lese ut lyden
    this.chunkErrors  = 0;    // pakken ble avvist for dekoding
    this.lastError    = '';
    this.lastFormat   = '';
    this.opusUnsupported = false;
  }

  /**
   * Opus-veien. Dekoderen er asynkron, sa planleggingen skjer i
   * output-tilbakekallet — der har vi bade lyden og tidsstempelet som fulgte
   * med den uendret hele veien fra senderen.
   */
  _onOpus(buf) {
    const p = decodeOpusPacket(buf);
    if (!p) return;
    this.received++;
    this.codec = 'opus';

    if (this.lastSeq >= 0 && p.seq > this.lastSeq + 1) this.gaps += p.seq - this.lastSeq - 1;
    if (p.seq > this.lastSeq) this.lastSeq = p.seq;

    if (!this.decoder) {
      if (typeof AudioDecoder === 'undefined') {
        this.decodeErrors++;
        this.opusUnsupported = true;
        this.lastError =
          'Denne nettleseren kan ikke dekode Opus (WebCodecs AudioDecoder ' +
          'kom i Safari 26). Be senderen huke av «Tving rå PCM».';
        return;
      }
      this.decoder = new AudioDecoder({
        output: (audioData) => this._playDecoded(audioData),
        error: (e) => {
          this.decodeErrors++;
          this.lastError = `dekoder: ${e.message || e}`;
          console.error('Opus-dekoder:', e);
        },
      });
      this.decoder.configure({
        codec: OPUS_CONFIG.codec,
        sampleRate: OPUS_CONFIG.sampleRate,
        numberOfChannels: OPUS_CONFIG.numberOfChannels,
      });
    }

    try {
      // Opus har ingen delta-rammer — hver pakke staar for seg.
      this.decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(p.timestampUs),
        data: p.payload,
      }));
    } catch (e) {
      this.chunkErrors++;
      this.lastError = `pakke: ${e.name} ${e.message}`;
    }
  }

  _playDecoded(audioData) {
    const frames   = audioData.numberOfFrames;
    const sr       = audioData.sampleRate;
    const channels = audioData.numberOfChannels;
    const fmt      = audioData.format;
    const serverMs = audioData.timestamp / 1000;      // tilbake til millisekunder

    this.lastFormat = fmt;

    const ch0 = new Float32Array(frames);
    const ch1 = new Float32Array(frames);

    try {
      // IKKE tving et format paa copyTo. Ber man om en konvertering
      // nettleseren ikke stotter, kaster den — og da feiler HVER pakke, selv om
      // dekodingen i seg selv gikk fint. Les heller det formatet vi faktisk fikk.
      if (fmt === 'f32-planar') {
        audioData.copyTo(ch0, { planeIndex: 0 });
        audioData.copyTo(ch1, { planeIndex: channels > 1 ? 1 : 0 });

      } else if (fmt === 'f32') {
        // Interleavet: alt ligger i ett plan.
        const inter = new Float32Array(frames * channels);
        audioData.copyTo(inter, { planeIndex: 0 });
        for (let i = 0; i < frames; i++) {
          ch0[i] = inter[i * channels];
          ch1[i] = channels > 1 ? inter[i * channels + 1] : ch0[i];
        }

      } else {
        // Ukjent eller heltallsformat — be om konvertering som siste utvei.
        audioData.copyTo(ch0, { planeIndex: 0, format: 'f32-planar' });
        audioData.copyTo(ch1, { planeIndex: channels > 1 ? 1 : 0, format: 'f32-planar' });
      }
    } catch (e) {
      this.copyErrors++;
      this.lastError = `${fmt}: ${e.name} ${e.message}`;
      audioData.close();
      return;
    }
    audioData.close();

    this.lastRate = sr;
    this._schedule({ serverTime: serverMs, sampleRate: sr, frames, ch0, ch1 });
  }

  onPacket(buf) {
    this.bytesReceived += buf.byteLength;

    if (packetKind(buf) === 'opus') { this._onOpus(buf); return; }

    const p = decodePacket(buf);
    if (!p) return;
    this.received++;
    this.lastRate = p.sampleRate;

    if (this.lastSeq >= 0 && p.seq > this.lastSeq + 1) this.gaps += p.seq - this.lastSeq - 1;
    if (p.seq > this.lastSeq) this.lastSeq = p.seq;

    this.codec = this.codec || 'pcm';
    this._schedule(p);
  }

  /** Felles for begge formater: legg blokka paa den delte tidslinja. */
  _schedule(p) {
    // Ulik samplingsrate betyr at hver pakke resamples for seg, og da faar man
    // artefakter i hver eneste pakkegrense uansett hvor god timingen er.
    this.rateMismatch = p.sampleRate !== Math.round(this.ctx.sampleRate);

    const target = this.player.scheduleTimeFor(p.serverTime + this.bufferMs);
    if (target === null) { this.late++; this.timeline.reset(); return; }

    const spot = this.timeline.place(target, p.frames, p.sampleRate, this.ctx.currentTime);
    if (spot === null) { this.late++; return; }
    const when = spot.when;

    // Fjern eller dupliser enkeltsamples for aa holde takten. Spredt utover
    // blokka, sa ingen enkeltendring blir horbar.
    const c = applySampleCorrection(p.ch0, p.ch1, spot.correction);

    const ab = this.ctx.createBuffer(2, c.frames, p.sampleRate);
    ab.copyToChannel(c.ch0, 0);
    ab.copyToChannel(c.ch1, 1);

    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gain);
    src.start(when);
    this.played++;

    // Gi blokka videre til den som vil se paa den — med tida den skal SPILLE
    // paa, ikke tida den kom. Det er den merkinga som gjor at en bakgrunn kan
    // bevege seg i takt mellom enheter av samme grunn som lyden gjor det.
    if (this.onblock) {
      try { this.onblock(c.ch0, c.ch1, p.sampleRate, when); } catch {}
    }
  }

  get resyncs()          { return this.timeline.resyncs; }
  get correctedSamples() { return this.timeline.drift.corrected; }
  get driftErrorMs()     { return this.timeline.drift.medianErrorMs; }

  setVolume(v) { this.gain.gain.value = v; }

  /** Faktisk baandbredde inn, i kbit/s. */
  bitrate(sinceSec) {
    return sinceSec > 0 ? (this.bytesReceived * 8 / 1000) / sinceSec : 0;
  }

  stop() {
    try { this.gain.disconnect(); } catch {}
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
  }
}
