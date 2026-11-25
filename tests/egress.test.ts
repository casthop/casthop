import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, HOST_KEY_HEADER } from "../worker/security.ts";
import { mintApiToken, signLivekitWebhook } from "../worker/livekit.ts";
import {
  applyStreamResults,
  livePhaseOf,
  nextBackoffMs,
  parseEgressInfo,
  parseEgressList,
  publicError,
  studioHasPeople,
} from "../worker/egress.ts";
import type { Destination, Env, PublicStudio, StudioState } from "../worker/types.ts";

const YT = "rtmp://ingest.example.com/live/super-secret-youtube-key";
const LI = "rtmp://ingest.example.com/live/super-secret-linkedin-key";
const X = "rtmp://ingest.example.com/live/super-secret-x-key";

let egressStarts = 0;
let egressStops = 0;
let streamUpdates = 0;
let listedParticipants: { identity: string }[] = [{ identity: "host" }];
let listedEgress: unknown = { items: [] };
const realFetch = globalThis.fetch;

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
    CASTHOP_EMPTY_GRACE_MS: "0",
    CASTHOP_BACKOFF_MS: "0",
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
  const res = await app.request(
    "https://casthop.test/api/studios",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Weekly product update" }),
    },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  return json<{ id: string; hostKey: string }>(res);
}

function liveHeaders(hostKey: string): HeadersInit {
  return { "Content-Type": "application/json", [HOST_KEY_HEADER]: hostKey };
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("StartRoomCompositeEgress")) {
      egressStarts += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream_outputs?: { urls?: string[] }[] };
      assert.ok((body.stream_outputs?.[0]?.urls?.length ?? 0) >= 1, "fan-out must send RTMP urls");
      return new Response(JSON.stringify({ egress_id: `eg_${egressStarts}` }), { status: 200 });
    }
    if (url.includes("StopEgress")) {
      egressStops += 1;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("UpdateStream")) {
      streamUpdates += 1;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("ListEgress")) {
      return new Response(JSON.stringify(listedEgress), { status: 200 });
    }
    if (url.includes("ListParticipants")) {
      return new Response(JSON.stringify({ participants: listedParticipants }), { status: 200 });
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

test("LiveKit API token for a room is roomAdmin on that room", async () => {
  const token = await mintApiToken(makeEnv(), "studio-room");
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
    video: { roomAdmin?: boolean; room?: string; roomRecord?: boolean };
  };
  assert.equal(payload.video.roomAdmin, true);
  assert.equal(payload.video.roomRecord, true);
  assert.equal(payload.video.room, "studio-room");
});

test("nextBackoffMs doubles then caps at 30s", () => {
  assert.equal(nextBackoffMs(0), 1_000);
  assert.equal(nextBackoffMs(1), 2_000);
  assert.equal(nextBackoffMs(5), 30_000);
  assert.equal(nextBackoffMs(20), 30_000);
});

test("publicError strips RTMP URLs", () => {
  assert.equal(publicError(`failed ${YT}`), "failed rtmp://…");
  assert.equal(publicError(""), null);
});

test("parseEgressInfo reads camelCase and snake_case stream results", () => {
  const info = parseEgressInfo({
    egress_id: "EG_1",
    room_name: "abc",
    status: "EGRESS_ACTIVE",
    stream_results: [{ url: YT, status: "FAILED", error: "connection reset" }],
  });
  assert.ok(info);
  assert.equal(info.egressId, "EG_1");
  assert.equal(info.status, "active");
  assert.equal(info.streams[0]?.status, "failed");
  assert.equal(parseEgressList({ items: [{ egressId: "EG_2", status: 4 }] })[0]?.status, "failed");
});

test("applyStreamResults sets per-destination status without exposing urls", () => {
  const dests: Destination[] = [
    { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: YT, enabled: true, status: "connecting", error: null },
    { id: "linkedin", kind: "linkedin", label: "LinkedIn", detail: "", url: LI, enabled: true, status: "connecting", error: null },
  ];
  const retry = applyStreamResults(
    dests,
    [
      { url: YT, status: "active", error: "" },
      { url: LI, status: "failed", error: `timeout ${LI}` },
    ],
    true,
  );
  assert.equal(retry, true);
  assert.equal(dests[0]?.status, "live");
  assert.equal(dests[1]?.status, "retrying");
  assert.equal(dests[1]?.error?.includes("super-secret"), false);
});

