import wasmUrl from "../wasm/casthop_media.wasm?url";

export type LayoutMode = "solo" | "side" | "grid" | "screen";

export type Rect = { x: number; y: number; w: number; h: number };

type Exports = {
  memory: WebAssembly.Memory;
  casthop_frame_size(): number;
  casthop_version(): number;
  casthop_denoise_new(): number;
  casthop_denoise_in_ptr(h: number): number;
  casthop_denoise_out_ptr(h: number): number;
  casthop_denoise_process(h: number): number;
  casthop_denoise_free(h: number): void;
  casthop_meter(ptr: number, len: number, rms: number, peak: number): number;
  casthop_layout(n: number, mode: number, out: number, cap: number): number;
  casthop_compose_new(w: number, h: number): number;
  casthop_compose_ptr(h: number): number;
  casthop_compose_len(h: number): number;
  casthop_compose_clear(h: number, rgba: number): void;
  casthop_tile_ptr(h: number): number;
  casthop_tile_reserve(h: number, bytes: number): number;
  casthop_compose_blit(
    h: number,
    srcW: number,
    srcH: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    filter: number,
  ): void;
  casthop_compose_banner(h: number, title: number, titleLen: number, sub: number, subLen: number): void;
  casthop_compose_free(h: number): void;
  casthop_blur_new(): number;
  casthop_blur_setup(h: number, w: number, height: number, mw: number, mh: number, radius: number, temporal: number): number;
  casthop_blur_frame_ptr(h: number): number;
  casthop_blur_frame_len(h: number): number;
  casthop_blur_mask_ptr(h: number): number;
  casthop_blur_mask_len(h: number): number;
  casthop_blur_process(h: number): number;
  casthop_blur_free(h: number): void;
};

let instancePromise: Promise<Exports> | null = null;

export function wasmAssetUrl(): string {
  return wasmUrl;
}

export async function loadWasm(): Promise<Exports> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const res = await fetch(wasmUrl);
      const bytes = await res.arrayBuffer();
      const module = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(module, {});
      return instance.exports as unknown as Exports;
    })();
  }
  return instancePromise;
}

export async function loadWasmBytes(): Promise<ArrayBuffer> {
  const res = await fetch(wasmUrl);
  return res.arrayBuffer();
}

export function modeCode(mode: LayoutMode): number {
  if (mode === "solo") return 0;
  if (mode === "side") return 1;
  if (mode === "screen") return 3;
  return 2;
}

export class WasmDenoiser {
  private readonly api: Exports;
  readonly handle: number;
  readonly inPtr: number;
  readonly outPtr: number;
  readonly frameSize: number;

  constructor(api: Exports) {
    this.api = api;
    this.handle = api.casthop_denoise_new();
    this.inPtr = api.casthop_denoise_in_ptr(this.handle);
    this.outPtr = api.casthop_denoise_out_ptr(this.handle);
    this.frameSize = api.casthop_frame_size();
  }

  process(input: Float32Array): { output: Float32Array; vad: number } {
    const n = this.frameSize;
    const mem = this.api.memory.buffer;
    const inp = new Float32Array(mem, this.inPtr, n);
    inp.set(input.subarray(0, n));
    const vad = this.api.casthop_denoise_process(this.handle) / 10_000;
    const output = new Float32Array(this.api.memory.buffer, this.outPtr, n).slice();
    return { output, vad };
  }
}

export class WasmMeter {
  private readonly api: Exports;
  private ptr: number;
  private cap: number;

  constructor(api: Exports) {
    this.api = api;
    this.cap = 512;
    this.ptr = 0;
  }

  measure(samples: Float32Array): { rms: number; peak: number; voice: boolean } {
    if (!this.ptr || this.cap < samples.length) {
      this.cap = Math.max(samples.length, 512);
    }
    const scratch = allocF32(this.api, samples.length + 2);
    const mem = this.api.memory.buffer;
    new Float32Array(mem, scratch, samples.length).set(samples);
    const rmsPtr = scratch + samples.length * 4;
    const peakPtr = rmsPtr + 4;
    const voice = this.api.casthop_meter(scratch, samples.length, rmsPtr, peakPtr);
    const rms = new Float32Array(this.api.memory.buffer, rmsPtr, 1)[0] ?? 0;
    const peak = new Float32Array(this.api.memory.buffer, peakPtr, 1)[0] ?? 0;
    return { rms, peak, voice: voice !== 0 };
  }
}

const scratchHandles: { api: Exports; handle: number; ptr: number; words: number }[] = [];

function allocF32(api: Exports, words: number): number {
  let slot = scratchHandles.find((s) => s.api === api && s.words >= words);
  if (!slot) {
    const handle = api.casthop_compose_new(16, 16);
    const ptr = api.casthop_tile_reserve(handle, words * 4);
    slot = { api, handle, ptr, words };
    scratchHandles.push(slot);
  } else if (slot.words < words) {
    slot.ptr = api.casthop_tile_reserve(slot.handle, words * 4);
    slot.words = words;
  }
  return slot.ptr;
}

