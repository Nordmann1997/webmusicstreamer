// Samler mikrofonen i blokker og sender dem til hovedtraden sammen med
// AudioContext-tida for forste sample. Det er tidsstempelet som gjor opptaket
// sammenlignbart med klikkene vi selv planla — samme klokke i begge ender.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.buf = new Float32Array(this.size);
    this.pos = 0;
    this.blockStart = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.pos === 0) this.blockStart = currentTime;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.pos++] = ch[i];
      if (this.pos === this.size) {
        this.port.postMessage({ t: this.blockStart, data: this.buf.slice() });
        this.pos = 0;
        this.blockStart = currentTime + (i + 1) / sampleRate;
      }
    }
    return true;
  }
}
registerProcessor('recorder', Recorder);