test("livePhaseOf maps host intent vs compositor health", () => {
  const base = {
    wantLive: true,
    live: false,
    egressId: null,
    liveStartingAt: undefined,
  } as StudioState;
  assert.equal(livePhaseOf({ ...base, wantLive: false, live: false, egressId: null }), "idle");
  assert.equal(livePhaseOf({ ...base, live: true, egressId: "eg" }), "live");
  assert.equal(livePhaseOf({ ...base, wantLive: false, live: true, egressId: "eg" }), "stopping");
  assert.equal(livePhaseOf(base), "retrying");
});

test("studioHasPeople ignores compositor identities", () => {
  assert.equal(studioHasPeople(["host"]), true);
  assert.equal(studioHasPeople(["EG_abc", "egress-chrome"]), false);
  assert.equal(studioHasPeople([]), false);
});

test("go live fans out enabled destinations and stop tears down egress", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const starts = egressStarts;
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, starts + 1);
  const live = await json<PublicStudio>(go);
  assert.equal(live.live, true);
  assert.equal(live.livePhase, "live");
  assert.equal(live.destinations.filter((d) => d.enabled).every((d) => d.status === "connecting" || d.status === "live"), true);

  const guest = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  assert.equal(JSON.stringify(guest).includes("super-secret"), false);
  assert.equal(guest.destinations[0]?.status, "connecting");

  const stop = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: false }) },
    env,
  );
  assert.equal(stop.status, 200);
  assert.ok(egressStops >= 1);
  const ended = await json<PublicStudio>(stop);
  assert.equal(ended.live, false);
  assert.equal(ended.livePhase, "idle");
});

test("unsigned webhook is 401; signed egress_ended retries start", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.ok(started.egressId);
  const starts = egressStarts;

  const unsigned = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { "Content-Type": "application/webhook+json" }, body: "{}" },
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.equal(egressStarts, starts);

  const body = JSON.stringify({
    event: "egress_ended",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_FAILED",
      error: "chrome crashed",
    },
  });
  const token = await signLivekitWebhook(env, body);
  const ended = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: token, "Content-Type": "application/webhook+json" }, body },
    env,
  );
  assert.equal(ended.status, 200, await ended.clone().text());
  const after = await json<PublicStudio>(ended);
  assert.equal(after.live, false);
  assert.equal(after.livePhase, "retrying");
  assert.equal(JSON.stringify(after).includes("super-secret"), false);

  listedEgress = { items: [] };
  const viaWorker = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(
    new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }),
  );
  assert.equal(viaWorker.status, 200, await viaWorker.clone().text());
  assert.ok(egressStarts > starts);
});

test("late egress_ended for a previous compositor does not retry the live one", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const current = started.egressId;
  assert.ok(current);
  const starts = egressStarts;
  const body = JSON.stringify({
    event: "egress_ended",
    egressInfo: {
      egressId: "EG_stale",
      roomName: id,
      status: "EGRESS_FAILED",
      error: "chrome crashed",
    },
  });
  const token = await signLivekitWebhook(env, body);
  const res = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: token, "Content-Type": "application/webhook+json" }, body },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const snap = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(hostKey) }, env),
  );
  assert.equal(snap.live, true);
  assert.equal(snap.livePhase, "live");
  assert.equal(snap.egressId, current);
  assert.equal(egressStarts, starts);
});

test("egress_updated marks a dropped RTMP destination and reattaches it", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const before = streamUpdates;
  const body = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: YT, status: "ACTIVE" },
        { url: LI, status: "FAILED", error: "broken pipe" },
        { url: X, status: "ACTIVE" },
      ],
    },
  });
  const token = await signLivekitWebhook(env, body);
  const res = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const state = await json<PublicStudio>(res);
  assert.equal(state.live, true);
  assert.equal(state.destinations.find((d) => d.id === "youtube")?.status, "live");
  assert.equal(state.destinations.find((d) => d.id === "linkedin")?.status, "retrying");
  assert.ok(streamUpdates > before);
});

test("empty LiveKit room stops stale egress after grace", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
    env,
  );
  const stops = egressStops;
  listedParticipants = [{ identity: "EG_compositor" }];
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const second = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const state = await json<PublicStudio>(second);
  assert.equal(state.live, false);
  assert.equal(state.livePhase, "idle");
  assert.equal(state.liveError, "Studio empty");
  assert.ok(egressStops > stops);
});

test("toggling a destination while live calls UpdateStream", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, hostKey } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const egressId = started.egressId;
  assert.ok(egressId);
  const before = streamUpdates;
  const next = started.destinations.map((d) => (d.id === "x" ? { ...d, enabled: false } : d));
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    { method: "POST", headers: liveHeaders(hostKey), body: JSON.stringify({ hostKey, destinations: next }) },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(streamUpdates > before);
});
