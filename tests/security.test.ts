import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CLAIM_STALE_MS,
  claimIsHeld,
  clientIp,
  cookieValue,
  DEV_API_KEY,
  DEV_API_SECRET,
  devKeyGuardError,
  ipBucket,
  isLoopbackUrl,
  originAllowed,
  publicOrigin,
  hostKeyFor,
  maskRtmpUrl,
  parseRtmpUrl,
  publicDestinations,
  publicState,
  publicStateHasFullRtmpUrl,
  sanitizeDestinations,
} from "../worker/security.ts";
import type { Destination, Env, StudioState } from "../worker/types.ts";

const secretUrl = "rtmp://ingest.example.com/live/super-secret-stream-key";

function dest(url: string): Destination {
  return { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url, enabled: true, status: "idle", error: null };
}

function state(url: string): StudioState {
  return {
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
    recordingPath: "/out/abc.mp4",
    separateRecordings: false,
    isoSessionId: null,
    isoTracks: [],
    bannerTitle: "Weekly",
    bannerSubtitle: "live",
    destinations: [dest(url)],
    participants: [],
    chat: [],
    createdAt: 1,
  };
}

test("clientIp ignores forwarded headers unless Cloudflare or CASTHOP_TRUST_FORWARDED", () => {
  const forwarded = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "cf-connecting-ip": "198.51.100.1" });
  assert.equal(clientIp(forwarded), "local");
  assert.equal(clientIp(forwarded, { cf: {} }), "198.51.100.1");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }), { cf: {} }), "local");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }), { trustForwarded: true }), "203.0.113.9");
  assert.equal(
    clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), { trustForwarded: true }),
    "10.0.0.1",
  );
});

test("cookieValue ignores malformed percent-encoding", () => {
  assert.equal(cookieValue("casthop_session=%E0%A4%A", "casthop_session"), "");
  assert.equal(cookieValue("casthop_session=ok%20token", "casthop_session"), "ok token");
});

test("maskRtmpUrl keeps only the last four characters of the key", () => {
  assert.equal(maskRtmpUrl(secretUrl), "rtmp://…/-key");
  assert.equal(maskRtmpUrl(""), "");
});

test("public destinations omit url unless includeUrls", () => {
  const hidden = publicDestinations([dest(secretUrl)], false);
  assert.equal(hidden[0]?.url, undefined);
  assert.equal(hidden[0]?.hasKey, true);
  assert.equal(hidden[0]?.urlMasked, "rtmp://…/-key");
  const shown = publicDestinations([dest(secretUrl)], true);
  assert.equal(shown[0]?.url, secretUrl);
});

test("publicState never serializes the stream key or recording path for guests", () => {
  const json = JSON.stringify(publicState(state(secretUrl), { includeUrls: false }));
  assert.equal(publicStateHasFullRtmpUrl(json, secretUrl), false);
  assert.equal(json.includes(secretUrl), false);
  assert.equal(json.includes("/out/abc.mp4"), false);
  assert.equal(json.includes("eg_1"), false);
  assert.equal(json.includes("hostKeyHash"), false);
  const pub = publicState(state(secretUrl), { includeUrls: false });
  assert.equal(pub.livePhase, "live");
  assert.equal(pub.destinations[0]?.status, "idle");
});

test("host publicState includes destination urls", () => {
  const json = JSON.stringify(publicState(state(secretUrl), { includeUrls: true }));
  assert.equal(json.includes(secretUrl), true);
  assert.equal(json.includes("eg_1"), true);
});

test("publicState omits destChat cursor and includes pinnedChat", () => {
  const raw = {
    ...state(secretUrl),
    destChat: { youtube: { liveChatId: "LC_secret", pageToken: "tok", nextPollAt: 9 } },
    pinnedChat: { id: "c1", name: "Ada", text: "hi", source: "youtube" as const },
  };
  const json = JSON.stringify(publicState(raw, { includeUrls: false }));
  assert.equal(json.includes("destChat"), false);
  assert.equal(json.includes("LC_secret"), false);
  const pub = publicState(raw, { includeUrls: false });
  assert.equal(pub.pinnedChat?.text, "hi");
});

