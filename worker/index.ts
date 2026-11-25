import { Hono } from "hono";
import type { Env, PublicStudio } from "./types";
import { MAX_ON_STAGE } from "./types";
import { StudioDurableObject } from "./studio";
import {
  asName,
  devKeyGuardError,
  HOST_IDENTITY,
  HOST_KEY_HEADER,
  isHostIdentity,
} from "./security";
import {
  guestSecretFor,
  guestSecretOk,
  livekitHealth,
  mintParticipantToken,
  randomId,
  sha256hex,
  startRoomComposite,
  stopEgress,
  updateParticipantPublish,
} from "./livekit";

export { StudioDurableObject };

export const app = new Hono<{ Bindings: Env }>();

async function ensureDb(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS studios (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL)",
    )
    .run();
}

function studioStub(env: Env, id: string): DurableObjectStub {
  return env.STUDIO.get(env.STUDIO.idFromName(id));
}

async function doAction(env: Env, id: string, action: string, body: unknown, method = "POST"): Promise<Response> {
  const stubRef = studioStub(env, id);
  return stubRef.fetch(`https://studio/${id}?action=${encodeURIComponent(action)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hostKeyFrom(c: { req: { header: (n: string) => string | undefined; json: () => Promise<unknown> } }, body: Record<string, unknown>): string {
  const header = c.req.header(HOST_KEY_HEADER) ?? c.req.header("X-Casthop-Host-Key");
  if (header) return header;
  return typeof body.hostKey === "string" ? body.hostKey : "";
}

app.use("/api/*", async (c, next) => {
  const err = devKeyGuardError(c.env);
  if (err) return c.json({ error: err }, 503);
  return next();
});

app.get("/api/health", async (c) => {
  const lk = await livekitHealth(c.env);
  return c.json({
    ok: lk.ok,
    livekit: { ok: lk.ok },
    maxOnStage: MAX_ON_STAGE,
  });
});

app.get("/api/config", (c) => {
  return c.json({
    livekitUrl: c.env.PUBLIC_LIVEKIT_URL,
    maxOnStage: MAX_ON_STAGE,
  });
});

app.post("/api/studios", async (c) => {
  await ensureDb(c.env.DB);
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = asName(body.title, "Weekly product update");
  const id = randomId(8).toLowerCase();
  const hostKey = randomId(16);
  const hostKeyHash = await sha256hex(hostKey);
  const createdAt = Date.now();
  await c.env.DB.prepare("INSERT INTO studios (id, title, created_at) VALUES (?, ?, ?)").bind(id, title, createdAt).run();
  const created = await studioStub(c.env, id).fetch(`https://studio/${id}?action=create`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title, hostKeyHash }),
  });
  if (!created.ok) {
    return c.json({ error: "failed to create studio" }, 500);
  }
  const origin = new URL(c.req.url).origin;
  return c.json({
    id,
    title,
    hostKey,
    hostUrl: `${origin}/studio/${id}?host=${encodeURIComponent(hostKey)}`,
    guestUrl: `${origin}/join/${id}`,
  });
});

