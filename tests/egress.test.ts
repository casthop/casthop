import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { app, StudioDurableObject } from "../worker/index.ts";
import { DEV_API_KEY, DEV_API_SECRET, SESSION_COOKIE } from "../worker/security.ts";
import { FakeD1 } from "./fake-d1.ts";
import { FakeR2 } from "./fake-r2.ts";
import { mintApiToken, mintParticipantToken, PORTRAIT_LAYOUT, PORTRAIT_PRESET, signLivekitWebhook, startRoomComposite } from "../worker/livekit.ts";
import {
  applyStreamResults,
  destsForAspect,
  beginPortraitRecovery,
  beginRecovery,
  egressIsProducing,
  egressOutputStarted,
  egressTimeMs,
  failedStreamUrls,
  heartbeatLost,
  isForeignEgress,
  livePhaseOf,
  outputPhase,
  MAX_STREAM_RETRIES,
  nextBackoffMs,
  parseEgressInfo,
  parseEgressList,
  pickActiveEgress,
  portraitRecoveryTimedOut,
  publicError,
  remainingRecoveryMs,
  redactStreamKey,
  startEgressTimeoutMs,
  streamOutputStarted,
  studioHasPeople,
  nextWatchMs,
  OUTPUT_SETTLE_MS,
} from "../worker/egress.ts";
import { destAspectOf, type Destination, type Env, type PublicStudio, type StudioState } from "../worker/types.ts";

const YT = "rtmp://127.0.0.1:1935/live/super-secret-youtube-key";
const LI = "rtmp://127.0.0.1:1935/live/super-secret-linkedin-key";
const X = "rtmp://127.0.0.1:1935/live/super-secret-x-key";

let egressStarts = 0;
let egressStops = 0;
let streamUpdates = 0;
const startBodies: Record<string, unknown>[] = [];
let listedParticipants: { identity: string }[] = [{ identity: "host" }];
let listedEgress: unknown = { items: [] };
let listEgressHold: Promise<void> | null = null;
let listEgressStarted: (() => void) | null = null;
let holdNextListEgress = false;
let listEgressFail = false;
let startRoomCompositeFail = false;
let startPortraitRoomCompositeFail = false;
let updateStreamHold: Promise<void> | null = null;
let updateStreamStarted: (() => void) | null = null;
let holdNextUpdateStream = false;
let stopEgressStatus = 200;
let startRoomCompositeHold: Promise<void> | null = null;
let startRoomCompositeStarted: (() => void) | null = null;
let holdNextStartRoomComposite = false;
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
    CASTHOP_EMPTY_GRACE_MS: "0",
    CASTHOP_BACKOFF_MS: "0",
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

function liveHeaders(cookie: string): HeadersInit {
  return { "Content-Type": "application/json", Cookie: cookie };
}

async function postEgressBeat(env: Env, id: string, identity: string, egressId: string) {
  const token = await mintParticipantToken({
    env,
    identity,
    name: "egress",
    room: id,
    canPublish: false,
  });
  return app.request(
    `https://casthop.test/api/studios/${id}/egress-beat`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ egressId }),
    },
    env,
  );
}

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("StartRoomCompositeEgress")) {
      egressStarts += 1;
      startRoomCompositeStarted?.();
      if (holdNextStartRoomComposite && startRoomCompositeHold) {
        holdNextStartRoomComposite = false;
        const signal = init?.signal;
        await Promise.race([
          startRoomCompositeHold,
          new Promise<never>((_, reject) => {
            const fail = () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            if (!signal) return;
            if (signal.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
          }),
        ]);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        stream_outputs?: { urls?: string[] }[];
        file_outputs?: { filepath?: string }[];
        layout?: string;
        preset?: number;
      };
      if (startPortraitRoomCompositeFail && body.layout === PORTRAIT_LAYOUT) {
        return new Response("portrait compositor refused", { status: 500 });
      }
      if (startRoomCompositeFail) return new Response(`cannot publish ${YT}`, { status: 500 });
      startBodies.push(body);
      const urls = body.stream_outputs?.[0]?.urls ?? [];
      const files = body.file_outputs ?? [];
      assert.ok(urls.length >= 1 || files.length >= 1, "egress needs RTMP or a recording");
      return new Response(JSON.stringify({ egress_id: `eg_${egressStarts}` }), { status: 200 });
    }
    if (url.includes("StopEgress")) {
      egressStops += 1;
      if (stopEgressStatus !== 200) return new Response("timeout", { status: stopEgressStatus });
      return new Response("{}", { status: 200 });
    }
    if (url.includes("UpdateStream")) {
      streamUpdates += 1;
      updateStreamStarted?.();
      if (holdNextUpdateStream && updateStreamHold) {
        holdNextUpdateStream = false;
        await updateStreamHold;
      }
      return new Response("{}", { status: 200 });
    }
    if (url.includes("ListEgress")) {
      if (listEgressFail) return new Response("boom", { status: 500 });
      listEgressStarted?.();
      if (holdNextListEgress && listEgressHold) {
        holdNextListEgress = false;
        await listEgressHold;
      }
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
  assert.equal(publicError("failed 127.0.0.1:1935/live/super-secret-youtube-key"), "failed rtmp://…");
  assert.equal(publicError("failed ingest.example.com/live/super-secret-youtube-key"), "failed rtmp://…");
  assert.equal(publicError("failed mux://8e0b1b9c-50a2-d893-ec0a-102056d112ae"), "failed rtmp://…");
  assert.equal(publicError("failed twitch://live_12345678_abcdefghijklmnop"), "failed rtmp://…");
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
  const withTs = parseEgressInfo({
    egressId: "EG_3",
    status: "EGRESS_ACTIVE",
    updatedAt: "1700000000000000000",
    started_at: 1_700_000_000_000,
  });
  assert.equal(withTs?.updatedAt, 1_700_000_000_000);
  assert.equal(withTs?.startedAt, 1_700_000_000_000);
});

test("egressTimeMs keeps milliseconds and converts nanos, including numeric strings", () => {
  const ms = 1_700_000_000_000;
  assert.equal(egressTimeMs(ms), ms);
  assert.equal(egressTimeMs(String(ms)), ms);
  assert.equal(egressTimeMs(1_700_000_000_000_000_000), ms);
  assert.equal(egressTimeMs("1700000000000000000"), ms);
  assert.equal(egressTimeMs("nope"), null);
  assert.equal(egressTimeMs(0), null);
});

