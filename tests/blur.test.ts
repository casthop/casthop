import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jsBlurComposite } from "../src/lib/js-pipeline.ts";
import { loadBlurPref, saveBlurPref } from "../src/lib/blur-prefs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "src/wasm/casthop_media.wasm");
const modelPath = join(root, "src/vendor/mediapipe/selfie_segmenter_landscape.tflite");
const noticePath = join(root, "src/vendor/mediapipe/NOTICE");

test("blur preference is off by default and stored per device", () => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  assert.equal(loadBlurPref("cam-a"), false);
  saveBlurPref("cam-a", true);
  saveBlurPref("cam-b", false);
  assert.equal(loadBlurPref("cam-a"), true);
  assert.equal(loadBlurPref("cam-b"), false);
  assert.equal(loadBlurPref("cam-missing"), false);
});

test("casthop_media.wasm stays under 500 KiB with zero imports", () => {
  const bytes = readFileSync(wasmPath);
  assert.ok(bytes.length < 500 * 1024, `wasm is ${bytes.length} bytes`);
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.equal(imports.length, 0);
});

test("selfie segmenter model is bundled and Apache-2.0 is noted", () => {
  const model = readFileSync(modelPath);
  assert.ok(model.length > 100_000 && model.length < 400_000);
  assert.equal(model.subarray(4, 8).toString(), "TFL3");
  const notice = readFileSync(noticePath, "utf8");
  assert.match(notice, /Apache License, Version 2.0/);
  assert.match(notice, /MediaPipe/);
});

test("WASM blur keeps a solid person and mixes a checkerboard background", async () => {
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exp = instance.exports as {
    casthop_blur_new: () => number;
    casthop_blur_setup: (h: number, w: number, height: number, mw: number, mh: number, r: number, t: number) => number;
    casthop_blur_frame_ptr: (h: number) => number;
    casthop_blur_frame_len: (h: number) => number;
    casthop_blur_mask_ptr: (h: number) => number;
    casthop_blur_process: (h: number) => number;
    casthop_blur_free: (h: number) => void;
    memory: WebAssembly.Memory;
  };
  const w = 64;
  const h = 64;
  const mw = 16;
  const mh = 16;
  const handle = exp.casthop_blur_new();
  assert.equal(exp.casthop_blur_setup(handle, w, h, mw, mh, 24, 0), 1);
  const framePtr = exp.casthop_blur_frame_ptr(handle);
  const maskPtr = exp.casthop_blur_mask_ptr(handle);
  const frame = new Uint8Array(exp.memory.buffer, framePtr, w * h * 4);
  const mask = new Uint8Array(exp.memory.buffer, maskPtr, mw * mh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < 32) {
        frame[i] = 200;
        frame[i + 1] = 10;
        frame[i + 2] = 10;
      } else {
        const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
        frame[i] = on ? 0 : 255;
        frame[i + 1] = 0;
        frame[i + 2] = on ? 255 : 0;
      }
      frame[i + 3] = 255;
    }
  }
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      mask[y * mw + x] = x < 8 ? 255 : 0;
    }
  }
  assert.equal(exp.casthop_blur_process(handle), 1);
  const person = frame[(16 * w + 8) * 4] ?? 0;
  assert.ok(Math.abs(person - 200) < 8, `person pixel ${person}`);
  const bg = frame[(16 * w + 48) * 4] ?? 0;
  assert.ok(bg !== 0 && bg !== 255, `background should be mixed, got ${bg}`);
  assert.ok(exp.casthop_blur_frame_len(handle) > 0);
  exp.casthop_blur_free(handle);
  assert.equal(exp.casthop_blur_frame_len(handle), 0);
  assert.equal(exp.casthop_blur_new(), handle);
});

test("JS blur fallback matches the WASM mix contract", () => {
  const w = 64;
  const h = 64;
  const frame = new Uint8Array(w * h * 4);
  const mask = new Uint8Array(16 * 16);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < 32) {
        frame[i] = 200;
        frame[i + 1] = 10;
        frame[i + 2] = 10;
      } else {
        const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
        frame[i] = on ? 0 : 255;
        frame[i + 1] = 0;
        frame[i + 2] = on ? 255 : 0;
      }
      frame[i + 3] = 255;
    }
  }
  mask.fill(0);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 8; x++) mask[y * 16 + x] = 255;
  }
  jsBlurComposite(frame, w, h, mask, 16, 16, 24, 0);
  const person = frame[(16 * w + 8) * 4] ?? 0;
  assert.ok(Math.abs(person - 200) < 8, `person pixel ${person}`);
  const bg = frame[(16 * w + 48) * 4] ?? 0;
  assert.ok(bg !== 0 && bg !== 255, `background should be mixed, got ${bg}`);
});
