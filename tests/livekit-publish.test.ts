import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isParticipantMissingError,
  retryUpdateParticipantPublish,
} from "../worker/livekit.ts";
import type { Env } from "../worker/types.ts";

test("isParticipantMissingError matches LiveKit not-in-room replies", () => {
  assert.equal(
    isParticipantMissingError(new Error("LiveKit /twirp/livekit.RoomService/UpdateParticipant 404: participant does not exist")),
    true,
  );
  assert.equal(isParticipantMissingError(new Error("participant not found")), true);
  assert.equal(isParticipantMissingError(new Error("not found in room")), true);
  assert.equal(isParticipantMissingError(new Error("internal error")), false);
});

const livekitEnv = {
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "secretsecretsecretsecret",
  LIVEKIT_HTTP_URL: "http://127.0.0.1:7880",
} as Env;

test("retryUpdateParticipantPublish keeps trying until the guest is in the room", async () => {
  let hits = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("UpdateParticipant")) {
      hits += 1;
      if (hits < 3) return new Response("participant does not exist", { status: 404 });
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    await retryUpdateParticipantPublish(livekitEnv, "studio", "g-ada", true, {
      delaysMs: [0, 0, 0],
      sleep: async () => undefined,
    });
    assert.equal(hits, 3);
  } finally {
    globalThis.fetch = prev;
  }
});

test("retryUpdateParticipantPublish uses the current stage flag, not a captured on", async () => {
  let hits = 0;
  let lastPublish: boolean | undefined;
  let onStage = true;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("UpdateParticipant")) {
      hits += 1;
      const raw = typeof init?.body === "string" ? init.body : "";
      const parsed = raw ? (JSON.parse(raw) as { permission?: { can_publish?: boolean } }) : {};
      lastPublish = parsed.permission?.can_publish;
      if (hits < 2) return new Response("participant does not exist", { status: 404 });
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    await retryUpdateParticipantPublish(
      livekitEnv,
      "studio",
      "g-ada",
      () => {
        const current = onStage;
        onStage = false;
        return current;
      },
      { delaysMs: [0, 0], sleep: async () => undefined },
    );
    assert.equal(hits, 2);
    assert.equal(lastPublish, false);
  } finally {
    globalThis.fetch = prev;
  }
});

test("retryUpdateParticipantPublish stops if the guest is no longer listed", async () => {
  let hits = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("UpdateParticipant")) {
      hits += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    await retryUpdateParticipantPublish(livekitEnv, "studio", "g-ada", async () => null, {
      delaysMs: [0],
      sleep: async () => undefined,
    });
    assert.equal(hits, 0);
  } finally {
    globalThis.fetch = prev;
  }
});