export function layoutRects(api: Exports, n: number, mode: LayoutMode, width: number, height: number): Rect[] {
  const ptr = allocF32(api, 32);
  const count = api.casthop_layout(n, modeCode(mode), ptr, 32);
  const data = new Float32Array(api.memory.buffer, ptr, count * 4);
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    rects.push({
      x: data[i * 4]! * width,
      y: data[i * 4 + 1]! * height,
      w: data[i * 4 + 2]! * width,
      h: data[i * 4 + 3]! * height,
    });
  }
  return rects;
}

export class WasmCompositor {
  private readonly api: Exports;
  readonly handle: number;
  readonly width: number;
  readonly height: number;

  constructor(api: Exports, width = 1280, height = 720) {
    this.api = api;
    this.width = width;
    this.height = height;
    this.handle = api.casthop_compose_new(width, height);
  }

  clear(rgba = 0x0b0b0dff): void {
    this.api.casthop_compose_clear(this.handle, rgba);
  }

  blit(tile: Uint8ClampedArray | Uint8Array, srcW: number, srcH: number, dest: Rect, bilinear = false): void {
    const bytes = srcW * srcH * 4;
    const ptr = this.api.casthop_tile_reserve(this.handle, bytes);
    new Uint8Array(this.api.memory.buffer, ptr, bytes).set(tile.subarray(0, bytes));
    this.api.casthop_compose_blit(
      this.handle,
      srcW,
      srcH,
      Math.round(dest.x),
      Math.round(dest.y),
      Math.round(dest.w),
      Math.round(dest.h),
      bilinear ? 1 : 0,
    );
  }

  banner(title: string, subtitle: string): void {
    const enc = new TextEncoder();
    const t = enc.encode(title);
    const s = enc.encode(subtitle);
    const ptr = this.api.casthop_tile_reserve(this.handle, t.length + s.length + 8);
    const buf = new Uint8Array(this.api.memory.buffer, ptr, t.length + s.length);
    buf.set(t, 0);
    buf.set(s, t.length);
    this.api.casthop_compose_banner(this.handle, ptr, t.length, ptr + t.length, s.length);
  }

  imageData(): ImageData {
    const ptr = this.api.casthop_compose_ptr(this.handle);
    const len = this.api.casthop_compose_len(this.handle);
    const pixels = new Uint8ClampedArray(this.api.memory.buffer, ptr, len).slice();
    return new ImageData(pixels, this.width, this.height);
  }
}

export class WasmBlur {
  private readonly api: Exports;
  private handle: number;
  width = 1280;
  height = 720;
  maskW = 256;
  maskH = 144;
  private lastBuffer: ArrayBuffer | null = null;
  private frameView: Uint8Array | null = null;
  private maskView: Uint8Array | null = null;

  constructor(api: Exports) {
    this.api = api;
    this.handle = api.casthop_blur_new();
  }

  setup(width: number, height: number, maskW: number, maskH: number, radius = 24, temporal = 180): boolean {
    if (!this.handle) return false;
    if (!this.api.casthop_blur_setup(this.handle, width, height, maskW, maskH, radius, temporal)) return false;
    this.width = width;
    this.height = height;
    this.maskW = maskW;
    this.maskH = maskH;
    this.lastBuffer = null;
    this.frameView = null;
    this.maskView = null;
    return true;
  }

  private syncViews(): boolean {
    const buf = this.api.memory.buffer;
    if (this.lastBuffer === buf && this.frameView && this.maskView) return true;
    const fp = this.api.casthop_blur_frame_ptr(this.handle);
    const mp = this.api.casthop_blur_mask_ptr(this.handle);
    if (!fp || !mp) {
      this.frameView = null;
      this.maskView = null;
      return false;
    }
    this.lastBuffer = buf;
    this.frameView = new Uint8Array(buf, fp, this.width * this.height * 4);
    this.maskView = new Uint8Array(buf, mp, this.maskW * this.maskH);
    return true;
  }

  process(frame: Uint8ClampedArray | Uint8Array, mask: Uint8Array): boolean {
    if (!this.handle) return false;
    if (!this.syncViews() || !this.frameView || !this.maskView) return false;
    this.frameView.set(frame);
    this.maskView.set(mask);
    if (!this.api.casthop_blur_process(this.handle)) return false;
    if (this.api.memory.buffer !== this.lastBuffer && !this.syncViews()) return false;
    if (!this.frameView) return false;
    frame.set(this.frameView);
    return true;
  }

  free(): void {
    if (!this.handle) return;
    this.api.casthop_blur_free(this.handle);
    this.handle = 0;
    this.lastBuffer = null;
    this.frameView = null;
    this.maskView = null;
  }
}
