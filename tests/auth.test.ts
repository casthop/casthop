import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, HOST_IDENTITY, SESSION_COOKIE } from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";
import { FakeD1 } from "./fake-d1.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";

let egressStarts = 0;
let egressStops = 0;
const realFetch = globalThis.fetch;

function jwtPayload(token: string): { sub: string; name: string; video: Record<string, unknown> } {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("bad jwt");
  return JSON.parse(Buffer.from(payload.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString()) as {
    sub: string;
    name: string;
    video: Record<string, unknown>;
  };
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

async function signIn(env: Env, email: string, headers: HeadersInit = {}): Promise<string> {
  const sent = await app.request(
    "https://casthop.test/api/auth/magic-link",
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
  const login = await app.request(`https://casthop.test${body.devLogin}`, { redirect: "manual" }, env);
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
    if (url.includes("github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_test" }), { status: 200 });
    }
    if (url.includes("api.github.com/user/emails")) {
      return new Response(JSON.stringify([{ email: "octo@example.com", primary: true, verified: true }]), { status: 200 });
    }
    if (url.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ id: 99, login: "octo", name: "Octo Cat", email: null }), { status: 200 });
    }
    if (url.includes("StartRoomCompositeEgress")) {
      egressStarts += 1;
      return new Response(JSON.stringify({ egress_id: "eg_test" }), { status: 200 });
    }
    if (url.includes("StopEgress")) {
      egressStops += 1;
      return new Response("{}", { status: 200 });
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

  const guestMint = await json<{ token: string; identity: string; guestSecret: string; canPublish: boolean }>(
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

  const hostMint = await json<{ token: string; identity: string }>(
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

  const cohostMint = await json<{ token: string; identity: string }>(
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
        const cfg = body as { github: boolean; maxOnStage: number };
        assert.equal(cfg.github, false);
        assert.equal(cfg.maxOnStage, 6);
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
          assert.ok(s.viewerRole === "owner" || s.viewerRole === "cohost");
        } else {
          assert.equal(blob.includes(YT), false);
          assert.equal(blob.includes("super-secret"), false);
          assert.equal(s.destinations[0]?.url, undefined);
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
      expect: { owner: 200, cohost: 403, guest: 403, signedOut: 403, expired: 403, outsider: 403 },
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

test("sessions rotate and the previous cookie still works once", async () => {
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
});

test("magic link is single-use", async () => {
  const env = makeEnv();
  const sent = await json<{ devLogin: string }>(
    await app.request(
      "https://casthop.test/api/auth/magic-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "once@example.com" }),
      },
      env,
    ),
  );
  const first = await app.request(`https://casthop.test${sent.devLogin}`, { redirect: "manual" }, env);
  assert.equal(first.status, 302);
  const second = await app.request(`https://casthop.test${sent.devLogin}`, { redirect: "manual" }, env);
  assert.equal(second.status, 302);
  assert.equal(second.headers.get("location"), "/?auth=invalid");
});
