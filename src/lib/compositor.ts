import { layoutRects, loadWasm, type LayoutMode, type Rect, WasmCompositor } from "./wasm";
import { jsComposeNearest, jsLayout } from "./js-pipeline";
import { type ComposeBackend } from "./compose-backend";
import { get2d, makeDrawCanvas, sizeCanvas, OUT_H, OUT_W, VERT_H, VERT_W, type DrawCanvas, type DrawContext } from "./draw-canvas";

export type { ComposeBackend } from "./compose-backend";
export { pickComposeBackend, pickComposeBackendFrom, pickComposeThread, pickComposeThreadFrom } from "./compose-backend";
export { OUT_H, OUT_W, VERT_H, VERT_W } from "./draw-canvas";

export type ComposeSource = CanvasImageSource | VideoFrame;

let cachedWasm: { key: string; comp: WasmCompositor } | null = null;
let wgpuMod: typeof import("./gpu-compositor") | undefined;
let wgpuTsMod: typeof import("./webgpu-ts") | undefined;
export type ComposePin = { name: string; text: string };
export type ComposeCaption = { name: string; text: string };

let bannerTitle = "";
let bannerSubtitle = "";
let pinned: ComposePin | null = null;
let captioned: ComposeCaption | null = null;
let scratch: DrawCanvas | null = null;

function overlayFn(ctx: DrawContext, width: number, height: number, portrait: boolean): void {
  drawBanner2d(ctx, bannerTitle, bannerSubtitle, width, height, portrait);
  if (pinned) drawPin2d(ctx, pinned, width, height, portrait);
  if (captioned) drawCaption2d(ctx, captioned, width, height, portrait, pinned !== null);
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

function modeIndex(mode: LayoutMode): number {
  if (mode === "solo") return 0;
  if (mode === "side") return 1;
  if (mode === "screen") return 3;
  if (mode === "portrait") return 4;
  return 2;
}

export async function composeFrame(opts: {
  backend: ComposeBackend;
  videos: ComposeSource[];
  mode: LayoutMode;
  title: string;
  subtitle: string;
  pin?: ComposePin | null;
  caption?: ComposeCaption | null;
  canvas: DrawCanvas;
  width?: number;
  height?: number;
}): Promise<{ backend: ComposeBackend; ms: number }> {
  const t0 = performance.now();
  const { videos, mode, title, subtitle, canvas } = opts;
  const width = opts.width ?? (mode === "portrait" ? VERT_W : OUT_W);
  const height = opts.height ?? (mode === "portrait" ? VERT_H : OUT_H);
  const portrait = mode === "portrait";
  sizeCanvas(canvas, width, height);
  bannerTitle = title;
  bannerSubtitle = subtitle;
  pinned = opts.pin ?? null;
  captioned = opts.caption ?? null;
  const overlay = (ctx: DrawContext) => overlayFn(ctx, width, height, portrait);

  if (opts.backend === "webgpu") {
    try {
      wgpuMod ??= await import("./gpu-compositor");
      const ok = await wgpuMod.drawWgpu(canvas, videos, mode, overlay);
      if (ok) return { backend: "webgpu", ms: performance.now() - t0 };
    } catch (err) {
      console.warn("wgpu compositor fallback", err);
    }
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "webgpu-ts") {
    try {
      wgpuTsMod ??= await import("./webgpu-ts");
      const ok = await wgpuTsMod.drawWebGpuTs(canvas, videos, mode, overlay);
      if (ok) return { backend: "webgpu-ts", ms: performance.now() - t0 };
    } catch (err) {
      console.warn("webgpu-ts compositor fallback", err);
    }
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "canvas2d") {
    await drawCanvas2d(canvas, videos, mode, width, height, overlay);
    return { backend: "canvas2d", ms: performance.now() - t0 };
  }

  if (opts.backend === "js-cpu") {
    const ctx = get2d(canvas, { willReadFrequently: true });
    if (!ctx) return { backend: "js-cpu", ms: performance.now() - t0 };
    const dst = ctx.createImageData(width, height);
    dst.data.fill(0);
    fillBg(dst.data, width, height, 11, 11, 13);
    const rects = jsLayout(videos.length || 1, modeIndex(mode));
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
        width,
        height,
        tile.data,
        640,
        360,
        Math.round(r.x * width),
        Math.round(r.y * height),
        Math.round(r.w * width),
        Math.round(r.h * height),
      );
    });
    ctx.putImageData(dst, 0, 0);
    overlay(ctx);
    return { backend: "js-cpu", ms: performance.now() - t0 };
  }

  const api = await loadWasm();
  const comp = wasmCompositorFor(api, width, height);
  comp.clear();
  const rects = layoutRects(api, Math.max(1, videos.length), mode, width, height);
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
    if (pinned) drawPin2d(ctx, pinned, width, height, portrait);
    if (captioned) drawCaption2d(ctx, captioned, width, height, portrait, pinned !== null);
  }
  return { backend: "wasm-cpu", ms: performance.now() - t0 };
}

