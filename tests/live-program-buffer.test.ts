import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { playlistFor, putLiveFile } from "../src/lib/live-program-buffer.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("playlist starts with the init chunk", () => {
  const text = playlistFor([{ name: "seg000.webm", duration: 4 }], "init.webm");
  assert.ok(text.includes('#EXT-X-MAP:URI="init.webm"'));
  assert.ok(text.indexOf("#EXT-X-MAP") < text.indexOf("seg000.webm"));
});

test("putLiveFile throws on a non-ok response", async () => {
  globalThis.fetch = async () => new Response("no", { status: 413 });
  await assert.rejects(() => putLiveFile("s1", "t", "seg000.webm", new Blob(["x"]), "video/webm"));
});

test("putLiveFile resolves on ok", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await putLiveFile("s1", "t", "seg000.webm", new Blob(["x"]), "video/webm");
});