test("parseEgressInfo reads LiveKit Twirp payloads with string int64 nanos", () => {
  const ms = 1_700_000_000_000;
  const ns = "1700000000000000000";
  const webhook = parseEgressInfo({
    event: "egress_updated",
    egressInfo: {
      egressId: "EG_lk",
      roomName: "studio",
      status: 1,
      startedAt: ns,
      updatedAt: ns,
      streamResults: [{ url: YT, status: 0 }],
    },
  });
  assert.ok(webhook);
  assert.equal(webhook.updatedAt, ms);
  assert.equal(webhook.startedAt, ms);
  assert.equal(egressIsProducing(webhook, { identities: ["host"], fromUpdate: false, now: ms }), false);
  const flowing = parseEgressInfo({
    event: "egress_updated",
    egressInfo: {
      egressId: "EG_lk",
      roomName: "studio",
      status: 1,
      streamResults: [{ url: YT, status: 0, startedAt: String(ms * 1e6) }],
    },
  });
  assert.equal(egressIsProducing(flowing!, { identities: ["host"], fromUpdate: false, now: ms }), false);
  const sent = parseEgressInfo({
    event: "egress_updated",
    egressInfo: {
      egressId: "EG_lk",
      roomName: "studio",
      status: 1,
      streamResults: [{ url: YT, status: 0, startedAt: ns, bytes: 4096 }],
    },
  });
  assert.equal(egressIsProducing(sent!, { identities: ["host"], fromUpdate: false, now: ms }), true);
  assert.equal(egressIsProducing(flowing!, { alreadyLive: true }), true);

  const listed = parseEgressList({
    items: [
      {
        egress_id: "EG_lk",
        room_name: "studio",
        status: "EGRESS_ACTIVE",
        updated_at: ns,
        started_at: ns,
      },
    ],
  });
  assert.equal(listed[0]?.updatedAt, ms);
  assert.equal(listed[0]?.startedAt, ms);
});

test("isForeignEgress ignores leftover compositor events after stop", () => {
  assert.equal(isForeignEgress("EG_live", "EG_live", "failed"), false);
  assert.equal(isForeignEgress("EG_live", "EG_old", "failed"), true);
  assert.equal(isForeignEgress("EG_live", "EG_old", "active"), true);
  assert.equal(isForeignEgress(null, "EG_old", "failed"), true);
  assert.equal(isForeignEgress(null, "EG_old", "complete"), true);
  assert.equal(isForeignEgress(null, "EG_new", "active"), false);
  assert.equal(isForeignEgress(null, "EG_old", "ending"), true);
  assert.equal(isForeignEgress(null, "EG_old", "ending", false), true);
  assert.equal(isForeignEgress("EG_old", "EG_old", "ending", false), true);
  assert.equal(isForeignEgress(null, "EG_old", "active", false), true);
  assert.equal(isForeignEgress(null, "EG_dead", "active", true, ["EG_dead"]), true);
  assert.equal(isForeignEgress("EG_live", "EG_dead", "failed", true, ["EG_dead"]), true);
});

test("pickActiveEgress skips a compositor that is already ending", () => {
  const items = [
    { egressId: "EG_dying", roomName: "r", status: "ending" as const, error: "", streams: [], updatedAt: null, startedAt: null },
    { egressId: "EG_live", roomName: "r", status: "active" as const, error: "", streams: [], updatedAt: null, startedAt: null },
  ];
  assert.equal(pickActiveEgress(items, null)?.egressId, "EG_live");
  assert.equal(pickActiveEgress(items, "EG_dying")?.egressId, "EG_live");
  assert.equal(pickActiveEgress(items, "EG_live", ["EG_live"])?.egressId, undefined);
});

test("applyStreamResults sets per-destination status without exposing urls", () => {
  const dests: Destination[] = [
    { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: YT, enabled: true, status: "connecting", error: null },
    { id: "linkedin", kind: "linkedin", label: "LinkedIn", detail: "", url: LI, enabled: true, status: "connecting", error: null },
  ];
  const retry = applyStreamResults(
    dests,
    [
      { url: YT, status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
      { url: LI, status: "failed", error: `timeout ${LI}` },
    ],
    true,
  );
  assert.equal(retry, true);
  assert.equal(dests[0]?.status, "live");
  assert.equal(dests[1]?.status, "retrying");
  assert.equal(dests[1]?.error?.includes("super-secret"), false);
});

test("applyStreamResults matches a short MediaMTX key redacted as {...}", () => {
  const dests: Destination[] = [
    {
      id: "youtube",
      kind: "youtube",
      label: "YouTube",
      detail: "",
      url: "rtmp://127.0.0.1:1935/live/qa",
      enabled: true,
      status: "connecting",
      error: null,
    },
    {
      id: "linkedin",
      kind: "linkedin",
      label: "LinkedIn",
      detail: "",
      url: "rtmp://127.0.0.1:1935/live/linkedin",
      enabled: false,
      status: "idle",
      error: null,
    },
  ];
  applyStreamResults(
    dests,
    [{ url: "rtmp://127.0.0.1:1935/live/{...}", status: "active", error: "", startedAt: Date.now(), bytes: 4096 }],
    true,
    Date.now(),
    true,
  );
  assert.equal(dests[0]?.status, "live");
  assert.equal(dests[1]?.status, "idle");
});

test("applyStreamResults marks the leftover dest live when stream URL matching fails", () => {
  const dests: Destination[] = [
    {
      id: "youtube",
      kind: "youtube",
      label: "YouTube",
      detail: "",
      url: "rtmp://127.0.0.1:1935/live/qa",
      enabled: true,
      status: "connecting",
      error: null,
    },
  ];
  applyStreamResults(
    dests,
    [{ url: "rtmp://127.0.0.1:1935/live/{redacted}", status: "active", error: "", startedAt: Date.now(), bytes: 4096 }],
    true,
    Date.now(),
    true,
  );
  assert.equal(dests[0]?.status, "live");
});

test("applyStreamResults matches LiveKit-redacted stream URLs", () => {
  const dests: Destination[] = [
    { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: "rtmp://127.0.0.1:1935/live/youtube", enabled: true, status: "connecting", error: null },
    { id: "linkedin", kind: "linkedin", label: "LinkedIn", detail: "", url: "rtmp://127.0.0.1:1935/live/linkedin", enabled: true, status: "connecting", error: null },
    { id: "x", kind: "x", label: "X", detail: "", url: "rtmp://127.0.0.1:1935/live/x", enabled: true, status: "connecting", error: null },
  ];
  assert.equal(redactStreamKey(dests[0]!.url), "rtmp://127.0.0.1:1935/live/{yo...be}");
  assert.equal(redactStreamKey(dests[1]!.url), "rtmp://127.0.0.1:1935/live/{li...in}");
  assert.equal(redactStreamKey(dests[2]!.url), "rtmp://127.0.0.1:1935/live/{...}");
  const retry = applyStreamResults(
    dests,
    [
      { url: "rtmp://127.0.0.1:1935/live/{yo...be}", status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
      { url: "rtmp://127.0.0.1:1935/live/{li...in}", status: "failed", error: "broken pipe" },
      { url: "rtmp://127.0.0.1:1935/live/{...}", status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
    ],
    true,
  );
  assert.equal(retry, true);
  assert.equal(dests[0]?.status, "live");
  assert.equal(dests[1]?.status, "retrying");
  assert.equal(dests[2]?.status, "live");
  assert.deepEqual(
    failedStreamUrls(dests, [
      { url: "rtmp://127.0.0.1:1935/live/{yo...be}", status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
      { url: "rtmp://127.0.0.1:1935/live/{li...in}", status: "failed", error: "broken pipe" },
      { url: "rtmp://127.0.0.1:1935/live/{...}", status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
    ]),
    ["rtmp://127.0.0.1:1935/live/linkedin"],
  );
});

test("applyStreamResults waits for backoff and gives up after MAX_STREAM_RETRIES", () => {
  const dests: Destination[] = [
    {
      id: "linkedin",
      kind: "linkedin",
      label: "LinkedIn",
      detail: "",
      url: LI,
      enabled: true,
      status: "retrying",
      error: "RTMP dropped",
      retryCount: 1,
      retryAt: Date.now() + 60_000,
    },
  ];
  assert.equal(applyStreamResults(dests, [{ url: LI, status: "failed", error: "still down" }], true), false);
  assert.equal(dests[0]?.status, "retrying");

  dests[0]!.retryCount = MAX_STREAM_RETRIES;
  dests[0]!.retryAt = 0;
  assert.equal(applyStreamResults(dests, [{ url: LI, status: "failed", error: "still down" }], true), false);
  assert.equal(dests[0]?.status, "failed");
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
  assert.equal(livePhaseOf({ ...base, liveFailed: true }), "failed");
  assert.equal(livePhaseOf({ ...base, egressId: "eg" }), "starting");
  assert.equal(livePhaseOf({ ...base, liveStartingAt: Date.now() }), "starting");
  assert.equal(livePhaseOf({ ...base, egressRecoveringSince: Date.now() }), "retrying");
  assert.equal(livePhaseOf({ ...base, egressRecoveringSince: Date.now(), egressId: "eg" }), "starting");
});

test("studioHasPeople ignores compositor identities", () => {
  assert.equal(studioHasPeople(["host"]), true);
  assert.equal(studioHasPeople(["EG_abc", "egress-chrome"]), false);
  assert.equal(studioHasPeople([]), false);
});

test("two overlapping go-live calls start only one compositor", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  let release!: () => void;
  listEgressHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawList = new Promise<void>((resolve) => {
    listEgressStarted = resolve;
  });
  holdNextListEgress = true;
  const first = app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  try {
    await sawList;
    const second = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    );
    assert.equal(second.status, 409, await second.clone().text());
    release();
    const go = await first;
    assert.equal(go.status, 200, await go.clone().text());
    assert.equal(egressStarts, starts + 1);
  } finally {
    listEgressHold = null;
    listEgressStarted = null;
    holdNextListEgress = false;
  }
});

test("stop during go-live list does not start egress", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  let release!: () => void;
  listEgressHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawList = new Promise<void>((resolve) => {
    listEgressStarted = resolve;
  });
  holdNextListEgress = true;
  const first = app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  try {
    await sawList;
    const stop = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: false }) },
      env,
    );
    assert.equal(stop.status, 200, await stop.clone().text());
    release();
    const go = await first;
    assert.equal(go.status, 200, await go.clone().text());
    const ended = await json<PublicStudio>(go);
    assert.equal(ended.live, false);
    assert.equal(ended.livePhase, "idle");
    assert.equal(egressStarts, starts);
  } finally {
    listEgressHold = null;
    listEgressStarted = null;
    holdNextListEgress = false;
  }
});

