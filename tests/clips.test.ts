import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import {
  LIVE_HLS_MAX_FILES,
  MAX_CLIPS_PER_STUDIO,
  parseClipSeconds,
  putLiveHlsFile,
  sliceHlsPlaylist,
} from "../worker/clips.ts";
import { HLS_INDEX, isHlsFilename, MAX_FILE_BYTES } from "../worker/replays.ts";
import { insertClip, LIST_CLIPS_PER_STUDIO } from "../worker/db.ts";
import { mintParticipantToken, signLivekitWebhook } from "../worker/livekit.ts";
import { redactStreamKey } from "../worker/egress.ts";
import { DEV_API_KEY, DEV_API_SECRET, SESSION_COOKIE } from "../worker/security.ts";
import type { Env, PublicClip, PublicStudio } from "../worker/types.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeR2 } from "./fake-r2.ts";
import { hlsFilesForSegments, hlsPlaylist } from "./replay-fixture.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";

let egressStarts = 0;
const realFetch = globalThis.fetch;

function fakeCtx(): DurableObjectState {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const rooms = new Map<string, StudioDurableObject>();
  const db = new FakeD1();
  const env = {
    LIVEKIT_API_KEY: DEV_API_KEY,
    LIVEKIT_API_SECRET: DEV_API_SECRET,
    LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
    PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
    RTMP_YOUTUBE: YT,
    RTMP_LINKEDIN: LI,
    RTMP_X: X,
    EGRESS_TEMPLATE_URL: "http://127.0.0.1:5173/egress-template",
    CASTHOP_ALLOW_DEV_KEYS: "1",
    CASTHOP_TRUST_FORWARDED: "1",
    PUBLIC_ORIGIN: "https://casthop.test",
    ASSETS: { fetch: async () => new Response("ok") },
    RECORDINGS: new FakeR2(),
    DB: db,
    ...overrides,
  } as Env;

  env.STUDIO = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      let room = rooms.get(name);
      if (!room) {
        room = new StudioDurableObject(fakeCtx(), env);
        rooms.set(name, room);
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request && init === undefined ? input : new Request(input, init);
          return room!.fetch(req);
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  return env;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function headerCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

function cookieNamed(res: Response, name: string): string {
  const hit = headerCookies(res).find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(";")[0] : "";
}

const DEV_ORIGIN = "https://127.0.0.1";

async function signIn(env: Env, email: string): Promise<string> {
  const sent = await app.request(
    `${DEV_ORIGIN}/api/auth/magic-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    },
    env,
  );
  assert.equal(sent.status, 200, await sent.clone().text());
  const body = await json<{ ok: boolean; devLogin?: string }>(sent);
  assert.ok(body.devLogin);
  const login = await app.request(`${DEV_ORIGIN}${body.devLogin}`, { method: "POST", redirect: "manual" }, env);
  assert.equal(login.status, 302);
  return cookieNamed(login, SESSION_COOKIE);
}

async function createStudio(env: Env, cookie: string, title = "Weekly product update") {
  const res = await app.request(
    "https://casthop.test/api/studios",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  return json<{ id: string }>(res);
}

async function goLive(env: Env, cookie: string, studioId: string): Promise<string> {
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${studioId}/live`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ live: true }),
      },
      env,
    ),
  );
  const egressId = started.egressId;
  assert.ok(egressId, "expected egress id");
  const liveBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId,
      roomName: studioId,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(LI), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(X), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
      ],
    },
  });
  const liveRes = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, liveBody) }, body: liveBody },
    env,
  );
  const raw = await liveRes.clone().text();
  assert.equal(liveRes.status, 200, raw);
  const live = JSON.parse(raw) as PublicStudio;
  assert.equal(live.livePhase, "live", raw);
  return egressId;
}

