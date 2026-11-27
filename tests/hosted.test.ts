import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, SESSION_COOKIE, bytesToB64Url } from "../worker/security.ts";
import type { Env } from "../worker/types.ts";
import { putLiveHlsFile, clipObjectKey, liveObjectKey } from "../worker/clips.ts";
import { isoChunkKey } from "../worker/iso.ts";
import { replayObjectKey } from "../worker/replays.ts";
import { EXTERNAL_TOKEN_MAX_TTL_SEC, parseKeyList, safeNextPath, serviceSignature } from "../worker/hosted.ts";
import { asTenantId, scopeStore, storeFor, tenantKeyPrefix } from "../worker/tenant.ts";
import { insertStudioRow } from "../worker/db.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeR2 } from "./fake-r2.ts";
import { hlsFiles, hlsPlaylist } from "./replay-fixture.ts";

const AUTH_SECRET = "a".repeat(40);
const OTHER_SECRET = "b".repeat(40);
const SERVICE_SECRET = "s".repeat(40);
const ISSUER = "https://control.example";
const ORIGIN = "https://casthop.test";

type TestEnv = Env & { _db: FakeD1; _r2: FakeR2; _stores: Map<string, Map<string, unknown>> };

function fakeCtx(store: Map<string, unknown>): DurableObjectState {
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      deleteAll: async () => {
        store.clear();
      },
      deleteAlarm: async () => undefined,
      setAlarm: async () => undefined,
    },
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
}

function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const rooms = new Map<string, StudioDurableObject>();
  const stores = new Map<string, Map<string, unknown>>();
  const db = new FakeD1();
  const r2 = new FakeR2();
  const env = {
    LIVEKIT_API_KEY: DEV_API_KEY,
    LIVEKIT_API_SECRET: DEV_API_SECRET,
    LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
    PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
    EGRESS_TEMPLATE_URL: "http://127.0.0.1:5173/egress-template",
    CASTHOP_ALLOW_DEV_KEYS: "1",
    CASTHOP_DEV: "1",
    CASTHOP_TRUST_FORWARDED: "1",
    PUBLIC_ORIGIN: ORIGIN,
    ASSETS: { fetch: async () => new Response("ok") },
    RECORDINGS: r2,
    DB: db,
    ...overrides,
  } as Env & { _db: FakeD1; _r2: FakeR2; _stores: Map<string, Map<string, unknown>> };
  env._db = db;
  env._r2 = r2;
  env._stores = stores;
  env.STUDIO = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      let room = rooms.get(name);
      if (!room) {
        const store = new Map<string, unknown>();
        stores.set(name, store);
        room = new StudioDurableObject(fakeCtx(store), env);
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

function hostedEnv(overrides: Partial<Env> = {}): TestEnv {
  return makeEnv({
    CASTHOP_EXTERNAL_AUTH_KEYS: `k1:${AUTH_SECRET}`,
    CASTHOP_EXTERNAL_AUTH_ISSUER: ISSUER,
    CASTHOP_SERVICE_KEYS: `svc1:${SERVICE_SECRET}`,
    ...overrides,
  });
}

const enc = (value: unknown) => bytesToB64Url(new TextEncoder().encode(JSON.stringify(value)));

async function makeToken(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; header?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", kid: "k1", ...opts.header };
  const payload = {
    iss: ISSUER,
    aud: "casthop",
    sub: "user-1",
    email: "ada@example.com",
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
    ...claims,
  };
  const body = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(opts.secret ?? AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${bytesToB64Url(sig)}`;
}

async function external(env: Env, token: string, next?: string): Promise<Response> {
  const q = new URLSearchParams({ token });
  if (next !== undefined) q.set("next", next);
  return app.request(`${ORIGIN}/api/auth/external?${q}`, { redirect: "manual" }, env);
}

function sessionCookie(res: Response): string {
  const hit = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return hit ? hit.split(";")[0]! : "";
}

async function signedFetch(
  env: Env,
  method: string,
  target: string,
  body = "",
  over: { secret?: string; kid?: string; timestamp?: number; nonce?: string; signature?: string } = {},
): Promise<Response> {
  const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = over.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const signature =
    over.signature ??
    (await serviceSignature(over.secret ?? SERVICE_SECRET, { timestamp, nonce, method, target, body: new TextEncoder().encode(body).buffer }));
  return app.request(
    `${ORIGIN}${target}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Casthop-Key-Id": over.kid ?? "svc1",
        "X-Casthop-Timestamp": timestamp,
        "X-Casthop-Nonce": nonce,
        "X-Casthop-Signature": signature,
      },
      body: method === "GET" || method === "DELETE" ? undefined : body,
    },
    env,
  );
}

