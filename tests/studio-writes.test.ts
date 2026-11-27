import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, sha256hex } from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";

const HOST_KEY = "host-key-for-write-test";

// Every storage call yields, so overlapping requests really interleave.
function slowCtx(): DurableObjectState {
  const store = new Map<string, unknown>();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
  return {
    storage: {
      get: async (key: string) => {
        await tick();
        return structuredClone(store.get(key));
      },
      put: async (key: string, value: unknown) => {
        await tick();
        store.set(key, structuredClone(value));
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

const env = {
  LIVEKIT_API_KEY: DEV_API_KEY,
  LIVEKIT_API_SECRET: DEV_API_SECRET,
  LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
  PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
  CASTHOP_ALLOW_DEV_KEYS: "1",
} as Env;

async function call(room: StudioDurableObject, action: string, body: Record<string, unknown>, method = "POST") {
  const res = await room.fetch(
    new Request(`https://do.test/?action=${action}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res;
}

test("overlapping writes do not overwrite each other", async () => {
  const room = new StudioDurableObject(slowCtx(), env);
  const hostKeyHash = await sha256hex(HOST_KEY);
  await call(room, "create", { id: "room1", title: "T", hostKeyHash }, "PUT");
  const join = (identity: string) => call(room, "join", { identity, name: identity });
  await Promise.all([join("g-a"), join("g-b")]);

  const results = await Promise.all([
    call(room, "chat", { hostKey: HOST_KEY, text: "one" }),
    call(room, "chat", { hostKey: HOST_KEY, text: "two" }),
    call(room, "stage", { hostKey: HOST_KEY, identity: "g-a", on: true }),
    call(room, "banner", { hostKey: HOST_KEY, bannerTitle: "New banner" }),
    join("g-c"),
  ]);
  for (const res of results) assert.equal(res.status, 200);

  const state = (await (await room.fetch(new Request("https://do.test/"))).json()) as PublicStudio;
  assert.deepEqual(state.chat.map((m) => m.text).sort(), ["one", "two"]);
  assert.equal(state.participants.find((p) => p.identity === "g-a")?.onStage, true);
  assert.equal(state.bannerTitle, "New banner");
  assert.deepEqual(state.participants.map((p) => p.identity).sort(), ["g-a", "g-b", "g-c"]);
});
