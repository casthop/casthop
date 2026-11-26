import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { GUEST_TOKEN_TTL_SEC, HOST_TOKEN_TTL_SEC } from "../worker/livekit.ts";
import { DEV_API_KEY, DEV_API_SECRET, HOST_IDENTITY, SESSION_COOKIE } from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";
import { FakeD1 } from "./fake-d1.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";

let egressStarts = 0;
let egressStops = 0;
let mailWebhookStatus = 503;
const livekitRemoved: string[] = [];
const realFetch = globalThis.fetch;
let githubEmails: { email: string; primary?: boolean; verified?: boolean }[] = [
  { email: "octo@example.com", primary: true, verified: true },
];
let githubUserEmail: string | null = null;
let githubUserId = 99;
let githubFetchThrows = false;
let updateParticipantStatus = 200;
let updateParticipantError = "participant does not exist";

function jwtPayload(token: string): { sub: string; name: string; exp: number; video: Record<string, unknown> } {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("bad jwt");
  return JSON.parse(Buffer.from(payload.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString()) as {
    sub: string;
    name: string;
    exp: number;
    video: Record<string, unknown>;
  };
}

function assertTtl(token: string, ttlSec: number): void {
  const now = Math.floor(Date.now() / 1000);
  const { exp } = jwtPayload(token);
  assert.ok(exp - now <= ttlSec + 5, `exp ${exp} farther than ${ttlSec}s`);
  assert.ok(exp - now >= ttlSec - 15, `exp ${exp} shorter than ${ttlSec}s`);
}

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

function makeEnv(overrides: Partial<Env> = {}): Env & { _db: FakeD1 } {
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
    RECORDINGS: {},
    DB: db,
    ...overrides,
  } as Env & { _db: FakeD1 };
  env._db = db;

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

async function signIn(env: Env, email: string, headers: HeadersInit = {}): Promise<string> {
  const sent = await app.request(
    `${DEV_ORIGIN}/api/auth/magic-link`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email }),
    },
    env,
  );
  assert.equal(sent.status, 200, await sent.clone().text());
  const body = await json<{ ok: boolean; devLogin?: string }>(sent);
  assert.ok(body.devLogin);
  const preview = await app.request(`${DEV_ORIGIN}${body.devLogin}`, { redirect: "manual" }, env);
  assert.equal(preview.status, 200, await preview.clone().text());
  const login = await app.request(`${DEV_ORIGIN}${body.devLogin}`, { method: "POST", redirect: "manual" }, env);
  assert.equal(login.status, 302);
  const raw = headerCookies(login).find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Secure/i);
  const cookie = cookieNamed(login, SESSION_COOKIE);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  return cookie;
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
  return json<{ id: string; guestUrl: string; role: string }>(res);
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (githubFetchThrows && (url.includes("github.com") || url.includes("api.github.com"))) {
      throw new Error("github down");
    }
    if (url.includes("github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_test" }), { status: 200 });
    }
    if (url.includes("api.github.com/user/emails")) {
      return new Response(JSON.stringify(githubEmails), { status: 200 });
    }
    if (url.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ id: githubUserId, login: "octo", name: "Octo Cat", email: githubUserEmail }), { status: 200 });
    }
    if (url.includes("StartRoomCompositeEgress")) {
      egressStarts += 1;
      return new Response(JSON.stringify({ egress_id: "eg_test" }), { status: 200 });
    }
    if (url.includes("StopEgress")) {
      egressStops += 1;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("ListParticipants")) {
      return new Response(JSON.stringify({ participants: [{ identity: "host" }] }), { status: 200 });
    }
    if (url.includes("RemoveParticipant")) {
      const raw = typeof init?.body === "string" ? init.body : "";
      const parsed = raw ? (JSON.parse(raw) as { identity?: string }) : {};
      livekitRemoved.push(parsed.identity ?? "");
      return new Response("{}", { status: 200 });
    }
    if (url.includes("UpdateParticipant")) {
      if (updateParticipantStatus === 200) return new Response("{}", { status: 200 });
      return new Response(updateParticipantError, { status: updateParticipantStatus });
    }
    if (url.includes("/twirp/livekit.")) {
      return new Response("{}", { status: 200 });
    }
    if (url.startsWith("http://127.0.0.1:7880")) {
      return new Response("ok", { status: 200 });
    }
    if (url.includes("https://mail.test/send")) {
      return new Response("fail", { status: mailWebhookStatus });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("authorization matrix: owner / co-host / guest / signed-out / expired", async () => {
  const env = makeEnv();
  const ownerCookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, ownerCookie);

  const invite = await app.request(
    `https://casthop.test/api/studios/${id}/cohosts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ email: "cohost@example.com" }),
    },
    env,
  );
  assert.equal(invite.status, 200, await invite.clone().text());
  const cohostCookie = await signIn(env, "cohost@example.com");

  const outsiderCookie = await signIn(env, "other@example.com");

  const guestMint = await json<{ token: string; identity: string; guestSecret: string; canPublish: boolean; expiresIn: number }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ada", role: "guest" }),
      },
      env,
    ),
  );
  assert.equal(guestMint.canPublish, false);
  assert.match(guestMint.identity, /^g-/);
  const guestJwt = jwtPayload(guestMint.token);
  assert.equal(guestJwt.sub, guestMint.identity);
  assert.equal(guestJwt.video.canPublish, false);
  assert.equal(guestJwt.video.roomAdmin, false);
  assert.equal(guestMint.expiresIn, GUEST_TOKEN_TTL_SEC);
  assertTtl(guestMint.token, GUEST_TOKEN_TTL_SEC);

  const hostMint = await json<{ token: string; identity: string; expiresIn: number }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ownerCookie },
        body: JSON.stringify({ name: "Host", role: "host" }),
      },
      env,
    ),
  );
  assert.equal(hostMint.identity, HOST_IDENTITY);
  const hostJwt = jwtPayload(hostMint.token);
  assert.equal(hostJwt.video.canPublish, true);
  assert.equal(hostJwt.video.roomAdmin, true);
  assert.equal(hostMint.expiresIn, HOST_TOKEN_TTL_SEC);
  assertTtl(hostMint.token, HOST_TOKEN_TTL_SEC);

  const cohostMint = await json<{ token: string; identity: string; expiresIn: number }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cohostCookie },
        body: JSON.stringify({ name: "Co", role: "host" }),
      },
      env,
    ),
  );
  assert.match(cohostMint.identity, /^host-/);
  assert.notEqual(cohostMint.identity, HOST_IDENTITY);
  assert.equal(cohostMint.expiresIn, HOST_TOKEN_TTL_SEC);
  assertTtl(cohostMint.token, HOST_TOKEN_TTL_SEC);

  const expiredEnv = makeEnv();
  const expiredCookie = await signIn(expiredEnv, "expired@example.com");
  const expiredStudio = await createStudio(expiredEnv, expiredCookie);
  expiredEnv._db.expireAllSessions();

  type Who = "owner" | "cohost" | "guest" | "signedOut" | "expired" | "outsider";
  type Row = {
    name: string;
    path: string;
    init: RequestInit;
    expect: Record<Who, number>;
    check?: (who: Who, body: unknown, status: number) => void;
  };

  const guestChat = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: guestMint.identity, guestSecret: guestMint.guestSecret, text: "hi" }),
  };

  const rows: Row[] = [
    {
      name: "GET health",
      path: "/api/health",
      init: {},
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
    },
    {
      name: "GET config",
      path: "/api/config",
      init: {},
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
      check: (_who, body) => {
        const cfg = body as { github: boolean; maxOnStage: number; destinationChat: { youtube: boolean } };
        assert.equal(cfg.github, false);
        assert.equal(cfg.maxOnStage, 6);
        assert.equal(cfg.destinationChat.youtube, false);
      },
    },
    {
      name: "GET me",
      path: "/api/auth/me",
      init: {},
      expect: { owner: 200, cohost: 200, guest: 401, signedOut: 401, expired: 401, outsider: 200 },
    },
    {
      name: "POST magic-link",
      path: "/api/auth/magic-link",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "fresh-matrix@example.com" }) },
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
    },
    {
      name: "GET callback missing token",
      path: "/api/auth/callback",
      init: { redirect: "manual" },
      expect: { owner: 302, cohost: 302, guest: 302, signedOut: 302, expired: 302, outsider: 302 },
    },
    {
      name: "POST callback missing token",
      path: "/api/auth/callback",
      init: { method: "POST", redirect: "manual" },
      expect: { owner: 302, cohost: 302, guest: 302, signedOut: 302, expired: 302, outsider: 302 },
    },
    {
      name: "GET github unconfigured",
      path: "/api/auth/github",
      init: {},
      expect: { owner: 404, cohost: 404, guest: 404, signedOut: 404, expired: 404, outsider: 404 },
    },
    {
      name: "GET github callback unconfigured",
      path: "/api/auth/github/callback",
      init: { redirect: "manual" },
      expect: { owner: 302, cohost: 302, guest: 302, signedOut: 302, expired: 302, outsider: 302 },
    },
    {
      name: "GET studios list",
      path: "/api/studios",
      init: {},
      expect: { owner: 200, cohost: 200, guest: 401, signedOut: 401, expired: 401, outsider: 200 },
    },
    {
      name: "POST studios",
      path: "/api/studios",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Another" }) },
      expect: { owner: 200, cohost: 200, guest: 401, signedOut: 401, expired: 401, outsider: 200 },
    },
    {
      name: "GET studio",
      path: `/api/studios/${id}`,
      init: {},
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
      check: (who, body) => {
        const s = body as PublicStudio & { viewerRole: string };
        const blob = JSON.stringify(s);
        if (who === "owner" || who === "cohost") {
          assert.equal(s.destinations.find((d) => d.id === "youtube")?.url, YT);
          assert.equal(s.destinations.find((d) => d.id === "youtube")?.aspect, "landscape");
          assert.ok(s.viewerRole === "owner" || s.viewerRole === "cohost");
        } else {
          assert.equal(blob.includes(YT), false);
          assert.equal(blob.includes("super-secret"), false);
          assert.equal(s.destinations[0]?.url, undefined);
          assert.equal(s.destinations[0]?.aspect, "landscape");
          assert.equal(s.viewerRole, "guest");
        }
      },
    },
    {
      name: "GET studio ws",
      path: `/api/studios/${id}/ws`,
      init: {},
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
    },
    {
      name: "POST token host",
      path: `/api/studios/${id}/token`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Host", role: "host" }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST token guest",
      path: `/api/studios/${id}/token`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "G", role: "guest" }) },
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
    },
    {
      name: "POST stage",
      path: `/api/studios/${id}/stage`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: guestMint.identity, on: true }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST layout",
      path: `/api/studios/${id}/layout`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: "solo" }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST destinations",
      path: `/api/studios/${id}/destinations`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinations: [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true }] }),
      },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST banner",
      path: `/api/studios/${id}/banner`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Weekly" }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST chat as guest secret",
      path: `/api/studios/${id}/chat`,
      init: guestChat,
      // expired hits a different studio, so this guest secret is not valid there
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 403, outsider: 200 },
    },
    {
      name: "POST chat unauthenticated",
      path: `/api/studios/${id}/chat`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "pwned" }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST pin",
      path: `/api/studios/${id}/pin`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: null }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST live start",
      path: `/api/studios/${id}/live`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live: true }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST live stop",
      path: `/api/studios/${id}/live`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live: false }) },
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST egress-beat",
      path: `/api/studios/${id}/egress-beat`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      expect: { owner: 401, cohost: 401, guest: 401, signedOut: 401, expired: 401, outsider: 401 },
    },
    {
      name: "GET cohosts",
      path: `/api/studios/${id}/cohosts`,
      init: {},
      expect: { owner: 200, cohost: 200, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST cohosts",
      path: `/api/studios/${id}/cohosts`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "new-co@example.com" }) },
      expect: { owner: 200, cohost: 403, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "DELETE cohosts",
      path: `/api/studios/${id}/cohosts/missing`,
      init: { method: "DELETE" },
      expect: { owner: 404, cohost: 403, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
    },
    {
      name: "POST logout",
      path: "/api/auth/logout",
      init: { method: "POST" },
      expect: { owner: 200, cohost: 200, guest: 200, signedOut: 200, expired: 200, outsider: 200 },
    },
  ];

  const cookieFor = (who: Who): string => {
    if (who === "owner") return ownerCookie;
    if (who === "cohost") return cohostCookie;
    if (who === "outsider") return outsiderCookie;
    if (who === "expired") return expiredCookie;
    return "";
  };

  const envFor = (who: Who): Env => (who === "expired" ? expiredEnv : env);
  const pathFor = (who: Who, path: string): string => {
    if (who !== "expired") return `https://casthop.test${path}`;
    return `https://casthop.test${path.replace(id, expiredStudio.id)}`;
  };

  const startsBefore = egressStarts;
  for (const row of rows) {
    for (const who of ["owner", "cohost", "guest", "signedOut", "expired", "outsider"] as Who[]) {
      if (row.name.startsWith("POST live") && who === "expired") {
        // live against the expired studio, which was never started
      }
      const headers = new Headers(row.init.headers);
      const cookie = cookieFor(who);
      if (cookie) headers.set("Cookie", cookie);
      const whoIndex = ["owner", "cohost", "guest", "signedOut", "expired", "outsider"].indexOf(who);
      if (row.name === "POST magic-link") {
        headers.set("cf-connecting-ip", `198.51.100.${10 + whoIndex}`);
        headers.set("Content-Type", "application/json");
        row.init = {
          ...row.init,
          body: JSON.stringify({ email: `fresh-${who}@example.com` }),
        };
      }
      const res = await app.request(pathFor(who, row.path), { ...row.init, headers }, envFor(who));
      assert.equal(
        res.status,
        row.expect[who],
        `${who} ${row.name} -> ${res.status} ${await res.clone().text()}`,
      );
      if (row.check && res.status === 200 && res.headers.get("content-type")?.includes("json")) {
        row.check(who, await json(res), res.status);
      }
    }
  }
  // Guest / signed-out / expired / outsider must not have started Egress. Owner and cohost may have.
  assert.ok(egressStarts >= startsBefore);
});

