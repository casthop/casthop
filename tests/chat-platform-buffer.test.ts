import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioDurableObject } from "../worker/index.ts";
import type { PlatformMessage } from "../worker/chat-platforms.ts";
import type { Env } from "../worker/types.ts";

function setup() {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        puts.push(key);
        store.set(key, value);
      },
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
  const room = new StudioDurableObject(ctx, {} as Env);
  return { room, store, puts };
}

const msg = (n: number): PlatformMessage => ({
  id: `twitch:${n}`,
  from: "twitch:1",
  name: "a",
  text: `m${n}`,
  at: n,
  source: "twitch",
});

async function liveRoom(wantLive: boolean) {
  const t = setup();
  const res = await t.room.fetch(
    new Request("https://x/?action=create", {
      method: "PUT",
      body: JSON.stringify({ id: "s1", title: "t", hostKeyHash: "h" }),
    }),
  );
  assert.equal(res.status, 200);
  const state = t.store.get("state") as { wantLive: boolean; chat: PlatformMessage[] };
  state.wantLive = wantLive;
  t.puts.length = 0;
  return { ...t, state };
}

test("a burst of platform messages lands in one write, behind the lock", async () => {
  const { room, state, puts } = await liveRoom(true);
  let release: () => void = () => undefined;
  const held = room["serialize"](() => new Promise<void>((r) => (release = r)));

  for (let i = 0; i < 150; i++) room["bufferPlatformMessages"]([msg(i)]);
  room["bufferPlatformMessages"]([msg(149)]); // duplicate id
  const flushed = room["flushPlatformMessages"]();

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(puts.length, 0, "no write while another write holds the lock");

  release();
  await held;
  await flushed;
  assert.deepEqual(puts, ["state"]);
  assert.equal(state.chat.length, 100);
  assert.equal(state.chat[99]?.id, "twitch:149");
  assert.equal(new Set(state.chat.map((m) => m.id)).size, 100);
});

test("buffered messages are dropped when the studio is not live", async () => {
  const { room, state, puts } = await liveRoom(false);
  room["bufferPlatformMessages"]([msg(1), msg(2)]);
  await room["flushPlatformMessages"]();
  assert.equal(puts.length, 0);
  assert.equal(state.chat.length, 0);
});