async function createTenantStudio(env: Env, tenantId: string, ownerEmail = "owner@example.com") {
  const res = await signedFetch(env, "POST", "/api/service/studios", JSON.stringify({ tenantId, ownerEmail, name: "Show" }));
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { studio: { id: string; name: string; tenantId: string; ownerId: string } }).studio;
}

async function ownerCookie(env: Env, email: string): Promise<string> {
  const res = await external(env, await makeToken({ email }));
  assert.equal(res.status, 302);
  return sessionCookie(res);
}

async function ingest(env: Env, cookie: string, studioId: string): Promise<{ id: string }> {
  const payload = JSON.stringify({ title: "Cut", visibility: "private", files: hlsFiles() });
  const res = await app.request(
    `${ORIGIN}/api/studios/${studioId}/replays`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "Content-Length": String(new TextEncoder().encode(payload).byteLength) },
      body: payload,
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { id: string };
}

async function r2Keys(r2: FakeR2): Promise<string[]> {
  return (await r2.list()).objects.map((o) => o.key);
}

// --- everything off -------------------------------------------------------

test("all hooks off: external auth and service routes are 404, config says default", async () => {
  const env = makeEnv();
  const token = await makeToken();
  assert.equal((await external(env, token)).status, 404);
  assert.equal((await signedFetch(env, "GET", "/api/service/tenants/acme/studios")).status, 404);
  const res = await app.request(`${ORIGIN}/api/service/studios`, { method: "POST", body: "{}" }, env);
  assert.equal(res.status, 404);
  const cfg = (await (await app.request(`${ORIGIN}/api/config`, {}, env)).json()) as { signin: string; github: boolean };
  assert.equal(cfg.signin, "default");
  assert.equal(cfg.github, false);
});

test("external keys without an issuer keep the route off", async () => {
  const env = makeEnv({ CASTHOP_EXTERNAL_AUTH_KEYS: `k1:${AUTH_SECRET}` });
  assert.equal((await external(env, await makeToken())).status, 404);
});

test("short secrets do not enable a hook", async () => {
  assert.equal(parseKeyList("k1:short"), null);
  assert.equal(parseKeyList(undefined), null);
  assert.deepEqual([...(parseKeyList(`a:${AUTH_SECRET}, b:${OTHER_SECRET},bad`) ?? [])].map(([k]) => k), ["a", "b"]);
  const env = makeEnv({ CASTHOP_SERVICE_KEYS: "svc1:short" });
  assert.equal((await signedFetch(env, "GET", "/api/service/tenants/acme/studios")).status, 404);
});

test("studios without a tenant keep today's R2 keys", async () => {
  const env = hostedEnv();
  const cookie = await ownerCookie(env, "plain@example.com");
  const created = await app.request(`${ORIGIN}/api/studios`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ title: "Plain" }) }, env);
  const { id } = (await created.json()) as { id: string };
  const replay = await ingest(env, cookie, id);
  const keys = await r2Keys(env._r2);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(key.startsWith(`replays/${id}/${replay.id}/`), key);
  assert.equal(tenantKeyPrefix(null), "");
});

// --- tenant ids and prefix ------------------------------------------------