test("H1: guests cannot pick identity, impersonate host, or steal another guest", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);

  const asHost = await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Guest", role: "host" }),
    },
    env,
  );
  assert.equal(asHost.status, 403);

  const spoofHost = await json<{ identity: string }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Guest", role: "guest", identity: HOST_IDENTITY }),
      },
      env,
    ),
  );
  assert.notEqual(spoofHost.identity, HOST_IDENTITY);
  assert.match(spoofHost.identity, /^g-/);

  const spoofHostSecret = await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Guest", role: "guest", identity: HOST_IDENTITY, guestSecret: "nope" }),
    },
    env,
  );
  assert.equal(spoofHostSecret.status, 403);

  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Host", role: "host" }),
    },
    env,
  );

  const first = await json<{ identity: string; guestSecret: string }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ada", role: "guest" }),
      },
      env,
    ),
  );

  const steal = await json<{ identity: string }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Mallory", role: "guest", identity: first.identity }),
      },
      env,
    ),
  );
  assert.notEqual(steal.identity, first.identity);

  const badSecret = await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mallory", role: "guest", identity: first.identity, guestSecret: "forged" }),
    },
    env,
  );
  assert.equal(badSecret.status, 403);

  const resume = await json<{ identity: string; canPublish: boolean }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ada", role: "guest", identity: first.identity, guestSecret: first.guestSecret }),
      },
      env,
    ),
  );
  assert.equal(resume.identity, first.identity);
  assert.equal(resume.canPublish, false);

  await app.request(
    `https://casthop.test/api/studios/${id}/stage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ identity: first.identity, on: true }),
    },
    env,
  );

  const onStage = await json<{ identity: string; canPublish: boolean }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ada", role: "guest", identity: first.identity, guestSecret: first.guestSecret }),
      },
      env,
    ),
  );
  assert.equal(onStage.canPublish, true);
});

test("staging a guest who is not in LiveKit yet still records onStage", async () => {
  updateParticipantStatus = 404;
  updateParticipantError = "participant does not exist";
  try {
    const env = makeEnv();
    const cookie = await signIn(env, "stage-missing@example.com");
    const { id } = await createStudio(env, cookie);
    const guest = await json<{ identity: string }>(
      await app.request(
        `https://casthop.test/api/studios/${id}/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Ada", role: "guest" }),
        },
        env,
      ),
    );
    const res = await app.request(
      `https://casthop.test/api/studios/${id}/stage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ identity: guest.identity, on: true }),
      },
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const state = await json<PublicStudio>(res);
    const person = state.participants.find((p) => p.identity === guest.identity);
    assert.equal(person?.onStage, true);
  } finally {
    updateParticipantStatus = 200;
  }
});

test("staging surfaces LiveKit permission errors that are not a missing participant", async () => {
  updateParticipantStatus = 500;
  updateParticipantError = "internal error";
  try {
    const env = makeEnv();
    const cookie = await signIn(env, "stage-fail@example.com");
    const { id } = await createStudio(env, cookie);
    const guest = await json<{ identity: string }>(
      await app.request(
        `https://casthop.test/api/studios/${id}/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Ada", role: "guest" }),
        },
        env,
      ),
    );
    const res = await app.request(
      `https://casthop.test/api/studios/${id}/stage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ identity: guest.identity, on: true }),
      },
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<PublicStudio & { warning?: string }>(res);
    assert.match(body.warning ?? "", /internal error/i);
    assert.equal(body.participants.find((p) => p.identity === guest.identity)?.onStage, true);
  } finally {
    updateParticipantStatus = 200;
  }
});

test("C2: live without an owner or co-host session does not start or stop Egress", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  const beforeStart = egressStarts;
  const beforeStop = egressStops;
  const bad = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: true, hostKey: "stolen" }),
    },
    env,
  );
  assert.equal(bad.status, 403);
  assert.equal(egressStarts, beforeStart);

  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ live: true }),
    },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, beforeStart + 1);

  const stopBad = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: false, hostKey: "stolen" }),
    },
    env,
  );
  assert.equal(stopBad.status, 403);
  assert.equal(egressStops, beforeStop);
});

test("H2: default LiveKit keys are refused off loopback", async () => {
  const env = makeEnv({
    CASTHOP_ALLOW_DEV_KEYS: undefined,
    LIVEKIT_HTTP_URL: "https://livekit.example.com",
    PUBLIC_LIVEKIT_URL: "wss://livekit.example.com",
  });
  const res = await app.request("https://casthop.test/api/health", {}, env);
  assert.equal(res.status, 503);
  const body = await json<{ error: string }>(res);
  assert.match(body.error, /devkey/);
});

test("host destination POST without url keeps the stored stream key", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  const publicGet = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        destinations: publicGet.destinations.map((d) => ({ ...d, enabled: d.id !== "custom" })),
      }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const saved = await json<PublicStudio>(res);
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.url, YT);
});

test("host can clear a destination url with an empty string", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  const publicGet = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        destinations: publicGet.destinations.map((d) => (d.id === "youtube" ? { ...d, url: "" } : d)),
      }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const saved = await json<PublicStudio>(res);
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.url, "");
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.hasKey, false);
});

test("chat requires host session or guest secret and uses the participant name", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  const stranger = await app.request(
    `https://casthop.test/api/studios/${id}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Host", identity: "host", text: "pwned" }),
    },
    env,
  );
  assert.equal(stranger.status, 403);

  await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Ada", role: "host" }),
    },
    env,
  );
  const guest = await json<{ identity: string; guestSecret: string }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ada", role: "guest" }),
      },
      env,
    ),
  );
  const spoof = await app.request(
    `https://casthop.test/api/studios/${id}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: guest.identity, guestSecret: guest.guestSecret, name: "Host", text: "hi" }),
    },
    env,
  );
  assert.equal(spoof.status, 200, await spoof.clone().text());
  const body = await json<PublicStudio>(spoof);
  const last = body.chat.at(-1);
  assert.equal(last?.name, "Ada");
  assert.equal(last?.from, guest.identity);
  assert.equal(last?.text, "hi");

  const asHost = await app.request(
    `https://casthop.test/api/studios/${id}/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "from host", name: "Nope" }),
    },
    env,
  );
  assert.equal(asHost.status, 200, await asHost.clone().text());
  const hostChat = await json<PublicStudio>(asHost);
  assert.equal(hostChat.chat.at(-1)?.from, HOST_IDENTITY);
  assert.equal(hostChat.chat.at(-1)?.name, "Ada");
});

