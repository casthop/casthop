import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { getClip, getReplay, getStudio, mintToken, sendEgressBeat } from "../src/lib/api.ts";

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

test("a crafted studio id stays inside its own /api/studios path", async () => {
  const hostile = ["../auth/logout?x=", "../auth/callback?token=abc&", "..%2Fstudios", "a/../../studios?x="];
  for (const id of hostile) {
    await getStudio(id);
    await sendEgressBeat(id, "token", "eg");
    await mintToken(id, { name: "Guest", role: "guest" });
  }
  for (const path of seen) {
    const url = resolved(path);
    assert.match(url.pathname, /^\/api\/studios\/[^/]+(\/(egress-beat|token))?$/, path);
    assert.equal(url.search, "", path);
  }
});

test("crafted replay and clip ids stay inside their paths", async () => {
  await getReplay("../auth/logout?x=");
  await getClip("../studios?x=");
  for (const path of seen) {
    const url = resolved(path);
    assert.match(url.pathname, /^\/api\/(replays|clips)\/[^/]+$/, path);
    assert.equal(url.search, "", path);
  }
});
