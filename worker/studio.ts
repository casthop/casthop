import { defaultDestinations, MAX_ON_STAGE, type Env, type LayoutId, type StudioState } from "./types";
import {
  asIdentity,
  asName,
  isHostIdentity,
  isLoopbackUrl,
  MAX_PARTICIPANTS,
  publicState,
  sanitizeDestinations,
} from "./security";
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
      if (state) pair[1].send(JSON.stringify({ type: "state", state: publicState(state, { includeUrls: false }) }));
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
      return json(publicState(state, { includeUrls: true }));
    }

    const state = await this.getState();
    if (!state) return json({ error: "Studio not found" }, 404);

    if (request.method === "GET") {
      return json(publicState(state, { includeUrls: false }));
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const hostKey = typeof body.hostKey === "string" ? body.hostKey : "";
    const isHost = hostKey ? (await sha256hex(hostKey)) === state.hostKeyHash : false;

    if (action === "auth") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return json({ ok: true, includeUrls: true });
    }

    if (action === "host-snapshot") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return json({ ok: true, state: publicState(state, { includeUrls: true }), secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath } });
    }

    if (action === "join") {
      const identity = asIdentity(body.identity);
      const name = asName(body.name, "Guest");
      const role = body.role === "host" && isHost ? "host" : "guest";
      if (!identity) return json({ error: "identity required" }, 400);
      if (isHostIdentity(identity) && !isHost) return json({ error: "host identity reserved" }, 403);
      const existing = state.participants.find((p) => p.identity === identity);
      if (!existing) {
        if (state.participants.length >= MAX_PARTICIPANTS) {
          return json({ error: "studio is full" }, 409);
        }
        state.participants.push({
          identity,
          name,
          role,
          onStage: role === "host",
          joinedAt: Date.now(),
        });
      } else {
        if (existing.role === "host" && role !== "host") {
          return json({ error: "cannot impersonate host" }, 403);
        }
        existing.name = name;
      }
      await this.putState(state);
      const person = state.participants.find((p) => p.identity === identity)!;
      return json({ ...publicState(state, { includeUrls: isHost }), onStage: person.onStage, role: person.role });
    }

    if (action === "stage") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const identity = asIdentity(body.identity);
      const on = Boolean(body.on);
      const person = state.participants.find((p) => p.identity === identity);
      if (!person) return json({ error: "participant not found" }, 404);
      const onStageCount = state.participants.filter((p) => p.onStage).length;
      if (on && !person.onStage && onStageCount >= MAX_ON_STAGE) {
        return json({ error: `Stage is full (${MAX_ON_STAGE})` }, 409);
      }
      person.onStage = on;
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
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
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "destinations") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const allowLoopback = isLoopbackUrl(this.env.LIVEKIT_HTTP_URL);
      const destinations = sanitizeDestinations(body.destinations, state.destinations, { allowLoopback });
      if (!destinations) return json({ error: "invalid destinations" }, 400);
      state.destinations = destinations;
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "banner") {
      if (!isHost) return json({ error: "host key required" }, 403);
      state.bannerTitle = asName(body.bannerTitle, state.bannerTitle);
      state.bannerSubtitle = String(body.bannerSubtitle ?? state.bannerSubtitle).slice(0, 80);
      state.title = asName(body.title, state.title);
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "claim-live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      if (state.live && state.egressId) {
        return json({
          ok: true,
          already: true,
          state: publicState(state, { includeUrls: true }),
          secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath },
        });
      }
      if (state.liveStarting) return json({ error: "already starting" }, 409);
      state.liveStarting = true;
      await this.putState(state);
      return json({
        ok: true,
        already: false,
        secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath },
      });
    }

    if (action === "live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      if (typeof body.live !== "boolean") return json({ error: "live required" }, 400);
      if (body.live && state.live && state.egressId && !body.egressId) {
        return json(publicState(state, { includeUrls: true }));
      }
      state.live = body.live;
      state.liveStartedAt = state.live ? Date.now() : null;
      state.liveStarting = false;
      if ("egressId" in body) state.egressId = body.egressId ? String(body.egressId) : null;
      if (body.recordingPath) state.recordingPath = String(body.recordingPath);
      if (!state.live) {
        state.egressId = null;
      }
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "chat") {
      const trimmed = typeof body.text === "string" ? body.text.trim().slice(0, 400) : "";
      if (!trimmed) return json({ error: "empty" }, 400);
      state.chat.push({
        id: crypto.randomUUID(),
        from: asIdentity(body.identity) || "anon",
        name: asName(body.name, "Guest"),
        text: trimmed,
        at: Date.now(),
        source: "studio",
      });
      state.chat = state.chat.slice(-100);
      await this.putState(state);
      return json(publicState(state, { includeUrls: false }));
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
      const text = typeof parsed.text === "string" ? parsed.text.trim().slice(0, 400) : "";
      if (!text) return;
      state.chat.push({
        id: crypto.randomUUID(),
        from: asIdentity(parsed.identity) || "anon",
        name: asName(parsed.name, "Guest"),
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
    const payload = JSON.stringify({ type: "state", state: publicState(state, { includeUrls: false }) });
    for (const sock of this.ctx.getWebSockets()) {
      try {
        sock.send(payload);
      } catch {
        /* drop */
      }
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
