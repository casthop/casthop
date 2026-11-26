import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import {
  durationFromPlaylist,
  hlsFilenamesInPlaylist,
  isHlsFilename,
  MAX_FILE_BYTES,
  MAX_INGEST_BYTES,
  playlistError,
} from "../worker/replays.ts";
import { DEV_API_KEY, DEV_API_SECRET, SESSION_COOKIE } from "../worker/security.ts";
import type { Env, PublicReplay } from "../worker/types.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeR2 } from "./fake-r2.ts";
import { HLS_PLAYLIST, hlsFiles } from "./replay-fixture.ts";

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

async function postReplay(
  env: Env,
  cookie: string,
  studioId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `https://casthop.test/api/studios/${studioId}/replays`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    },
    env,
  );
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/twirp/livekit.") || url.startsWith("http://127.0.0.1:7880")) {
      return new Response("{}", { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("playlist helper rejects traversal and remote URIs", () => {
  assert.equal(isHlsFilename("index.m3u8"), true);
  assert.equal(isHlsFilename("../index.m3u8"), false);
  assert.equal(isHlsFilename("seg0.m4s"), true);
  assert.equal(playlistError("not a playlist"), "playlist must start with #EXTM3U");
  assert.equal(playlistError("#EXTM3U\nhttp://evil.test/x.ts\n"), "playlist has an unsafe URI");
  assert.equal(playlistError("#EXTM3U\n#EXT-X-MAP:URI=\"../init.mp4\"\n"), "playlist has an unsafe URI");
  assert.deepEqual(hlsFilenamesInPlaylist(HLS_PLAYLIST), ["init.mp4", "seg0.m4s"]);
  assert.equal(durationFromPlaylist(HLS_PLAYLIST), 4000);
});

test("owner archives a private replay into mocked R2 and plays HLS", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const created = await postReplay(env, cookie, id, {
    title: "Office hours",
    visibility: "private",
    files: hlsFiles(),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const replay = await json<PublicReplay>(created);
  assert.equal(replay.visibility, "private");
  assert.equal(replay.durationMs, 4000);
  assert.equal(replay.playlistUrl, `/api/replays/${replay.id}/hls/index.m3u8`);
  assert.ok(replay.bytes > 0);

  const listed = await json<{ studios: { id: string; replays: PublicReplay[] }[] }>(
    await app.request("https://casthop.test/api/studios", { headers: { Cookie: cookie } }, env),
  );
  assert.equal(listed.studios[0]?.replays[0]?.id, replay.id);

  const t0 = performance.now();
  const playlist = await app.request(`https://casthop.test${replay.playlistUrl}`, { headers: { Cookie: cookie } }, env);
  const playlistMs = performance.now() - t0;
  assert.equal(playlist.status, 200, await playlist.clone().text());
  assert.equal(playlist.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(playlist.headers.get("cache-control"), "private, no-store");
  const text = await playlist.text();
  assert.match(text, /#EXTM3U/);
  assert.ok(playlistMs < 100, `playlist TTFB ${playlistMs}ms`);

  const seg = await app.request(`https://casthop.test/api/replays/${replay.id}/hls/seg0.m4s`, { headers: { Cookie: cookie } }, env);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get("content-type"), "video/iso.segment");

  const guest = await app.request(`https://casthop.test/api/replays/${replay.id}`, {}, env);
  assert.equal(guest.status, 401);
  const guestHls = await app.request(`https://casthop.test${replay.playlistUrl}`, {}, env);
  assert.equal(guestHls.status, 401);
});

test("public replay is playable by link; private stays host-only", async () => {
  const env = makeEnv();
  const owner = await signIn(env, "owner@example.com");
  const outsider = await signIn(env, "other@example.com");
  const { id } = await createStudio(env, owner);

  const priv = await json<PublicReplay>(
    await postReplay(env, owner, id, { title: "Private cut", visibility: "private", files: hlsFiles() }),
  );
  const pub = await json<PublicReplay>(
    await postReplay(env, owner, id, { title: "Public cut", visibility: "public", files: hlsFiles() }),
  );

  const openPub = await app.request(`https://casthop.test/api/replays/${pub.id}`, {}, env);
  assert.equal(openPub.status, 200);
  const pubBody = await json<PublicReplay>(openPub);
  assert.equal(pubBody.viewerCanEdit, false);
  const openHls = await app.request(`https://casthop.test${pub.playlistUrl}`, {}, env);
  assert.equal(openHls.status, 200);
  assert.equal(openHls.headers.get("cache-control"), "public, max-age=3600");

  const outsiderPriv = await app.request(
    `https://casthop.test/api/replays/${priv.id}`,
    { headers: { Cookie: outsider } },
    env,
  );
  assert.equal(outsiderPriv.status, 403);
  const outsiderHls = await app.request(
    `https://casthop.test${priv.playlistUrl}`,
    { headers: { Cookie: outsider } },
    env,
  );
  assert.equal(outsiderHls.status, 403);

  const patched = await app.request(
    `https://casthop.test/api/studios/${id}/replays/${priv.id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: owner },
      body: JSON.stringify({ visibility: "public" }),
    },
    env,
  );
  assert.equal(patched.status, 200);
  const nowOpen = await app.request(`https://casthop.test/api/replays/${priv.id}`, {}, env);
  assert.equal(nowOpen.status, 200);
});

test("studio list loads replays for every studio in one query", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const a = await createStudio(env, cookie, "One");
  const b = await createStudio(env, cookie, "Two");
  await postReplay(env, cookie, a.id, { title: "Cut A", files: hlsFiles() });
  await postReplay(env, cookie, b.id, { title: "Cut B", files: hlsFiles() });
  const listed = await json<{ studios: { id: string; title: string; replays: PublicReplay[] }[] }>(
    await app.request("https://casthop.test/api/studios", { headers: { Cookie: cookie } }, env),
  );
  const one = listed.studios.find((s) => s.id === a.id);
  const two = listed.studios.find((s) => s.id === b.id);
  assert.equal(one?.replays[0]?.title, "Cut A");
  assert.equal(two?.replays[0]?.title, "Cut B");
});

test("PUT HLS files add to the stored byte total", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const created = await json<PublicReplay>(await postReplay(env, cookie, id, { title: "Cuts", files: hlsFiles() }));
  const first = await json<PublicReplay>(
    await app.request(`https://casthop.test/api/studios/${id}/replays/${created.id}/hls/seg1.m4s`, {
      method: "PUT",
      headers: { Cookie: cookie },
      body: "aaaa",
    }, env),
  );
  assert.equal(first.bytes, created.bytes + 4);
  const second = await json<PublicReplay>(
    await app.request(`https://casthop.test/api/studios/${id}/replays/${created.id}/hls/seg2.m4s`, {
      method: "PUT",
      headers: { Cookie: cookie },
      body: "bbbbbb",
    }, env),
  );
  assert.equal(second.bytes, created.bytes + 4 + 6);
});

test("ingest and PUT reject oversized content-length before reading the body", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const hugePost = await app.request(
    `https://casthop.test/api/studios/${id}/replays`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_INGEST_BYTES + 1),
        Cookie: cookie,
      },
      body: JSON.stringify({ title: "nope" }),
    },
    env,
  );
  assert.equal(hugePost.status, 413);

  const replay = await json<PublicReplay>(await postReplay(env, cookie, id, { title: "Cuts", files: hlsFiles() }));
  const hugePut = await app.request(
    `https://casthop.test/api/studios/${id}/replays/${replay.id}/hls/seg1.m4s`,
    {
      method: "PUT",
      headers: { "Content-Length": String(MAX_FILE_BYTES + 1), Cookie: cookie },
      body: "x",
    },
    env,
  );
  assert.equal(hugePut.status, 400);
});

test("ingest rejects unsafe playlists and missing index", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, cookie);
  const bad = await postReplay(env, cookie, id, {
    files: [{ name: "index.m3u8", content: "#EXTM3U\n../secret.m4s\n" }],
  });
  assert.equal(bad.status, 400);
  const missing = await postReplay(env, cookie, id, {
    files: [{ name: "seg0.m4s", content: "c2VnMA==", encoding: "base64" }],
  });
  assert.equal(missing.status, 400);
});
