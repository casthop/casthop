import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GUEST_TOKEN_TTL_SEC, HOST_TOKEN_TTL_SEC } from "../worker/livekit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("hot /api routes stay on the Hono Worker", () => {
  const src = readFileSync(join(root, "worker/index.ts"), "utf8");
  assert.match(src, /app\.post\("\/api\/studios\/:id\/token"/);
  assert.match(src, /app\.get\("\/api\/studios\/:id"/);
  assert.match(src, /app\.post\("\/api\/studios\/:id\/egress-beat"/);
  assert.match(src, /app\.post\("\/api\/livekit\/webhook"/);
  assert.match(src, /app\.post\("\/api\/studios\/:id\/live"/);
});

test("workers-rs bench JWT TTLs match livekit.ts", () => {
  assert.equal(GUEST_TOKEN_TTL_SEC, 6 * 60 * 60);
  assert.equal(HOST_TOKEN_TTL_SEC, 10 * 60);
  const jwt = readFileSync(join(root, "crates/casthop-hot/src/jwt.rs"), "utf8");
  assert.match(jwt, /GUEST_TTL_SEC: u64 = 6 \* 60 \* 60;/);
  assert.match(jwt, /HOST_TTL_SEC: u64 = 10 \* 60;/);
  assert.match(jwt, /CLOCK_SKEW_SEC: u64 = 10;/);
  assert.match(jwt, /WEBHOOK_TTL_SEC: u64 = 10 \* 60;/);
});