test("unsigned LiveKit webhook is rejected", async () => {
  const env = makeEnv();
  const res = await app.request("https://casthop.test/api/livekit/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "egress_ended" }),
  }, env);
  assert.equal(res.status, 401);
});

test("token minting is rate limited; host can still join a full studio", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  let lastStatus = 200;
  for (let i = 0; i < 21; i++) {
    const res = await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `G${i}`, role: "guest" }),
      },
      env,
    );
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429);
  const host = await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Host", role: "host" }),
    },
    env,
  );
  assert.equal(host.status, 200, await host.clone().text());
});

test("sign-in is rate limited per IP", async () => {
  const env = makeEnv();
  let last = 200;
  for (let i = 0; i < 6; i++) {
    const res = await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ email: `user${i}@example.com` }),
      },
      env,
    );
    last = res.status;
  }
  assert.equal(last, 429);
});

test("spoofed forwarding headers share the local IP bucket, which is rate limited", async () => {
  const env = makeEnv({ CASTHOP_TRUST_FORWARDED: "0" });
  let last = 200;
  for (let i = 0; i < 6; i++) {
    const res = await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": `203.0.113.${i}`,
          "x-forwarded-for": `198.51.100.${i}`,
        },
        body: JSON.stringify({ email: `spoof${i}@example.com` }),
      },
      env,
    );
    last = res.status;
    if (i < 5) assert.equal(res.status, 200, await res.clone().text());
  }
  assert.equal(last, 429);
});

