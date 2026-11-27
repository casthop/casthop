import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioDurableObject } from "../worker/index.ts";
import { asChatText, asName, DEV_API_KEY, DEV_API_SECRET, MAX_STUDIO_SOCKETS, sha256hex } from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";

const env = {
  LIVEKIT_API_KEY: DEV_API_KEY,
  LIVEKIT_API_SECRET: DEV_API_SECRET,
  LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
  PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
  CASTHOP_ALLOW_DEV_KEYS: "1",
} as Env;

function ctxWithSockets(open: number): { ctx: DurableObjectState; accepted: () => number } {
  const store = new Map<string, unknown>();
  let accepted = 0;
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
    getWebSockets: () => Array.from({ length: open }, () => ({ send: () => undefined })),
    acceptWebSocket: () => {
      accepted += 1;
    },
  } as unknown as DurableObjectState;
  return { ctx, accepted: () => accepted };
}

const upgrade = () => new Request("https://studio/room1", { headers: { Upgrade: "websocket" } });

async function create(room: StudioDurableObject): Promise<void> {
  const hostKeyHash = await sha256hex("host-key");
  await room.fetch(
    new Request("https://studio/room1?action=create", { method: "PUT", body: JSON.stringify({ id: "room1", title: "T", hostKeyHash }) }),
  );
}

test("a socket upgrade to a studio that does not exist is refused, not kept", async () => {
  const { ctx, accepted } = ctxWithSockets(0);
  const room = new StudioDurableObject(ctx, env);
  const res = await room.fetch(upgrade());
  assert.equal(res.status, 404);
  assert.equal(accepted(), 0);
});

test("a studio stops accepting sockets at its cap", async () => {
  const { ctx, accepted } = ctxWithSockets(MAX_STUDIO_SOCKETS);
  const room = new StudioDurableObject(ctx, env);
  await create(room);
  const res = await room.fetch(upgrade());
  assert.equal(res.status, 503);
  assert.equal(accepted(), 0);
});

test("chat text and names drop control characters", async () => {
  assert.equal(asChatText("\u0001".repeat(400)), "");
  assert.equal(asChatText("hi\u0000there\n"), "hi there");
  assert.equal(asName("\u0007Ada\u001b"), "Ada");
  assert.equal(asName("\u0001\u0002"), "Guest");

  const { ctx } = ctxWithSockets(0);
  const room = new StudioDurableObject(ctx, env);
  await create(room);
  const res = await room.fetch(
    new Request("https://studio/room1?action=chat", {
      method: "POST",
      body: JSON.stringify({ hostKey: "host-key", text: `${"\u0001".repeat(10)}hello` }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const state = (await res.json()) as PublicStudio;
  assert.equal(state.chat.at(-1)?.text, "hello");
});
