/**
 * Tiny TS Worker with the same JWT CPU as the live Hono routes.
 * Used only by `bun run bench:worker` against the workers-rs crate.
 */
import {
  mintParticipantToken,
  signLivekitWebhook,
  verifyLivekitWebhook,
  verifyParticipantToken,
  GUEST_TOKEN_TTL_SEC,
  HOST_TOKEN_TTL_SEC,
  type LivekitKeys,
} from "../../worker/livekit";
import { DEV_API_KEY, DEV_API_SECRET } from "../../worker/security";

type BenchEnv = {
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
};

function lkEnv(env: BenchEnv): LivekitKeys {
  return {
    LIVEKIT_API_KEY: env.LIVEKIT_API_KEY || DEV_API_KEY,
    LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET || DEV_API_SECRET,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const lk = lkEnv(env);

    if (request.method === "GET" && path === "/api/health") {
      return json({ ok: true, livekit: { ok: true }, impl: "ts" });
    }

    if (request.method === "POST" && path === "/internal/cpu") {
      const body = (await request.json().catch(() => ({}))) as { n?: number; op?: string };
      const n = Math.min(20_000, Math.max(1, Number(body.n) || 1));
      const op = body.op || "jwt-mint";
      const t0 = performance.now();
      if (op === "jwt-verify") {
        const token = await mintParticipantToken({
          env: lk,
          identity: "host",
          name: "Ada",
          room: "bench",
          canPublish: true,
          canPublishData: true,
          roomAdmin: true,
          ttlSec: HOST_TOKEN_TTL_SEC,
        });
        const header = `Bearer ${token}`;
        for (let i = 0; i < n; i++) {
          if (!(await verifyParticipantToken(lk, header))) return json({ error: "verify failed" }, 500);
        }
      } else if (op === "webhook-verify") {
        const payload = '{"event":"track_published","room":{"name":"bench"}}';
        const token = await signLivekitWebhook(lk, payload);
        for (let i = 0; i < n; i++) {
          if (!(await verifyLivekitWebhook(lk, token, payload))) return json({ error: "webhook verify failed" }, 500);
        }
      } else {
        for (let i = 0; i < n; i++) {
          await mintParticipantToken({
            env: lk,
            identity: i % 2 === 0 ? "g-bench" : "host",
            name: "Guest",
            room: "bench",
            canPublish: false,
            canPublishData: false,
            roomAdmin: false,
            ttlSec: GUEST_TOKEN_TTL_SEC,
          });
        }
      }
      const ms = performance.now() - t0;
      return json({ impl: "ts", op, n, ms, perOpUs: (ms * 1000) / n });
    }

    if (request.method === "POST" && path === "/internal/token") {
      const body = (await request.json().catch(() => ({}))) as {
        identity?: string;
        name?: string;
        room?: string;
        role?: string;
      };
      const host = body.role === "host";
      const identity = body.identity || "g-bench";
      const name = body.name || "Guest";
      const room = body.room || "bench";
      const token = await mintParticipantToken({
        env: lk,
        identity,
        name,
        room,
        canPublish: host,
        canPublishData: host,
        roomAdmin: host,
        ttlSec: host ? HOST_TOKEN_TTL_SEC : GUEST_TOKEN_TTL_SEC,
      });
      return json({
        token,
        identity,
        name,
        role: host ? "host" : "guest",
        expiresIn: host ? HOST_TOKEN_TTL_SEC : GUEST_TOKEN_TTL_SEC,
      });
    }

    if (request.method === "POST" && path === "/internal/verify") {
      const body = (await request.json().catch(() => ({}))) as { token?: string; body?: string };
      const token = body.token || "";
      if (typeof body.body === "string") {
        return json({ ok: await verifyLivekitWebhook(lk, token, body.body), kind: "webhook" });
      }
      const claims = await verifyParticipantToken(lk, token);
      if (!claims) return json({ ok: false, kind: "participant" });
      return json({ ok: true, kind: "participant", identity: claims.identity, room: claims.room });
    }

    if (request.method === "POST" && path === "/api/livekit/webhook") {
      const raw = await request.text();
      if (!(await verifyLivekitWebhook(lk, request.headers.get("Authorization") ?? undefined, raw))) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
