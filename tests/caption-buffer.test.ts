import assert from "node:assert/strict";
import { test } from "node:test";
import { StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, sha256hex } from "../worker/security.ts";
import type { CaptionCue, Env, PublicStudio, StudioState } from "../worker/types.ts";

const HOST_KEY = "host-key-for-caption-test";

function setup() {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  const ctx = {
    storage: {
      get: async (key: string | string[]) =>
        Array.isArray(key) ? new Map(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)])) : store.get(key),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        const entries = typeof key === "string" ? { [key]: value } : key;
        puts.push(Object.keys(entries).join(","));
        for (const [k, v] of Object.entries(entries)) store.set(k, v);
      },
      delete: async (keys: string[]) => {
        for (const k of keys) store.delete(k);
      },
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
  const env = {
    LIVEKIT_API_KEY: DEV_API_KEY,
    LIVEKIT_API_SECRET: DEV_API_SECRET,
    LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
    PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
    CASTHOP_ALLOW_DEV_KEYS: "1",
  } as Env;
  return { room: new StudioDurableObject(ctx, env), store, puts };
}

async function call(room: StudioDurableObject, action: string, body: Record<string, unknown>, method = "POST") {
  return room.fetch(
    new Request(`https://do.test/?action=${action}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function studio(live = true) {
  const t = setup();
  await call(t.room, "create", { id: "s1", title: "t", hostKeyHash: await sha256hex(HOST_KEY) }, "PUT");
  const raw = () => t.store.get("state") as StudioState;
  raw().wantLive = live;
  const publicState = async () => (await (await t.room.fetch(new Request("https://do.test/"))).json()) as PublicStudio;
  return { ...t, raw, publicState };
}

const cue = (n: number): CaptionCue => ({ from: "host", name: "Ana", text: `line ${n}`, start: 1000 + n * 1000, end: 1900 + n * 1000 });

test("a new studio has captions off and ignores caption text", async () => {
  const { room, puts, raw, publicState } = await studio();
  assert.deepEqual((await publicState()).captions, { on: false, burn: false });
  puts.length = 0;

  const res = await call(room, "caption", { hostKey: HOST_KEY, text: "hello", durationMs: 1000 });
  assert.deepEqual(await res.json(), { ok: true, accepted: false });
  await room["flushCaptions"]();
  assert.equal(puts.length, 0);
  assert.equal(raw().captionChunks ?? 0, 0);
});

test("only a host can change caption settings, and values must be booleans", async () => {
  const { room, publicState } = await studio();
  assert.equal((await call(room, "captions-pref", { on: true })).status, 403);
  assert.equal((await call(room, "captions-pref", { hostKey: HOST_KEY, on: "yes" })).status, 400);
  assert.equal((await call(room, "captions-pref", { hostKey: HOST_KEY, on: true })).status, 200);
  assert.deepEqual((await publicState()).captions, { on: true, burn: false });
});

test("a burst of captions lands in one batch, behind the lock", async () => {
  const { room, puts, raw } = await studio();
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true, burn: true });
  puts.length = 0;
  let release: () => void = () => undefined;
  const held = room["serialize"](() => new Promise<void>((r) => (release = r)));

  for (let i = 0; i < 120; i++) room["bufferCaption"](cue(i));
  const flushed = room["flushCaptions"]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(puts.length, 0, "no write while another write holds the lock");

  release();
  await held;
  await flushed;
  assert.deepEqual(puts, ["cap:000001,cap:000002,cap:000003", "state"]);
  assert.equal(raw().captionCues, 120);
  assert.equal(raw().captionLine?.text, "line 119");
});

test("caption text from the host is buffered, then written once", async () => {
  const { room, puts, raw } = await studio();
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true });
  puts.length = 0;
  for (const text of ["one", "two", "three"]) {
    const res = await call(room, "caption", { hostKey: HOST_KEY, text, durationMs: 1500, ageMs: 200 });
    assert.deepEqual(await res.json(), { ok: true, accepted: true });
  }
  assert.equal(puts.length, 0, "nothing is written per request");
  await room["flushCaptions"]();
  assert.deepEqual(puts, ["cap:000001", "state"]);
  assert.equal(raw().captionCues, 3);
});

test("captions are dropped when the studio is not live or captions are turned off", async () => {
  const { room, puts, raw } = await studio(false);
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true });
  const res = await call(room, "caption", { hostKey: HOST_KEY, text: "hi", durationMs: 500 });
  assert.deepEqual(await res.json(), { ok: true, accepted: false });

  raw().wantLive = true;
  room["bufferCaption"](cue(1));
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: false });
  puts.length = 0;
  await room["flushCaptions"]();
  assert.equal(puts.length, 0);
});

test("the VTT file is host only and counts from the first caption write", async () => {
  const { room, raw } = await studio();
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true });
  assert.equal((await call(room, "captions-get", { hostKey: HOST_KEY })).status, 404);

  raw().liveStartedAt = 1000;
  room["bufferCaption"](cue(1));
  await room["flushCaptions"]();

  assert.equal((await call(room, "captions-get", {})).status, 403);
  const res = await call(room, "captions-get", { hostKey: HOST_KEY });
  assert.equal(res.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.equal(await res.text(), "WEBVTT\n\n00:00:01.000 --> 00:00:01.900\n<v Ana>line 1\n");
  const list = (await (await call(room, "iso-list", { hostKey: HOST_KEY })).json()) as { captions: unknown };
  assert.deepEqual(list.captions, { filename: "captions.vtt", cues: 1 });
});

test("public state shows the latest line only when captions are burned in", async () => {
  const { room, publicState } = await studio();
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true, burn: false });
  room["bufferCaption"](cue(1));
  await room["flushCaptions"]();
  assert.equal((await publicState()).captionLine, null);

  await call(room, "captions-pref", { hostKey: HOST_KEY, burn: true });
  assert.equal((await publicState()).captionLine?.text, "line 1");
});

test("caption text needs a host key or a guest secret", async () => {
  const { room } = await studio();
  await call(room, "captions-pref", { hostKey: HOST_KEY, on: true });
  assert.equal((await call(room, "caption", { text: "hi" })).status, 403);
  assert.equal((await call(room, "caption", { identity: "g-x", guestSecret: "nope", text: "hi" })).status, 403);
});
