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

export type JsBlurState = {
  smooth: Uint8Array | null;
  feather: Uint8Array | null;
  down: Uint8Array | null;
  tmp: Uint8Array | null;
};

function ensure(buf: Uint8Array | null, n: number): Uint8Array {
  return buf && buf.length >= n ? buf : new Uint8Array(n);
}

/** Same algorithm as crates/casthop-media blur.rs (mask EMA, 4× box-blur, mix). */
export function jsBlurComposite(
  frame: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  radius: number,
  temporal: number,
  state: JsBlurState = { smooth: null, feather: null, down: null, tmp: null },
): void {
  const pixels = width * height;
  if (frame.length < pixels * 4 || maskW < 1 || maskH < 1) return;
  const mx = maskW * maskH;
  let smooth = state.smooth;
  if (!smooth || smooth.length !== mx) {
    smooth = new Uint8Array(mx);
    state.smooth = smooth;
    smooth.set(mask.subarray(0, mx));
  } else if (temporal <= 0) {
    smooth.set(mask.subarray(0, mx));
  } else {
    const t = temporal & 255;
    const inv = 256 - t;
    for (let i = 0; i < mx; i++) {
      smooth[i] = ((smooth[i]! * t + mask[i]! * inv) >> 8) & 255;
    }
  }
  const feather = ensure(state.feather, mx);
  state.feather = feather;
  box3Mask(smooth, feather, maskW, maskH);
  const dw = Math.max(1, Math.floor(width / 4));
  const dh = Math.max(1, Math.floor(height / 4));
  const down = ensure(state.down, dw * dh * 4);
  const tmp = ensure(state.tmp, dw * dh * 4);
  state.down = down;
  state.tmp = tmp;
  downsampleRgba(frame, width, height, down, dw, dh);
  const r = Math.max(1, Math.min(16, Math.floor(radius / 4)));
  boxBlurH(down, tmp, dw, dh, r);
  boxBlurV(tmp, down, dw, dh, r);
  mixFromDown(frame, width, height, feather, maskW, maskH, down, dw, dh);
}

function box3Mask(src: Uint8Array, dst: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h, y + 2);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w, x + 2);
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx++) {
          sum += src[row + xx]!;
          n += 1;
        }
      }
      dst[y * w + x] = n === 0 ? 0 : (sum / n) | 0;
    }
  }
}

function downsampleRgba(
  src: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  dst: Uint8Array,
  dw: number,
  dh: number,
): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.floor((y * sh) / dh);
    const sy2 = Math.min(sh - 1, sy + 2);
    for (let x = 0; x < dw; x++) {
      const sx = Math.floor((x * sw) / dw);
      const sx2 = Math.min(sw - 1, sx + 2);
      let r = 0;
      let g = 0;
      let b = 0;
      const pts = [sx, sy, sx2, sy, sx, sy2, sx2, sy2];
      for (let p = 0; p < 8; p += 2) {
        const i = (pts[p + 1]! * sw + pts[p]!) * 4;
        r += src[i]!;
        g += src[i + 1]!;
        b += src[i + 2]!;
      }
      const o = (y * dw + x) * 4;
      dst[o] = (r / 4) | 0;
      dst[o + 1] = (g / 4) | 0;
      dst[o + 2] = (b / 4) | 0;
      dst[o + 3] = 255;
    }
  }
}

function boxBlurH(src: Uint8Array, dst: Uint8Array, w: number, h: number, radius: number): void {
  const prefix = new Uint32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 3; c++) {
      prefix[0] = 0;
      for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x]! + src[row + x * 4 + c]!;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w, x + radius + 1);
        dst[row + x * 4 + c] = ((prefix[x1]! - prefix[x0]!) / (x1 - x0)) | 0;
      }
    }
    for (let x = 0; x < w; x++) dst[row + x * 4 + 3] = 255;
  }
}

function boxBlurV(src: Uint8Array, dst: Uint8Array, w: number, h: number, radius: number): void {
  const prefix = new Uint32Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      prefix[0] = 0;
      for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y]! + src[(y * w + x) * 4 + c]!;
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(h, y + radius + 1);
        dst[(y * w + x) * 4 + c] = ((prefix[y1]! - prefix[y0]!) / (y1 - y0)) | 0;
      }
    }
    for (let y = 0; y < h; y++) dst[(y * w + x) * 4 + 3] = 255;
  }
}

function mixFromDown(
  frame: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  down: Uint8Array,
  dw: number,
  dh: number,
): void {
  const maxMx = maskW - 1;
  const maxMy = maskH - 1;
  const xDen = Math.max(1, width - 1);
  const yDen = Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const myQ = ((y * maxMy * 256) / yDen) | 0;
    const my0 = Math.min(maxMy, myQ >> 8);
    const my1 = Math.min(maxMy, my0 + 1);
    const ty = myQ & 255;
    const row0 = my0 * maskW;
    const row1 = my1 * maskW;
    const dy = Math.min(dh - 1, ((y * dh) / height) | 0);
    const drow = dy * dw;
    for (let x = 0; x < width; x++) {
      const mxQ = ((x * maxMx * 256) / xDen) | 0;
      const mx0 = Math.min(maxMx, mxQ >> 8);
      const mx1 = Math.min(maxMx, mx0 + 1);
      const tx = mxQ & 255;
      const c00 = mask[row0 + mx0]!;
      const c10 = mask[row0 + mx1]!;
      const c01 = mask[row1 + mx0]!;
      const c11 = mask[row1 + mx1]!;
      const a = c00 * (256 - tx) + c10 * tx;
      const b = c01 * (256 - tx) + c11 * tx;
      const m = (a * (256 - ty) + b * ty) >> 16;
      const o = (y * width + x) * 4;
      if (m >= 255) {
        frame[o + 3] = 255;
        continue;
      }
      const dx = Math.min(dw - 1, ((x * dw) / width) | 0);
      const bi = (drow + dx) * 4;
      if (m === 0) {
        frame[o] = down[bi]!;
        frame[o + 1] = down[bi + 1]!;
        frame[o + 2] = down[bi + 2]!;
        frame[o + 3] = 255;
        continue;
      }
      const inv = 255 - m;
      frame[o] = ((frame[o]! * m + down[bi]! * inv) / 255) | 0;
      frame[o + 1] = ((frame[o + 1]! * m + down[bi + 1]! * inv) / 255) | 0;
      frame[o + 2] = ((frame[o + 2]! * m + down[bi + 2]! * inv) / 255) | 0;
      frame[o + 3] = 255;
    }
  }
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
