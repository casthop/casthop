/// <reference types="vite/client" />

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
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    format: string,
  ): void;
  export function gpu_compositor_draw(sources: ArrayLike<CanvasImageSource>, mode: number): number;
}