test("list egress failure does not start a second compositor", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  listEgressFail = true;
  try {
    const go = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    );
    assert.equal(go.status, 200, await go.clone().text());
    const waiting = await json<PublicStudio>(go);
    assert.equal(waiting.live, false);
    assert.equal(waiting.livePhase, "retrying");
    assert.equal(egressStarts, starts);
    listEgressFail = false;
    const viaWorker = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(
      new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }),
    );
    assert.equal(viaWorker.status, 200, await viaWorker.clone().text());
    assert.equal(egressStarts, starts + 1);
  } finally {
    listEgressFail = false;
  }
});

test("LiveKit Twirp errors do not include stream keys", async () => {
  startRoomCompositeFail = true;
  try {
    await startRoomComposite({
      env: makeEnv(),
      room: "studio-room",
      layout: "side",
      urls: [YT],
      filepath: "/out/x.mp4",
    });
    assert.fail("expected StartRoomComposite to throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /LiveKit .* 500/);
    assert.equal(msg.includes("super-secret"), false);
    assert.equal(msg.includes(YT), false);
    assert.equal(msg.includes("cannot publish rtmp://…"), true);
  } finally {
    startRoomCompositeFail = false;
  }
});

test("go-live start failure does not put the LiveKit body in liveError", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  startRoomCompositeFail = true;
  try {
    const go = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    );
    assert.equal(go.status, 200, await go.clone().text());
    const waiting = await json<PublicStudio>(go);
    assert.equal(waiting.live, false);
    assert.equal(waiting.livePhase, "retrying");
    assert.equal(waiting.liveError, "Could not go live");
    for (const d of waiting.destinations) {
      assert.equal((d.error ?? "").includes("super-secret"), false);
      assert.equal((d.error ?? "").includes("twirp"), false);
    }
  } finally {
    startRoomCompositeFail = false;
  }
});

test("go live waits until someone is in the LiveKit room", async () => {
  listedParticipants = [];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_EMPTY_GRACE_MS: "60000" });
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, starts);
  const waiting = await json<PublicStudio>(go);
  assert.equal(waiting.live, false);
  assert.equal(waiting.livePhase, "starting");

  listedParticipants = [{ identity: "host" }];
  const viaWorker = await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(
    new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }),
  );
  assert.equal(viaWorker.status, 200, await viaWorker.clone().text());
  assert.equal(egressStarts, starts + 1);
});

test("go live fans out enabled destinations and stop tears down egress", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, starts + 1);
  const live = await json<PublicStudio>(go);
  assert.equal(live.live, false);
  assert.equal(live.livePhase, "starting");
  assert.ok(live.egressId);
  assert.equal(live.destinations.filter((d) => d.enabled).every((d) => d.status === "connecting"), true);

  const guest = await json<PublicStudio>(await app.request(`https://casthop.test/api/studios/${id}`, {}, env));
  assert.equal(JSON.stringify(guest).includes("super-secret"), false);
  assert.equal(guest.destinations[0]?.status, "connecting");

  const stop = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: false }) },
    env,
  );
  assert.equal(stop.status, 200);
  assert.ok(egressStops >= 1);
  const ended = await json<PublicStudio>(stop);
  assert.equal(ended.live, false);
  assert.equal(ended.livePhase, "idle");
});

test("ending webhook after host stop does not flip live back on", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.ok(started.egressId);
  const stop = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: false }) },
    env,
  );
  assert.equal(stop.status, 200);
  const body = JSON.stringify({
    event: "egress_updated",
    egressInfo: { egressId: started.egressId, roomName: id, status: "EGRESS_ENDING" },
  });
  const res = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, body) }, body },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const snap = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.equal(snap.live, false);
  assert.equal(snap.livePhase, "idle");
  assert.equal(snap.egressId, null);
});

