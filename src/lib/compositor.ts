import { layoutRects, loadWasm, type LayoutMode, type Rect, WasmCompositor } from "./wasm";
import { jsComposeNearest, jsLayout } from "./js-pipeline";
import { type ComposeBackend } from "./compose-backend";
import { get2d, makeDrawCanvas, sizeCanvas, OUT_H, OUT_W, type DrawCanvas, type DrawContext } from "./draw-canvas";

export type { ComposeBackend } from "./compose-backend";
export { pickComposeBackend, pickComposeBackendFrom, pickComposeThread, pickComposeThreadFrom } from "./compose-backend";
export { OUT_H, OUT_W } from "./draw-canvas";

export type ComposeSource = CanvasImageSource | VideoFrame;

let cachedWasm: { key: string; comp: WasmCompositor } | null = null;
let wgpuMod: typeof import("./gpu-compositor") | undefined;
let wgpuTsMod: typeof import("./webgpu-ts") | undefined;
export type ComposePin = { name: string; text: string };

let bannerTitle = "";
let bannerSubtitle = "";
let pinned: ComposePin | null = null;
let scratch: DrawCanvas | null = null;

function overlayFn(ctx: DrawContext): void {
  drawBanner2d(ctx, bannerTitle, bannerSubtitle);
  if (pinned) drawPin2d(ctx, pinned);
}

function wasmCompositorFor(api: Awaited<ReturnType<typeof loadWasm>>, width: number, height: number): WasmCompositor {
  const key = `${width}x${height}`;
  if (cachedWasm && cachedWasm.key === key) return cachedWasm.comp;
  cachedWasm = { key, comp: new WasmCompositor(api, width, height) };
  return cachedWasm.comp;
}

export function sourceSize(src: ComposeSource): { w: number; h: number } {
  if (typeof VideoFrame !== "undefined" && src instanceof VideoFrame) {
    return { w: src.displayWidth || src.codedWidth, h: src.displayHeight || src.codedHeight };
  }
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight };
  }
  const sized = src as { width: number; height: number };
  return { w: sized.width, h: sized.height };
}

function scratchCanvas(): DrawCanvas {
  scratch ??= makeDrawCanvas(640, 360);
  return scratch;
}

export async function composeFrame(opts: {
  backend: ComposeBackend;
  videos: ComposeSource[];
  mode: LayoutMode;
  title: string;
  subtitle: string;
  pin?: ComposePin | null;
  canvas: DrawCanvas;
}): Promise<{ backend: ComposeBackend; ms: number }> {
  const t0 = performance.now();
  const { videos, mode, title, subtitle, canvas } = opts;
  sizeCanvas(canvas, OUT_W, OUT_H);
  bannerTitle = title;
  bannerSubtitle = subtitle;
  pinned = opts.pin ?? null;

  if (opts.backend === "webgpu") {
    try {
      wgpuMod ??= await import("./gpu-compositor");
      const ok = await wgpuMod.drawWgpu(canvas, videos, mode, overlayFn);
      if (ok) return { backend: "webgpu", ms: performance.now() - t0 };
    } catch (err) {
      console.warn("wgpu compositor fallback", err);
    }
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "webgpu-ts") {
    try {
      wgpuTsMod ??= await import("./webgpu-ts");
      const ok = await wgpuTsMod.drawWebGpuTs(canvas, videos, mode, overlayFn);
      if (ok) return { backend: "webgpu-ts", ms: performance.now() - t0 };
    } catch (err) {
      console.warn("webgpu-ts compositor fallback", err);
    }
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "canvas2d") {
    await drawCanvas2d(canvas, videos, mode);
    return { backend: "canvas2d", ms: performance.now() - t0 };
  }

  if (opts.backend === "js-cpu") {
    const ctx = get2d(canvas, { willReadFrequently: true });
    if (!ctx) return { backend: "js-cpu", ms: performance.now() - t0 };
    const dst = ctx.createImageData(OUT_W, OUT_H);
    dst.data.fill(0);
    fillBg(dst.data, OUT_W, OUT_H, 11, 11, 13);
    const rects = jsLayout(videos.length || 1, mode === "solo" ? 0 : mode === "side" ? 1 : mode === "screen" ? 3 : 2);
    const scratchTile = scratchCanvas();
    const sctx = get2d(scratchTile, { willReadFrequently: true });
    if (!sctx) return { backend: "js-cpu", ms: performance.now() - t0 };
    videos.forEach((video, i) => {
      const r = rects[i];
      const { w } = sourceSize(video);
      if (!r || !w) return;
      sizeCanvas(scratchTile, 640, 360);
      sctx.drawImage(video, 0, 0, 640, 360);
      const tile = sctx.getImageData(0, 0, 640, 360);
      jsComposeNearest(
        dst.data,
        OUT_W,
        OUT_H,
        tile.data,
        640,
        360,
        Math.round(r.x * OUT_W),
        Math.round(r.y * OUT_H),
        Math.round(r.w * OUT_W),
        Math.round(r.h * OUT_H),
      );
    });
    ctx.putImageData(dst, 0, 0);
    overlayFn(ctx);
    return { backend: "js-cpu", ms: performance.now() - t0 };
  }

  const api = await loadWasm();
  const comp = wasmCompositorFor(api, OUT_W, OUT_H);
  comp.clear();
  const rects = layoutRects(api, Math.max(1, videos.length), mode, OUT_W, OUT_H);
  const scratchTile = scratchCanvas();
  const sctx = get2d(scratchTile, { willReadFrequently: true });
  if (!sctx) return { backend: "wasm-cpu", ms: performance.now() - t0 };
  videos.forEach((video, i) => {
    const r = rects[i];
    const { w } = sourceSize(video);
    if (!r || !w) return;
    sizeCanvas(scratchTile, 640, 360);
    sctx.drawImage(video, 0, 0, 640, 360);
    const tile = sctx.getImageData(0, 0, 640, 360);
    comp.blit(tile.data, 640, 360, r, false);
  });
  comp.banner(title, subtitle);
  const ctx = get2d(canvas);
  if (ctx) {
    ctx.putImageData(comp.imageData(), 0, 0);
    if (pinned) drawPin2d(ctx, pinned);
  }
  return { backend: "wasm-cpu", ms: performance.now() - t0 };
}

