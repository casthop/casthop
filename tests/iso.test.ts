import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import {
  chunkKeysFromList,
  concatChunkStream,
  deleteIsoTrackObjects,
  downloadChunkKeys,
  downloadName,
  isoChunkFits,
  isoChunkKey,
  isoMimeOk,
  ISO_SESSION_MAX_BYTES,
  ISO_TRACK_MAX_BYTES,
  isoPrefix,
  isoTracksForStart,
  ISO_TRACKS_MAX,
  ISO_TRACKS_PER_IDENTITY,
  listIsoChunkKeys,
  mixedFilename,
  parseChunkIndex,
} from "../worker/iso.ts";
import { IsoHttpError, isoUploadRetryable, pickRecorderMime } from "../src/lib/iso-recorder.ts";
import { DEV_API_KEY, DEV_API_SECRET, HOST_IDENTITY, SESSION_COOKIE, publicState } from "../worker/security.ts";
import type { Env, IsoTrack, PublicStudio, RecordingList } from "../worker/types.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeR2 } from "./fake-r2.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";
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

function makeEnv(): Env & { _r2: FakeR2 } {
  const rooms = new Map<string, StudioDurableObject>();
  const db = new FakeD1();
  const r2 = new FakeR2();
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
    RECORDINGS: r2 as unknown as R2Bucket,
    DB: db,
  } as Env & { _r2: FakeR2 };
  env._r2 = r2;
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

async function signIn(env: Env, email: string): Promise<string> {
  const sent = await app.request(
    "https://127.0.0.1/api/auth/magic-link",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) },
    env,
  );
  const body = await json<{ devLogin?: string }>(sent);
  const login = await app.request(`https://127.0.0.1${body.devLogin}`, { method: "POST", redirect: "manual" }, env);
  return cookieNamed(login, SESSION_COOKIE);
}