test("parseRtmpUrl accepts rtmp/rtmps and rejects junk / private hosts", () => {
  assert.equal(parseRtmpUrl("rtmp://127.0.0.1:1935/live/youtube", { allowLoopback: true }), "rtmp://127.0.0.1:1935/live/youtube");
  assert.equal(parseRtmpUrl("rtmp://127.0.0.1:1935/live/youtube", { allowLoopback: false }), null);
  assert.equal(parseRtmpUrl("rtmp://127.0.0.2/live/k", { allowLoopback: false }), null);
  assert.equal(parseRtmpUrl("rtmp://0.0.0.0/live/k", { allowLoopback: false }), null);
  assert.equal(parseRtmpUrl("rtmp://[::1]/live/k", { allowLoopback: false }), null);
  assert.equal(parseRtmpUrl("rtmp://[::1]/live/k", { allowLoopback: true }), "rtmp://[::1]/live/k");
  assert.equal(parseRtmpUrl("rtmps://a.youtube.com/live2/abcd", { allowLoopback: false }), "rtmps://a.youtube.com/live2/abcd");
  assert.equal(parseRtmpUrl("rtmpfoo://evil", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("https://example.com", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("rtmp://169.254.169.254/live/k", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("rtmp://10.0.0.1/live/k", { allowLoopback: false }), null);
  assert.equal(parseRtmpUrl("rtmp://100.64.0.1/live/k", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("rtmp://[fd12::1]/live/k", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("rtmp://[fe80::1]/live/k", { allowLoopback: true }), null);
  assert.equal(parseRtmpUrl("x".repeat(600), { allowLoopback: true }), null);
});

test("parseRtmpUrl refuses internal targets however they are spelled", () => {
  const internal = [
    "rtmp://[::ffff:10.0.0.1]:1935/live/k",
    "rtmp://[::ffff:169.254.169.254]/live/k",
    "rtmp://[0:0:0:0:0:ffff:a00:1]/live/k",
    "rtmp://[64:ff9b::a00:1]/live/k",
    "rtmp://167772161:1935/live/k",
    "rtmp://0x0a000001/live/k",
    "rtmp://012.0.0.1/live/k",
    "rtmps://192.168.1.10/live/k",
    "rtmp://172.20.0.5/live/k",
    "rtmp://224.0.0.1/live/k",
    "rtmp://redis/live/k",
    "rtmp://ingest.internal/live/k",
    "rtmp://printer.local/live/k",
    "rtmp://localhost./live/k",
  ];
  for (const url of internal) {
    assert.equal(parseRtmpUrl(url, { allowLoopback: true }), null, url);
    assert.equal(parseRtmpUrl(url, { allowLoopback: false }), null, url);
  }
  const loopback = ["rtmp://[::ffff:127.0.0.1]/live/k", "rtmp://2130706433/live/k", "rtmp://127.1/live/k", "rtmp://studio.localhost/live/k"];
  for (const url of loopback) assert.equal(parseRtmpUrl(url, { allowLoopback: false }), null, url);
  assert.equal(parseRtmpUrl("rtmp://localhost:1935/live/x", { allowLoopback: true }), "rtmp://localhost:1935/live/x");
  assert.equal(parseRtmpUrl("rtmp://studio.localhost/live/x", { allowLoopback: true }), "rtmp://studio.localhost/live/x");
  for (const ok of [
    "rtmp://a.rtmp.youtube.com/live2/key",
    "rtmps://live-api-s.facebook.com:443/rtmp/key",
    "rtmp://203.0.113.9/live/key",
    "rtmp://[2001:db8::1]/live/key",
  ]) {
    assert.equal(parseRtmpUrl(ok, { allowLoopback: false }), ok, ok);
  }
  assert.equal(isLoopbackUrl("http://[::1]:7880"), true);
  assert.equal(isLoopbackUrl("ws://127.0.0.2:7880"), true);
});

test("sanitizeDestinations merges omitted urls onto existing keys", () => {
  const existing = [dest(secretUrl)];
  const next = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true }],
    existing,
    { allowLoopback: false },
  );
  assert.ok(next);
  assert.equal(next[0]?.url, secretUrl);
  const cleared = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", url: "", enabled: true }],
    existing,
    { allowLoopback: false },
  );
  assert.ok(cleared);
  assert.equal(cleared[0]?.url, "");
});

test("sanitizeDestinations keeps a 9:16 aspect and defaults omitted to landscape", () => {
  const existing = [dest(secretUrl)];
  const portrait = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true, aspect: "portrait" }],
    existing,
    { allowLoopback: false, allowPortrait: true },
  );
  assert.ok(portrait);
  assert.equal(portrait[0]?.aspect, "portrait");
  assert.equal(
    sanitizeDestinations(
      [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true, aspect: "portrait" }],
      existing,
      { allowLoopback: false },
    ),
    null,
  );
  const disabledPortrait = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: false, aspect: "portrait" }],
    existing,
    { allowLoopback: false },
  );
  assert.ok(disabledPortrait);
  assert.equal(disabledPortrait[0]?.aspect, "portrait");
  assert.equal(disabledPortrait[0]?.enabled, false);
  const alreadyEnabled = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true, aspect: "portrait" }],
    [{ ...dest(secretUrl), aspect: "portrait", enabled: true }],
    { allowLoopback: false },
  );
  assert.ok(alreadyEnabled);
  assert.equal(alreadyEnabled[0]?.aspect, "portrait");
  assert.equal(alreadyEnabled[0]?.enabled, true);
  assert.equal(
    sanitizeDestinations(
      [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true, aspect: "portrait" }],
      [{ ...dest(secretUrl), aspect: "portrait", enabled: false }],
      { allowLoopback: false },
    ),
    null,
  );
  const omitted = sanitizeDestinations(
    [{ id: "youtube", kind: "youtube", label: "YouTube", detail: "", enabled: true }],
    existing,
    { allowLoopback: false },
  );
  assert.ok(omitted);
  assert.equal(omitted[0]?.aspect, "landscape");
  const shown = publicDestinations(portrait, false);
  assert.equal(shown[0]?.aspect, "portrait");
  assert.equal(shown[0]?.url, undefined);
});