test("email sign-in limit returns ok without sending, so the owner is not locked out", async () => {
  const env = makeEnv();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    for (let i = 0; i < 4; i++) {
      const res = await app.request(
        "https://casthop.test/api/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.40" },
          body: JSON.stringify({ email: "victim@example.com" }),
        },
        env,
      );
      assert.equal(res.status, 200, await res.clone().text());
    }
  } finally {
    console.log = origLog;
  }
  const sent = logs.filter((line) => line.includes("casthop mail") && line.includes("victim@example.com"));
  assert.equal(sent.length, 3);
  assert.equal(env._db.rows("magic_links").filter((r) => r.email === "victim@example.com").length, 3);
});

test("email sign-in limit is per email and IP, so another client can still get a link", async () => {
  const env = makeEnv();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        "https://casthop.test/api/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
          body: JSON.stringify({ email: "victim@example.com" }),
        },
        env,
      );
      assert.equal(res.status, 200, await res.clone().text());
    }
    const owner = await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ email: "victim@example.com" }),
      },
      env,
    );
    assert.equal(owner.status, 200, await owner.clone().text());
  } finally {
    console.log = origLog;
  }
  const sent = logs.filter((line) => line.includes("casthop mail") && line.includes("victim@example.com"));
  assert.equal(sent.length, 4);
});