async function createStudio(env: Env, cookie: string): Promise<string> {
  const res = await app.request(
    "https://casthop.test/api/studios",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title: "ISO" }),
    },
    env,
  );
  return (await json<{ id: string }>(res)).id;
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("StartRoomCompositeEgress")) {
      return new Response(JSON.stringify({ egress_id: "eg_iso" }), { status: 200 });
    }
    if (url.includes("StopEgress") || url.includes("ListParticipants") || url.includes("/twirp/livekit.")) {
      return new Response(JSON.stringify({ participants: [{ identity: "host" }] }), { status: 200 });
    }
    if (url.startsWith("http://127.0.0.1:7880")) return new Response("ok", { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("parseChunkIndex and mime helpers", () => {
  assert.equal(parseChunkIndex("0"), 0);
  assert.equal(parseChunkIndex("000012"), 12);
  assert.equal(parseChunkIndex("-1"), null);
  assert.equal(parseChunkIndex("1e2"), null);
  assert.equal(isoMimeOk("video/webm;codecs=vp8,opus"), true);
  assert.equal(isoMimeOk("application/json"), false);
  assert.equal(mixedFilename("/out/abc-stamp.mp4"), "abc-stamp.mp4");
  assert.equal(downloadName({
    id: "t",
    sessionId: "s",
    identity: "g-1",
    name: "Ada Lovelace!",
    kind: "camera",
    mimeType: "video/webm;codecs=vp8,opus",
    startedAt: 1,
    endedAt: null,
    bytes: 1,
    chunks: 1,
    complete: false,
  }), "Ada_Lovelace_-camera.webm");
});

test("isoTracksForStart caps the live session and drops oldest history", () => {
  const stub = (id: string, sessionId: string, identity: string, startedAt: number): IsoTrack => ({
    id,
    sessionId,
    identity,
    name: "n",
    kind: "camera",
    mimeType: "video/webm",
    startedAt,
    endedAt: null,
    bytes: 0,
    chunks: 0,
    complete: true,
  });
  const mine = Array.from({ length: ISO_TRACKS_PER_IDENTITY }, (_, i) => stub(`m${i}`, "now", "host", i));
  assert.equal(isoTracksForStart(mine, "host", "now"), null);

  const old = Array.from({ length: ISO_TRACKS_MAX }, (_, i) => stub(`old${i}`, "prev", "g", i));
  const plan = isoTracksForStart(old, "host", "now");
  assert.equal(plan?.kept.length, ISO_TRACKS_MAX - 1);
  assert.equal(plan?.kept[0]?.id, "old1");
  assert.deepEqual(plan?.dropped, ["old0"]);

  const sessionFull = Array.from({ length: ISO_TRACKS_MAX }, (_, i) => stub(`s${i}`, "now", `g-${i}`, i));
  assert.equal(isoTracksForStart(sessionFull, "host", "now"), null);
});

test("deleteIsoTrackObjects removes numbered chunks", async () => {
  const r2 = new FakeR2();
  const bucket = r2 as unknown as R2Bucket;
  await bucket.put(isoChunkKey("stu", "old", 0), new TextEncoder().encode("AA"));
  await bucket.put(isoChunkKey("stu", "keep", 0), new TextEncoder().encode("BB"));
  await deleteIsoTrackObjects(bucket, "stu", "old");
  assert.equal(await bucket.get(isoChunkKey("stu", "old", 0)), null);
  assert.ok(await bucket.get(isoChunkKey("stu", "keep", 0)));
});

test("isoUploadRetryable retries transient statuses only", () => {
  assert.equal(isoUploadRetryable(new Error("network")), true);
  assert.equal(isoUploadRetryable(new IsoHttpError(502, "upload failed")), true);
  assert.equal(isoUploadRetryable(new IsoHttpError(429, "too many uploads")), true);
  assert.equal(isoUploadRetryable(new IsoHttpError(408, "timeout")), true);
  assert.equal(isoUploadRetryable(new IsoHttpError(404, "track not found")), false);
  assert.equal(isoUploadRetryable(new IsoHttpError(409, "track complete")), false);
  assert.equal(isoUploadRetryable(new IsoHttpError(413, "chunk too large")), false);
});

test("R2 chunk keys sort and concat in order", async () => {
  const r2 = new FakeR2();
  const bucket = r2 as unknown as R2Bucket;
  await bucket.put(isoChunkKey("stu", "trk", 1), new TextEncoder().encode("BB"));
  await bucket.put(isoChunkKey("stu", "trk", 0), new TextEncoder().encode("AA"));
  const keys = await listIsoChunkKeys(bucket, "stu", "trk");
  assert.deepEqual(keys, [isoChunkKey("stu", "trk", 0), isoChunkKey("stu", "trk", 1)]);
  assert.deepEqual(chunkKeysFromList([{ key: isoPrefix("stu", "trk") + "meta" }, { key: keys[0]! }], isoPrefix("stu", "trk")), [
    keys[0],
  ]);
  const stream = concatChunkStream(bucket, keys);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const out = new TextDecoder().decode(Buffer.concat(parts.map((p) => Buffer.from(p))));
  assert.equal(out, "AABB");
});

test("pickRecorderMime uses the first supported type", () => {
  const prev = globalThis.MediaRecorder;
  globalThis.MediaRecorder = {
    isTypeSupported: (type: string) => type === "video/webm",
  } as typeof MediaRecorder;
  try {
    const stream = {
      getVideoTracks: () => [{ readyState: "live" }],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    assert.equal(pickRecorderMime(stream), "video/webm");
  } finally {
    globalThis.MediaRecorder = prev;
  }
});

test("host can enable ISO, each person uploads chunks, host downloads concat", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const id = await createStudio(env, cookie);

  const denied = await app.request(`https://casthop.test/api/studios/${id}/iso-pref`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ separateRecordings: true }),
  }, env);
  assert.equal(denied.status, 403);

  const pref = await app.request(`https://casthop.test/api/studios/${id}/iso-pref`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ separateRecordings: true }),
  }, env);
  assert.equal(pref.status, 200, await pref.clone().text());
  assert.equal((await json<PublicStudio>(pref)).separateRecordings, true);

  const tooSoon = await app.request(`https://casthop.test/api/studios/${id}/iso`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ kind: "camera", mimeType: "video/webm", sessionId: "nope", startedAt: Date.now() }),
  }, env);
  assert.equal(tooSoon.status, 409);

  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Host", role: "host" }) },
    env,
  );
  const live = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(live.status, 200, await live.clone().text());
  const liveBody = await json<PublicStudio>(live);
  assert.equal(liveBody.separateRecordings, true);
  assert.ok(liveBody.isoSessionId);
  assert.equal(JSON.stringify(liveBody).includes("isoTracks"), false);

  const guestMint = await json<{ identity: string; guestSecret: string }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ada", role: "guest" }) },
      env,
    ),
  );

  const hostTrack = await json<{ track: IsoTrack }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/iso`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          kind: "camera",
          mimeType: "video/webm;codecs=vp8,opus",
          sessionId: liveBody.isoSessionId,
          startedAt: Date.now(),
        }),
      },
      env,
    ),
  );
  assert.equal(hostTrack.track.identity, HOST_IDENTITY);
  assert.equal(hostTrack.track.complete, false);

  const guestTrack = await json<{ track: IsoTrack }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/iso`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity: guestMint.identity,
          guestSecret: guestMint.guestSecret,
          kind: "camera",
          mimeType: "video/webm",
          sessionId: liveBody.isoSessionId,
          startedAt: Date.now(),
        }),
      },
      env,
    ),
  );

  const steal = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/chunks/0`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Casthop-Identity": guestMint.identity,
        "X-Casthop-Guest-Secret": guestMint.guestSecret,
      },
      body: new Uint8Array([1, 2, 3]),
    },
    env,
  );
  assert.equal(steal.status, 404);

  const skip = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/chunks/2`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Cookie: cookie },
      body: new TextEncoder().encode("SKIP"),
    },
    env,
  );
  assert.equal(skip.status, 409);

  env._r2.failNextPut = true;
  const lostPut = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/chunks/0`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Cookie: cookie },
      body: new TextEncoder().encode("AAAA"),
    },
    env,
  );
  assert.equal(lostPut.status, 502);

  await putChunk(env, id, hostTrack.track.id, 0, "AAAA", cookie);
  await putChunk(env, id, hostTrack.track.id, 1, "BBBB", cookie);
  const rewrite = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/chunks/1`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Cookie: cookie },
      body: new TextEncoder().encode("BBBB"),
    },
    env,
  );
  assert.equal(rewrite.status, 409);

  const stealLate = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/chunks/2`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Casthop-Identity": guestMint.identity,
        "X-Casthop-Guest-Secret": guestMint.guestSecret,
      },
      body: new Uint8Array([9, 9, 9]),
    },
    env,
  );
  assert.equal(stealLate.status, 404);

  const guestChunk = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${guestTrack.track.id}/chunks/0`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Casthop-Identity": guestMint.identity,
        "X-Casthop-Guest-Secret": guestMint.guestSecret,
      },
      body: new TextEncoder().encode("GUEST"),
    },
    env,
  );
  assert.equal(guestChunk.status, 200, await guestChunk.clone().text());
  const afterRetry = await json<{ track: IsoTrack }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/iso/${hostTrack.track.id}/complete`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" },
      env,
    ),
  );
  assert.equal(afterRetry.track.complete, true);
  assert.equal(afterRetry.track.chunks, 2);
  assert.equal(afterRetry.track.bytes, 8);

  const guestList = await app.request(`https://casthop.test/api/studios/${id}/recordings`, {}, env);
  assert.equal(guestList.status, 403);

  const listed = await json<RecordingList>(
    await app.request(`https://casthop.test/api/studios/${id}/recordings`, { headers: { Cookie: cookie } }, env),
  );
  assert.equal(listed.tracks.length, 2);
  assert.ok(listed.mixed?.filename?.endsWith(".mp4"));

  await env._r2.put(isoChunkKey(id, hostTrack.track.id, 99), new TextEncoder().encode("NOPE"));
  const prefix = isoPrefix(id, hostTrack.track.id);
  const listedKeys = await listIsoChunkKeys(env.RECORDINGS, id, hostTrack.track.id);
  assert.deepEqual(downloadChunkKeys(listedKeys, prefix, 2), [
    isoChunkKey(id, hostTrack.track.id, 0),
    isoChunkKey(id, hostTrack.track.id, 1),
  ]);

  const dl = await app.request(
    `https://casthop.test/api/studios/${id}/recordings/iso/${hostTrack.track.id}`,
    { headers: { Cookie: cookie } },
    env,
  );
  assert.equal(dl.status, 200, await dl.clone().text());
  assert.equal(dl.headers.get("content-type"), "video/webm");
  assert.match(dl.headers.get("content-disposition") ?? "", /camera\.webm/);
  assert.equal(await dl.text(), "AAAABBBB");

  const guestDl = await app.request(
    `https://casthop.test/api/studios/${id}/recordings/iso/${hostTrack.track.id}`,
    {},
    env,
  );
  assert.equal(guestDl.status, 403);

  const guestPublic = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  assert.equal(JSON.stringify(guestPublic).includes("isoTracks"), false);
  assert.equal(guestPublic.separateRecordings, true);

  const stop = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ live: false }) },
    env,
  );
  assert.equal(stop.status, 200);
  const stopped = await json<PublicStudio>(stop);
  assert.equal(stopped.isoSessionId, null);

  const lateStart = await app.request(
    `https://casthop.test/api/studios/${id}/iso`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity: guestMint.identity,
        guestSecret: guestMint.guestSecret,
        kind: "camera",
        mimeType: "video/webm",
        sessionId: liveBody.isoSessionId,
        startedAt: Date.now(),
      }),
    },
    env,
  );
  assert.equal(lateStart.status, 409);

  const lateChunk = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${guestTrack.track.id}/chunks/1`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Casthop-Identity": guestMint.identity,
        "X-Casthop-Guest-Secret": guestMint.guestSecret,
      },
      body: new TextEncoder().encode("MORE"),
    },
    env,
  );
  assert.equal(lateChunk.status, 200, await lateChunk.clone().text());
});

test("iso-start caps tracks per identity in a session", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const id = await createStudio(env, cookie);
  await app.request(
    `https://casthop.test/api/studios/${id}/iso-pref`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ separateRecordings: true }),
    },
    env,
  );
  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Host", role: "host" }) },
    env,
  );
  const live = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.ok(live.isoSessionId);
  for (let i = 0; i < ISO_TRACKS_PER_IDENTITY; i += 1) {
    const res = await app.request(
      `https://casthop.test/api/studios/${id}/iso`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          kind: "camera",
          mimeType: "video/webm",
          sessionId: live.isoSessionId,
          startedAt: Date.now(),
        }),
      },
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
  }
  const over = await app.request(
    `https://casthop.test/api/studios/${id}/iso`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        kind: "camera",
        mimeType: "video/webm",
        sessionId: live.isoSessionId,
        startedAt: Date.now(),
      }),
    },
    env,
  );
  assert.equal(over.status, 429);
});