test("tenant id format", () => {
  for (const ok of ["a", "acme", "acme-1", "a_b", "0abc", "a".repeat(63)]) assert.equal(asTenantId(ok), ok);
  for (const bad of ["", "-a", "_a", "A", "a b", "a/b", "a.b", "a".repeat(64), "..", 5, null, undefined]) assert.equal(asTenantId(bad), null, String(bad));
});

test("tenant studio writes every R2 key under t/<tenant>/", async () => {
  const env = hostedEnv();
  const studio = await createTenantStudio(env, "acme", "t1@example.com");
  const cookie = await ownerCookie(env, "t1@example.com");
  const replay = await ingest(env, cookie, studio.id);
  const store = await storeFor(env, studio.id);
  await putLiveHlsFile(store, studio.id, "index.m3u8", new TextEncoder().encode(hlsPlaylist(2)));
  await store.RECORDINGS.put(clipObjectKey(studio.id, "c1", "index.m3u8"), "x");
  await store.RECORDINGS.put(isoChunkKey(studio.id, "tr1", 0), "x");
  const keys = await r2Keys(env._r2);
  assert.ok(keys.length >= 6);
  for (const key of keys) assert.ok(key.startsWith("t/acme/"), key);
  assert.ok(keys.includes(`t/acme/${replayObjectKey(studio.id, replay.id, "index.m3u8")}`));
  assert.ok(keys.includes(`t/acme/${liveObjectKey(studio.id, "index.m3u8")}`));
  // Reads go through the same prefix.
  const served = await app.request(`${ORIGIN}/api/replays/${replay.id}/hls/index.m3u8`, { headers: { Cookie: cookie } }, env);
  assert.equal(served.status, 200);
});

test("scoped store hides the prefix from list results", async () => {
  const r2 = new FakeR2();
  const scoped = scopeStore(r2, "acme");
  await scoped.put("live/s1/a", "1");
  await r2.put("live/s1/other-tenant-less", "2");
  const page = await scoped.list({ prefix: "live/s1/" });
  assert.deepEqual(page.objects.map((o) => o.key), ["live/s1/a"]);
  await scoped.delete(["live/s1/a"]);
  assert.deepEqual(await r2Keys(r2), ["live/s1/other-tenant-less"]);
});

// --- external auth --------------------------------------------------------

test("external token signs in, sets the session cookie and redirects", async () => {
  const env = hostedEnv();
  const res = await external(env, await makeToken({ name: "Ada Lovelace" }), "/studio/abc?x=1");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/studio/abc?x=1");
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  const me = await app.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: sessionCookie(res) } }, env);
  assert.equal(me.status, 200);
  const body = (await me.json()) as { email: string; name: string };
  assert.equal(body.email, "ada@example.com");
  assert.equal(body.name, "Ada Lovelace");
});

test("external token sign-in does not grant co-host until the invite is accepted", async () => {
  const env = hostedEnv();
  const studio = await createTenantStudio(env, "acme", "boss@example.com");
  const bossCookie = await ownerCookie(env, "boss@example.com");
  const invite = await app.request(
    `${ORIGIN}/api/studios/${studio.id}/cohosts`,
    { method: "POST", headers: { "Content-Type": "application/json", Cookie: bossCookie }, body: JSON.stringify({ email: "guest@example.com" }) },
    env,
  );
  assert.equal(invite.status, 200);
  const cookie = await ownerCookie(env, "guest@example.com");
  const before = await app.request(`${ORIGIN}/api/studios/${studio.id}/cohosts`, { headers: { Cookie: cookie } }, env);
  assert.notEqual(before.status, 200);
  const accept = await app.request(`${ORIGIN}/api/studios/${studio.id}/cohosts/accept`, { method: "POST", headers: { Cookie: cookie } }, env);
  assert.equal(accept.status, 200);
  const after = await app.request(`${ORIGIN}/api/studios/${studio.id}/cohosts`, { headers: { Cookie: cookie } }, env);
  assert.equal(after.status, 200);
});

test("external token without next goes home", async () => {
  const res = await external(hostedEnv(), await makeToken());
  assert.equal(res.headers.get("location"), "/");
});

