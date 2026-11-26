import { composeFrame, type ComposeBackend } from "../lib/compositor";
import type { ComposeWorkerIn, ComposeWorkerOut } from "../lib/compose-messages";
import { FRAME_SAMPLE_CAP, pushSample, usedSamples } from "../lib/compose-support";
import type { LayoutMode } from "../lib/wasm";

const OUTPUT_FPS = 30;
const OUTPUT_INTERVAL_MS = 1000 / OUTPUT_FPS;

const tiles = new Map<string, VideoFrame>();
const order: string[] = [];
const pumps = new Map<string, AbortController>();
const samples = new Float64Array(FRAME_SAMPLE_CAP);
const cursor = { i: 0, n: 0 };

let canvas: OffscreenCanvas | null = null;
let backend: ComposeBackend = "canvas2d";
let mode: LayoutMode = "grid";
let title = "Casthop";
let subtitle = "live";
let pin: { name: string; text: string } | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
let busy = false;
let timer = 0;
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

async function writeOutput(): Promise<void> {
  if (!writer || !canvas) return;
  const vf = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000), alpha: "discard" });
  try {
    await writer.write(vf);
  } finally {
    vf.close();
  }
}

async function composeOnce(): Promise<void> {
  if (!canvas || !running) return;
  const result = await composeFrame({
    backend,
    videos: sources(),
    mode,
    title,
    subtitle,
    pin,
    canvas,
  });
  backend = result.backend;
  pushSample(samples, cursor, result.ms);
  frames += 1;
  await writeOutput();
}

function cancelSchedule(): void {
  if (timer) self.clearTimeout(timer);
  timer = 0;
}

function startLoop(): void {
  if (!running || timer) return;
  timer = self.setTimeout(tick, 0);
}

function tick(): void {
  timer = 0;
  if (!running) return;
  if (busy) {
    dropped += 1;
    timer = self.setTimeout(tick, OUTPUT_INTERVAL_MS);
    return;
  }
  busy = true;
  const t0 = performance.now();
  void composeOnce()
    .catch((err) => {
      post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      busy = false;
      if (!running) return;
      const wait = Math.max(0, OUTPUT_INTERVAL_MS - (performance.now() - t0));
      timer = self.setTimeout(tick, wait);
    });
}

async function pump(id: string, readable: ReadableStream<VideoFrame>, signal: AbortSignal): Promise<void> {
  const reader = readable.getReader();
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
  try {
    while (running && !signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!order.includes(id) || signal.aborted) {
        value.close();
        break;
      }
      const prev = tiles.get(id);
      if (prev) prev.close();
      tiles.set(id, value);
    }
  } catch {
    /* track ended */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function abortPump(id: string): void {
  pumps.get(id)?.abort();
  pumps.delete(id);
}

function stop(): void {
  running = false;
  cancelSchedule();
  for (const id of [...pumps.keys()]) abortPump(id);
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
    startLoop();
    return;
  }
  if (msg.type === "add") {
    abortPump(msg.id);
    const ac = new AbortController();
    pumps.set(msg.id, ac);
    if (!order.includes(msg.id)) order.push(msg.id);
    void pump(msg.id, msg.readable, ac.signal);
    return;
  }
  if (msg.type === "remove") {
    abortPump(msg.id);
    const i = order.indexOf(msg.id);
    if (i >= 0) order.splice(i, 1);
    closeTile(msg.id);
    return;
  }
  if (msg.type === "meta") {
    mode = msg.mode;
    title = msg.title;
    subtitle = msg.subtitle;
    pin = msg.pin ?? null;
    return;
  }
  if (msg.type === "snapshot") {
    post({ type: "stats", frames, dropped, frameMs: usedSamples(samples, cursor.n), backend });
    return;
  }
  if (msg.type === "stop") stop();
};
