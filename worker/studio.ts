import { defaultDestinations, MAX_ON_STAGE, type Env, type LayoutId, type StudioState } from "./types";
import { sha256hex, updateEgressLayout } from "./livekit";

type Incoming =
  | { type: "chat"; text: string; name: string; identity: string }
  | { type: "ping" };

export class StudioDurableObject {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const state = await this.getState();
      if (state) pair[1].send(JSON.stringify({ type: "state", state: publicState(state) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const action = url.searchParams.get("action") ?? "";

    if (request.method === "PUT" && action === "create") {
      const body = (await request.json()) as {
        id: string;
        title: string;
        hostKeyHash: string;
      };
      const now = Date.now();
      const state: StudioState = {
        id: body.id,
        title: body.title,
        hostKeyHash: body.hostKeyHash,
        layout: "side",
        live: false,
        liveStartedAt: null,
        egressId: null,
        recordingPath: null,
        bannerTitle: body.title,
        bannerSubtitle: "Building in public, episode 1",
        destinations: defaultDestinations(this.env),
        participants: [],
        chat: [],
        createdAt: now,
      };
      await this.putState(state);
      return json(publicState(state));
    }

    const state = await this.getState();
    if (!state) return json({ error: "Studio not found" }, 404);

    if (request.method === "GET") {
      return json(publicState(state));
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const hostKey = String(body.hostKey ?? url.searchParams.get("hostKey") ?? "");
    const isHost = hostKey ? (await sha256hex(hostKey)) === state.hostKeyHash : false;

    if (action === "auth") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return json({ ok: true });
    }

    if (action === "join") {
      const identity = String(body.identity ?? "");
      const name = String(body.name ?? "Guest").slice(0, 40);
      const role = body.role === "host" ? "host" : "guest";
      if (!identity) return json({ error: "identity required" }, 400);
      const existing = state.participants.find((p) => p.identity === identity);
      if (!existing) {
        state.participants.push({
          identity,
          name,
          role,
          onStage: role === "host",
          joinedAt: Date.now(),
        });
      } else {
        existing.name = name;
      }
      await this.putState(state);
      return json(publicState(state));
    }

    if (action === "stage") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const identity = String(body.identity ?? "");
      const on = Boolean(body.on);
      const person = state.participants.find((p) => p.identity === identity);
      if (!person) return json({ error: "participant not found" }, 404);
      const onStageCount = state.participants.filter((p) => p.onStage).length;
      if (on && !person.onStage && onStageCount >= MAX_ON_STAGE) {
        return json({ error: `Stage is full (${MAX_ON_STAGE})` }, 409);
      }
      person.onStage = on;
      await this.putState(state);
      return json(publicState(state));
    }

    if (action === "layout") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const layout = body.layout as LayoutId;
      if (layout !== "solo" && layout !== "side" && layout !== "screen") {
        return json({ error: "unknown layout" }, 400);
      }
      state.layout = layout;
      await this.putState(state);
      if (state.live && state.egressId) {
        try {
          await updateEgressLayout(this.env, state.egressId, layout);
        } catch (err) {
          console.warn("update layout failed", err);
        }
      }
      return json(publicState(state));
    }

    if (action === "destinations") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const destinations = body.destinations as StudioState["destinations"];
      if (!Array.isArray(destinations)) return json({ error: "destinations required" }, 400);
      state.destinations = destinations;
      await this.putState(state);
      return json(publicState(state));
    }

    if (action === "banner") {
      if (!isHost) return json({ error: "host key required" }, 403);
      state.bannerTitle = String(body.bannerTitle ?? state.bannerTitle).slice(0, 80);
      state.bannerSubtitle = String(body.bannerSubtitle ?? state.bannerSubtitle).slice(0, 80);
      state.title = String(body.title ?? state.title).slice(0, 80);
      await this.putState(state);
      return json(publicState(state));
    }

    if (action === "live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      state.live = Boolean(body.live);
      state.liveStartedAt = state.live ? Date.now() : null;
      state.egressId = body.egressId ? String(body.egressId) : null;
      state.recordingPath = body.recordingPath ? String(body.recordingPath) : state.recordingPath;
      await this.putState(state);
      return json(publicState(state));
    }

    if (action === "chat") {
      const text = String(body.text ?? "").trim().slice(0, 400);
      if (!text) return json({ error: "empty" }, 400);
      state.chat.push({
        id: crypto.randomUUID(),
        from: String(body.identity ?? "anon"),
        name: String(body.name ?? "Guest"),
        text,
        at: Date.now(),
        source: "studio",
      });
      state.chat = state.chat.slice(-100);
      await this.putState(state);
      return json(publicState(state));
    }

    return json({ error: "unknown action" }, 400);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: Incoming;
    try {
      parsed = JSON.parse(message) as Incoming;
    } catch {
      return;
    }
    if (parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (parsed.type === "chat") {
      const state = await this.getState();
      if (!state) return;
      const text = parsed.text.trim().slice(0, 400);
      if (!text) return;
      state.chat.push({
        id: crypto.randomUUID(),
        from: parsed.identity,
        name: parsed.name,
        text,
        at: Date.now(),
        source: "studio",
      });
      state.chat = state.chat.slice(-100);
      await this.putState(state);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private async getState(): Promise<StudioState | null> {
    return (await this.ctx.storage.get<StudioState>("state")) ?? null;
  }

  private async putState(state: StudioState): Promise<void> {
    await this.ctx.storage.put("state", state);
    const payload = JSON.stringify({ type: "state", state: publicState(state) });
    for (const sock of this.ctx.getWebSockets()) {
      try {
        sock.send(payload);
      } catch {
        /* drop */
      }
    }
  }
}

function publicState(state: StudioState): Omit<StudioState, "hostKeyHash"> {
  const { hostKeyHash: _hidden, ...rest } = state;
  return rest;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