test("external token rejects bad input", async () => {
  const env = hostedEnv({ CASTHOP_EXTERNAL_AUTH_KEYS: `k1:${AUTH_SECRET},k2:${OTHER_SECRET}` });
  const now = Math.floor(Date.now() / 1000);
  const good = await makeToken();
  const [h, p, s] = good.split(".");
  const cases: [string, string][] = [
    ["bad signature", `${h}.${p}.${s!.slice(0, -2)}AA`],
    ["tampered payload", `${h}.${enc({ iss: ISSUER, aud: "casthop", sub: "x", email: "evil@example.com", iat: now, exp: now + 60, jti: "z" })}.${s}`],
    ["wrong secret for kid", await makeToken({}, { secret: OTHER_SECRET })],
    ["unknown kid", await makeToken({}, { header: { kid: "nope" } })],
    ["alg none", await makeToken({}, { header: { alg: "none" } })],
    ["alg HS512", await makeToken({}, { header: { alg: "HS512" } })],
    ["no kid", await makeToken({}, { header: { kid: undefined } })],
    ["expired", await makeToken({ exp: now - 1 })],
    // Margin over the limit: the Worker reads its clock later, maybe a second later.
    ["exp too far", await makeToken({ exp: now + EXTERNAL_TOKEN_MAX_TTL_SEC + 30 })],
    ["wrong aud", await makeToken({ aud: "other" })],
    ["wrong iss", await makeToken({ iss: "https://evil.example" })],
    ["no sub", await makeToken({ sub: undefined })],
    ["bad email", await makeToken({ email: "nope" })],
    ["no jti", await makeToken({ jti: undefined })],
    ["long jti", await makeToken({ jti: "j".repeat(129) })],
    ["no iat", await makeToken({ iat: undefined })],
    ["bad tenant", await makeToken({ tenant: "Bad Tenant" })],
    ["garbage", "not-a-jwt"],
    ["empty", ""],
  ];
  for (const [name, token] of cases) {
    const res = await external(env, token);
    assert.equal(res.status, 401, name);
    assert.equal(sessionCookie(res), "", name);
  }
  assert.equal(env._db.rows("sessions").length, 0);
  // Second configured kid works.
  assert.equal((await external(env, await makeToken({}, { secret: OTHER_SECRET, header: { kid: "k2" } }))).status, 302);
});

test("external token jti is one-time", async () => {
  const env = hostedEnv();
  const token = await makeToken({ jti: "once" });
  assert.equal((await external(env, token)).status, 302);
  const again = await external(env, token);
  assert.equal(again.status, 401);
  assert.equal(sessionCookie(again), "");
});

test("external token prunes expired jti rows", async () => {
  const env = hostedEnv();
  env._db.rows("used_jtis").push({ jti: "old", exp: 1 });
  assert.equal((await external(env, await makeToken())).status, 302);
  assert.ok(!env._db.rows("used_jtis").some((r) => r.jti === "old"));
});

test("external next never leaves the origin", async () => {
  const env = hostedEnv();
  for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "evil", "/a\\b", "/\r\nSet-Cookie: x=1", "http://evil.example/"]) {
    const res = await external(env, await makeToken(), next);
    assert.equal(res.status, 302, next);
    assert.equal(res.headers.get("location"), "/", next);
  }
  assert.equal(safeNextPath("/ok?a=b#c"), "/ok?a=b#c");
  assert.equal(safeNextPath(undefined), "/");
});

test("external auth is rate limited per IP", async () => {
  const env = hostedEnv();
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await external(env, "junk")).status;
  assert.equal(last, 429);
});

// --- CASTHOP_SIGNIN=external ----------------------------------------------

