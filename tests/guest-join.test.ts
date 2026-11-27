import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { StudioDurableObject } from "../worker/index.ts";
import {
  ABSENT_GUEST_GRACE_MS,
  DEV_API_KEY,
  DEV_API_SECRET,
  GUEST_MINT_PER_SOURCE,
  GUESTS_PER_SOURCE,
  MAX_PARTICIPANTS,
  sha256hex,
  TOKEN_MINT_WINDOW_MS,
} from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";

const env = {
  LIVEKIT_API_KEY: DEV_API_KEY,
  LIVEKIT_API_SECRET: DEV_API_SECRET,
  LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
  PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
  CASTHOP_ALLOW_DEV_KEYS: "1",
    CASTHOP_DEV: "1",
} as Env;

const realNow = Date.now;
const realFetch = globalThis.fetch;
let now = 1_700_000_000_000;
let inRoom: string[] = [];

beforeEach(() => {
  now = 1_700_000_000_000;
  inRoom = [];
  Date.now = () => now;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("ListParticipants")) {
      return new Response(JSON.stringify({ participants: inRoom.map((identity) => ({ identity })) }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

function fakeCtx(): DurableObjectState {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

async function newRoom(): Promise<StudioDurableObject> {
  const room = new StudioDurableObject(fakeCtx(), env);
  const hostKeyHash = await sha256hex("host-key");
  await room.fetch(
    new Request("https://do.test/?action=create", { method: "PUT", body: JSON.stringify({ id: "room1", title: "T", hostKeyHash }) }),
  );
  return room;
}

let seq = 0;
function join(room: StudioDurableObject, source: string, identity = `g-${++seq}`) {
  return room.fetch(
    new Request("https://do.test/?action=join", {
      method: "POST",
      body: JSON.stringify({ identity, name: "Guest", role: "guest", source }),
    }),
  );
}

async function fill(room: StudioDurableObject, source: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % GUEST_MINT_PER_SOURCE === 0) now += TOKEN_MINT_WINDOW_MS + 1;
    const identity = `g-${++seq}`;
    const res = await join(room, source, identity);
    assert.equal(res.status, 200, await res.clone().text());
    ids.push(identity);
  }
  return ids;
}

async function guests(room: StudioDurableObject): Promise<string[]> {
  const state = (await (await room.fetch(new Request("https://do.test/"))).json()) as PublicStudio;
  return state.participants.filter((p) => p.role === "guest").map((p) => p.identity);
}

test("one network gets a share of new guest joins per minute, not the studio's whole budget", async () => {
  const room = await newRoom();
  for (let i = 0; i < GUEST_MINT_PER_SOURCE; i++) assert.equal((await join(room, "203.0.113.7")).status, 200);
  assert.equal((await join(room, "203.0.113.7")).status, 429);
  assert.equal((await join(room, "198.51.100.9")).status, 200);
});

test("one network cannot hold more than its share of guest slots", async () => {
  const room = await newRoom();
  await fill(room, "203.0.113.7", GUESTS_PER_SOURCE);
  now += TOKEN_MINT_WINDOW_MS + 1;
  const extra = await join(room, "203.0.113.7");
  assert.equal(extra.status, 429);
  assert.match(await extra.text(), /this network/);
  assert.equal((await join(room, "198.51.100.9")).status, 200);
});

test("a full studio frees guests who never showed up in the room", async () => {
  const room = await newRoom();
  const held: string[] = [];
  for (let s = 0; held.length < MAX_PARTICIPANTS; s++) {
    now += TOKEN_MINT_WINDOW_MS + 1;
    held.push(...(await fill(room, `198.51.100.${s}`, Math.min(GUESTS_PER_SOURCE, MAX_PARTICIPANTS - held.length))));
  }
  const present = held.slice(0, 10);

  now += TOKEN_MINT_WINDOW_MS + 1;
  inRoom = ["host", ...held];
  assert.equal((await join(room, "203.0.113.50")).status, 409, "everyone is in the room, so the studio stays full");

  inRoom = ["host", ...present];
  now += ABSENT_GUEST_GRACE_MS + 1;
  const fresh = await join(room, "203.0.113.51", "g-newcomer");
  assert.equal(fresh.status, 200, await fresh.clone().text());
  const after = await guests(room);
  assert.ok(after.includes("g-newcomer"));
  for (const id of present) assert.ok(after.includes(id), `${id} is in the room and keeps its slot`);
  assert.equal(after.length, present.length + 1);
});

test("joins without a source (no trusted client address) are not capped per network", async () => {
  const room = await newRoom();
  for (let i = 0; i < GUESTS_PER_SOURCE + 1; i++) assert.equal((await join(room, "")).status, 200);
});
