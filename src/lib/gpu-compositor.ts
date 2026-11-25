import init, { gpu_compositor_create, gpu_compositor_draw } from "../wasm/casthop_gpu.js";
import gpuWasmUrl from "../wasm/casthop_gpu_bg.wasm?url";
import { modeCode, type LayoutMode } from "./wasm";
import { get2d, makeDrawCanvas, type DrawCanvas, type DrawContext } from "./draw-canvas";

export type GpuTile = CanvasImageSource | VideoFrame;

let wasmInit: Promise<void> | null = null;
let cached: { key: string; canvas: DrawCanvas; device: GPUDevice } | null = null;
let inflight: Promise<DrawCanvas | null> | null = null;
let gpuFail = false;
let drawFails = 0;
const DRAW_FAIL_LIMIT = 3;

async function ensureGpu(width: number, height: number): Promise<DrawCanvas | null> {
  if (gpuFail) return null;
  const key = `${width}x${height}`;
  if (cached?.key === key) return cached.canvas;
  if (inflight) {
    await inflight;
    if (gpuFail) return null;
    if (cached?.key === key) return cached.canvas;
  }
  const pending = openGpu(width, height, key);
  inflight = pending;
  try {
    return await pending;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

async function openGpu(width: number, height: number, key: string): Promise<DrawCanvas | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      gpuFail = true;
      return null;
    }
    wasmInit ??= init({ module_or_path: gpuWasmUrl }).then(() => undefined);
    await wasmInit;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      gpuFail = true;
      return null;
    }
    const device = await adapter.requestDevice();
    const canvas = makeDrawCanvas(width, height);
    try {
      gpu_compositor_create(device, canvas, width, height, gpu.getPreferredCanvasFormat());
    } catch (err) {
      device.destroy();
      throw err;
    }
    if (cached) cached.device.destroy();
    cached = { key, canvas, device };
    void device.lost.then(() => {
      if (cached?.device === device) cached = null;
    });
    return canvas;
  } catch (err) {
    console.warn("wgpu compositor fallback", err);
    gpuFail = true;
    return null;
  }
}

export async function drawWgpu(
  dest: DrawCanvas,
  tiles: GpuTile[],
  mode: LayoutMode,
  banner: (ctx: DrawContext) => void,
): Promise<boolean> {
  const gpuCanvas = await ensureGpu(dest.width, dest.height);
  if (!gpuCanvas) return false;
  try {
    const ok = gpu_compositor_draw(tiles, modeCode(mode));
    if (!ok) {
      drawFails += 1;
      if (drawFails >= DRAW_FAIL_LIMIT) gpuFail = true;
      return false;
    }
    const ctx = get2d(dest);
    if (!ctx) return false;
    ctx.drawImage(gpuCanvas, 0, 0);
    banner(ctx);
    drawFails = 0;
    return true;
  } catch (err) {
    console.warn("wgpu draw failed", err);
    drawFails += 1;
    if (drawFails >= DRAW_FAIL_LIMIT) gpuFail = true;
    return false;
  }
}

export function gpuWasmAssetUrl(): string {
  return gpuWasmUrl;
}