test("CASTHOP_SIGNIN=external blocks magic-link and GitHub, keeps sessions", async () => {
  const env = hostedEnv({ CASTHOP_SIGNIN: "external", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
  const calls: [string, string, RequestInit][] = [
    ["POST", "/api/auth/magic-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }) }],
    ["GET", "/api/auth/callback?token=abc", {}],
    ["POST", "/api/auth/callback?token=abc", { method: "POST" }],
    ["GET", "/api/auth/github", { redirect: "manual" }],
    ["GET", "/api/auth/github/callback?code=1&state=2", { redirect: "manual" }],
  ];
  for (const [method, path, init] of calls) {
    const res = await app.request(`${ORIGIN}${path}`, init, env);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: "signin_external" });
  }
  assert.equal(env._db.rows("magic_links").length, 0);
  const cfg = (await (await app.request(`${ORIGIN}/api/config`, {}, env)).json()) as { signin: string; github: boolean };
  assert.equal(cfg.signin, "external");
  assert.equal(cfg.github, true);
  // Handoff, an existing session and guest join still work.
  const signed = await external(env, await makeToken());
  assert.equal(signed.status, 302);
  const me = await app.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: sessionCookie(signed) } }, env);
  assert.equal(me.status, 200);
  const studio = await createTenantStudio(env, "acme");
  const guest = await app.request(`${ORIGIN}/api/studios/${studio.id}`, {}, env);
  assert.equal(guest.status, 200);
});

test("CASTHOP_SIGNIN=external rejects tenantless studio creation", async () => {
  const env = hostedEnv({ CASTHOP_SIGNIN: "external" });
  const signed = await external(env, await makeToken());
  const before = env._db.rows("studios").length;
  const res = await app.request(
    `${ORIGIN}/api/studios`,
    { method: "POST", headers: { Cookie: sessionCookie(signed), "Content-Type": "application/json" }, body: "{}" },
    env,
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "signin_external" });
  assert.equal(env._db.rows("studios").length, before);
});

// --- service API ----------------------------------------------------------

test("service API rejects bad signatures, stale timestamps and reused nonces", async () => {
  const env = hostedEnv();
  const path = "/api/service/tenants/acme/studios";
  const now = Math.floor(Date.now() / 1000);
  const unsigned = await app.request(`${ORIGIN}${path}`, {}, env);
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "bad_signature" });
  assert.equal((await signedFetch(env, "GET", path, "", { signature: "0".repeat(64) })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { secret: OTHER_SECRET })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { kid: "nope" })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { timestamp: now - 301 })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { timestamp: now + 301 })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { nonce: "short" })).status, 401);
  assert.equal((await signedFetch(env, "GET", path, "", { timestamp: now - 299 })).status, 200);
  const nonce = "n".repeat(20);
  assert.equal((await signedFetch(env, "GET", path, "", { nonce })).status, 200);
  assert.equal((await signedFetch(env, "GET", path, "", { nonce })).status, 401);
});

test("service signature covers the query, method and body", async () => {
  const env = hostedEnv();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "q".repeat(20);
  const sig = await serviceSignature(SERVICE_SECRET, { timestamp, nonce, method: "GET", target: "/api/service/tenants/acme/studios", body: new ArrayBuffer(0) });
  const res = await app.request(
    `${ORIGIN}/api/service/tenants/other/studios`,
    { headers: { "X-Casthop-Key-Id": "svc1", "X-Casthop-Timestamp": timestamp, "X-Casthop-Nonce": nonce, "X-Casthop-Signature": sig } },
    env,
  );
  assert.equal(res.status, 401);
  const tampered = await signedFetch(env, "POST", "/api/service/studios", '{"tenantId":"acme","ownerEmail":"a@example.com"}', {
    signature: await serviceSignature(SERVICE_SECRET, { timestamp, nonce: "r".repeat(20), method: "POST", target: "/api/service/studios", body: new TextEncoder().encode("{}").buffer }),
    nonce: "r".repeat(20),
    timestamp: Number(timestamp),
  });
  assert.equal(tampered.status, 401);
});

test("insertStudioRow sets the tenant in the same insert", async () => {
  const env = hostedEnv();
  await insertStudioRow(env.DB, "t1", "Show", 1, "acct", "acme");
  await insertStudioRow(env.DB, "t2", "Plain", 2, "acct");
  assert.equal(env._db.rows("studios").find((r) => r.id === "t1")?.tenant_id, "acme");
  assert.equal(env._db.rows("studios").find((r) => r.id === "t2")?.tenant_id, null);
});