test("publicOrigin uses PUBLIC_ORIGIN and only falls back on loopback", () => {
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "https://casthop.example" }, "https://evil.example/"), "https://casthop.example");
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "https://casthop.example/app" }, "http://127.0.0.1/"), "https://casthop.example");
  assert.equal(publicOrigin({}, "https://127.0.0.1/api/auth/magic-link"), "https://127.0.0.1");
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: "" }, "https://casthop.test/api/auth/magic-link"), null);
});

test("hostKeyFor uses HOST_KEY_SECRET so rotating LiveKit keys does not change it", async () => {
  const studio = "studio1";
  const withHost = { HOST_KEY_SECRET: "host-secret-host-secret-host-secret", LIVEKIT_API_SECRET: DEV_API_SECRET };
  const rotatedLivekit = { HOST_KEY_SECRET: "host-secret-host-secret-host-secret", LIVEKIT_API_SECRET: "rotated-livekit-secret-rotated" };
  const fallback = { LIVEKIT_API_SECRET: DEV_API_SECRET };
  const a = await hostKeyFor(withHost, studio);
  const b = await hostKeyFor(rotatedLivekit, studio);
  const c = await hostKeyFor(fallback, studio);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(await hostKeyFor(fallback, studio), await hostKeyFor({ LIVEKIT_API_SECRET: DEV_API_SECRET }, studio));
});

test("originAllowed rejects a cross-site Origin", () => {
  const url = "https://casthop.test/api/auth/callback";
  assert.equal(originAllowed(new Request(url, { method: "POST" })), true);
  assert.equal(originAllowed(new Request(url, { method: "POST", headers: { Origin: "https://casthop.test" } })), true);
  assert.equal(originAllowed(new Request(url, { method: "POST", headers: { Origin: "https://evil.example" } })), false);
});

test("claimIsHeld expires after 30s", () => {
  const now = 1_000_000;
  assert.equal(claimIsHeld(now - 1000, now), true);
  assert.equal(claimIsHeld(now - CLAIM_STALE_MS - 1, now), false);
  assert.equal(claimIsHeld(undefined, now), false);
});

test("devKeyGuardError refuses the published keypair off loopback", () => {
  const base = {
    LIVEKIT_API_KEY: DEV_API_KEY,
    LIVEKIT_API_SECRET: DEV_API_SECRET,
    LIVEKIT_HTTP_URL: "https://livekit.example.com",
    PUBLIC_LIVEKIT_URL: "wss://livekit.example.com",
  } as Env;
  assert.match(devKeyGuardError(base) ?? "", /devkey/);
  assert.equal(devKeyGuardError({ ...base, CASTHOP_ALLOW_DEV_KEYS: "1" }), null);
  assert.equal(
    devKeyGuardError({
      ...base,
      LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
      PUBLIC_LIVEKIT_URL: "ws://127.0.0.1:7880",
    }),
    null,
  );
});

test("egress template attaches unmuted audio tracks", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/pages/EgressTemplate.tsx"), "utf8");
  assert.match(src, /Track\.Kind\.Audio/);
  assert.match(src, /el\.muted = false/);
  assert.match(src, /document\.body\.appendChild\(el\)/);
  assert.match(src, /if \(track\.kind === Track\.Kind\.Audio\)/);
  assert.match(src, /room\.connect\(url, token\)\.then\(signalReady\)/);
});

test("denoise worklet primes silence and does not splice raw input on underrun", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/worklets/denoise-processor.js"), "utf8");
  assert.match(src, /this\.outWrite = FRAME/);
  assert.match(src, /if \(queued < output\.length\) \{\s*output\.fill\(0\)/s);
});

test("ipBucket groups IPv6 by /64 and leaves IPv4 alone", () => {
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:DB8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8:0001:0002:ffff::9"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(ipBucket("::ffff:198.51.100.4"), "198.51.100.4");
  assert.equal(ipBucket("local"), "local");
});
