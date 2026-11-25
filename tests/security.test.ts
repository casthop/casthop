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
  isLoopbackUrl,
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
  return { id: "youtube", kind: "youtube", label: "YouTube", detail: "", url, enabled: true };
}

function state(url: string): StudioState {
  return {
    id: "abc",
    title: "Weekly",
    hostKeyHash: "hash",
    layout: "side",
    live: true,
    liveStartedAt: 1,
    egressId: "eg_1",
    recordingPath: "/out/abc.mp4",
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
});

test("host publicState includes destination urls", () => {
  const json = JSON.stringify(publicState(state(secretUrl), { includeUrls: true }));
  assert.equal(json.includes(secretUrl), true);
  assert.equal(json.includes("eg_1"), true);
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
