#!/usr/bin/env node
/**
 * Node-side WASM vs JS comparison (CPU time / frame, bundle size).
 * Browser numbers come from /internal/bench.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { cpuUsage } from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "src/wasm/casthop_media.wasm");
const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const exp = instance.exports;

const FRAME = exp.casthop_frame_size();
const denoiseH = exp.casthop_denoise_new();
const inPtr = exp.casthop_denoise_in_ptr(denoiseH);
const outPtr = exp.casthop_denoise_out_ptr(denoiseH);

function jsDenoise(frame) {
  let sum = 0;
  let sum2 = 0;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i];
    sum += s;
    sum2 += s * s;
    if (s >= 0 !== prev >= 0) zc += 1;
    prev = s;
  }
  const mean = sum / frame.length;
  const rms = Math.sqrt(sum2 / frame.length);
  const gate = rms < 0.01 ? 0.08 : 1;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = (frame[i] - mean) * gate;
  return out;
}

function jsCompose(dst, dw, dh, src, sw, sh, dx, dy, tw, th) {
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
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

const sine = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) {
  sine[i] = Math.sin((i * 440 * 2 * Math.PI) / 48000) * 0.2 + (Math.random() - 0.5) * 0.04;
}

const denoiseFrames = 8000;
const cpu0 = cpuUsage();
const t0 = performance.now();
for (let i = 0; i < denoiseFrames; i++) {
  new Float32Array(exp.memory.buffer, inPtr, FRAME).set(sine);
  exp.casthop_denoise_process(denoiseH);
  void new Float32Array(exp.memory.buffer, outPtr, FRAME)[0];
}
const wasmDenoiseMs = performance.now() - t0;
const cpuWasmDenoise = cpuUsage(cpu0);

const cpu1 = cpuUsage();
const t1 = performance.now();
for (let i = 0; i < denoiseFrames; i++) jsDenoise(sine);
const jsDenoiseMs = performance.now() - t1;
const cpuJsDenoise = cpuUsage(cpu1);

const tile = new Uint8Array(640 * 360 * 4);
for (let i = 0; i < tile.length; i += 4) {
  tile[i] = (i * 13) & 255;
  tile[i + 1] = 90;
  tile[i + 2] = 120;
  tile[i + 3] = 255;
}
const composeH = exp.casthop_compose_new(1280, 720);
const composeFrames = 80;
const cpu2 = cpuUsage();
const t2 = performance.now();
for (let n = 0; n < composeFrames; n++) {
  exp.casthop_compose_clear(composeH, 0x0b0b0dff);
  for (let i = 0; i < 4; i++) {
    const ptr = exp.casthop_tile_reserve(composeH, tile.length);
    new Uint8Array(exp.memory.buffer, ptr, tile.length).set(tile);
    const dx = (i % 2) * 640;
    const dy = Math.floor(i / 2) * 360;
    exp.casthop_compose_blit(composeH, 640, 360, dx, dy, 640, 360, 0);
  }
}
const wasmComposeMs = performance.now() - t2;
const cpuWasmCompose = cpuUsage(cpu2);

const dst = new Uint8Array(1280 * 720 * 4);
const cpu3 = cpuUsage();
const t3 = performance.now();
for (let n = 0; n < composeFrames; n++) {
  dst.fill(11);
  for (let i = 0; i < 4; i++) {
    jsCompose(dst, 1280, 720, tile, 640, 360, (i % 2) * 640, Math.floor(i / 2) * 360, 640, 360);
  }
}
const jsComposeMs = performance.now() - t3;
const cpuJsCompose = cpuUsage(cpu3);

const out = {
  wasmBytes: bytes.length,
  wasmKiB: +(bytes.length / 1024).toFixed(1),
  denoise: {
    frames: denoiseFrames,
    wasmMsPerFrame: wasmDenoiseMs / denoiseFrames,
    jsMsPerFrame: jsDenoiseMs / denoiseFrames,
    speedup: jsDenoiseMs / wasmDenoiseMs,
    wasmCpuMs: (cpuWasmDenoise.user + cpuWasmDenoise.system) / 1000,
    jsCpuMs: (cpuJsDenoise.user + cpuJsDenoise.system) / 1000,
  },
  compose: {
    frames: composeFrames,
    size: "1280x720 x4 tiles nearest",
    wasmMsPerFrame: wasmComposeMs / composeFrames,
    jsMsPerFrame: jsComposeMs / composeFrames,
    speedup: jsComposeMs / wasmComposeMs,
    wasmCpuMs: (cpuWasmCompose.user + cpuWasmCompose.system) / 1000,
    jsCpuMs: (cpuJsCompose.user + cpuJsCompose.system) / 1000,
  },
};

console.log(JSON.stringify(out, null, 2));
const destDir = join(root, "data/measure");
mkdirSync(destDir, { recursive: true });
writeFileSync(join(destDir, "wasm-bench.json"), JSON.stringify(out, null, 2));