test("unsigned webhook is 401; signed egress_ended retries start", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
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

test("terminal webhook after crash does not markRetry while egressId is empty", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.ok(started.egressId);
  const crash = JSON.stringify({
    event: "egress_ended",
    egressInfo: { egressId: started.egressId, roomName: id, status: "EGRESS_FAILED", error: "chrome crashed" },
  });
  await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, crash) }, body: crash },
    env,
  );
  const starts = egressStarts;
  const late = JSON.stringify({
    event: "egress_ended",
    egressInfo: { egressId: started.egressId, roomName: id, status: "EGRESS_FAILED", error: "chrome crashed" },
  });
  const res = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, late) }, body: late },
    env,
  );
  assert.equal(res.status, 200);
  const after = await json<PublicStudio>(res);
  assert.equal(after.livePhase, "retrying");
  listedEgress = { items: [] };
  await env.STUDIO.get(env.STUDIO.idFromName(id)).fetch(
    new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }),
  );
  assert.equal(egressStarts, starts + 1);
});

test("late egress_ended for a previous compositor does not retry the live one", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
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
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.equal(snap.live, false);
  assert.equal(snap.livePhase, "starting");
  assert.equal(snap.egressId, current);
  assert.equal(egressStarts, starts);
});

test("egress_updated with redacted stream URLs marks destinations live", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const body = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(LI), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(X), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
      ],
    },
  });
  const res = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, body) }, body },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const state = await json<PublicStudio>(res);
  assert.equal(state.destinations.find((d) => d.id === "youtube")?.status, "live");
  assert.equal(state.destinations.find((d) => d.id === "linkedin")?.status, "live");
  assert.equal(state.destinations.find((d) => d.id === "x")?.status, "live");
});

test("egress_updated marks a dropped RTMP destination and reattaches it", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
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
        { url: YT, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: LI, status: "FAILED", error: "broken pipe" },
        { url: X, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
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

test("a failed RTMP destination is not reattached forever", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const before = streamUpdates;
  let last: PublicStudio | undefined;
  for (let i = 0; i < MAX_STREAM_RETRIES + 2; i++) {
    const body = JSON.stringify({
      event: "egress_updated",
      egressInfo: {
        egressId: started.egressId,
        roomName: id,
        status: "EGRESS_ACTIVE",
        streamResults: [
          { url: YT, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
          { url: LI, status: "FAILED", error: "broken pipe" },
          { url: X, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        ],
      },
    });
    const res = await app.request(
      "https://casthop.test/api/livekit/webhook",
      { method: "POST", headers: { Authorization: await signLivekitWebhook(env, body) }, body },
      env,
    );
    assert.equal(res.status, 200, await res.clone().text());
    last = await json<PublicStudio>(res);
  }
  assert.equal(streamUpdates, before + MAX_STREAM_RETRIES);
  assert.equal(last?.destinations.find((d) => d.id === "linkedin")?.status, "failed");
  assert.equal(last?.destinations.find((d) => d.id === "youtube")?.status, "live");
});

test("missing compositor while ListEgress is still active starts a new compositor", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_COMPOSITOR_GRACE_MS: "0" });
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.equal(started.live, false);
  assert.equal(started.livePhase, "starting");
  const starts = egressStarts;
  const stops = egressStops;
  listedParticipants = [{ identity: "host" }];
  listedEgress = {
    items: [{ egressId: started.egressId, roomName: id, status: "EGRESS_ACTIVE" }],
  };
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  const first = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const after = await json<PublicStudio>(first);
  assert.equal(after.livePhase, "starting");
  assert.ok(egressStops > stops);
  assert.equal(egressStarts, starts + 1);
  const snap = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.ok(snap.egressId);
  assert.notEqual(snap.egressId, started.egressId);
});

test("empty LiveKit room stops stale egress after grace", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
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
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const egressId = started.egressId;
  assert.ok(egressId);
  const before = streamUpdates;
  const next = started.destinations.map((d) => (d.id === "x" ? { ...d, enabled: false } : d));
  const res = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ destinations: next }) },
    env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(streamUpdates > before);
});

test("stop during destination UpdateStream keeps live off", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  let release!: () => void;
  updateStreamHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawUpdate = new Promise<void>((resolve) => {
    updateStreamStarted = resolve;
  });
  holdNextUpdateStream = true;
  const next = started.destinations.map((d) => (d.id === "x" ? { ...d, enabled: false } : d));
  const toggle = app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ destinations: next }) },
    env,
  );
  try {
    await sawUpdate;
    const stop = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: false }) },
      env,
    );
    assert.equal(stop.status, 200, await stop.clone().text());
    release();
    const destRes = await toggle;
    assert.equal(destRes.status, 200, await destRes.clone().text());
    const ended = await json<PublicStudio>(destRes);
    assert.equal(ended.live, false);
    assert.equal(ended.livePhase, "idle");
  } finally {
    updateStreamHold = null;
    updateStreamStarted = null;
    holdNextUpdateStream = false;
  }
});

test("stop during RTMP reattach UpdateStream keeps live off", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  let release!: () => void;
  updateStreamHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawUpdate = new Promise<void>((resolve) => {
    updateStreamStarted = resolve;
  });
  holdNextUpdateStream = true;
  const body = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: YT, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: LI, status: "FAILED", error: "broken pipe" },
        { url: X, status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
      ],
    },
  });
  const webhook = app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, body) }, body },
    env,
  );
  try {
    await sawUpdate;
    const stop = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: false }) },
      env,
    );
    assert.equal(stop.status, 200, await stop.clone().text());
    release();
    const res = await webhook;
    assert.equal(res.status, 200, await res.clone().text());
    const ended = await json<PublicStudio>(
      await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
    );
    assert.equal(ended.live, false);
    assert.equal(ended.livePhase, "idle");
  } finally {
    updateStreamHold = null;
    updateStreamStarted = null;
    holdNextUpdateStream = false;
  }
});