async function drawCanvas2d(
  canvas: DrawCanvas,
  videos: ComposeSource[],
  mode: LayoutMode,
  width: number,
  height: number,
  overlay: (ctx: DrawContext) => void,
): Promise<void> {
  const ctx = get2d(canvas);
  if (!ctx) return;
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, width, height);
  let rects: Rect[];
  try {
    const api = await loadWasm();
    rects = layoutRects(api, Math.max(1, videos.length), mode, width, height);
  } catch {
    const js = jsLayout(Math.max(1, videos.length), modeIndex(mode));
    rects = js.map((r) => ({ x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height }));
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
  overlay(ctx);
}

function drawBanner2d(
  ctx: DrawContext,
  title: string,
  subtitle: string,
  width: number,
  height: number,
  portrait: boolean,
): void {
  const short = Math.min(width, height);
  const h = Math.round(short * 0.11);
  const pad = Math.round(short / 28);
  const x = Math.round(width / 24);
  const w = width - x * 2;
  const y = portrait ? height - h - Math.round(short * 0.03) : height - h - pad;
  const titlePx = Math.round(short * 0.039);
  const subPx = Math.round(short * 0.028);
  ctx.fillStyle = "rgba(18,19,22,0.9)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  ctx.fillStyle = "#6d64f7";
  ctx.fillRect(x, y, 6, h);
  ctx.fillStyle = "#f3f4f6";
  ctx.font = `600 ${titlePx}px 'Public Sans', sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 22, y + h / 2 - 2);
  ctx.fillStyle = "#9aa0ab";
  ctx.font = `500 ${subPx}px 'Public Sans', sans-serif`;
  ctx.fillText(subtitle, x + 22 + ctx.measureText(title).width + 28, y + h / 2);
}

function drawPin2d(ctx: DrawContext, pin: ComposePin, width: number, height: number, portrait: boolean): void {
  const short = Math.min(width, height);
  const bannerH = Math.round(short * 0.11);
  const pad = Math.round(short / 28);
  const bannerY = portrait ? height - bannerH - Math.round(short * 0.03) : height - bannerH - pad;
  const h = Math.round(short * 0.089);
  const x = Math.round(width / 24);
  const w = Math.round(width * (portrait ? 0.9 : 0.56));
  const y = bannerY - h - 12;
  const namePx = Math.round(short * 0.025);
  const textPx = Math.round(short * 0.022);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.clip();
  ctx.fillStyle = "rgba(18,19,22,0.92)";
  ctx.fill();
  ctx.fillStyle = "#6d64f7";
  ctx.fillRect(x, y, 6, h);
  ctx.fillStyle = "#f3f4f6";
  ctx.font = `600 ${namePx}px 'Public Sans', sans-serif`;
  ctx.textBaseline = "middle";
  ctx.fillText(pin.name, x + 18, y + h * 0.34);
  ctx.fillStyle = "#c5c9d2";
  ctx.font = `500 ${textPx}px 'Public Sans', sans-serif`;
  ctx.fillText(pin.text, x + 18, y + h * 0.72);
  ctx.restore();
}

let wrapped: { key: string; lines: string[] } = { key: "", lines: [] };

// Wrapping only reruns when the text or width changes, not every frame.
function captionLines(ctx: DrawContext, text: string, maxWidth: number, px: number): string[] {
  const key = `${px}|${maxWidth}|${text}`;
  if (wrapped.key === key) return wrapped.lines;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  // Keep the newest two lines of a long segment.
  wrapped = { key, lines: lines.slice(-2) };
  return wrapped.lines;
}

function drawCaption2d(
  ctx: DrawContext,
  caption: ComposeCaption,
  width: number,
  height: number,
  portrait: boolean,
  hasPin: boolean,
): void {
  const short = Math.min(width, height);
  const px = Math.round(short * (portrait ? 0.034 : 0.04));
  const lineH = Math.round(px * 1.3);
  const pad = Math.round(px * 0.5);
  const bannerH = Math.round(short * 0.11);
  const bannerY = portrait ? height - bannerH - Math.round(short * 0.03) : height - bannerH - Math.round(short / 28);
  const pinH = hasPin ? Math.round(short * 0.089) + 12 : 0;
  ctx.font = `600 ${px}px 'Public Sans', sans-serif`;
  const maxWidth = Math.round(width * (portrait ? 0.86 : 0.7));
  const lines = captionLines(ctx, caption.text, maxWidth, px);
  const boxW = Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width))) + pad * 2;
  const boxH = lines.length * lineH + pad;
  const x = Math.round((width - boxW) / 2);
  const y = bannerY - pinH - 16 - boxH;
  ctx.fillStyle = "rgba(10,10,10,0.78)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, width / 2, y + pad / 2 + lineH * (i + 0.5)));
  ctx.textAlign = "start";
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