test("service API creates and lists studios for a tenant", async () => {
  const env = hostedEnv();
  const studio = await createTenantStudio(env, "acme", "Owner@Example.com");
  assert.equal(studio.name, "Show");
  assert.equal(studio.tenantId, "acme");
  const account = env._db.rows("accounts").find((r) => r.email === "owner@example.com");
  assert.equal(account?.id, studio.ownerId);
  assert.ok(env._db.rows("studio_members").some((m) => m.studio_id === studio.id && m.account_id === studio.ownerId && m.role === "owner"));
  assert.equal(env._db.rows("studios").find((r) => r.id === studio.id)?.tenant_id, "acme");
  await createTenantStudio(env, "other", "o2@example.com");
  const listed = await signedFetch(env, "GET", "/api/service/tenants/acme/studios");
  assert.equal(listed.status, 200);
  const body = (await listed.json()) as { studios: { id: string; name: string; ownerId: string; createdAt: number }[] };
  assert.deepEqual(body.studios.map((s) => s.id), [studio.id]);
  assert.equal(body.studios[0]?.ownerId, studio.ownerId);
  assert.equal(typeof body.studios[0]?.createdAt, "number");
  // The owner reaches the studio as a normal host.
  const cookie = await ownerCookie(env, "owner@example.com");
  assert.equal((await app.request(`${ORIGIN}/api/studios/${studio.id}`, { headers: { Cookie: cookie } }, env)).status, 200);
});

test("service API validates studio input", async () => {
  const env = hostedEnv();
  for (const body of [{ ownerEmail: "a@example.com" }, { tenantId: "Bad Id", ownerEmail: "a@example.com" }, { tenantId: "acme", ownerEmail: "nope" }, {}]) {
    assert.equal((await signedFetch(env, "POST", "/api/service/studios", JSON.stringify(body))).status, 400, JSON.stringify(body));
  }
  assert.equal((await signedFetch(env, "POST", "/api/service/studios", "not json")).status, 400);
  assert.equal(env._db.rows("studios").length, 0);
});

async function seedStudioData(env: TestEnv, tenantId: string, email: string) {
  const studio = await createTenantStudio(env, tenantId, email);
  const cookie = await ownerCookie(env, email);
  await ingest(env, cookie, studio.id);
  const store = await storeFor(env, studio.id);
  await store.RECORDINGS.put(isoChunkKey(studio.id, "tr1", 0), "x");
  await store.RECORDINGS.put(clipObjectKey(studio.id, "c1", "index.m3u8"), "x");
  await store.RECORDINGS.put(liveObjectKey(studio.id, "index.m3u8"), "x");
  await env._db.prepare("INSERT INTO studio_invites (id, studio_id, email, created_at) VALUES (?, ?, ?, ?)").bind("i1", studio.id, "x@example.com", 1).run();
  return studio;
}

