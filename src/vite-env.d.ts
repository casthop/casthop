/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Self-host the on-device caption runtime and model. See docs, "Live captions". */
  readonly VITE_CAPTION_RUNTIME_URL?: string;
  readonly VITE_CAPTION_RUNTIME_BASE?: string;
  readonly VITE_CAPTION_MODEL_BASE?: string;
  readonly VITE_CAPTION_MODEL?: string;
}

interface Window {
  __BENCH__?: unknown;
  __PERF__?: unknown;
  __PERF_RUNNING__?: unknown;
}

declare module "*.wasm?url" {
  const src: string;
  export default src;
}

declare module "*.js?url" {
  const src: string;
  export default src;
}

declare module "*casthop_gpu.js" {
  export default function init(opts?: { module_or_path?: unknown }): Promise<unknown>;
  export function gpu_compositor_create(
    device: GPUDevice,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
    format: string,
  ): void;
  export function gpu_compositor_draw(sources: ArrayLike<CanvasImageSource | VideoFrame>, mode: number): number;
}

declare module "*.tflite?url" {
  const src: string;
  export default src;
}
