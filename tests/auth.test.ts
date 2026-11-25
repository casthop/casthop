import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, HOST_IDENTITY, HOST_KEY_HEADER } from "../worker/security.ts";
import type { Env, PublicStudio } from "../worker/types.ts";

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

function makeEnv(overrides: Partial<Env> = {}): Env {
  const rooms = new Map<string, StudioDurableObject>();
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
    DB: {
      prepare() {
        const stmt = {
          run: async () => ({ success: true }),
          bind() {
            return stmt;
          },
        };
        return stmt;
      },
    },
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

async function createStudio(env: Env) {
  const res = await app.request("https://casthop.test/api/studios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Weekly product update" }),
  }, env);
  assert.equal(res.status, 200, await res.clone().text());
  return json<{ id: string; hostKey: string; guestUrl: string }>(res);
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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

test("authorization matrix: stranger / guest / host", async () => {
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const guestMint = await json<{ token: string; identity: string; guestSecret: string; canPublish: boolean }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", role: "guest" }),
    }, env),
  );
  assert.equal(guestMint.canPublish, false);
  assert.match(guestMint.identity, /^g-/);
  const guestJwt = jwtPayload(guestMint.token);
  assert.equal(guestJwt.sub, guestMint.identity);
  assert.equal(guestJwt.video.canPublish, false);
  assert.equal(guestJwt.video.canPublishData, false);
  assert.equal(guestJwt.video.canUpdateOwnMetadata, false);
  assert.equal(guestJwt.video.roomAdmin, false);

  const hostMint = await json<{ token: string; identity: string }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Host", role: "host", hostKey }),
    }, env),
  );
  assert.equal(hostMint.identity, HOST_IDENTITY);
  const hostJwt = jwtPayload(hostMint.token);
  assert.equal(hostJwt.sub, HOST_IDENTITY);
  assert.equal(hostJwt.video.canPublish, true);
  assert.equal(hostJwt.video.roomAdmin, true);

  const rows: { name: string; who: "stranger" | "guest" | "host"; init: RequestInit; expect: number; check?: (body: unknown, status: number) => void }[] = [
    {
      name: "GET studio",
      who: "stranger",
      init: {},
      expect: 200,
      check: (body) => {
        const s = body as PublicStudio;
        const blob = JSON.stringify(s);
        assert.equal(blob.includes(YT), false);
        assert.equal(blob.includes("super-secret"), false);
        assert.equal(s.destinations[0]?.url, undefined);
        assert.equal(s.destinations[0]?.hasKey, true);
        assert.ok(s.destinations[0]?.urlMasked.startsWith("rtmp://"));
        assert.equal(s.egressId, null);
      },
    },
    {
      name: "GET studio",
      who: "guest",
      init: {},
      expect: 200,
      check: (body) => {
        assert.equal(JSON.stringify(body).includes(YT), false);
      },
    },
    {
      name: "GET studio",
      who: "host",
      init: { headers: { [HOST_KEY_HEADER]: hostKey } },
      expect: 200,
      check: (body) => {
        const s = body as PublicStudio;
        assert.equal(s.destinations.find((d) => d.id === "youtube")?.url, YT);
      },
    },
    {
      name: "POST live start",
      who: "stranger",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live: true }) },
      expect: 403,
    },
    {
      name: "POST live start",
      who: "guest",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live: true }) },
      expect: 403,
    },
    {
      name: "POST live stop",
      who: "stranger",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ live: false }) },
      expect: 403,
    },
    {
      name: "POST stage",
      who: "stranger",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: guestMint.identity, on: true }) },
      expect: 403,
    },
    {
      name: "POST stage",
      who: "guest",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: guestMint.identity, on: true }) },
      expect: 403,
    },
    {
      name: "POST layout",
      who: "guest",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: "solo" }) },
      expect: 403,
    },
    {
      name: "POST destinations",
      who: "guest",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinations: [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true, url: "rtmp://evil.example/live/stolen" }] }),
      },
      expect: 403,
    },
    {
      name: "POST banner",
      who: "stranger",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "pwned" }) },
      expect: 403,
    },
    {
      name: "POST token as host",
      who: "stranger",
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Nope", role: "host" }) },
      expect: 403,
    },
  ];

  const pathFor = (name: string) => {
    if (name.startsWith("GET studio")) return `https://casthop.test/api/studios/${id}`;
    if (name.startsWith("POST live")) return `https://casthop.test/api/studios/${id}/live`;
    if (name.startsWith("POST stage")) return `https://casthop.test/api/studios/${id}/stage`;
    if (name.startsWith("POST layout")) return `https://casthop.test/api/studios/${id}/layout`;
    if (name.startsWith("POST destinations")) return `https://casthop.test/api/studios/${id}/destinations`;
    if (name.startsWith("POST banner")) return `https://casthop.test/api/studios/${id}/banner`;
    if (name.startsWith("POST token")) return `https://casthop.test/api/studios/${id}/token`;
    throw new Error(name);
  };

  const startsBefore = egressStarts;
  for (const row of rows) {
    const res = await app.request(pathFor(row.name), row.init, env);
    assert.equal(res.status, row.expect, `${row.who} ${row.name} -> ${res.status} ${await res.clone().text()}`);
    if (row.check) row.check(await json(res), res.status);
  }
  assert.equal(egressStarts, startsBefore, "unauthenticated live must not start Egress");

  const hostLive = await app.request(`https://casthop.test/api/studios/${id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [HOST_KEY_HEADER]: hostKey },
    body: JSON.stringify({ hostKey, live: true }),
  }, env);
  assert.equal(hostLive.status, 200, await hostLive.clone().text());
  assert.equal(egressStarts, startsBefore + 1);
  const liveState = await json<PublicStudio>(hostLive);
  assert.equal(liveState.live, true);

  const hostStop = await app.request(`https://casthop.test/api/studios/${id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey, live: false }),
  }, env);
  assert.equal(hostStop.status, 200);
  assert.ok(egressStops >= 1);

  const hostStage = await app.request(`https://casthop.test/api/studios/${id}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey, identity: guestMint.identity, on: true }),
  }, env);
  assert.equal(hostStage.status, 200);
});

test("H1: guests cannot pick identity, impersonate host, or steal another guest", async () => {
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);

  const asHost = await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Guest", role: "host" }),
  }, env);
  assert.equal(asHost.status, 403);

  const spoofHost = await json<{ identity: string }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Guest", role: "guest", identity: HOST_IDENTITY }),
    }, env),
  );
  assert.notEqual(spoofHost.identity, HOST_IDENTITY);
  assert.match(spoofHost.identity, /^g-/);

  const spoofHostSecret = await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Guest", role: "guest", identity: HOST_IDENTITY, guestSecret: "nope" }),
  }, env);
  assert.equal(spoofHostSecret.status, 403);

  await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Host", role: "host", hostKey }),
  }, env);

  const first = await json<{ identity: string; guestSecret: string }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", role: "guest" }),
    }, env),
  );

  const steal = await json<{ identity: string }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mallory", role: "guest", identity: first.identity }),
    }, env),
  );
  assert.notEqual(steal.identity, first.identity);

  const badSecret = await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Mallory", role: "guest", identity: first.identity, guestSecret: "forged" }),
  }, env);
  assert.equal(badSecret.status, 403);

  const resume = await json<{ identity: string; canPublish: boolean }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", role: "guest", identity: first.identity, guestSecret: first.guestSecret }),
    }, env),
  );
  assert.equal(resume.identity, first.identity);
  assert.equal(resume.canPublish, false);

  await app.request(`https://casthop.test/api/studios/${id}/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey, identity: first.identity, on: true }),
  }, env);

  const onStage = await json<{ identity: string; canPublish: boolean }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", role: "guest", identity: first.identity, guestSecret: first.guestSecret }),
    }, env),
  );
  assert.equal(onStage.canPublish, true);
});