test("service API deletes a studio: Durable Object, D1 rows and R2 objects, not accounts", async () => {
  const env = hostedEnv();
  const doomed = await seedStudioData(env, "acme", "a@example.com");
  const kept = await seedStudioData(env, "acme", "b@example.com");
  assert.ok((env._stores.get(doomed.id)?.size ?? 0) > 0);
  const res = await signedFetch(env, "DELETE", `/api/service/studios/${doomed.id}?tenantId=acme`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  assert.equal(env._stores.get(doomed.id)?.size, 0);
  for (const table of ["studios", "studio_members", "studio_invites", "replays"]) {
    assert.ok(!env._db.rows(table).some((r) => (r.studio_id ?? r.id) === doomed.id), table);
  }
  const keys = await r2Keys(env._r2);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(!key.includes(`/${doomed.id}/`), key);
  assert.ok(keys.some((k) => k.includes(`/${kept.id}/`)));
  assert.ok(env._db.rows("accounts").some((a) => a.email === "a@example.com"));
  assert.ok(env._db.rows("studios").some((r) => r.id === kept.id));
});

test("service API will not delete a studio across tenants", async () => {
  const env = hostedEnv();
  const studio = await seedStudioData(env, "acme", "a@example.com");
  const before = await r2Keys(env._r2);
  assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/${studio.id}?tenantId=other`)).status, 404);
  assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/nope?tenantId=acme`)).status, 404);
  assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/${studio.id}`)).status, 400);
  assert.ok(env._db.rows("studios").some((r) => r.id === studio.id));
  assert.deepEqual(await r2Keys(env._r2), before);
});

test("service API does not delete a studio that has no tenant", async () => {
  const env = hostedEnv();
  const cookie = await ownerCookie(env, "plain@example.com");
  const created = await app.request(`${ORIGIN}/api/studios`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" }, env);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/${id}?tenantId=acme`)).status, 404);
  assert.ok(env._db.rows("studios").some((r) => r.id === id));
});

test("service API deletes a tenant and everything under its R2 prefix", async () => {
  const env = hostedEnv();
  const a = await seedStudioData(env, "acme", "a@example.com");
  const b = await seedStudioData(env, "acme", "b@example.com");
  const other = await seedStudioData(env, "other", "c@example.com");
  await env._r2.put("t/acme/stray/object", "x");
  // More than one list page.
  for (let i = 0; i < 1100; i++) await env._r2.put(`t/acme/bulk/${String(i).padStart(5, "0")}`, "x");
  const res = await signedFetch(env, "DELETE", "/api/service/tenants/acme");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2 });
  const keys = await r2Keys(env._r2);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(key.startsWith("t/other/"), key);
  for (const id of [a.id, b.id]) {
    assert.ok(!env._db.rows("studios").some((r) => r.id === id));
    assert.equal(env._stores.get(id)?.size, 0);
  }
  assert.ok(env._db.rows("studios").some((r) => r.id === other.id));
  const listed = await signedFetch(env, "GET", "/api/service/tenants/acme/studios");
  assert.deepEqual(await listed.json(), { studios: [] });
  assert.ok(env._db.rows("accounts").some((r) => r.email === "a@example.com"));
});

test("only the Worker can reach the Durable Object destroy action", async () => {
  const env = hostedEnv();
  const studio = await createTenantStudio(env, "acme");
  const stub = env.STUDIO.get(env.STUDIO.idFromName(studio.id));
  const res = await stub.fetch(`https://studio/${studio.id}?action=destroy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostKey: "guess" }),
  });
  assert.equal(res.status, 403);
  assert.ok((env._stores.get(studio.id)?.size ?? 0) > 0);
});

const realFetch = globalThis.fetch;
let egressLists = 0;
let livekitDown = false;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/twirp/")) return realFetch(input, init);
    if (livekitDown) throw new Error("livekit down");
    if (url.includes("ListEgress")) egressLists += 1;
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("deleting a studio asks LiveKit to end egress and still deletes when LiveKit is down", async () => {
  const env = hostedEnv();
  const first = await createTenantStudio(env, "acme", "a@example.com");
  const listsBefore = egressLists;
  assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/${first.id}?tenantId=acme`)).status, 200);
  assert.ok(egressLists > listsBefore);
  const second = await createTenantStudio(env, "acme", "b@example.com");
  livekitDown = true;
  try {
    assert.equal((await signedFetch(env, "DELETE", `/api/service/studios/${second.id}?tenantId=acme`)).status, 200);
  } finally {
    livekitDown = false;
  }
  assert.ok(!env._db.rows("studios").some((r) => r.id === second.id));
});

test("service routes need a signature even for signed-in users", async () => {
  const env = hostedEnv();
  const cookie = await ownerCookie(env, "owner@example.com");
  const res = await app.request(`${ORIGIN}/api/service/tenants/acme/studios`, { headers: { Cookie: cookie } }, env);
  assert.equal(res.status, 401);
});