test("colliding redacted stream keys match by destination id", () => {
  const qa = "rtmp://127.0.0.1:1935/live/qa";
  const x = "rtmp://127.0.0.1:1935/live/x";
  assert.equal(redactStreamKey(qa), redactStreamKey(x));
  const dests: Destination[] = [
    { id: "qa", kind: "custom", label: "QA", detail: "", url: qa, enabled: true, status: "connecting", error: null },
    { id: "x", kind: "x", label: "X", detail: "", url: x, enabled: true, status: "connecting", error: null },
  ];
  const masked = redactStreamKey(qa);
  applyStreamResults(
    dests,
    [
      { url: masked, status: "finished", error: "" },
      { url: masked, status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
    ],
    true,
  );
  assert.equal(dests.find((d) => d.id === "qa")?.status, "live");
  assert.equal(dests.find((d) => d.id === "x")?.status, "stopped");

  dests[0]!.enabled = false;
  dests[0]!.status = "idle";
  dests[1]!.status = "connecting";
  dests[1]!.enabled = true;
  applyStreamResults(
    dests,
    [
      { url: masked, status: "finished", error: "" },
      { url: masked, status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 },
    ],
    true,
  );
  assert.equal(dests.find((d) => d.id === "qa")?.status, "idle");
  assert.equal(dests.find((d) => d.id === "x")?.status, "live");
});

test("egressIsProducing needs stream output, not listed-active or a compositor identity", () => {
  const dead = {
    egressId: "EG_dead",
    roomName: "r",
    status: "active" as const,
    error: "",
    streams: [] as { url: string; status: "active"; error: string }[],
    updatedAt: Date.now(),
    startedAt: Date.now(),
  };
  assert.equal(egressIsProducing(dead, { identities: ["host", "EG_abc"], fromUpdate: true }), false);
  const starting = {
    ...dead,
    streams: [{ url: YT, status: "active" as const, error: "", startedAt: Date.now() }],
  };
  assert.equal(egressIsProducing(starting, { identities: ["host"], fromUpdate: false }), false);
  assert.equal(egressIsProducing(starting, { alreadyLive: true }), true);
  const flowing = {
    ...dead,
    streams: [{ url: YT, status: "active" as const, error: "", bytes: 4096 }],
  };
  assert.equal(egressIsProducing(flowing, { identities: ["host"], fromUpdate: false }), true);
  const now = Date.now();
  assert.equal(
    streamOutputStarted({ url: YT, status: "active", error: "", startedAt: now }, now),
    false,
  );
  assert.equal(
    streamOutputStarted({ url: YT, status: "active", error: "", startedAt: now - OUTPUT_SETTLE_MS }, now),
    true,
  );
  assert.equal(streamOutputStarted({ url: YT, status: "active", error: "", duration: 1 }), true);
  assert.equal(streamOutputStarted({ url: YT, status: "active", error: "", bytes: 12 }), true);
  assert.equal(streamOutputStarted({ url: YT, status: "active", error: "", duration: 0 }), false);
  assert.equal(streamOutputStarted({ url: YT, status: "active", error: "" }), false);
  assert.equal(streamOutputStarted({ url: YT, status: "failed", error: "" }), false);
  assert.equal(egressOutputStarted(starting), false);
  assert.equal(egressOutputStarted(flowing), true);
});

test("dead compositor with StopEgress 408 starts a fresh egress and does not re-adopt the corpse", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  stopEgressStatus = 408;
  try {
    const env = makeEnv({ CASTHOP_COMPOSITOR_GRACE_MS: "0" });
    const { id, cookie } = await createStudio(env);
    const started = await json<PublicStudio>(
      await app.request(
        `https://casthop.test/api/studios/${id}/live`,
        { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
        env,
      ),
    );
    const starts = egressStarts;
    const stops = egressStops;
    listedParticipants = [{ identity: "host" }];
    listedEgress = {
      items: [
        {
          egressId: started.egressId,
          roomName: id,
          status: "EGRESS_ACTIVE",
          streamResults: [
            { url: redactStreamKey(YT), status: "ACTIVE" },
            { url: redactStreamKey(LI), status: "ACTIVE" },
            { url: redactStreamKey(X), status: "ACTIVE" },
          ],
        },
      ],
    };
    const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
    const first = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
    const recovered = await json<PublicStudio>(first);
    assert.equal(egressStarts, starts + 1);
    assert.equal(egressStops, stops + 1);
    assert.equal(recovered.livePhase, "starting");
    const recoveredSnap = await json<PublicStudio>(
      await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
    );
    assert.ok(recoveredSnap.egressId);
    assert.notEqual(recoveredSnap.egressId, started.egressId);
    assert.equal(
      recovered.destinations.filter((d) => d.enabled).every((d) => d.status === "connecting" || d.status === "retrying"),
      true,
    );

    listedParticipants = [{ identity: "host" }, { identity: "EG_new" }];
    listedEgress = {
      items: [
        {
          egressId: started.egressId,
          roomName: id,
          status: "EGRESS_ACTIVE",
          streamResults: [
            { url: redactStreamKey(YT), status: "ACTIVE" },
            { url: redactStreamKey(LI), status: "ACTIVE" },
            { url: redactStreamKey(X), status: "ACTIVE" },
          ],
        },
        { egressId: recoveredSnap.egressId, roomName: id, status: "EGRESS_STARTING" },
      ],
    };
    const second = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
    const still = await json<PublicStudio>(second);
    assert.equal(still.livePhase, "starting");
    const stillSnap = await json<PublicStudio>(
      await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
    );
    assert.equal(stillSnap.egressId, recoveredSnap.egressId);
    assert.equal(egressStarts, starts + 1);
    assert.equal(egressStops, stops + 1);
    assert.equal(still.destinations.some((d) => d.status === "live"), false);
  } finally {
    stopEgressStatus = 200;
  }
});

test("recovery budget exceeded marks live failed; retry starts a new compositor", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_COMPOSITOR_GRACE_MS: "0", CASTHOP_RECOVERY_MS: "0" });
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const starts = egressStarts;
  listedParticipants = [{ identity: "host" }];
  listedEgress = {
    items: [{ egressId: started.egressId, roomName: id, status: "EGRESS_ACTIVE" }],
  };
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  const failedRes = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const failed = await json<PublicStudio>(failedRes);
  assert.equal(failed.live, false);
  assert.equal(failed.livePhase, "failed");
  assert.equal(failed.liveError, "Compositor left");
  assert.equal(failed.destinations.filter((d) => d.enabled).every((d) => d.status === "failed"), true);
  assert.equal(egressStarts, starts);

  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const retry = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.equal(retry.livePhase, "starting");
  assert.equal(egressStarts, starts + 1);
});

test("recovery timers overlap the start RPC with the 30s budget", () => {
  const now = 1_000_000;
  const state = { egressRecoveringSince: now - 10_000, egressHeartbeatAt: now - 12_000 };
  assert.equal(remainingRecoveryMs(state, now, 30_000), 20_000);
  assert.equal(startEgressTimeoutMs(20_000), 20_000);
  assert.equal(startEgressTimeoutMs(null), 30_000);
  assert.equal(startEgressTimeoutMs(0), 0);
  const recovering = { egressRecoveringSince: null as number | null, egressHeartbeatAt: now - 4_000 };
  beginRecovery(recovering, now);
  assert.equal(recovering.egressRecoveringSince, now - 4_000);
  beginRecovery(recovering, now + 50);
  assert.equal(recovering.egressRecoveringSince, now - 4_000);
  assert.equal(heartbeatLost({ egressHeartbeatAt: now - 5_000 }, now, 5_000), true);
  assert.equal(heartbeatLost({ egressHeartbeatAt: now - 4_999 }, now, 5_000), false);
  assert.equal(heartbeatLost({ egressHeartbeatAt: null }, now, 5_000), false);
  assert.equal(heartbeatLost({ egressHeartbeatAt: now - 3_000 }, now), true);
  assert.equal(heartbeatLost({ egressHeartbeatAt: now - 2_999 }, now), false);
  assert.equal(nextWatchMs(false), 500);
  assert.equal(nextWatchMs(true), 3_000);
  const portrait = { portraitRecoveringSince: null as number | null, portraitHeartbeatAt: now - 4_000 };
  beginPortraitRecovery(portrait, now);
  assert.equal(portrait.portraitRecoveringSince, now - 4_000);
  beginPortraitRecovery(portrait, now + 50);
  assert.equal(portrait.portraitRecoveringSince, now - 4_000);
  assert.equal(portraitRecoveryTimedOut({ portraitRecoveringSince: now - 30_000 }, now, 30_000), true);
  assert.equal(portraitRecoveryTimedOut({ portraitRecoveringSince: now - 29_999 }, now, 30_000), false);
});