async function drawCanvas2d(canvas: DrawCanvas, videos: ComposeSource[], mode: LayoutMode): Promise<void> {
  const ctx = get2d(canvas);
  if (!ctx) return;
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  let rects: Rect[];
  try {
    const api = await loadWasm();
    rects = layoutRects(api, Math.max(1, videos.length), mode, OUT_W, OUT_H);
  } catch {
    const js = jsLayout(
      Math.max(1, videos.length),
      mode === "solo" ? 0 : mode === "side" ? 1 : mode === "screen" ? 3 : 2,
    );
    rects = js.map((r) => ({ x: r.x * OUT_W, y: r.y * OUT_H, w: r.w * OUT_W, h: r.h * OUT_H }));
  }
  videos.forEach((video, i) => {
    const r = rects[i];
    if (!r) return;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.clip();
    const { w } = sourceSize(video);
    if (w) ctx.drawImage(video, r.x, r.y, r.w, r.h);
    else {
      ctx.fillStyle = "#22232b";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  });
  overlayFn(ctx);
}

function drawBanner2d(ctx: DrawContext, title: string, subtitle: string): void {
  const h = Math.round(OUT_H * 0.11);
  const y = OUT_H - h - Math.round(OUT_H / 28);
  const x = Math.round(OUT_W / 24);
  const w = OUT_W - x * 2;
  ctx.fillStyle = "rgba(18,19,22,0.9)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  ctx.fillStyle = "#6d64f7";
  ctx.fillRect(x, y, 6, h);
  ctx.fillStyle = "#f3f4f6";
  ctx.font = "600 28px 'Public Sans', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 22, y + h / 2 - 2);
  ctx.fillStyle = "#9aa0ab";
  ctx.font = "500 20px 'Public Sans', sans-serif";
  ctx.fillText(subtitle, x + 22 + ctx.measureText(title).width + 28, y + h / 2);
}

function drawPin2d(ctx: DrawContext, pin: ComposePin): void {
  const bannerH = Math.round(OUT_H * 0.11);
  const bannerY = OUT_H - bannerH - Math.round(OUT_H / 28);
  const h = 64;
  const x = Math.round(OUT_W / 24);
  const w = Math.round(OUT_W * 0.56);
  const y = bannerY - h - 12;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.clip();
  ctx.fillStyle = "rgba(18,19,22,0.92)";
  ctx.fill();
  ctx.fillStyle = "#6d64f7";
  ctx.fillRect(x, y, 6, h);
  ctx.fillStyle = "#f3f4f6";
  ctx.font = "600 18px 'Public Sans', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(pin.name, x + 18, y + 22);
  ctx.fillStyle = "#c5c9d2";
  ctx.font = "500 16px 'Public Sans', sans-serif";
  ctx.fillText(pin.text, x + 18, y + 46);
  ctx.restore();
}

function fillBg(data: Uint8ClampedArray, w: number, h: number, r: number, g: number, b: number): void {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
}

export function spawnComposeWorker(): Worker {
  return new Worker(new URL("../workers/compose-worker.ts", import.meta.url), { type: "module" });
}
