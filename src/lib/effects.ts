import workletUrl from "../worklets/denoise-processor.js?url";
import { loadWasmBytes } from "./wasm";

export type FxBackend = "wasm" | "js" | "off";

export type MediaPipeline = {
  process(stream: MediaStream): Promise<MediaStream>;
};

export type Meter = {
  getLevel: () => number;
  getVad: () => number;
  stop: () => void;
};

const liveContexts: AudioContext[] = [];

export function fxFromSearch(search = location.search): FxBackend {
  const v = new URLSearchParams(search).get("fx");
  if (v === "js" || v === "off" || v === "wasm") return v;
  return "wasm";
}

export const passthroughPipeline: MediaPipeline = {
  async process(stream) {
    return stream;
  },
};

/**
 * Noise suppression + VAD before LiveKit publish.
 * WASM path: RNNoise (nnnoiseless) in an AudioWorklet.
 * JS path: DC-remove + noise gate in the same worklet (comparison).
 */
export async function processWithPipeline(stream: MediaStream, backend: FxBackend = fxFromSearch()): Promise<MediaStream> {
  if (backend === "off") return stream;
  const audio = stream.getAudioTracks()[0];
  const video = stream.getVideoTracks();
  if (!audio) return stream;
  try {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    liveContexts.push(ctx);
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(new MediaStream([audio]));
    const node = new AudioWorkletNode(ctx, "casthop-denoise", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { backend },
    });
    const init: { type: string; backend: FxBackend; wasm?: ArrayBuffer } = { type: "init", backend };
    if (backend === "wasm") {
      init.wasm = await loadWasmBytes();
    }
    node.port.postMessage(init, init.wasm ? [init.wasm] : []);
    const dest = ctx.createMediaStreamDestination();
    src.connect(node).connect(dest);
    if (ctx.state === "suspended") await ctx.resume();
    const processed = dest.stream.getAudioTracks()[0];
    if (!processed) return stream;
    return new MediaStream([...video, processed]);
  } catch (err) {
    console.warn("casthop pipeline fallback", err);
    return stream;
  }
}

export const mediaPipeline: MediaPipeline = {
  process: (stream) => processWithPipeline(stream),
};

export function attachWorkletMeter(stream: MediaStream, backend: FxBackend = fxFromSearch()): Promise<Meter> {
  const audio = stream.getAudioTracks()[0];
  if (!audio) return Promise.resolve({ getLevel: () => 0, getVad: () => 0, stop: () => undefined });
  return (async () => {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    liveContexts.push(ctx);
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(new MediaStream([audio]));
    const node = new AudioWorkletNode(ctx, "casthop-denoise", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    let rms = 0;
    let vad = 0;
    node.port.onmessage = (ev) => {
      const msg = ev.data as { type?: string; rms?: number; vad?: number };
      if (msg.type === "meter") {
        rms = msg.rms ?? 0;
        vad = msg.vad ?? 0;
      }
    };
    const init: { type: string; backend: FxBackend; wasm?: ArrayBuffer } = { type: "init", backend };
    if (backend === "wasm") init.wasm = await loadWasmBytes();
    node.port.postMessage(init, init.wasm ? [init.wasm] : []);
    src.connect(node);
    if (ctx.state === "suspended") await ctx.resume();
    return {
      getLevel: () => Math.min(1, rms / 0.12),
      getVad: () => vad,
      stop: () => {
        node.disconnect();
        src.disconnect();
        void ctx.close();
      },
    };
  })();
}