async function putLiveFiles(
  env: Env,
  cookie: string,
  studioId: string,
  files: { name: string; content: string; encoding?: "utf8" | "base64" }[],
): Promise<void> {
  for (const file of files) {
    const bytes =
      file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    const res = await app.request(
      `https://casthop.test/api/studios/${studioId}/live-hls/${file.name}`,
      {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Length": String(bytes.byteLength) },
        body: bytes,
      },
      env,
    );
    assert.equal(res.status, 200, `${file.name} ${await res.clone().text()}`);
  }
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("StartRoomCompositeEgress")) {
      egressStarts += 1;
      return new Response(JSON.stringify({ egress_id: `eg_${egressStarts}` }), { status: 200 });
    }
    if (url.includes("ListParticipants")) {
      return new Response(JSON.stringify({ participants: [{ identity: "host" }] }), { status: 200 });
    }
    if (url.includes("/twirp/livekit.") || url.startsWith("http://127.0.0.1:7880")) {
      return new Response("{}", { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("sliceHlsPlaylist keeps the last 30s and the init map", () => {
  assert.equal(parseClipSeconds(30), 30);
  assert.equal(parseClipSeconds(60), 60);
  assert.equal(parseClipSeconds(45), null);
  const playlist = hlsPlaylist(16, 4);
  const sliced = sliceHlsPlaylist(playlist, 30);
  assert.ok(!("error" in sliced), JSON.stringify(sliced));
  if ("error" in sliced) return;
  assert.equal(sliced.durationMs, 32_000);
  assert.ok(sliced.files.includes("init.mp4"));
  assert.ok(sliced.files.includes("seg15.m4s"));
  assert.ok(sliced.files.includes("seg8.m4s"));
  assert.ok(!sliced.files.includes("seg7.m4s"));
  assert.ok(sliced.playlist.includes("#EXT-X-ENDLIST"));
  const full = sliceHlsPlaylist(playlist, 60);
  assert.ok(!("error" in full));
  if ("error" in full) return;
  assert.equal(full.durationMs, 60_000);
  assert.ok(full.files.includes("seg1.m4s"));
  assert.ok(!full.files.includes("seg0.m4s"));
});

test("host clips last 30s from live HLS without starting another egress", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const starts = egressStarts;
  await goLive(env, cookie, id);
  assert.ok(egressStarts > starts);
  const afterLive = egressStarts;
  await putLiveFiles(env, cookie, id, hlsFilesForSegments(16));

  const created = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ seconds: 30 }),
    },
    env,
  );
  assert.equal(created.status, 200, await created.clone().text());
  const clip = await json<PublicClip>(created);
  assert.equal(clip.seconds, 30);
  assert.equal(clip.durationMs, 32_000);
  assert.equal(clip.visibility, "private");
  assert.equal(clip.studioId, id);
  assert.equal(clip.playlistUrl, `/api/clips/${clip.id}/hls/${HLS_INDEX}`);
  assert.equal(clip.downloadUrl, `/api/clips/${clip.id}/file`);
  assert.equal(egressStarts, afterLive);

  const playlist = await app.request(`https://casthop.test${clip.playlistUrl}`, { headers: { Cookie: cookie } }, env);
  assert.equal(playlist.status, 200);
  const text = await playlist.text();
  assert.ok(text.includes("seg15.m4s"));
  assert.ok(!text.includes("seg7.m4s"));

  const file = await app.request(`https://casthop.test${clip.downloadUrl}`, { headers: { Cookie: cookie } }, env);
  assert.equal(file.status, 200);
  assert.ok(file.headers.get("Content-Disposition")?.includes(clip.id));
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.ok(bytes.byteLength > 0);

  const listed = await json<{ studios: { id: string; clips: PublicClip[] }[] }>(
    await app.request("https://casthop.test/api/studios", { headers: { Cookie: cookie } }, env),
  );
  assert.equal(listed.studios[0]?.clips[0]?.id, clip.id);

  const guest = await app.request(`https://casthop.test/api/clips/${clip.id}`, {}, env);
  assert.equal(guest.status, 401);
});

test("public clip omits studioId; 60s clip keeps more segments", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  await goLive(env, cookie, id);
  await putLiveFiles(env, cookie, id, hlsFilesForSegments(16));
  const created = await json<PublicClip>(
    await app.request(
      `https://casthop.test/api/studios/${id}/clips`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ seconds: 60, visibility: "public" }),
      },
      env,
    ),
  );
  assert.equal(created.seconds, 60);
  const open = await json<PublicClip>(await app.request(`https://casthop.test/api/clips/${created.id}`, {}, env));
  assert.equal(open.studioId, undefined);
  assert.equal(open.visibility, "public");
  const playlist = await app.request(`https://casthop.test${created.playlistUrl}`, {}, env);
  assert.equal(playlist.status, 200);
  const text = await playlist.text();
  assert.ok(text.includes("seg1.m4s"));
  assert.ok(!text.includes("seg0.m4s"));
  const patched = await json<PublicClip>(
    await app.request(
      `https://casthop.test/api/studios/${id}/clips/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ visibility: "private" }),
      },
      env,
    ),
  );
  assert.equal(patched.visibility, "private");
  const closed = await app.request(`https://casthop.test/api/clips/${created.id}`, {}, env);
  assert.equal(closed.status, 401);
});

