/**
 * AudioWorklet: 48 kHz mono, 128-sample quanta, RNNoise frames of 480.
 * Main thread posts { type: 'init', wasm, backend: 'wasm' | 'js' }.
 * Posts { type: 'meter', rms, peak, vad } about every 10 ms.
 */
const FRAME = 480;

class CasthopDenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.backend = "off";
    this.ready = false;
    this.wasm = null;
    this.handle = 0;
    this.inPtr = 0;
    this.outPtr = 0;
    this.pending = new Float32Array(FRAME);
    this.filled = 0;
    this.outBuf = new Float32Array(FRAME * 3);
    this.outRead = 0;
    this.outWrite = FRAME;
    this.meterAt = 0;
    this.port.onmessage = (ev) => this.onMessage(ev.data);
  }

  async onMessage(data) {
    if (!data || data.type !== "init") return;
    this.backend = data.backend || "wasm";
    if (this.backend === "wasm" && data.wasm) {
      try {
        const result = await WebAssembly.instantiate(data.wasm, {});
        this.wasm = result.instance.exports;
        this.handle = this.wasm.casthop_denoise_new();
        this.inPtr = this.wasm.casthop_denoise_in_ptr(this.handle);
        this.outPtr = this.wasm.casthop_denoise_out_ptr(this.handle);
        this.ready = true;
      } catch (err) {
        this.backend = "js";
        this.ready = true;
        this.port.postMessage({ type: "fallback", reason: String(err) });
      }
    } else {
      this.ready = true;
    }
    this.port.postMessage({ type: "ready", backend: this.backend });
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input || !this.ready || this.backend === "off") {
      if (input) output.set(input);
      else output.fill(0);
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this.pending[this.filled++] = input[i];
      if (this.filled === FRAME) {
        const frame = this.runFrame(this.pending);
        this.filled = 0;
        for (let j = 0; j < FRAME; j++) {
          this.outBuf[this.outWrite] = frame[j];
          this.outWrite = (this.outWrite + 1) % this.outBuf.length;
        }
      }
    }

    const queued = (this.outWrite - this.outRead + this.outBuf.length) % this.outBuf.length;
    if (queued < output.length) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < output.length; i++) {
      output[i] = this.outBuf[this.outRead];
      this.outRead = (this.outRead + 1) % this.outBuf.length;
    }
    return true;
  }

  runFrame(frame) {
    if (this.backend === "wasm" && this.wasm) {
      const mem = this.wasm.memory.buffer;
      new Float32Array(mem, this.inPtr, FRAME).set(frame);
      const vad = this.wasm.casthop_denoise_process(this.handle) / 10000;
      const out = new Float32Array(this.wasm.memory.buffer, this.outPtr, FRAME).slice();
      this.emitMeter(out, vad);
      return out;
    }
    const out = jsGate(frame);
    this.emitMeter(out, out._vad ?? 0);
    return out;
  }

  emitMeter(frame, vad) {
    this.meterAt++;
    if (this.meterAt % 2 !== 0) return;
    let sum2 = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const a = Math.abs(frame[i]);
      if (a > peak) peak = a;
      sum2 += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sum2 / frame.length);
    this.port.postMessage({ type: "meter", rms, peak, vad });
  }
}

function jsGate(frame) {
  let sum = 0;
  let sum2 = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i];
    sum += s;
    sum2 += s * s;
    if (s >= 0 !== prev >= 0) zc += 1;
    prev = s;
  }
  const mean = sum / frame.length;
  const rms = Math.sqrt(sum2 / frame.length);
  const zcr = zc / frame.length;
  const voice = rms > 0.018 && zcr > 0.01 && zcr < 0.25;
  const gate = rms < 0.01 ? 0.08 : 1;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = (frame[i] - mean) * gate;
  out._vad = voice ? 1 : 0;
  return out;
}

registerProcessor("casthop-denoise", CasthopDenoiseProcessor);
