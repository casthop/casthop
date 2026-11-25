export type DrawCanvas = HTMLCanvasElement | OffscreenCanvas;
export type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const OUT_W = 1280;
export const OUT_H = 720;

export function makeDrawCanvas(width: number, height: number): DrawCanvas {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

export function get2d(canvas: DrawCanvas, attrs?: CanvasRenderingContext2DSettings): DrawContext | null {
  return canvas.getContext("2d", attrs) as DrawContext | null;
}

export function sizeCanvas(canvas: DrawCanvas, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