test("failed R2 put is not counted on the track", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const id = await createStudio(env, cookie);
  await app.request(
    `https://casthop.test/api/studios/${id}/iso-pref`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ separateRecordings: true }) },
    env,
  );
  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Host", role: "host" }) },
    env,
  );
  const live = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const { track } = await json<{ track: IsoTrack }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/iso`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ kind: "camera", mimeType: "video/webm", sessionId: live.isoSessionId, startedAt: Date.now() }),
      },
      env,
    ),
  );
  env._r2.failNextPut = true;
  const failed = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${track.id}/chunks/0`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream", Cookie: cookie }, body: new TextEncoder().encode("AAAA") },
    env,
  );
  assert.equal(failed.status, 502);
  const list = await json<RecordingList>(
    await app.request(`https://casthop.test/api/studios/${id}/recordings`, { headers: { Cookie: cookie } }, env),
  );
  assert.equal(list.tracks[0]?.chunks, 0);
  assert.equal(list.tracks[0]?.bytes, 0);
  await putChunk(env, id, track.id, 0, "AAAA", cookie);
  const after = await json<RecordingList>(
    await app.request(`https://casthop.test/api/studios/${id}/recordings`, { headers: { Cookie: cookie } }, env),
  );
  assert.equal(after.tracks[0]?.chunks, 1);
  assert.equal(after.tracks[0]?.bytes, 4);
});

