/**
 * On-device speech to text. Runs off the main thread so the compositor is not touched.
 * The runtime (transformers.js + onnxruntime-web) and the model are loaded from
 * same-origin URLs by default, only after captions are turned on. No audio leaves this worker.
 */
import { SpeechSegmenter } from "../lib/speech-segmenter";
import type { CaptionWorkerIn, CaptionWorkerOut } from "../lib/caption-messages";

type AsrFn = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>;

type Runtime = {
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<AsrFn>;
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    backends: { onnx: { wasm: { wasmPaths: string } } };
  };
};

function isRuntime(mod: object): mod is Runtime {
  return "pipeline" in mod && typeof mod.pipeline === "function" && "env" in mod && typeof mod.env === "object" && mod.env !== null;
}

function textOf(out: unknown): string {
  const first = Array.isArray(out) ? out[0] : out;
  if (typeof first === "object" && first !== null && "text" in first && typeof first.text === "string") return first.text;
  return "";
}

const SAMPLE_RATE = 16000;
// More waiting than this means the device is too slow; skip ahead to stay near real time.
const QUEUE_MAX = 2;

const segmenter = new SpeechSegmenter({ sampleRate: SAMPLE_RATE });
const queue: { samples: Float32Array; endedAt: number }[] = [];
let asr: AsrFn | null = null;
let loading = false;
let draining = false;

function post(msg: CaptionWorkerOut): void {
  self.postMessage(msg);
}

async function load(msg: Extract<CaptionWorkerIn, { type: "init" }>): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const mod: unknown = await import(/* @vite-ignore */ msg.runtimeUrl);
    if (typeof mod !== "object" || mod === null || !isRuntime(mod)) throw new Error("runtime");
    mod.env.allowRemoteModels = false;
    mod.env.allowLocalModels = true;
    mod.env.localModelPath = msg.modelBase;
    mod.env.backends.onnx.wasm.wasmPaths = msg.runtimeBase;
    const hasGpu = typeof navigator !== "undefined" && "gpu" in navigator;
    try {
      if (!hasGpu) throw new Error("no webgpu");
      asr = await mod.pipeline("automatic-speech-recognition", msg.model, { device: "webgpu", dtype: "fp32" });
    } catch {
      asr = await mod.pipeline("automatic-speech-recognition", msg.model, { device: "wasm", dtype: "q8" });
    }
    post({ type: "ready" });
  } catch {
    post({ type: "unsupported", reason: "model" });
  }
}

async function drain(): Promise<void> {
  if (draining || !asr) return;
  draining = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const text = textOf(await asr(job.samples, { language: "en", task: "transcribe" })).trim();
      if (text) {
        post({
          type: "segment",
          text,
          durationMs: Math.round((job.samples.length / SAMPLE_RATE) * 1000),
          ageMs: Math.round(performance.now() - job.endedAt),
        });
      }
    }
  } catch {
    post({ type: "unsupported", reason: "run" });
    asr = null;
  } finally {
    draining = false;
  }
}

self.onmessage = (ev: MessageEvent<CaptionWorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    void load(msg);
    return;
  }
  // Until the model is ready there is nothing to transcribe; drop audio instead of queueing it.
  if (!asr) return;
  const segment = segmenter.push(msg.samples);
  if (!segment) return;
  queue.push({ samples: segment.samples, endedAt: performance.now() });
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  void drain();
};
