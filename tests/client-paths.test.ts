import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  getClip,
  getReplay,
  getStudio,
  isoDownloadPath,
  mintToken,
  removeCohost,
  sendEgressBeat,
  setClipVisibility,
  setReplayVisibility,
} from "../src/lib/api.ts";
import { completeIsoTrack, uploadIsoChunk } from "../src/lib/iso-recorder.ts";
import { putLiveFile } from "../src/lib/live-program-buffer.ts";

const realFetch = globalThis.fetch;
let seen: string[] = [];

beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// What fetch would really request from the app origin for a path the client built.
function resolved(path: string): URL {
  return new URL(path, "https://casthop.test/");
}

function assertOwnPath(path: string, pattern: RegExp): void {
  const url = resolved(path);
  assert.match(url.pathname, pattern, path);
  assert.equal(url.search, "", path);
}

test("a crafted studio id stays inside its own /api/studios path", async () => {
  const hostile = ["../auth/logout?x=", "../auth/callback?token=abc&", "..%2Fstudios", "a/../../studios?x="];
  for (const id of hostile) {
    await getStudio(id);
    await sendEgressBeat(id, "token", "eg");
    await mintToken(id, { name: "Guest", role: "guest" });
  }
  for (const path of seen) {
    assertOwnPath(path, /^\/api\/studios\/[^/]+(\/(egress-beat|token))?$/);
  }
});

test("crafted replay and clip ids stay inside their paths", async () => {
  await getReplay("../auth/logout?x=");
  await getClip("../studios?x=");
  for (const path of seen) {
    assertOwnPath(path, /^\/api\/(replays|clips)\/[^/]+$/);
  }
});

test("crafted nested studio ids stay inside their own path segments", async () => {
  const hostile = "../auth/logout?x=";
  await removeCohost("studio", hostile);
  await setReplayVisibility("studio", hostile, "public");
  await setClipVisibility("studio", hostile, "public");
  await uploadIsoChunk("studio", hostile, 0, new Blob(["x"]), { identity: "host", name: "Host" });
  await completeIsoTrack("studio", hostile, { identity: "host", name: "Host" });
  await putLiveFile("studio", "token", hostile, "x", "application/vnd.apple.mpegurl");
  assertOwnPath(isoDownloadPath("studio", hostile), /^\/api\/studios\/studio\/recordings\/iso\/[^/]+$/);
  for (const path of seen) {
    assertOwnPath(
      path,
      /^\/api\/studios\/studio\/(cohosts|replays|clips|iso)\/[^/]+(\/(chunks\/0|complete))?$|^\/api\/studios\/studio\/live-hls\/[^/]+$/,
    );
  }
});
