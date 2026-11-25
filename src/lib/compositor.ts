import { layoutRects, loadWasm, type LayoutMode, type Rect, WasmCompositor } from "./wasm";
import { jsComposeNearest, jsLayout } from "./js-pipeline";
import { type ComposeBackend } from "./compose-backend";

export type { ComposeBackend } from "./compose-backend";
export { pickComposeBackend, pickComposeBackendFrom } from "./compose-backend";

export type ComposeSource = HTMLVideoElement | HTMLCanvasElement;

const OUT_W = 1280;
const OUT_H = 720;

let cachedWasm: { key: string; comp: WasmCompositor } | null = null;

function wasmCompositorFor(api: Awaited<ReturnType<typeof loadWasm>>, width: number, height: number): WasmCompositor {
  const key = `${width}x${height}`;
  if (cachedWasm && cachedWasm.key === key) return cachedWasm.comp;
  cachedWasm = { key, comp: new WasmCompositor(api, width, height) };
  return cachedWasm.comp;
}

function sourceSize(src: ComposeSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  return { w: src.width, h: src.height };
}

export async function composeFrame(opts: {
  backend: ComposeBackend;
  videos: ComposeSource[];
  mode: LayoutMode;
  title: string;
  subtitle: string;
  canvas: HTMLCanvasElement;
}): Promise<{ backend: ComposeBackend; ms: number }> {
  const t0 = performance.now();
  const { videos, mode, title, subtitle, canvas } = opts;
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const banner = (ctx: CanvasRenderingContext2D) => drawBanner2d(ctx, title, subtitle);

  if (opts.backend === "webgpu") {
    const { drawWgpu } = await import("./gpu-compositor");
    const ok = await drawWgpu(canvas, videos, mode, banner);
    if (ok) return { backend: "webgpu", ms: performance.now() - t0 };
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "webgpu-ts") {
    const { drawWebGpuTs } = await import("./webgpu-ts");
    const ok = await drawWebGpuTs(canvas, videos, mode, banner);
    if (ok) return { backend: "webgpu-ts", ms: performance.now() - t0 };
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "canvas2d") {
    await drawCanvas2d(canvas, videos, mode, title, subtitle);
    return { backend: "canvas2d", ms: performance.now() - t0 };
  }

  if (opts.backend === "js-cpu") {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const dst = ctx.createImageData(OUT_W, OUT_H);
    dst.data.fill(0);
    fillBg(dst.data, OUT_W, OUT_H, 11, 11, 13);
    const rects = jsLayout(videos.length || 1, mode === "solo" ? 0 : mode === "side" ? 1 : mode === "screen" ? 3 : 2);
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
    videos.forEach((video, i) => {
      const r = rects[i];
      const { w } = sourceSize(video);
      if (!r || !w) return;
      scratch.width = 640;
      scratch.height = 360;
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
    drawBanner2d(ctx, title, subtitle);
    return { backend: "js-cpu", ms: performance.now() - t0 };
  }

  const api = await loadWasm();
  const comp = wasmCompositorFor(api, OUT_W, OUT_H);
  comp.clear();
  const rects = layoutRects(api, Math.max(1, videos.length), mode, OUT_W, OUT_H);
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
  videos.forEach((video, i) => {
    const r = rects[i];
    const { w } = sourceSize(video);
    if (!r || !w) return;
    scratch.width = 640;
    scratch.height = 360;
    sctx.drawImage(video, 0, 0, 640, 360);
    const tile = sctx.getImageData(0, 0, 640, 360);
    comp.blit(tile.data, 640, 360, r, false);
  });
  comp.banner(title, subtitle);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(comp.imageData(), 0, 0);
  return { backend: "wasm-cpu", ms: performance.now() - t0 };
}

async function drawCanvas2d(
  canvas: HTMLCanvasElement,
  videos: ComposeSource[],
  mode: LayoutMode,
  title: string,
  subtitle: string,
): Promise<void> {
  const ctx = canvas.getContext("2d")!;
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
  drawBanner2d(ctx, title, subtitle);
}

function drawBanner2d(ctx: CanvasRenderingContext2D, title: string, subtitle: string): void {
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