test("go live stays Starting until stream bytes, then Live", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.equal(started.livePhase, "starting");
  assert.equal(started.live, false);
  assert.equal(started.destinations.find((d) => d.id === "youtube")?.status, "connecting");

  const omittedBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE" }],
    },
  });
  const omittedRes = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, omittedBody) }, body: omittedBody },
    env,
  );
  const omitted = await json<PublicStudio>(omittedRes);
  assert.equal(omitted.livePhase, "starting");
  assert.equal(omitted.destinations.find((d) => d.id === "youtube")?.status, "connecting");

  const startingBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE", duration: 0 }],
    },
  });
  const startingRes = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, startingBody) }, body: startingBody },
    env,
  );
  const stillStarting = await json<PublicStudio>(startingRes);
  assert.equal(stillStarting.livePhase, "starting");
  assert.equal(stillStarting.destinations.find((d) => d.id === "youtube")?.status, "connecting");

  const startedAtBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE", started_at: String(Date.now() * 1e6) }],
    },
  });
  const startedAtRes = await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, startedAtBody) }, body: startedAtBody },
    env,
  );
  const stillStartingAt = await json<PublicStudio>(startedAtRes);
  assert.equal(stillStartingAt.livePhase, "starting");
  assert.equal(stillStartingAt.destinations.find((d) => d.id === "youtube")?.status, "connecting");

  const liveBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
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
  const live = await json<PublicStudio>(liveRes);
  assert.equal(live.livePhase, "live");
  assert.equal(live.live, true);
  assert.equal(live.destinations.find((d) => d.id === "youtube")?.status, "live");
});

test("a missed compositor heartbeat drops Live to Reconnecting while ListEgress is still active", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_HEARTBEAT_MS: "5", CASTHOP_COMPOSITOR_GRACE_MS: "60000" });
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const liveBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(LI), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(X), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
      ],
    },
  });
  await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, liveBody) }, body: liveBody },
    env,
  );
  const beat = await postEgressBeat(env, id, "EG_abc", started.egressId ?? "");
  assert.equal(beat.status, 200, await beat.clone().text());
  assert.equal((await json<{ ignored?: boolean }>(beat)).ignored, undefined);
  const stillLive = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.equal(stillLive.livePhase, "live");
  assert.equal(stillLive.destinations.find((d) => d.id === "youtube")?.status, "live");
  await new Promise((r) => setTimeout(r, 15));
  listedEgress = {
    items: [
      {
        egressId: started.egressId,
        roomName: id,
        status: "EGRESS_ACTIVE",
        streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 }],
      },
    ],
  };
  const starts = egressStarts;
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  const res = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const after = await json<PublicStudio>(res);
  assert.notEqual(after.livePhase, "live");
  assert.ok(after.livePhase === "retrying" || after.livePhase === "starting");
  assert.equal(after.live, false);
  assert.equal(after.destinations.some((d) => d.status === "live"), false);
  assert.ok(
    after.destinations.filter((d) => d.enabled).every((d) => d.status === "retrying" || d.status === "connecting"),
  );
  assert.ok(egressStarts > starts);
});

test("egress-beat ignores a compositor for a previous egress id", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_HEARTBEAT_MS: "5", CASTHOP_COMPOSITOR_GRACE_MS: "60000" });
  const { id, cookie } = await createStudio(env);
  const started = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  const liveBody = JSON.stringify({
    event: "egress_updated",
    egressInfo: {
      egressId: started.egressId,
      roomName: id,
      status: "EGRESS_ACTIVE",
      streamResults: [
        { url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(LI), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
        { url: redactStreamKey(X), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 },
      ],
    },
  });
  await app.request(
    "https://casthop.test/api/livekit/webhook",
    { method: "POST", headers: { Authorization: await signLivekitWebhook(env, liveBody) }, body: liveBody },
    env,
  );
  const mismatch = await postEgressBeat(env, id, "EG_old", "EG_old");
  assert.equal(mismatch.status, 200, await mismatch.clone().text());
  assert.equal((await json<{ ignored?: boolean }>(mismatch)).ignored, true);
  const missing = await postEgressBeat(env, id, "EG_abc", "");
  assert.equal((await json<{ ignored?: boolean }>(missing)).ignored, true);
  listedParticipants = [{ identity: "host" }];
  listedEgress = {
    items: [
      {
        egressId: started.egressId,
        roomName: id,
        status: "EGRESS_ACTIVE",
        streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 }],
      },
    ],
  };
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const restarted = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.ok(restarted.egressId);
  assert.notEqual(restarted.egressId, started.egressId);
  listedParticipants = [{ identity: "host" }, { identity: "EG_new" }];
  listedEgress = {
    items: [
      {
        egressId: restarted.egressId,
        roomName: id,
        status: "EGRESS_ACTIVE",
        streamResults: [{ url: redactStreamKey(YT), status: "ACTIVE", started_at: "1700000000000000000", bytes: 4096 }],
      },
    ],
  };
  const stale = await postEgressBeat(env, id, "EG_abc", started.egressId ?? "");
  assert.equal((await json<{ ignored?: boolean }>(stale)).ignored, true);
  await new Promise((r) => setTimeout(r, 15));
  const starts = egressStarts;
  await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
  const after = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: liveHeaders(cookie) }, env),
  );
  assert.equal(after.egressId, restarted.egressId);
  assert.equal(egressStarts, starts);
  const fresh = await postEgressBeat(env, id, "EG_new", restarted.egressId ?? "");
  assert.equal((await json<{ ignored?: boolean }>(fresh)).ignored, undefined);
});

test("egress-beat rejects guest and host tokens", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id } = await createStudio(env);
  const guest = await mintParticipantToken({ env, identity: "g-1", name: "G", room: id, canPublish: true });
  const host = await mintParticipantToken({ env, identity: "host", name: "Host", room: id, canPublish: true });
  const guestRes = await app.request(
    `https://casthop.test/api/studios/${id}/egress-beat`,
    { method: "POST", headers: { Authorization: `Bearer ${guest}` }, body: "{}" },
    env,
  );
  assert.equal(guestRes.status, 403);
  const hostRes = await app.request(
    `https://casthop.test/api/studios/${id}/egress-beat`,
    { method: "POST", headers: { Authorization: `Bearer ${host}` }, body: "{}" },
    env,
  );
  assert.equal(hostRes.status, 403);
  const none = await app.request(`https://casthop.test/api/studios/${id}/egress-beat`, { method: "POST", body: "{}" }, env);
  assert.equal(none.status, 401);
});