app.get("/api/studios/:id", async (c) => {
  const id = c.req.param("id");
  const hostKey = c.req.header(HOST_KEY_HEADER) ?? "";
  if (hostKey) {
    const snap = await doAction(c.env, id, "host-snapshot", { hostKey });
    if (snap.status === 403) return c.json({ error: "host key required" }, 403);
    if (!snap.ok) return new Response(snap.body, { status: snap.status, headers: snap.headers });
    const data = (await snap.json()) as { state: PublicStudio };
    return c.json(data.state);
  }
  const res = await studioStub(c.env, id).fetch(`https://studio/${id}`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/api/studios/:id/ws", async (c) => {
  const id = c.req.param("id");
  return studioStub(c.env, id).fetch(c.req.raw);
});

app.post("/api/studios/:id/token", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    role?: "host" | "guest";
    hostKey?: string;
    identity?: string;
    guestSecret?: string;
  };
  const name = asName(body.name, body.role === "host" ? "Host" : "Guest");

  if (body.role === "host") {
    const hostKey = hostKeyFrom(c, body);
    if (!hostKey) return c.json({ error: "host key required" }, 403);
    const auth = await doAction(c.env, id, "auth", { hostKey });
    if (!auth.ok) return c.json({ error: "bad host key" }, 403);
    const identity = HOST_IDENTITY;
    const joined = await doAction(c.env, id, "join", { identity, name, role: "host", hostKey });
    if (!joined.ok) return new Response(joined.body, { status: joined.status, headers: joined.headers });
    const token = await mintParticipantToken({
      env: c.env,
      identity,
      name,
      room: id,
      canPublish: true,
      canPublishData: true,
      roomAdmin: true,
    });
    return c.json({
      token,
      identity,
      name,
      role: "host" as const,
      url: c.env.PUBLIC_LIVEKIT_URL,
      canPublish: true,
    });
  }

  let identity: string;
  let guestSecret: string;
  if (body.guestSecret && body.identity) {
    if (isHostIdentity(body.identity)) return c.json({ error: "host identity reserved" }, 403);
    const ok = await guestSecretOk(c.env, id, body.identity, body.guestSecret);
    if (!ok) return c.json({ error: "bad guest secret" }, 403);
    identity = body.identity;
    guestSecret = body.guestSecret;
  } else {
    identity = `g-${randomId(8)}`;
    guestSecret = await guestSecretFor(c.env, id, identity);
  }

  const joined = await doAction(c.env, id, "join", { identity, name, role: "guest" });
  if (!joined.ok) return new Response(joined.body, { status: joined.status, headers: joined.headers });
  const joinedBody = (await joined.json()) as { onStage?: boolean };
  const canPublish = Boolean(joinedBody.onStage);
  const token = await mintParticipantToken({
    env: c.env,
    identity,
    name,
    room: id,
    canPublish,
    canPublishData: false,
    roomAdmin: false,
  });
  return c.json({
    token,
    identity,
    name,
    role: "guest" as const,
    url: c.env.PUBLIC_LIVEKIT_URL,
    canPublish,
    guestSecret,
  });
});

app.post("/api/studios/:id/stage", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { identity?: string; on?: boolean; hostKey?: string };
  const res = await doAction(c.env, id, "stage", body);
  if (res.ok && body.identity) {
    try {
      await updateParticipantPublish(c.env, id, body.identity, Boolean(body.on));
    } catch (err) {
      console.warn("updateParticipantPublish", err);
    }
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/layout", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "layout", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/destinations", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "destinations", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/banner", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "banner", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/chat", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "chat", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/live", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { hostKey?: string; live?: boolean };
  const hostKey = hostKeyFrom(c, body);
  if (!hostKey) return c.json({ error: "host key required" }, 403);
  if (typeof body.live !== "boolean") return c.json({ error: "live required" }, 400);

  const snap = await doAction(c.env, id, "host-snapshot", { hostKey });
  if (snap.status === 404) return c.json({ error: "Studio not found" }, 404);
  if (!snap.ok) return c.json({ error: "host key required" }, 403);
  const data = (await snap.json()) as {
    state: PublicStudio;
    secrets: { destinations: { url: string; enabled: boolean }[]; egressId: string | null };
  };

  if (!body.live) {
    if (data.secrets.egressId) {
      try {
        await stopEgress(c.env, data.secrets.egressId);
      } catch (err) {
        console.warn("stop egress", err);
      }
    }
    const res = await doAction(c.env, id, "live", { hostKey, live: false, egressId: null });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  if (data.state.live && data.secrets.egressId) {
    return c.json(data.state);
  }

  const claim = await doAction(c.env, id, "claim-live", { hostKey });
  if (claim.status === 409) return c.json({ error: "already starting" }, 409);
  if (!claim.ok) return new Response(claim.body, { status: claim.status, headers: claim.headers });
  const claimed = (await claim.json()) as {
    already?: boolean;
    secrets: { destinations: { url: string; enabled: boolean }[]; egressId: string | null };
  };
  if (claimed.already && claimed.secrets.egressId) {
    return c.json(data.state);
  }

  const urls = claimed.secrets.destinations.filter((d) => d.enabled && d.url).map((d) => d.url);
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const filepath = `/out/${id}-${stamp}.mp4`;
  try {
    const { egressId } = await startRoomComposite({
      env: c.env,
      room: id,
      layout: data.state.layout,
      urls,
      filepath,
    });
    const res = await doAction(c.env, id, "live", {
      hostKey,
      live: true,
      egressId,
      recordingPath: filepath,
    });
    if (!res.ok) {
      try {
        await stopEgress(c.env, egressId);
      } catch {
        /* already failing */
      }
      await doAction(c.env, id, "live", { hostKey, live: false, egressId: null });
    }
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    console.warn("egress start failed", err);
    await doAction(c.env, id, "live", { hostKey, live: false, egressId: null });
    return c.json({ error: "Could not go live" }, 502);
  }
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