test("parallel sign-in rate limit does not 500", async () => {
  const env = makeEnv();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      app.request(
        "https://casthop.test/api/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.50" },
          body: JSON.stringify({ email: `race${i}@example.com` }),
        },
        env,
      ),
    ),
  );
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 200 || s === 429));
  assert.ok(statuses.some((s) => s === 429));
  assert.equal(statuses.includes(500), false);
});

test("sessions rotate and the previous cookie still works within the grace window", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  env._db.setSessionRotatedAt(1);
  const me = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(me.status, 200);
  const rotated = cookieNamed(me, SESSION_COOKIE);
  assert.ok(rotated);
  assert.notEqual(rotated, cookie);
  const oldStill = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(oldStill.status, 200);
  const next = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: rotated } }, env);
  assert.equal(next.status, 200);
});

test("rotated session cookie is returned on a raw Response route", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  env._db.setSessionRotatedAt(1);
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/layout`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ layout: "solo" }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const rotated = cookieNamed(res, SESSION_COOKIE);
  assert.ok(rotated);
  assert.notEqual(rotated, cookie);
  const me = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: rotated } }, env);
  assert.equal(me.status, 200);
});

test("parallel rotation issues only one new cookie", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  env._db.setSessionRotatedAt(1);
  const [a, b] = await Promise.all([
    app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env),
    app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const issued = [cookieNamed(a, SESSION_COOKIE), cookieNamed(b, SESSION_COOKIE)].filter(Boolean);
  assert.equal(issued.length, 1);
  const current = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: issued[0] } }, env);
  assert.equal(current.status, 200);
  const prev = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(prev.status, 200);
});

test("previous cookie is rejected after the rotation grace window; current cookie still works", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  env._db.setSessionRotatedAt(1);
  const me = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(me.status, 200);
  const rotated = cookieNamed(me, SESSION_COOKIE);
  env._db.setSessionRotatedAt(Date.now() - 61_000);
  const stalePrev = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(stalePrev.status, 401);
  const current = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: rotated } }, env);
  assert.equal(current.status, 200);
});

test("malformed session cookie does not 500", async () => {
  const env = makeEnv();
  const res = await app.request(
    "https://casthop.test/api/auth/me",
    { headers: { Cookie: "casthop_session=%E0%A4%A" } },
    env,
  );
  assert.equal(res.status, 401);
});

test("expired session cannot host, and Set-Cookie clears on /me", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "ada@example.com");
  const { id } = await createStudio(env, cookie);
  env._db.expireAllSessions();
  const me = await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cookie } }, env);
  assert.equal(me.status, 401);
  const live = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ live: true }),
    },
    env,
  );
  assert.equal(live.status, 403);
});

test("GitHub OAuth ignores unverified emails and cannot steal an existing account", async () => {
  const env = makeEnv({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" });
  const victim = await signIn(env, "victim@example.com");
  const meBefore = await json<{ email: string; githubId: string | null }>(
    await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: victim } }, env),
  );
  assert.equal(meBefore.email, "victim@example.com");
  githubEmails = [{ email: "victim@example.com", primary: true, verified: false }];
  githubUserEmail = "victim@example.com";
  try {
    const start = await app.request("https://casthop.test/api/auth/github", { redirect: "manual" }, env);
    const location = start.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") ?? "";
    const oauthCookie = cookieNamed(start, "casthop_oauth");
    const callback = await app.request(
      `https://casthop.test/api/auth/github/callback?code=abc&state=${state}`,
      { redirect: "manual", headers: { Cookie: oauthCookie } },
      env,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/?auth=invalid");
    assert.equal(cookieNamed(callback, SESSION_COOKIE), "");
    const still = await json<{ email: string; githubId: string | null }>(
      await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: victim } }, env),
    );
    assert.equal(still.email, "victim@example.com");
    assert.equal(still.githubId, null);
  } finally {
    githubEmails = [{ email: "octo@example.com", primary: true, verified: true }];
    githubUserEmail = null;
  }
});

