import { composeFrame, type ComposeBackend } from "../lib/compositor";
import type { ComposeWorkerIn, ComposeWorkerOut } from "../lib/compose-messages";
import { FRAME_SAMPLE_CAP, pushSample, usedSamples } from "../lib/compose-support";
import type { LayoutMode } from "../lib/wasm";

const tiles = new Map<string, VideoFrame>();
const order: string[] = [];
const samples = new Float64Array(FRAME_SAMPLE_CAP);
const cursor = { i: 0, n: 0 };

let canvas: OffscreenCanvas | null = null;
let backend: ComposeBackend = "canvas2d";
let mode: LayoutMode = "grid";
let title = "Casthop";
let subtitle = "live";
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let busy = false;
let raf = 0;
let dropped = 0;
let frames = 0;
let running = true;

function post(msg: ComposeWorkerOut): void {
  self.postMessage(msg);
}

function closeTile(id: string): void {
  const prev = tiles.get(id);
  if (prev) prev.close();
  tiles.delete(id);
}

function sources(): VideoFrame[] {
  const out: VideoFrame[] = [];
  for (const id of order) {
    const frame = tiles.get(id);
    if (frame) out.push(frame);
  }
  return out;
}

async function composeOnce(): Promise<void> {
  if (!canvas || !running) return;
  const t0 = performance.now();
  const result = await composeFrame({
    backend,
    videos: sources(),
    mode,
    title,
    subtitle,
    canvas,
  });
  backend = result.backend;
  if (writer) {
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t0 * 1000), alpha: "discard" });
    try {
      await writer.write(vf);
    } finally {
      vf.close();
    }
  }
  pushSample(samples, cursor, performance.now() - t0);
  frames += 1;
}

function schedule(cb: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(cb);
  return self.setTimeout(cb, 16);
}

function queueCompose(): void {
  if (raf) return;
  raf = schedule(() => {
    raf = 0;
    if (!running) return;
    if (busy) {
      dropped += 1;
      queueCompose();
      return;
    }
    busy = true;
    void composeOnce()
      .catch((err) => {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        busy = false;
      });
  });
}

async function pump(id: string, readable: ReadableStream<VideoFrame>): Promise<void> {
  const reader = readable.getReader();
  try {
    while (running) {
      const { value, done } = await reader.read();
      if (done) break;
      const prev = tiles.get(id);
      if (prev) prev.close();
      tiles.set(id, value);
      queueCompose();
    }
  } catch {
    /* track ended */
  } finally {
    reader.releaseLock();
  }
}

function stop(): void {
  running = false;
  for (const id of [...tiles.keys()]) closeTile(id);
  order.length = 0;
  void writer?.close().catch(() => undefined);
  writer = null;
  canvas = null;
}

self.onmessage = (ev: MessageEvent<ComposeWorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    canvas = msg.canvas;
    backend = msg.backend;
    if (msg.writable) writer = msg.writable.getWriter();
    running = true;
    post({ type: "ready", backend });
    return;
  }
  if (msg.type === "add") {
    if (!order.includes(msg.id)) order.push(msg.id);
    void pump(msg.id, msg.readable);
    return;
  }
  if (msg.type === "remove") {
    const i = order.indexOf(msg.id);
    if (i >= 0) order.splice(i, 1);
    closeTile(msg.id);
    queueCompose();
    return;
  }
  if (msg.type === "meta") {
    mode = msg.mode;
    title = msg.title;
    subtitle = msg.subtitle;
    queueCompose();
    return;
  }
  if (msg.type === "snapshot") {
    post({ type: "stats", frames, dropped, frameMs: usedSamples(samples, cursor.n), backend });
    return;
  }
  if (msg.type === "stop") stop();
};