test("a second upload to a chunk index in flight cannot store uncounted bytes", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const id = await createStudio(env, cookie);
  await app.request(
    `https://casthop.test/api/studios/${id}/iso-pref`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ separateRecordings: true }) },
    env,
  );
  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Host", role: "host" }) },
    env,
  );
  const live = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const { track } = await json<{ track: IsoTrack }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/iso`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ kind: "camera", mimeType: "video/webm", sessionId: live.isoSessionId, startedAt: Date.now() }),
      },
      env,
    ),
  );
  const put = (body: string) =>
    app.request(
      `https://casthop.test/api/studios/${id}/iso/${track.id}/chunks/0`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream", Cookie: cookie }, body: new TextEncoder().encode(body) },
      env,
    );
  let release!: () => void;
  env._r2.holdNextPut = new Promise<void>((resolve) => {
    release = resolve;
  });
  const small = put("A");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const big = await put("BBBBBBBBBBBBBBBB");
  assert.equal(big.status, 429, "the index is reserved for the upload already in flight");
  release();
  assert.equal((await small).status, 200);

  const list = await json<RecordingList>(
    await app.request(`https://casthop.test/api/studios/${id}/recordings`, { headers: { Cookie: cookie } }, env),
  );
  const stored = await env._r2.get(isoChunkKey(id, track.id, 0));
  assert.equal(list.tracks[0]?.bytes, 1);
  assert.equal(stored?.size, list.tracks[0]?.bytes, "stored bytes match counted bytes");
});

