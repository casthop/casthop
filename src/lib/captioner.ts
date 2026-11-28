/**
 * Starts on-device captions for one mic track. Only imported work happens when
 * captions are on: the worker, the model and the audio graph all start here.
 */
import workletUrl from "../worklets/caption-capture.js?url";
import type { CaptionWorkerIn, CaptionWorkerOut } from "./caption-messages";

export type CaptionSegment = { text: string; durationMs: number; ageMs: number };

export type CaptionerHandlers = {
  onSegment: (segment: CaptionSegment) => void;
  /** Called once if this device cannot run captions. */
  onUnsupported: () => void;
};

export type Captioner = { stop: () => void };

// Files are same-origin unless the deployer points these at their own host. See the docs.
export type CaptionAssets = { runtimeUrl: string; runtimeBase: string; modelBase: string; model: string };

function baseUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  return new URL(base.endsWith("/") ? base : `${base}/`, document.baseURI).toString();
}

export function captionAssets(): CaptionAssets {
  const root = `${baseUrl()}captions/`;
  return {
    runtimeUrl: import.meta.env.VITE_CAPTION_RUNTIME_URL || `${root}transformers.min.js`,
    runtimeBase: import.meta.env.VITE_CAPTION_RUNTIME_BASE || root,
    modelBase: import.meta.env.VITE_CAPTION_MODEL_BASE || `${root}models/`,
    model: import.meta.env.VITE_CAPTION_MODEL || "whisper-tiny.en",
  };
}

export function captionsSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

export async function startCaptioner(track: MediaStreamTrack, handlers: CaptionerHandlers): Promise<Captioner> {
  const worker = new Worker(new URL("../workers/caption-worker.ts", import.meta.url), { type: "module" });
  const ctx = new AudioContext({ sampleRate: 16000 });
  let stopped = false;
  let failed = false;
  const fail = () => {
    if (failed || stopped) return;
    failed = true;
    handlers.onUnsupported();
  };
  const stop = () => {
    stopped = true;
    worker.terminate();
    void ctx.close().catch(() => undefined);
  };

  worker.onmessage = (ev: MessageEvent<CaptionWorkerOut>) => {
    const msg = ev.data;
    if (msg.type === "segment") handlers.onSegment(msg);
    else if (msg.type === "unsupported") fail();
  };
  worker.onerror = fail;
  const assets = captionAssets();
  const init: CaptionWorkerIn = { type: "init", ...assets };
  worker.postMessage(init);

  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, "casthop-caption-capture", { numberOfOutputs: 0 });
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      const frame: CaptionWorkerIn = { type: "frame", samples: ev.data };
      worker.postMessage(frame, [ev.data.buffer]);
    };
    source.connect(node);
  } catch {
    fail();
    stop();
  }
  return { stop };
}
