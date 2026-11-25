export function supportsOffscreenCompose(): boolean {
  return (
    typeof OffscreenCanvas === "function" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" &&
    typeof Worker === "function" &&
    typeof VideoFrame === "function" &&
    typeof MediaStreamTrackProcessor === "function"
  );
}

export function supportsTrackGenerator(): boolean {
  return typeof MediaStreamTrackGenerator === "function";
}

export const FRAME_SAMPLE_CAP = 2048;

export function pushSample(buf: Float64Array, cursor: { i: number; n: number }, ms: number): void {
  buf[cursor.i] = ms;
  cursor.i = (cursor.i + 1) % buf.length;
  if (cursor.n < buf.length) cursor.n += 1;
}

export function usedSamples(buf: Float64Array, n: number): number[] {
  return Array.from(buf.subarray(0, n));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const i = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - i) + sorted[hi]! * (i - lo);
}