test("isoChunkFits enforces per-track and per-session byte caps", () => {
  const row = (id: string, bytes: number): IsoTrack => ({
    id,
    sessionId: "s",
    identity: "host",
    name: "Host",
    kind: "camera",
    mimeType: "video/webm",
    startedAt: 1,
    endedAt: null,
    bytes,
    chunks: 1,
    complete: false,
  });
  const nearTrackCap = row("a", ISO_TRACK_MAX_BYTES - 1);
  assert.equal(isoChunkFits([nearTrackCap], nearTrackCap, 1), true);
  assert.equal(isoChunkFits([nearTrackCap], nearTrackCap, 2), false);
  const full = Math.floor(ISO_SESSION_MAX_BYTES / ISO_TRACK_MAX_BYTES);
  const others = Array.from({ length: full }, (_, i) => row(`o${i}`, ISO_TRACK_MAX_BYTES));
  const mine = row("mine", 0);
  assert.equal(isoChunkFits([...others, mine], mine, 1), ISO_SESSION_MAX_BYTES > full * ISO_TRACK_MAX_BYTES);
  assert.equal(isoChunkFits([row("x", 0)], row("x", 0), 1), true);
});

test("publicState omits iso track files", () => {
  const jsonText = JSON.stringify(
    publicState(
      {
        id: "abc",
        title: "Weekly",
        hostKeyHash: "hash",
        layout: "side",
        live: true,
        liveStartedAt: 1,
        wantLive: true,
        liveError: null,
        egressRetryCount: 0,
        egressRetryAt: null,
        emptySince: null,
        egressId: "eg_1",
        recordingPath: "/out/secret.mp4",
        separateRecordings: true,
        isoSessionId: "sess1",
        isoTracks: [
          {
            id: "trk",
            sessionId: "sess1",
            identity: "host",
            name: "Host",
            kind: "camera",
            mimeType: "video/webm",
            startedAt: 1,
            endedAt: null,
            bytes: 9,
            chunks: 1,
            complete: false,
          },
        ],
        bannerTitle: "Weekly",
        bannerSubtitle: "live",
        destinations: [],
        participants: [],
        chat: [],
        createdAt: 1,
      },
      { includeUrls: false },
    ),
  );
  assert.equal(jsonText.includes("isoTracks"), false);
  assert.equal(jsonText.includes("/out/secret.mp4"), false);
  assert.equal(jsonText.includes("sess1"), true);
});

async function putChunk(env: Env, id: string, trackId: string, index: number, text: string, cookie: string): Promise<void> {
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/iso/${trackId}/chunks/${index}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Cookie: cookie },
      body: new TextEncoder().encode(text),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
}
