import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pickComposeBackendFrom } from "../src/lib/compose-backend.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("pickComposeBackendFrom maps query flags", () => {
  assert.equal(pickComposeBackendFrom(""), "canvas2d");
  assert.equal(pickComposeBackendFrom("?fx=js"), "canvas2d");
  assert.equal(pickComposeBackendFrom("?compose=wasm"), "wasm-cpu");
  assert.equal(pickComposeBackendFrom("compose=cpu"), "wasm-cpu");
  assert.equal(pickComposeBackendFrom("?compose=js"), "js-cpu");
  assert.equal(pickComposeBackendFrom("?compose=webgpu"), "webgpu");
  assert.equal(pickComposeBackendFrom("?compose=wgpu"), "webgpu");
  assert.equal(pickComposeBackendFrom("?compose=webgpu-ts"), "webgpu-ts");
  assert.equal(pickComposeBackendFrom("?compose=canvas"), "canvas2d");
});

test("casthop_media.wasm has zero imports", () => {
  const buf = readFileSync(join(root, "src/wasm/casthop_media.wasm"));
  const mod = new WebAssembly.Module(buf);
  assert.equal(WebAssembly.Module.imports(mod).length, 0);
  const inst = new WebAssembly.Instance(mod, {});
  const exp = inst.exports as { casthop_layout: (n: number, mode: number, out: number, cap: number) => number; memory: WebAssembly.Memory };
  assert.equal(typeof exp.casthop_layout, "function");
});

test("casthop_gpu_bg.wasm is a separate compositor module with JS imports", () => {
  const buf = readFileSync(join(root, "src/wasm/casthop_gpu_bg.wasm"));
  assert.ok(buf.byteLength > 8_000);
  assert.ok(buf.byteLength < 200_000, `gpu wasm ${buf.byteLength} should stay well under 200 KiB`);
  const mod = new WebAssembly.Module(buf);
  const imports = WebAssembly.Module.imports(mod);
  assert.ok(imports.length > 0);
  assert.ok(imports.some((i) => i.module.includes("wbg") || i.name.includes("wbg") || i.module === "__wbindgen_placeholder__"));
  const exports = WebAssembly.Module.exports(mod);
  assert.ok(exports.some((e) => e.name.includes("gpu_compositor")));
});

test("webgpu draw only disables after several failed frames", () => {
  const src = readFileSync(join(root, "src/lib/gpu-compositor.ts"), "utf8");
  assert.match(src, /DRAW_FAIL_LIMIT = 3/);
  assert.match(src, /drawFails >= DRAW_FAIL_LIMIT/);
  assert.doesNotMatch(src, /if \(!ok\) \{\s*gpuFail = true/);
});

test("webgpu-ts reuses per-tile buffers and destroys old textures", () => {
  const src = readFileSync(join(root, "src/lib/webgpu-ts.ts"), "utf8");
  assert.match(src, /rectBuf/);
  assert.match(src, /texture\.destroy\(\)/);
  assert.match(src, /rectBuf\.destroy\(\)/);
  assert.match(src, /device\.destroy\(\)/);
  assert.match(src, /let inflight/);
});

test("wgpu init shares one in-flight promise and clears a lost device", () => {
  const src = readFileSync(join(root, "src/lib/gpu-compositor.ts"), "utf8");
  assert.match(src, /let inflight/);
  assert.match(src, /device\.lost/);
  assert.match(src, /cached = null/);
});

test("egress template still falls back through pickComposeBackend", () => {
  const src = readFileSync(join(root, "src/pages/EgressTemplate.tsx"), "utf8");
  assert.match(src, /pickComposeBackend/);
  assert.match(src, /composeFrame/);
});
