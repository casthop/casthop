/** Plain JS counterparts used for MEASUREMENTS.md (same algorithms, no WASM). */

export const JS_FRAME = 480;

export function jsDenoiseFrame(frame: Float32Array): { output: Float32Array; vad: number } {
  let sum = 0;
  let sum2 = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]!;
    sum += s;
    sum2 += s * s;
    if (s >= 0 !== prev >= 0) zc += 1;
    prev = s;
  }
  const mean = sum / frame.length;
  const rms = Math.sqrt(sum2 / frame.length);
  const zcr = zc / frame.length;
  const vad = rms > 0.018 && zcr > 0.01 && zcr < 0.25 ? 1 : 0;
  const gate = rms < 0.01 ? 0.08 : 1;
  const output = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) output[i] = (frame[i]! - mean) * gate;
  return { output, vad };
}

export function jsMeter(samples: Float32Array): { rms: number; peak: number; voice: boolean } {
  let sum2 = 0;
  let peak = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sum2 += s * s;
    if (s >= 0 !== prev >= 0) zc += 1;
    prev = s;
  }
  const rms = Math.sqrt(sum2 / samples.length);
  const zcr = zc / samples.length;
  return { rms, peak, voice: rms > 0.018 && zcr > 0.01 && zcr < 0.25 };
}

export type JsRect = { x: number; y: number; w: number; h: number };

export function jsLayout(n: number, mode: number): JsRect[] {
  const count = Math.max(1, Math.min(6, n));
  const g = 0.012;
  if (mode === 0) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (mode === 3) {
    const cams = Math.max(1, Math.min(3, count - 1));
    const mainW = 0.72;
    const out: JsRect[] = [{ x: 0, y: 0, w: mainW, h: 1 }];
    const stackX = mainW + g;
    const stackW = 1 - stackX;
    const ch = (1 - g * (cams - 1)) / cams;
    for (let i = 0; i < cams; i++) out.push({ x: stackX, y: i * (ch + g), w: stackW, h: ch });
    return out;
  }
  if (mode === 1 && count <= 2) {
    const w = (1 - g) / 2;
    return [
      { x: 0, y: 0, w, h: 1 },
      { x: w + g, y: 0, w, h: 1 },
    ];
  }
  const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : 3;
  const rows = count <= 2 ? 1 : 2;
  const cw = (1 - g * (cols - 1)) / cols;
  const rh = (1 - g * (rows - 1)) / rows;
  const out: JsRect[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: c * (cw + g), y: r * (rh + g), w: cw, h: rh });
  }
  return out;
}

export function jsComposeNearest(
  dst: Uint8ClampedArray,
  dw: number,
  dh: number,
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  tw: number,
  th: number,
): void {
  for (let y = 0; y < th; y++) {
    const sy = Math.floor((y * sh) / th);
    const yy = dy + y;
    if (yy >= dh) break;
    for (let x = 0; x < tw; x++) {
      const sx = Math.floor((x * sw) / tw);
      const xx = dx + x;
      if (xx >= dw) break;
      const si = (sy * sw + sx) * 4;
      const di = (yy * dw + xx) * 4;
      dst[di] = src[si]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
}
