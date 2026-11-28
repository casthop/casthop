/**
 * AudioWorklet for captions. The context runs at 16 kHz, so this only
 * gathers mono samples into 100 ms frames and posts them to the main thread.
 */
const FRAME = 1600;

class CasthopCaptionCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(FRAME - this.filled, channel.length - read);
      this.frame.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("casthop-caption-capture", CasthopCaptionCapture);