test("StartRoomComposite timeout is bounded by the remaining recovery budget", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_COMPOSITOR_GRACE_MS: "0", CASTHOP_RECOVERY_MS: "80", CASTHOP_BACKOFF_MS: "0" });
  const { id, cookie } = await createStudio(env);
  await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  let release!: () => void;
  startRoomCompositeHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdNextStartRoomComposite = true;
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  try {
    const failedRes = await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" }));
    const failed = await json<PublicStudio>(failedRes);
    assert.equal(failed.livePhase, "failed");
    assert.equal(failed.live, false);
  } finally {
    release();
    startRoomCompositeHold = null;
    startRoomCompositeStarted = null;
    holdNextStartRoomComposite = false;
  }
});

test("outputPhase is off when no destination uses that size", () => {
  const dests: Destination[] = [
    { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: YT, enabled: true, status: "live", error: null, aspect: "landscape" },
    { id: "custom", kind: "custom", label: "TikTok", detail: "", url: "rtmp://ingest.example.com/live/tiktok-key", enabled: false, status: "idle", error: null, aspect: "portrait" },
  ];
  assert.equal(outputPhase(dests, "landscape"), "live");
  assert.equal(outputPhase(dests, "portrait"), "off");
});

test("isForeignEgress treats a second owned compositor as ours", () => {
  assert.equal(isForeignEgress("EG_land", "EG_port", "active", true, [], ["EG_port"]), false);
  assert.equal(isForeignEgress("EG_land", "EG_other", "active", true, [], ["EG_port"]), true);
});

test("applyStreamResults on landscape dests leaves portrait dests alone", () => {
  const dests: Destination[] = [
    { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: YT, enabled: true, status: "connecting", error: null, aspect: "landscape" },
    { id: "custom", kind: "custom", label: "TikTok", detail: "", url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, status: "connecting", error: null, aspect: "portrait" },
  ];
  applyStreamResults(
    destsForAspect(dests, "landscape"),
    [{ url: YT, status: "active", error: "", startedAt: 1_700_000_000_000, bytes: 4096 }],
    true,
    Date.now(),
    true,
  );
  assert.equal(dests[0]?.status, "live");
  assert.equal(dests[1]?.status, "connecting");
});

test("go live with a 9:16 destination starts a second portrait compositor", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const patched = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "custom"
            ? { ...d, url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, aspect: "portrait" }
            : { ...d, aspect: "landscape", enabled: d.id === "youtube" },
        ),
      }),
    },
    env,
  );
  assert.equal(patched.status, 200, await patched.clone().text());
  const saved = await json<PublicStudio>(patched);
  assert.equal(saved.destinations.find((d) => d.id === "custom")?.aspect, "portrait");
  assert.equal(destAspectOf(saved.destinations.find((d) => d.id === "youtube") ?? {}), "landscape");

  startBodies.length = 0;
  const starts = egressStarts;
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, starts + 2);
  const land = startBodies.find((b) => b.layout !== PORTRAIT_LAYOUT);
  const port = startBodies.find((b) => b.layout === PORTRAIT_LAYOUT);
  assert.ok(land);
  assert.ok(port);
  assert.equal(port.preset, PORTRAIT_PRESET);
  assert.equal(Array.isArray(port.file_outputs), false);
  const landUrls = (land.stream_outputs as { urls?: string[] }[] | undefined)?.[0]?.urls ?? [];
  const portUrls = (port.stream_outputs as { urls?: string[] }[] | undefined)?.[0]?.urls ?? [];
  assert.ok(landUrls.some((u) => u.includes("youtube")));
  assert.ok(portUrls.some((u) => u.includes("tiktok-key")));
  assert.equal(landUrls.some((u) => u.includes("tiktok-key")), false);
});

test("switching a live destination to 9:16 starts portrait egress", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const starts = egressStarts;
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  assert.equal(egressStarts, starts + 1);
  const afterGo = await json<PublicStudio>(go);
  listedEgress = {
    items: [
      {
        egressId: afterGo.egressId,
        status: "EGRESS_ACTIVE",
        stream_results: [{ url: YT, status: "ACTIVE", started_at: Date.now() * 1e6, bytes: 4096 }],
      },
    ],
  };
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  startBodies.length = 0;
  const nextStarts = egressStarts;
  const switched = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "x" ? { ...d, aspect: "portrait", enabled: true } : d,
        ),
      }),
    },
    env,
  );
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.equal(egressStarts, nextStarts + 1);
  assert.equal(startBodies.at(-1)?.layout, PORTRAIT_LAYOUT);
});

test("startRoomComposite refuses 9:16 without a custom template", async () => {
  await assert.rejects(
    () =>
      startRoomComposite({
        env: makeEnv({ EGRESS_TEMPLATE_URL: "" }),
        room: "studio-room",
        layout: PORTRAIT_LAYOUT,
        urls: [YT],
      }),
    /9:16 needs a custom Egress template/,
  );
});

test("portrait destinations are rejected when the Egress template is unset", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv({ EGRESS_TEMPLATE_URL: "" });
  const { id, cookie } = await createStudio(env);
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const enabled = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "custom" ? { ...d, aspect: "portrait", enabled: true } : d,
        ),
      }),
    },
    env,
  );
  assert.equal(enabled.status, 400);
  const disabled = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) => (d.id === "custom" ? { ...d, aspect: "portrait" } : d)),
      }),
    },
    env,
  );
  assert.equal(disabled.status, 200, await disabled.clone().text());
  const saved = await json<PublicStudio>(disabled);
  assert.equal(saved.destinations.find((d) => d.id === "custom")?.aspect, "portrait");
  assert.equal(saved.destinations.find((d) => d.id === "custom")?.enabled, false);
});

test("an already-enabled 9:16 dest does not block other destination saves when the template is unset", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const enable = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "custom"
            ? { ...d, url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, aspect: "portrait" }
            : d,
        ),
      }),
    },
    env,
  );
  assert.equal(enable.status, 200, await enable.clone().text());
  env.EGRESS_TEMPLATE_URL = "";
  const after = await json<PublicStudio>(enable);
  const editOther = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: after.destinations.map((d) => (d.id === "youtube" ? { ...d, enabled: false } : d)),
      }),
    },
    env,
  );
  assert.equal(editOther.status, 200, await editOther.clone().text());
  const saved = await json<PublicStudio>(editOther);
  assert.equal(saved.destinations.find((d) => d.id === "custom")?.aspect, "portrait");
  assert.equal(saved.destinations.find((d) => d.id === "custom")?.enabled, true);
  assert.equal(saved.destinations.find((d) => d.id === "youtube")?.enabled, false);
});

