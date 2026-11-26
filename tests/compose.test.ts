import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pickComposeBackendFrom, pickComposeThreadFrom } from "../src/lib/compose-backend.ts";
import { jsLayout } from "../src/lib/js-pipeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("js portrait layout stacks cameras above a captions band", () => {
  const r = jsLayout(3, 4);
  assert.equal(r.length, 3);
  const last = r[2]!;
  assert.ok(last.y + last.h < 0.84);
  assert.equal(r[0]?.x, 0);
  assert.equal(r[0]?.w, 1);
  assert.ok((r[1]?.y ?? 0) > (r[0]?.y ?? 0));
});

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
  const exp = inst.exports as {
    casthop_layout: (n: number, mode: number, out: number, cap: number) => number;
    casthop_compose_new: (w: number, h: number) => number;
    casthop_tile_reserve: (h: number, bytes: number) => number;
    memory: WebAssembly.Memory;
  };
  assert.equal(typeof exp.casthop_layout, "function");
  const handle = exp.casthop_compose_new(16, 16);
  const ptr = exp.casthop_tile_reserve(handle, 128);
  const n = exp.casthop_layout(3, 4, ptr, 32);
  assert.equal(n, 3);
  const mem = new Float32Array(exp.memory.buffer, ptr, 12);
  const bottom = mem[2 * 4 + 1]! + mem[2 * 4 + 3]!;
  assert.ok(bottom < 0.84, `portrait cameras must leave a captions band, got ${bottom}`);
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
  assert.match(src, /try \{\s*const ok = gpu_compositor_draw/s);
  assert.match(src, /console\.warn\("wgpu draw failed"/);
});

test("webgpu-ts reuses per-tile buffers and destroys old textures", () => {
  const src = readFileSync(join(root, "src/lib/webgpu-ts.ts"), "utf8");
  assert.match(src, /rectBuf/);
  assert.match(src, /texture\.destroy\(\)/);
  assert.match(src, /rectBuf\.destroy\(\)/);
  assert.match(src, /device\.destroy\(\)/);
  assert.match(src, /let inflight/);
  assert.match(src, /DRAW_FAIL_LIMIT = 3/);
  assert.match(src, /device\.destroy\(\);\s*throw err/s);
  assert.match(src, /rect: new Float32Array\(4\)/);
  assert.doesNotMatch(src, /new Float32Array\(\[/);
  assert.match(src, /writeBuffer\(slot\.rectBuf, 0, rect\)/);
  assert.match(src, /for \(let i = tiles\.length; i < gpu\.tiles\.length; i\+\+\)/);
});

test("bench publishes results without as unknown as", () => {
  const bench = readFileSync(join(root, "src/pages/Bench.tsx"), "utf8");
  const env = readFileSync(join(root, "src/vite-env.d.ts"), "utf8");
  assert.doesNotMatch(bench, /as unknown as/);
  assert.match(bench, /window\.__BENCH__ =/);
  assert.match(env, /__BENCH__\?: unknown/);
});

test("wgpu init shares one in-flight promise and clears a lost device", () => {
  const src = readFileSync(join(root, "src/lib/gpu-compositor.ts"), "utf8");
  assert.match(src, /let inflight/);
  assert.match(src, /device\.lost/);
  assert.match(src, /cached = null/);
});

test("wgpu compositor create destroys the new device if pipeline setup throws", () => {
  const src = readFileSync(join(root, "src/lib/gpu-compositor.ts"), "utf8");
  assert.match(src, /gpu_compositor_create\(/);
  assert.match(src, /device\.destroy\(\);\s*throw err/s);
});

test("rust webgpu path destroys the previous tile texture on resize", () => {
  const src = readFileSync(join(root, "crates/casthop-media/src/gpu_web.rs"), "utf8");
  assert.match(src, /if let Some\(old\) = inner\.tiles\[i\]\.take\(\)/);
  assert.match(src, /old\.texture\.destroy\(\)/);
  assert.match(src, /inner\.tiles\.iter_mut\(\)\.skip\(n as usize\)/);
});

test("gpu compose checks texture and buffer device limits", () => {
  const rust = readFileSync(join(root, "crates/casthop-media/src/gpu_web.rs"), "utf8");
  const ts = readFileSync(join(root, "src/lib/webgpu-ts.ts"), "utf8");
  assert.match(rust, /max_texture_dimension_2d/);
  assert.match(rust, /max_buffer_size/);
  assert.match(rust, /w > inner\.max_tex \|\| h > inner\.max_tex/);
  assert.match(ts, /maxTextureDimension2D/);
  assert.match(ts, /maxBufferSize/);
  assert.match(ts, /w > gpu\.maxTex \|\| h > gpu\.maxTex/);
});

test("wasm build requires wasm-bindgen 0.2.100 before cargo", () => {
  const src = readFileSync(join(root, "scripts/build-wasm.sh"), "utf8");
  const checkAt = src.indexOf('wasm-bindgen --version | grep -q "0.2.100"');
  const cargoAt = src.indexOf("cargo build");
  assert.ok(checkAt >= 0, "missing wasm-bindgen 0.2.100 version check");
  assert.ok(cargoAt > checkAt, "version check must run before cargo build");
});

test("egress template still falls back through pickComposeBackend", () => {
  const src = readFileSync(join(root, "src/pages/EgressTemplate.tsx"), "utf8");
  assert.match(src, /pickComposeBackend/);
  assert.match(src, /startProgramCompose/);
  assert.match(src, /initialLayout === "portrait"/);
  assert.match(src, /sendEgressBeat/);
  assert.match(src, /q\.get\("egressId"\) \|\| fromToken\.egressId/);
  assert.match(src, /sendEgressBeat\(studioId, token, egressId\)/);
  assert.match(src, /HEARTBEAT_BEAT_MS/);
});

test("gpu compositor accepts OffscreenCanvas and VideoFrame", () => {
  const src = readFileSync(join(root, "crates/casthop-media/src/gpu_web.rs"), "utf8");
  assert.match(src, /OffscreenCanvas/);
  assert.match(src, /VideoFrame/);
  assert.match(src, /display_width/);
  assert.match(src, /canvas must be HTMLCanvasElement or OffscreenCanvas/);
});

test("compose thread query is opt-out of the worker path", () => {
  assert.equal(pickComposeThreadFrom("?thread=main"), "main");
});
