import init, { gpu_compositor_create, gpu_compositor_draw } from "../wasm/casthop_gpu.js";
import gpuWasmUrl from "../wasm/casthop_gpu_bg.wasm?url";
import { modeCode, type LayoutMode } from "./wasm";

export type GpuTile = HTMLVideoElement | HTMLCanvasElement;

let initPromise: Promise<void> | null = null;
let cached: { key: string; canvas: HTMLCanvasElement } | null = null;
let gpuFail = false;
let drawFails = 0;
const DRAW_FAIL_LIMIT = 3;

async function ensureGpu(width: number, height: number): Promise<HTMLCanvasElement | null> {
  if (gpuFail) return null;
  const key = `${width}x${height}`;
  if (cached && cached.key === key) return cached.canvas;
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      gpuFail = true;
      return null;
    }
    initPromise ??= init({ module_or_path: gpuWasmUrl }).then(() => undefined);
    await initPromise;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      gpuFail = true;
      return null;
    }
    const device = await adapter.requestDevice();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    gpu_compositor_create(device, canvas, width, height, gpu.getPreferredCanvasFormat());
    cached = { key, canvas };
    return canvas;
  } catch (err) {
    console.warn("wgpu compositor fallback", err);
    gpuFail = true;
    cached = null;
    return null;
  }
}

export async function drawWgpu(
  dest: HTMLCanvasElement,
  tiles: GpuTile[],
  mode: LayoutMode,
  banner: (ctx: CanvasRenderingContext2D) => void,
): Promise<boolean> {
  const gpuCanvas = await ensureGpu(dest.width, dest.height);
  if (!gpuCanvas) return false;
  const ok = gpu_compositor_draw(tiles, modeCode(mode));
  if (!ok) {
    drawFails += 1;
    if (drawFails >= DRAW_FAIL_LIMIT) gpuFail = true;
    return false;
  }
  drawFails = 0;
  const ctx = dest.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(gpuCanvas, 0, 0);
  banner(ctx);
  return true;
}

export function gpuWasmAssetUrl(): string {
  return gpuWasmUrl;
}
