// Fanger lyden fra getDisplayMedia og sender den til hovedtraden i blokker,
// med AudioContext-tida for FORSTE sample i hver blokk. Det tidsstempelet er
// hele poenget: det er det som gjor at mottakerne vet naar lyden hore hjemme.
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.blockSize || 1024;
    this.ch0 = new Float32Array(this.size);
    this.ch1 = new Float32Array(this.size);
    this.pos = 0;
    this.blockStart = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const a = input[0];
    const b = input[1] || input[0];      // mono → dupliser til stereo
    if (!a) return true;

    for (let i = 0; i < a.length; i++) {
      if (this.pos === 0) this.blockStart = currentTime + i / sampleRate;
      this.ch0[this.pos] = a[i];
      this.ch1[this.pos] = b[i];
      this.pos++;

      if (this.pos === this.size) {
        this.port.postMessage(
          { t: this.blockStart, ch0: this.ch0.slice(), ch1: this.ch1.slice() });
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
