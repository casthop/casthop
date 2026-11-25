import { Hono } from "hono";
import type { Env, StudioState } from "./types";
import { MAX_ON_STAGE } from "./types";
import { StudioDurableObject } from "./studio";
import {
  livekitHealth,
  mintParticipantToken,
  randomId,
  sha256hex,
  startRoomComposite,
  stopEgress,
  updateParticipantPublish,
} from "./livekit";

export { StudioDurableObject };

const app = new Hono<{ Bindings: Env }>();

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

app.get("/api/health", async (c) => {
  const lk = await livekitHealth(c.env);
  return c.json({
    ok: true,
    livekit: lk,
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
  const title = (body.title ?? "Weekly product update").trim().slice(0, 80) || "Weekly product update";
  const id = randomId(6).toLowerCase();
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
  const res = await studioStub(c.env, id).fetch(`https://studio/${id}`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/api/studios/:id/ws", async (c) => {
  const id = c.req.param("id");
  return studioStub(c.env, id).fetch(c.req.raw);
});

app.post("/api/studios/:id/token", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    name?: string;
    role?: "host" | "guest";
    hostKey?: string;
    identity?: string;
  };
  const snapshot = await studioStub(c.env, id).fetch(`https://studio/${id}`);
  if (!snapshot.ok) return c.json({ error: "Studio not found" }, 404);
  const state = (await snapshot.json()) as Omit<StudioState, "hostKeyHash">;
  const name = (body.name ?? (body.role === "host" ? "Host" : "Guest")).trim().slice(0, 40);
  const identity = body.identity ?? `${body.role === "host" ? "host" : "g"}-${randomId(5)}`;
  let role: "host" | "guest" = "guest";
  let canPublish = false;
  if (body.role === "host" && body.hostKey) {
    const auth = await doAction(c.env, id, "auth", { hostKey: body.hostKey });
    if (!auth.ok) return c.json({ error: "bad host key" }, 403);
    await doAction(c.env, id, "join", { identity, name, role: "host", hostKey: body.hostKey });
    role = "host";
    canPublish = true;
  } else {
    await doAction(c.env, id, "join", { identity, name, role: "guest" });
    const onStage = state.participants.find((p) => p.identity === identity)?.onStage ?? false;
    canPublish = onStage;
  }
  const token = await mintParticipantToken({
    env: c.env,
    identity,
    name,
    room: id,
    canPublish,
    roomAdmin: role === "host",
  });
  return c.json({
    token,
    identity,
    name,
    role,
    url: c.env.PUBLIC_LIVEKIT_URL,
    canPublish,
  });
});

app.post("/api/studios/:id/stage", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { identity: string; on: boolean; hostKey: string };
  const res = await doAction(c.env, id, "stage", body);
  if (res.ok) {
    try {
      await updateParticipantPublish(c.env, id, body.identity, body.on);
    } catch (err) {
      console.warn("updateParticipantPublish", err);
    }
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/layout", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const res = await doAction(c.env, id, "layout", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/destinations", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const res = await doAction(c.env, id, "destinations", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/banner", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const res = await doAction(c.env, id, "banner", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/chat", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const res = await doAction(c.env, id, "chat", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/live", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { hostKey: string; live: boolean };
  const snapRes = await studioStub(c.env, id).fetch(`https://studio/${id}`);
  if (!snapRes.ok) return c.json({ error: "Studio not found" }, 404);
  const state = (await snapRes.json()) as Omit<StudioState, "hostKeyHash">;

  if (!body.live) {
    if (state.egressId) {
      try {
        await stopEgress(c.env, state.egressId);
      } catch (err) {
        console.warn("stop egress", err);
      }
    }
    const res = await doAction(c.env, id, "live", { hostKey: body.hostKey, live: false, egressId: null });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  const urls = state.destinations.filter((d) => d.enabled && d.url.startsWith("rtmp")).map((d) => d.url);
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const filepath = `/out/${id}-${stamp}.mp4`;
  try {
    const { egressId } = await startRoomComposite({
      env: c.env,
      room: id,
      layout: state.layout,
      urls,
      filepath,
    });
    const res = await doAction(c.env, id, "live", {
      hostKey: body.hostKey,
      live: true,
      egressId,
      recordingPath: filepath,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : "egress failed",
        hint: "Is `docker compose up` running? Egress needs LiveKit, Redis, and MediaMTX on this machine.",
      },
      502,
    );
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

