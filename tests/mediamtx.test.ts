import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const yml = readFileSync(join(root, "infra/mediamtx.yml"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

test("dev MediaMTX turns MoQ off so 8892/8893 are not on all interfaces", () => {
  assert.match(yml, /^moq:\s*no\s*$/m);
  assert.doesNotMatch(yml, /moqHTTP2Address:\s*:8892/);
  assert.doesNotMatch(yml, /moqHTTP3Address:\s*:8892/);
  assert.doesNotMatch(yml, /moqQUICAddress:\s*:8893/);
  assert.match(yml, /^rtmpAddress:\s*127\.0\.0\.1:1935\s*$/m);
  assert.match(compose, /infra\/mediamtx\.yml:\/mediamtx\.yml/);
});

test("dev MediaMTX HLS and playback allow no browser origin", () => {
  // The MediaMTX 1.21 default is ["*"], which lets any page in the developer's browser read them.
  assert.match(yml, /^hlsAllowOrigins:\s*\[\]\s*$/m);
  assert.match(yml, /^playbackAllowOrigins:\s*\[\]\s*$/m);
  assert.match(yml, /^hlsAddress:\s*127\.0\.0\.1:8888\s*$/m);
  assert.match(yml, /^playbackAddress:\s*127\.0\.0\.1:9996\s*$/m);
});