test("C2: live with a bad host key does not start or stop Egress", async () => {
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const beforeStart = egressStarts;
  const beforeStop = egressStops;
  const bad = await app.request(`https://casthop.test/api/studios/${id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey: "wrong", live: true }),
  }, env);
  assert.equal(bad.status, 403);
  assert.equal(egressStarts, beforeStart);

  const go = await app.request(`https://casthop.test/api/studios/${id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey, live: true }),
  }, env);
  assert.equal(go.status, 200);
  assert.equal(egressStarts, beforeStart + 1);

  const stopBad = await app.request(`https://casthop.test/api/studios/${id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey: "wrong", live: false }),
  }, env);
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
  const { id, hostKey } = await createStudio(env);
  const publicGet = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  const res = await app.request(`https://casthop.test/api/studios/${id}/destinations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostKey,
      destinations: publicGet.destinations.map((d) => ({ ...d, enabled: d.id !== "custom" })),
    }),
  }, env);
  assert.equal(res.status, 200, await res.clone().text());
  const saved = await json<PublicStudio>(res);
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.url, YT);
});

test("host can clear a destination url with an empty string", async () => {
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const publicGet = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, { headers: { [HOST_KEY_HEADER]: hostKey } }, env));
  const res = await app.request(`https://casthop.test/api/studios/${id}/destinations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostKey,
      destinations: publicGet.destinations.map((d) => (d.id === "youtube" ? { ...d, url: "" } : d)),
    }),
  }, env);
  assert.equal(res.status, 200, await res.clone().text());
  const saved = await json<PublicStudio>(res);
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.url, "");
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.hasKey, false);
});

test("chat requires host key or guest secret and uses the participant name", async () => {
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const stranger = await app.request(`https://casthop.test/api/studios/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Host", identity: "host", text: "pwned" }),
  }, env);
  assert.equal(stranger.status, 403);

  await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ada", role: "host", hostKey }),
  }, env);
  const guest = await json<{ identity: string; guestSecret: string }>(
    await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", role: "guest" }),
    }, env),
  );
  const spoof = await app.request(`https://casthop.test/api/studios/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: guest.identity, guestSecret: guest.guestSecret, name: "Host", text: "hi" }),
  }, env);
  assert.equal(spoof.status, 200, await spoof.clone().text());
  const body = await json<PublicStudio>(spoof);
  const last = body.chat.at(-1);
  assert.equal(last?.name, "Ada");
  assert.equal(last?.from, guest.identity);
  assert.equal(last?.text, "hi");

  const asHost = await app.request(`https://casthop.test/api/studios/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [HOST_KEY_HEADER]: hostKey },
    body: JSON.stringify({ text: "from host", name: "Nope" }),
  }, env);
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
  const { id, hostKey } = await createStudio(env);
  let lastStatus = 200;
  for (let i = 0; i < 21; i++) {
    const res = await app.request(`https://casthop.test/api/studios/${id}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `G${i}`, role: "guest" }),
    }, env);
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429);
  const host = await app.request(`https://casthop.test/api/studios/${id}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Host", role: "host", hostKey }),
  }, env);
  assert.equal(host.status, 200, await host.clone().text());
});