test("GitHub OAuth is optional and creates a session when configured", async () => {
  const env = makeEnv({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" });
  const start = await app.request("https://casthop.test/api/auth/github", { redirect: "manual" }, env);
  assert.equal(start.status, 302);
  const location = start.headers.get("location") ?? "";
  assert.match(location, /github.com\/login\/oauth\/authorize/);
  const state = new URL(location).searchParams.get("state") ?? "";
  const oauthCookie = cookieNamed(start, "casthop_oauth");
  const callback = await app.request(
    `https://casthop.test/api/auth/github/callback?code=abc&state=${state}`,
    { redirect: "manual", headers: { Cookie: oauthCookie } },
    env,
  );
  assert.equal(callback.status, 302);
  const session = cookieNamed(callback, SESSION_COOKIE);
  const me = await json<{ email: string; name: string }>(
    await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: session } }, env),
  );
  assert.equal(me.email, "octo@example.com");
  assert.equal(me.name, "Octo Cat");
  assert.match(location, /redirect_uri=https%3A%2F%2Fcasthop\.test%/);
});

test("GitHub callback treats a network error as a failed sign-in", async () => {
  const env = makeEnv({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" });
  const start = await app.request("https://casthop.test/api/auth/github", { redirect: "manual" }, env);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const oauthCookie = cookieNamed(start, "casthop_oauth");
  githubFetchThrows = true;
  try {
    const callback = await app.request(
      `https://casthop.test/api/auth/github/callback?code=abc&state=${state}`,
      { redirect: "manual", headers: { Cookie: oauthCookie } },
      env,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/?auth=invalid");
    assert.equal(cookieNamed(callback, SESSION_COOKIE), "");
    const cleared = headerCookies(callback).find((c) => c.startsWith("casthop_oauth="));
    assert.ok(cleared);
    assert.match(cleared ?? "", /Max-Age=0/i);
  } finally {
    githubFetchThrows = false;
  }
});

test("GitHub OAuth does not overwrite an email already linked to another GitHub user", async () => {
  const env = makeEnv({ GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" });
  githubEmails = [{ email: "shared@example.com", primary: true, verified: true }];
  githubUserId = 11;
  try {
    async function oauthSession(): Promise<Response> {
      const start = await app.request("https://casthop.test/api/auth/github", { redirect: "manual" }, env);
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const oauthCookie = cookieNamed(start, "casthop_oauth");
      return app.request(
        `https://casthop.test/api/auth/github/callback?code=abc&state=${state}`,
        { redirect: "manual", headers: { Cookie: oauthCookie } },
        env,
      );
    }
    const first = await oauthSession();
    assert.equal(first.status, 302);
    const session = cookieNamed(first, SESSION_COOKIE);
    const me = await json<{ email: string; githubId: string | null }>(
      await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: session } }, env),
    );
    assert.equal(me.email, "shared@example.com");
    assert.equal(me.githubId, "11");
    githubUserId = 22;
    const second = await oauthSession();
    assert.equal(second.status, 302);
    assert.equal(second.headers.get("location"), "/?auth=invalid");
    const still = await json<{ githubId: string | null }>(
      await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: session } }, env),
    );
    assert.equal(still.githubId, "11");
  } finally {
    githubEmails = [{ email: "octo@example.com", primary: true, verified: true }];
    githubUserId = 99;
  }
});

test("POST magic callback rejects a cross-site Origin and does not consume the token", async () => {
  const env = makeEnv();
  const sent = await json<{ devLogin: string }>(
    await app.request(
      `${DEV_ORIGIN}/api/auth/magic-link`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "csrf@example.com" }),
      },
      env,
    ),
  );
  const csrf = await app.request(
    `${DEV_ORIGIN}${sent.devLogin}`,
    { method: "POST", redirect: "manual", headers: { Origin: "https://evil.example" } },
    env,
  );
  assert.equal(csrf.status, 403);
  const ok = await app.request(
    `${DEV_ORIGIN}${sent.devLogin}`,
    { method: "POST", redirect: "manual", headers: { Origin: DEV_ORIGIN } },
    env,
  );
  assert.equal(ok.status, 302);
  assert.ok(cookieNamed(ok, SESSION_COOKIE));
});

