import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { initLength, playlistFor, putLiveFile } from "../src/lib/live-program-buffer.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("playlist starts with the init chunk", () => {
  const text = playlistFor([{ name: "seg000.webm", duration: 4 }], "init.webm");
  assert.ok(text.includes('#EXT-X-MAP:URI="init.webm"'));
  assert.ok(text.indexOf("#EXT-X-MAP") < text.indexOf("seg000.webm"));
});

test("initLength cuts a webm chunk before the first Cluster", () => {
  const chunk = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x18, 0x53, 0x80, 0x67, 0x1f, 0x43, 0xb6, 0x75, 0x01]);
  assert.equal(initLength(chunk), 9);
});

test("initLength cuts an mp4 chunk before the first moof box", () => {
  const chunk = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]);
  assert.equal(initLength(chunk), 8);
});

test("initLength keeps a header-only chunk whole", () => {
  assert.equal(initLength(new Uint8Array([1, 2, 3])), 3);
});

test("putLiveFile throws on a non-ok response", async () => {
  globalThis.fetch = async () => new Response("no", { status: 413 });
  await assert.rejects(() => putLiveFile("s1", "t", "seg000.webm", new Blob(["x"]), "video/webm"));
});

test("putLiveFile resolves on ok", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await putLiveFile("s1", "t", "seg000.webm", new Blob(["x"]), "video/webm");
});