test("overlapping 9:16 starts share one compositor", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv();
  const { id, cookie } = await createStudio(env);
  const go = await app.request(
    `https://casthop.test/api/studios/${id}/live`,
    { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
    env,
  );
  assert.equal(go.status, 200, await go.clone().text());
  const afterGo = await json<PublicStudio>(go);
  listedEgress = {
    items: [
      {
        egressId: afterGo.egressId,
        status: "EGRESS_ACTIVE",
        stream_results: [{ url: YT, status: "ACTIVE", started_at: Date.now() * 1e6, bytes: 4096 }],
      },
    ],
  };
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const portraitBody = JSON.stringify({
    destinations: studio.destinations.map((d) => (d.id === "x" ? { ...d, aspect: "portrait", enabled: true } : d)),
  });
  let release!: () => void;
  const sawStart = new Promise<void>((resolve) => {
    startRoomCompositeStarted = () => resolve();
  });
  startRoomCompositeHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdNextStartRoomComposite = true;
  const nextStarts = egressStarts;
  try {
    const first = app.request(
      `https://casthop.test/api/studios/${id}/destinations`,
      { method: "POST", headers: liveHeaders(cookie), body: portraitBody },
      env,
    );
    await sawStart;
    const second = await app.request(
      `https://casthop.test/api/studios/${id}/destinations`,
      { method: "POST", headers: liveHeaders(cookie), body: portraitBody },
      env,
    );
    release();
    const firstRes = await first;
    assert.equal(firstRes.status, 200, await firstRes.clone().text());
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal(egressStarts, nextStarts + 1);
  } finally {
    release();
    startRoomCompositeHold = null;
    startRoomCompositeStarted = null;
    holdNextStartRoomComposite = false;
  }
});

test("9:16 start failures fail portrait dests after the recovery budget", async () => {
  listedParticipants = [{ identity: "host" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_RECOVERY_MS: "0" });
  const { id, cookie } = await createStudio(env);
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  const patched = await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "custom"
            ? { ...d, url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, aspect: "portrait" }
            : { ...d, aspect: "landscape", enabled: d.id === "youtube" },
        ),
      }),
    },
    env,
  );
  assert.equal(patched.status, 200, await patched.clone().text());
  startPortraitRoomCompositeFail = true;
  startBodies.length = 0;
  try {
    const go = await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    );
    assert.equal(go.status, 200, await go.clone().text());
    const after = await json<PublicStudio>(go);
    assert.ok(after.egressId);
    assert.notEqual(after.livePhase, "failed");
    assert.equal(after.destinations.find((d) => d.id === "custom")?.status, "failed");
    assert.notEqual(after.destinations.find((d) => d.id === "youtube")?.status, "failed");
    assert.equal(startBodies.some((b) => b.layout === PORTRAIT_LAYOUT), false);
    assert.equal(startBodies.some((b) => b.layout !== PORTRAIT_LAYOUT), true);
  } finally {
    startPortraitRoomCompositeFail = false;
  }
});

test("a 9:16 compositor that never beats is restarted then capped", async () => {
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = { items: [] };
  const env = makeEnv({ CASTHOP_HEARTBEAT_MS: "5", CASTHOP_COMPOSITOR_GRACE_MS: "0" });
  const { id, cookie } = await createStudio(env);
  const studio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${id}`, { headers: { Cookie: cookie } }, env),
  );
  await app.request(
    `https://casthop.test/api/studios/${id}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(cookie),
      body: JSON.stringify({
        destinations: studio.destinations.map((d) =>
          d.id === "custom"
            ? { ...d, url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, aspect: "portrait" }
            : { ...d, aspect: "landscape", enabled: d.id === "youtube" },
        ),
      }),
    },
    env,
  );
  const go = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${id}/live`,
      { method: "POST", headers: liveHeaders(cookie), body: JSON.stringify({ live: true }) },
      env,
    ),
  );
  assert.ok(go.egressId);
  listedEgress = {
    items: [
      {
        egressId: go.egressId,
        status: "EGRESS_ACTIVE",
        stream_results: [{ url: YT, status: "ACTIVE", started_at: Date.now() * 1e6, bytes: 4096 }],
      },
    ],
  };
  await new Promise((r) => setTimeout(r, 15));
  const starts = egressStarts;
  const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
  const restarted = await json<PublicStudio>(
    await stub.fetch(new Request(`https://studio/${id}?action=watch`, { method: "POST", body: "{}" })),
  );
  assert.ok(egressStarts > starts);
  assert.notEqual(restarted.destinations.find((d) => d.id === "youtube")?.status, "failed");
  assert.notEqual(restarted.livePhase, "failed");

  const capEnv = makeEnv({ CASTHOP_HEARTBEAT_MS: "5", CASTHOP_COMPOSITOR_GRACE_MS: "0", CASTHOP_RECOVERY_MS: "0" });
  const { id: capId, cookie: capCookie } = await createStudio(capEnv);
  const capStudio = await json<PublicStudio>(
    await app.request(`https://casthop.test/api/studios/${capId}`, { headers: { Cookie: capCookie } }, capEnv),
  );
  await app.request(
    `https://casthop.test/api/studios/${capId}/destinations`,
    {
      method: "POST",
      headers: liveHeaders(capCookie),
      body: JSON.stringify({
        destinations: capStudio.destinations.map((d) =>
          d.id === "custom"
            ? { ...d, url: "rtmp://ingest.example.com/live/tiktok-key", enabled: true, aspect: "portrait" }
            : { ...d, aspect: "landscape", enabled: d.id === "youtube" },
        ),
      }),
    },
    capEnv,
  );
  const capGo = await json<PublicStudio>(
    await app.request(
      `https://casthop.test/api/studios/${capId}/live`,
      { method: "POST", headers: liveHeaders(capCookie), body: JSON.stringify({ live: true }) },
      capEnv,
    ),
  );
  listedParticipants = [{ identity: "host" }, { identity: "EG_abc" }];
  listedEgress = {
    items: [
      {
        egressId: capGo.egressId,
        status: "EGRESS_ACTIVE",
        stream_results: [{ url: YT, status: "ACTIVE", started_at: Date.now() * 1e6, bytes: 4096 }],
      },
    ],
  };
  await new Promise((r) => setTimeout(r, 15));
  const capStarts = egressStarts;
  const capStub = capEnv.STUDIO.get(capEnv.STUDIO.idFromName(capId));
  const capped = await json<PublicStudio>(
    await capStub.fetch(new Request(`https://studio/${capId}?action=watch`, { method: "POST", body: "{}" })),
  );
  assert.equal(capped.destinations.find((d) => d.id === "custom")?.status, "failed");
  assert.notEqual(capped.destinations.find((d) => d.id === "youtube")?.status, "failed");
  assert.notEqual(capped.livePhase, "failed");
  assert.equal(egressStarts, capStarts);
});