test("magic link mail uses PUBLIC_ORIGIN, not the Host header", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const env = makeEnv({ PUBLIC_ORIGIN: "https://casthop.test" });
    const res = await app.request(
      "https://evil.example/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "host-spoof@example.com" }),
      },
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
    const mail = logs.join("\n");
    assert.match(mail, /https:\/\/casthop\.test\/api\/auth\/callback/);
    assert.equal(mail.includes("evil.example"), false);
  } finally {
    console.log = origLog;
  }
});

test("magic link off loopback without PUBLIC_ORIGIN fails closed", async () => {
  const env = makeEnv({ PUBLIC_ORIGIN: "" });
  const res = await app.request(
    "https://casthop.test/api/auth/magic-link",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "no-origin@example.com" }),
    },
    env,
  );
  assert.equal(res.status, 503);
});

test("devLogin is returned on loopback when CF-Connecting-IP is 127.0.0.1", async () => {
  const env = makeEnv();
  const sent = await json<{ ok: boolean; devLogin?: string }>(
    await app.request(
      "http://127.0.0.1/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "127.0.0.1" },
        body: JSON.stringify({ email: "e2e-loopback@example.com" }),
      },
      env,
    ),
  );
  assert.equal(sent.ok, true);
  assert.ok(sent.devLogin);
});

test("devLogin is omitted when Host is loopback but the client IP is not local", async () => {
  const env = makeEnv();
  const sent = await json<{ ok: boolean; devLogin?: string }>(
    await app.request(
      "http://localhost/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.80" },
        body: JSON.stringify({ email: "spoof-host@example.com" }),
      },
      env,
    ),
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.devLogin, undefined);
});

test("devLogin is omitted on a non-loopback host even with CASTHOP_ALLOW_DEV_KEYS", async () => {
  const env = makeEnv();
  const sent = await json<{ ok: boolean; devLogin?: string }>(
    await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "remote@example.com" }),
      },
      env,
    ),
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.devLogin, undefined);
});

test("magic link is not logged or returned outside local/dev", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const env = makeEnv({
      LIVEKIT_API_KEY: "prodkey",
      LIVEKIT_API_SECRET: "prodsecretprodsecretprodsecret",
      CASTHOP_ALLOW_DEV_KEYS: "0",
    });
    const res = await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "prod@example.com" }),
      },
      env,
    );
    assert.equal(res.status, 502);
    const sent = await json<{ error?: string; devLogin?: string }>(res);
    assert.equal(sent.devLogin, undefined);
    assert.match(sent.error ?? "", /could not send/);
    assert.equal(
      logs.some((line) => line.includes("casthop mail")),
      false,
    );
  } finally {
    console.log = origLog;
  }
});

test("failed mail webhook returns an error instead of pretending the link was sent", async () => {
  mailWebhookStatus = 503;
  const env = makeEnv({
    LIVEKIT_API_KEY: "prodkey",
    LIVEKIT_API_SECRET: "prodsecretprodsecretprodsecret",
    CASTHOP_ALLOW_DEV_KEYS: "0",
    MAIL_WEBHOOK_URL: "https://mail.test/send",
  });
  const res = await app.request(
    "https://casthop.test/api/auth/magic-link",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "hook@example.com" }),
    },
    env,
  );
  assert.equal(res.status, 502);
  const body = await json<{ error: string }>(res);
  assert.match(body.error, /could not send/);
});

