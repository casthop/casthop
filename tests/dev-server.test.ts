import assert from "node:assert/strict";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import config, { dataDir } from "../vite.config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("dev server listens on loopback only", () => {
  assert.equal(config.server?.host, "127.0.0.1");
});

test("dev server does not serve recordings under data/", () => {
  assert.ok(isAbsolute(dataDir), "Vite only matches slash globs against absolute paths");
  assert.equal(dataDir, join(root, "data").replaceAll("\\", "/"));
  assert.ok(config.server?.fs?.deny?.includes(`${dataDir}/**`));
});

test("Miniflare data explorer is off unless opted in", () => {
  assert.equal(process.env.X_LOCAL_EXPLORER, "false");
});