test("clip rejects idle studios, bad seconds, and guests", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const idle = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ seconds: 60 }),
    },
    env,
  );
  assert.equal(idle.status, 409);
  await goLive(env, cookie, id);
  const bad = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ seconds: 45 }),
    },
    env,
  );
  assert.equal(bad.status, 400);
  const none = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ seconds: 60 }),
    },
    env,
  );
  assert.equal(none.status, 409);
  const guest = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds: 60 }),
    },
    env,
  );
  assert.equal(guest.status, 403);
});

test("compositor JWT can write live HLS while the host cannot when idle", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const idlePut = await app.request(
    `https://casthop.test/api/studios/${id}/live-hls/${HLS_INDEX}`,
    {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Length": "8" },
      body: "#EXTM3U\n",
    },
    env,
  );
  assert.equal(idlePut.status, 409);
  await goLive(env, cookie, id);
  const token = await mintParticipantToken({
    env,
    identity: "EG_abc",
    name: "egress",
    room: id,
    canPublish: false,
  });
  const playlist = hlsPlaylist(1, 4);
  const put = await app.request(
    `https://casthop.test/api/studios/${id}/live-hls/${HLS_INDEX}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Length": String(new TextEncoder().encode(playlist).length),
      },
      body: playlist,
    },
    env,
  );
  assert.equal(put.status, 200, await put.clone().text());
});

test("live HLS PUT caps size after reading, not only from Content-Length", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  await goLive(env, cookie, id);
  const huge = new Uint8Array(MAX_FILE_BYTES + 1);
  huge.fill(1);
  await assert.rejects(
    () => putLiveHlsFile(env, id, "seg000.webm", huge),
    (err: unknown) => err instanceof Error && err.message === "invalid file size",
  );
  const req = new Request(`https://casthop.test/api/studios/${id}/live-hls/seg000.webm`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Length": "4" },
    body: huge,
  });
  const over = await app.request(req, undefined, env);
  assert.equal(over.status, 400, await over.clone().text());
});

test("studio list keeps the latest 20 clips per studio", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  for (let i = 0; i < LIST_CLIPS_PER_STUDIO + 1; i++) {
    await insertClip(env.DB, {
      id: `clip${String(i).padStart(3, "0")}`,
      studioId: id,
      title: `Clip ${i}`,
      visibility: "private",
      durationMs: 30_000,
      seconds: 30,
      createdAt: Date.now() + i,
      bytes: 10,
      files: 2,
    });
  }
  const listed = await json<{ studios: { clips: PublicClip[] }[] }>(
    await app.request("https://casthop.test/api/studios", { headers: { Cookie: cookie } }, env),
  );
  assert.equal(listed.studios[0]?.clips.length, LIST_CLIPS_PER_STUDIO);
  const studioList = await json<{ clips: PublicClip[] }>(
    await app.request(`https://casthop.test/api/studios/${id}/clips`, { headers: { Cookie: cookie } }, env),
  );
  assert.equal(studioList.clips.length, LIST_CLIPS_PER_STUDIO + 1);
});

test("clip ingest caps clips per studio", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  await goLive(env, cookie, id);
  await putLiveFiles(env, cookie, id, hlsFilesForSegments(2));
  for (let i = 0; i < MAX_CLIPS_PER_STUDIO; i++) {
    await insertClip(env.DB, {
      id: `cap${String(i).padStart(3, "0")}`,
      studioId: id,
      title: `Cap ${i}`,
      visibility: "private",
      durationMs: 4000,
      seconds: 30,
      createdAt: Date.now() + i,
      bytes: 1,
      files: 1,
    });
  }
  const blocked = await app.request(
    `https://casthop.test/api/studios/${id}/clips`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ seconds: 30 }),
    },
    env,
  );
  assert.equal(blocked.status, 400);
  assert.equal((await json<{ error: string }>(blocked)).error, "too many clips");
});

test("live HLS filename rules match replay helpers", () => {
  assert.equal(isHlsFilename("seg0.webm"), true);
  assert.equal(isHlsFilename("../x.webm"), false);
  assert.equal(LIVE_HLS_MAX_FILES, 32);
});