test("failed co-host invite mail does not leave a stuck pending invite", async () => {
  const env = makeEnv();
  const cookie = await signIn(env, "owner-invite@example.com");
  const { id } = await createStudio(env, cookie);
  mailWebhookStatus = 503;
  env.MAIL_WEBHOOK_URL = "https://mail.test/send";
  try {
    const first = await app.request(
      `https://casthop.test/api/studios/${id}/cohosts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ email: "stuck@example.com" }),
      },
      env,
    );
    assert.equal(first.status, 502, await first.clone().text());
    const listed = await json<{ pending: { email: string }[] }>(
      await app.request(`https://casthop.test/api/studios/${id}/cohosts`, { headers: { Cookie: cookie } }, env),
    );
    assert.equal(listed.pending.length, 0);
    mailWebhookStatus = 200;
    const second = await app.request(
      `https://casthop.test/api/studios/${id}/cohosts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ email: "stuck@example.com" }),
      },
      env,
    );
    assert.equal(second.status, 200, await second.clone().text());
  } finally {
    mailWebhookStatus = 503;
    delete env.MAIL_WEBHOOK_URL;
  }
});

test("ensureDb sweeps expired sessions, magic links, oauth states, and stale rate rows", async () => {
  const env = makeEnv();
  env._db.rows("sessions").push({
    id: "s1",
    account_id: "a1",
    token_hash: "h",
    prev_token_hash: null,
    expires_at: 1,
    created_at: 1,
    rotated_at: 1,
  });
  env._db.rows("magic_links").push({
    token_hash: "m1",
    email: "old@example.com",
    expires_at: 1,
    consumed_at: null,
    created_at: 1,
  });
  env._db.rows("oauth_states").push({ state: "stale", expires_at: 1 });
  env._db.rows("rate_limits").push({ key: "ip:1.1.1.1", count: 9, window_start: 1 });
  const res = await app.request("https://casthop.test/api/auth/me", {}, env);
  assert.equal(res.status, 401);
  assert.equal(env._db.rows("sessions").length, 0);
  assert.equal(env._db.rows("magic_links").length, 0);
  assert.equal(env._db.rows("oauth_states").length, 0);
  assert.equal(env._db.rows("rate_limits").length, 0);
});

test("magic link is single-use", async () => {
  const env = makeEnv();
  const sent = await json<{ devLogin: string }>(
    await app.request(
      `${DEV_ORIGIN}/api/auth/magic-link`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "once@example.com" }),
      },
      env,
    ),
  );
  const peek = await app.request(`${DEV_ORIGIN}${sent.devLogin}`, { redirect: "manual" }, env);
  assert.equal(peek.status, 200, await peek.clone().text());
  assert.match(await peek.text(), /Sign in/);
  assert.equal(cookieNamed(peek, SESSION_COOKIE), "");
  const token = new URL(sent.devLogin, DEV_ORIGIN).searchParams.get("token") ?? "";
  const first = await app.request(
    `${DEV_ORIGIN}/api/auth/callback`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    },
    env,
  );
  assert.equal(first.status, 302);
  assert.ok(cookieNamed(first, SESSION_COOKIE));
  const second = await app.request(`${DEV_ORIGIN}${sent.devLogin}`, { method: "POST", redirect: "manual" }, env);
  assert.equal(second.status, 302);
  assert.equal(second.headers.get("location"), "/?auth=invalid");
  const peekAfter = await app.request(`${DEV_ORIGIN}${sent.devLogin}`, { redirect: "manual" }, env);
  assert.equal(peekAfter.status, 302);
  assert.equal(peekAfter.headers.get("location"), "/?auth=invalid");
});

test("removing a co-host kicks them, expires host tokens quickly, and denies rejoin by identity", async () => {
  livekitRemoved.length = 0;
  const env = makeEnv();
  const ownerCookie = await signIn(env, "owner@example.com");
  const { id } = await createStudio(env, ownerCookie);
  const owner = await json<{ id: string }>(
    await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: ownerCookie } }, env),
  );
  const delOwner = await app.request(
    `https://casthop.test/api/studios/${id}/cohosts/${owner.id}`,
    { method: "DELETE", headers: { Cookie: ownerCookie } },
    env,
  );
  assert.equal(delOwner.status, 404);
  const invite = await app.request(
    `https://casthop.test/api/studios/${id}/cohosts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ email: "cohost-kick@example.com" }),
    },
    env,
  );
  assert.equal(invite.status, 200, await invite.clone().text());
  const cohostCookie = await signIn(env, "cohost-kick@example.com");
  const cohost = await json<{ id: string }>(
    await app.request("https://casthop.test/api/auth/me", { headers: { Cookie: cohostCookie } }, env),
  );
  const minted = await json<{ identity: string; token: string; expiresIn: number }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cohostCookie },
        body: JSON.stringify({ name: "Co", role: "host" }),
      },
      env,
    ),
  );
  assert.equal(minted.expiresIn, HOST_TOKEN_TTL_SEC);
  assertTtl(minted.token, HOST_TOKEN_TTL_SEC);
  const before = await json<{ participants: { identity: string }[] }>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: ownerCookie } }, env),
  );
  assert.ok(before.participants.some((p) => p.identity === minted.identity));

  const del = await app.request(
    `https://casthop.test/api/studios/${id}/cohosts/${cohost.id}`,
    { method: "DELETE", headers: { Cookie: ownerCookie } },
    env,
  );
  assert.equal(del.status, 200, await del.clone().text());
  assert.ok(livekitRemoved.includes(minted.identity));

  const after = await json<{ participants: { identity: string }[] }>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: ownerCookie } }, env),
  );
  assert.equal(
    after.participants.some((p) => p.identity === minted.identity),
    false,
  );

  const remint = await app.request(
    `https://casthop.test/api/studios/${id}/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cohostCookie },
      body: JSON.stringify({ name: "Co", role: "host" }),
    },
    env,
  );
  assert.equal(remint.status, 403);

  const sneak = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(`https://studio/${id}?action=join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: minted.identity, name: "Co", role: "host" }),
  });
  assert.equal(sneak.status, 403);
  const sneakBody = await json<{ error?: string }>(sneak);
  assert.equal(sneakBody.error, "removed from studio");

  const reinvite = await app.request(
    `https://casthop.test/api/studios/${id}/cohosts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ email: "cohost-kick@example.com" }),
    },
    env,
  );
  assert.equal(reinvite.status, 200, await reinvite.clone().text());
  const back = await json<{ token: string; expiresIn: number }>(
    await app.request(
      `https://casthop.test/api/studios/${id}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cohostCookie },
        body: JSON.stringify({ name: "Co", role: "host" }),
      },
      env,
    ),
  );
  assert.equal(back.expiresIn, HOST_TOKEN_TTL_SEC);
  assertTtl(back.token, HOST_TOKEN_TTL_SEC);
});
