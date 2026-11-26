import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, SESSION_COOKIE } from "../worker/security.ts";
import { FakeD1 } from "./fake-d1.ts";
import {
  clampPollMs,
  destChatConfigured,
  destChatProviders,
  parseYoutubeChatPage,
  parseYoutubeLiveChatIdFromBroadcasts,
  parseYoutubeLiveChatIdFromVideos,
  pollYoutubeChat,
  youtubeChatConfigured,
} from "../worker/chat-ingest.ts";
import type { Env, PublicStudio } from "../worker/types.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";

let youtubePolls = 0;
let youtubeBroadcasts = 0;
let youtubeTokens = 0;
let youtubeVideos = 0;
const realFetch = globalThis.fetch;

const ytMessage = {
  id: "yt-msg-1",
  snippet: {
    type: "textMessageEvent",
    publishedAt: "2026-01-02T00:00:00.000Z",
    displayMessage: "hello from yt",
  },
  authorDetails: { channelId: "UCabc123", displayName: "Viewer A" },
};

function fakeCtx(): DurableObjectState {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      setAlarm: async (at: number) => {
        alarm = at;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
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
    CASTHOP_EMPTY_GRACE_MS: "60000",
    CASTHOP_TRUST_FORWARDED: "1",
    PUBLIC_ORIGIN: "https://casthop.test",
    ASSETS: { fetch: async () => new Response("ok") },
    RECORDINGS: {},
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

async function signIn(env: Env, email = "owner@example.com"): Promise<string> {
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
  const cookie = cookieNamed(login, SESSION_COOKIE);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  return cookie;
}

async function createStudio(env: Env) {
  const cookie = await signIn(env);
  const res = await app.request(
    "https://casthop.test/api/studios",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title: "Weekly product update" }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const created = await json<{ id: string }>(res);
  return { id: created.id, cookie };
}

async function goLiveAndWatch(env: Env, id: string, cookie: string): Promise<PublicStudio> {
  const live = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ live: true }),
    },
    env,
  );
  assert.equal(live.status, 200, await live.clone().text());
  const watch = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(`https://studio/${id}?action=watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(watch.status, 200, await watch.clone().text());
  return json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("oauth2.googleapis.com/token")) {
      youtubeTokens += 1;
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("googleapis.com/youtube/v3/liveChat/messages")) {
      youtubePolls += 1;
      const parsed = new URL(url);
      assert.ok(parsed.searchParams.get("liveChatId"));
      return new Response(
        JSON.stringify({
          pollingIntervalMillis: 4000,
          nextPageToken: "page-2",
          items: [ytMessage],
        }),
        { status: 200 },
      );
    }
    if (url.includes("googleapis.com/youtube/v3/liveBroadcasts")) {
      youtubeBroadcasts += 1;
      return new Response(
        JSON.stringify({ items: [{ snippet: { liveChatId: "LC_from_broadcast" } }] }),
        { status: 200 },
      );
    }
    if (url.includes("googleapis.com/youtube/v3/videos")) {
      youtubeVideos += 1;
      return new Response(
        JSON.stringify({ items: [{ liveStreamingDetails: { activeLiveChatId: "LC_from_video" } }] }),
        { status: 200 },
      );
    }
    if (url.includes("StartRoomCompositeEgress")) {
      return new Response(JSON.stringify({ egress_id: "eg_chat" }), { status: 200 });
    }
    if (url.includes("StopEgress")) {
      return new Response("{}", { status: 200 });
    }
    if (url.includes("ListEgress")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              egressId: "eg_chat",
              roomName: "studio",
              status: 1,
              streamResults: [{ url: YT, status: 0, startedAt: Date.now(), bytes: 4096 }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("ListParticipants")) {
      return new Response(JSON.stringify({ participants: [{ identity: "host" }] }), { status: 200 });
    }
    if (url.includes("/twirp/livekit.")) {
      return new Response("{}", { status: 200 });
    }
    if (url.startsWith("http://127.0.0.1:7880")) {
      return new Response("ok", { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("destination chat is hidden without credentials", () => {
  assert.equal(youtubeChatConfigured({}), false);
  assert.equal(destChatConfigured({}).youtube, false);
  assert.equal(youtubeChatConfigured({ YOUTUBE_API_KEY: "k" }), false);
  assert.equal(destChatProviders.length, 1);
  assert.equal(destChatProviders[0]?.id, "youtube");
});

test("GET /api/config reports youtube chat off by default", async () => {
  const env = makeEnv();
  const res = await app.request("https://casthop.test/api/config", {}, env);
  assert.equal(res.status, 200);
  const body = await json<{ destinationChat: { youtube: boolean } }>(res);
  assert.equal(body.destinationChat.youtube, false);
});

test("parseYoutubeChatPage reads pollingIntervalMillis and text messages", () => {
  const page = parseYoutubeChatPage({
    pollingIntervalMillis: 5500,
    nextPageToken: "n2",
    items: [ytMessage, { id: "skip", snippet: { displayMessage: "   " } }],
  });
  assert.ok(page);
  assert.equal(page.pollAfterMs, 5500);
  assert.equal(page.pageToken, "n2");
  assert.equal(page.comments.length, 1);
  assert.equal(page.comments[0]?.source, "youtube");
  assert.equal(page.comments[0]?.name, "Viewer A");
  assert.equal(page.comments[0]?.text, "hello from yt");
  assert.equal(page.comments[0]?.from, "yt:UCabc123");
  assert.equal(clampPollMs(500), 2_000);
  assert.equal(clampPollMs(90_000), 60_000);
  assert.equal(clampPollMs("nope"), 5_000);
});

test("live chat id parsers read videos and broadcasts", () => {
  assert.equal(parseYoutubeLiveChatIdFromVideos({ items: [{ liveStreamingDetails: { activeLiveChatId: "LC1" } }] }), "LC1");
  assert.equal(parseYoutubeLiveChatIdFromBroadcasts({ items: [{ snippet: { liveChatId: "LC2" } }] }), "LC2");
  assert.equal(parseYoutubeLiveChatIdFromVideos({ items: [] }), null);
});

test("pollYoutubeChat uses the API polling interval and mocked messages", async () => {
  youtubePolls = 0;
  const result = await pollYoutubeChat({ YOUTUBE_API_KEY: "test-key", YOUTUBE_LIVE_CHAT_ID: "LC_env" }, {}, null);
  assert.equal(youtubePolls, 1);
  assert.equal(result.liveChatId, "LC_env");
  assert.equal(result.page?.pollAfterMs, 4000);
  assert.equal(result.page?.comments[0]?.text, "hello from yt");
});

test("live studio pulls YouTube comments and host can pin them", async () => {
  youtubePolls = 0;
  const env = makeEnv({ YOUTUBE_API_KEY: "test-key", YOUTUBE_LIVE_CHAT_ID: "LC_env" });
  const { id, cookie } = await createStudio(env);
  const cfg = await json<{ destinationChat: { youtube: boolean } }>(
    await app.request("https://casthop.test/api/config", {}, env),
  );
  assert.equal(cfg.destinationChat.youtube, true);

  const after = await goLiveAndWatch(env, id, cookie);
  assert.equal(youtubePolls, 1);
  const yt = after.chat.find((m) => m.source === "youtube");
  assert.ok(yt);
  assert.equal(yt.text, "hello from yt");
  assert.equal(yt.name, "Viewer A");
  assert.equal("destChat" in after, false);

  const again = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(`https://studio/${id}?action=watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(again.status, 200);
  assert.equal(youtubePolls, 1, "must wait for pollingIntervalMillis");

  const pinned = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ chatId: yt.id }),
      },
      env,
    ),
  );
  assert.equal(pinned.pinnedChat?.id, yt.id);
  assert.equal(pinned.pinnedChat?.text, "hello from yt");

  const guest = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  assert.equal(guest.pinnedChat?.id, yt.id);
  assert.equal(guest.chat.some((m) => m.source === "youtube"), true);

  const unpinned = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/pin`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ chatId: null }),
      },
      env,
    ),
  );
  assert.equal(unpinned.pinnedChat, null);
});

test("going live without YouTube credentials does not call Google", async () => {
  youtubePolls = 0;
  youtubeBroadcasts = 0;
  youtubeTokens = 0;
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  await goLiveAndWatch(env, id, cookie);
  assert.equal(youtubePolls, 0);
  assert.equal(youtubeBroadcasts, 0);
  assert.equal(youtubeTokens, 0);
});

test("OAuth finds the active broadcast liveChatId", async () => {
  youtubePolls = 0;
  youtubeBroadcasts = 0;
  youtubeTokens = 0;
  const result = await pollYoutubeChat(
    {
      YOUTUBE_OAUTH_CLIENT_ID: "cid",
      YOUTUBE_OAUTH_CLIENT_SECRET: "csecret",
      YOUTUBE_OAUTH_REFRESH_TOKEN: "rtoken",
    },
    {},
    null,
  );
  assert.equal(youtubeTokens, 1);
  assert.equal(youtubeBroadcasts, 1);
  assert.equal(youtubePolls, 1);
  assert.equal(result.liveChatId, "LC_from_broadcast");
  assert.equal(result.page?.comments[0]?.text, "hello from yt");
});

test("API key plus video id resolves activeLiveChatId", async () => {
  youtubeVideos = 0;
  youtubePolls = 0;
  const result = await pollYoutubeChat({ YOUTUBE_API_KEY: "test-key", YOUTUBE_VIDEO_ID: "vid1" }, {}, null);
  assert.equal(youtubeVideos, 1);
  assert.equal(youtubePolls, 1);
  assert.equal(result.liveChatId, "LC_from_video");
});

test("pin requires a host session", async () => {
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  await app.request(
    `https://casthop.test/api/studios/${id}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "from host" }),
    },
    env,
  );
  const denied = await app.request(
    `https://casthop.test/api/studios/${id}/pin`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "nope" }),
    },
    env,
  );
  assert.equal(denied.status, 403);
});
