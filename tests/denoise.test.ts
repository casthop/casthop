import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  copyDenoisePref,
  loadDenoisePref,
  saveDenoisePref,
  saveDenoisePrefPair,
} from "../src/lib/denoise-prefs.ts";
import { fxBackendForDenoise } from "../src/lib/fx.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function mockStorage(): void {
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
}

test("denoise preference is on by default and stored per device", () => {
  mockStorage();
  assert.equal(loadDenoisePref("mic-a"), true);
  saveDenoisePref("mic-a", false);
  saveDenoisePref("mic-b", true);
  assert.equal(loadDenoisePref("mic-a"), false);
  assert.equal(loadDenoisePref("mic-b"), true);
  assert.equal(loadDenoisePref("mic-missing"), true);
  assert.equal(loadDenoisePref("mic-a", "mic-b"), true);
  assert.equal(loadDenoisePref("", "mic-a"), false);
  saveDenoisePref("", false);
  copyDenoisePref("", "mic-c");
  assert.equal(loadDenoisePref("mic-c"), false);
  saveDenoisePref("mic-d", true);
  copyDenoisePref("", "mic-d");
  assert.equal(loadDenoisePref("mic-d"), true);
  saveDenoisePrefPair("mic-e", "mic-f", false);
  assert.equal(loadDenoisePref("mic-e"), false);
  assert.equal(loadDenoisePref("mic-f"), false);
  saveDenoisePrefPair("mic-e", "mic-f", true);
  assert.equal(loadDenoisePref("mic-e"), true);
  assert.equal(loadDenoisePref("mic-f"), true);
});

test("?fx=off forces the pipeline off; the toggle otherwise chooses wasm or off", () => {
  assert.equal(fxBackendForDenoise(true, ""), "wasm");
  assert.equal(fxBackendForDenoise(true, "?fx=wasm"), "wasm");
  assert.equal(fxBackendForDenoise(true, "?fx=js"), "js");
  assert.equal(fxBackendForDenoise(false, ""), "off");
  assert.equal(fxBackendForDenoise(false, "?fx=js"), "off");
  assert.equal(fxBackendForDenoise(true, "?fx=off"), "off");
  assert.equal(fxBackendForDenoise(false, "?fx=off"), "off");
});

test("processWithPipeline returns a close() that drops the AudioContext", () => {
  const effects = readFileSync(join(root, "src/lib/effects.ts"), "utf8");
  assert.match(effects, /export type PipelineHandle/);
  assert.match(effects, /close:\s*\(\)\s*=>/);
  assert.match(effects, /dropContext\(live\)/);
  const studio = readFileSync(join(root, "src/pages/Studio.tsx"), "utf8");
  assert.match(studio, /denoiseHandleRef\.current\?\.close\(\)/);
  assert.match(studio, /prev\?\.close\(\)/);
});
