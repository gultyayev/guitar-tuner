// Runs on the audio rendering thread. Does no analysis: it only batches the
// 128-sample render quanta into hop-sized chunks and hands them to the worker
// over a MessagePort (transferred, zero-copy), so neither this thread nor the
// UI thread ever does heavy work.
class TunerTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.hop = options.processorOptions.hop;
    this.buf = new Float32Array(this.hop);
    this.n = 0;
    this.out = null;
    this.port.onmessage = e => { this.out = e.data.port; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.out) return true;
    let i = 0;
    while (i < ch.length) {
      const k = Math.min(ch.length - i, this.hop - this.n);
      this.buf.set(ch.subarray(i, i + k), this.n);
      this.n += k; i += k;
      if (this.n === this.hop) {
        this.out.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.hop);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('tuner-tap', TunerTap);
