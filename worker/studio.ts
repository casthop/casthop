import { defaultDestinations, MAX_ON_STAGE, type Env, type LayoutId, type StudioState } from "./types";
import {
  asIdentity,
  asName,
  CHAT_MAX,
  CHAT_WINDOW_MS,
  claimIsHeld,
  GUEST_STALE_MS,
  HOST_IDENTITY,
  isHostIdentity,
  isLoopbackUrl,
  MAX_PARTICIPANTS,
  publicState,
  sanitizeDestinations,
  TOKEN_MINT_MAX,
  TOKEN_MINT_WINDOW_MS,
} from "./security";
import { guestSecretOk, sha256hex, updateEgressLayout } from "./livekit";

type Incoming =
  | { type: "chat"; text?: string; name?: string; identity?: string; hostKey?: string; guestSecret?: string }
  | { type: "ping" };

export class StudioDurableObject {
  ctx: DurableObjectState;
  env: Env;
  private chatHits = new Map<string, { n: number; t: number }>();
  private mintHits = { n: 0, t: 0 };

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
      if ((state.kickedIdentities ?? []).includes(identity)) {
        if (role !== "host") return json({ error: "removed from studio" }, 403);
        state.kickedIdentities = (state.kickedIdentities ?? []).filter((id) => id !== identity);
      }
      if (isHostIdentity(identity) && !isHost) return json({ error: "host identity reserved" }, 403);
      this.pruneGuests(state);
      const existing = state.participants.find((p) => p.identity === identity);
      if (!existing) {
        if (role !== "host") {
          if (!this.allowMint()) return json({ error: "too many joins" }, 429);
          const guests = state.participants.filter((p) => p.role === "guest").length;
          if (guests >= MAX_PARTICIPANTS) return json({ error: "studio is full" }, 409);
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
        existing.joinedAt = Date.now();
      }
      await this.putState(state);
      const person = state.participants.find((p) => p.identity === identity)!;
      return json({ ...publicState(state, { includeUrls: isHost }), onStage: person.onStage, role: person.role });
    }

    if (action === "remove") {
      if (!isHost) return json({ error: "host key required" }, 403);
      const identity = asIdentity(body.identity);
      if (!identity || identity === HOST_IDENTITY) return json({ error: "identity required" }, 400);
      state.participants = state.participants.filter((p) => p.identity !== identity);
      const kicked = new Set(state.kickedIdentities ?? []);
      kicked.add(identity);
      state.kickedIdentities = [...kicked];
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
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
      if (claimIsHeld(state.liveStartingAt)) return json({ error: "already starting" }, 409);
      state.liveStartingAt = Date.now();
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
      state.liveStartingAt = undefined;
      if ("egressId" in body) state.egressId = body.egressId ? String(body.egressId) : null;
      if (body.recordingPath) state.recordingPath = String(body.recordingPath);
      if (!state.live) {
        state.egressId = null;
      }
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "chat") {
      const person = await this.chatAuthor(state, body, isHost);
      if (!person) return json({ error: "chat auth required" }, 403);
      if (!this.allowChat(person.identity)) return json({ error: "slow down" }, 429);
      const trimmed = typeof body.text === "string" ? body.text.trim().slice(0, 400) : "";
      if (!trimmed) return json({ error: "empty" }, 400);
      state.chat.push({
        id: crypto.randomUUID(),
        from: person.identity,
        name: person.name,
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
      const hostKey = typeof parsed.hostKey === "string" ? parsed.hostKey : "";
      const isHost = hostKey ? (await sha256hex(hostKey)) === state.hostKeyHash : false;
      const person = await this.chatAuthor(state, parsed as unknown as Record<string, unknown>, isHost);
      if (!person) return;
      if (!this.allowChat(person.identity)) return;
      const text = typeof parsed.text === "string" ? parsed.text.trim().slice(0, 400) : "";
      if (!text) return;
      state.chat.push({
        id: crypto.randomUUID(),
        from: person.identity,
        name: person.name,
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

  private async chatAuthor(
    state: StudioState,
    body: Record<string, unknown>,
    isHost: boolean,
  ): Promise<{ identity: string; name: string } | null> {
    if (isHost) {
      const claimed = asIdentity(body.identity);
      const identity = claimed && isHostIdentity(claimed) ? claimed : HOST_IDENTITY;
      const person = state.participants.find((p) => p.identity === identity) ?? state.participants.find((p) => p.role === "host");
      return { identity, name: person?.name || "Host" };
    }
    const identity = asIdentity(body.identity);
    const secret = typeof body.guestSecret === "string" ? body.guestSecret : "";
    if (!identity || !secret) return null;
    if (!(await guestSecretOk(this.env, state.id, identity, secret))) return null;
    const person = state.participants.find((p) => p.identity === identity);
    if (!person) return null;
    return { identity: person.identity, name: person.name };
  }

  private pruneGuests(state: StudioState): void {
    const now = Date.now();
    state.participants = state.participants.filter(
      (p) => p.role === "host" || p.onStage || now - p.joinedAt < GUEST_STALE_MS,
    );
  }

  private allowChat(key: string): boolean {
    const now = Date.now();
    const row = this.chatHits.get(key) ?? { n: 0, t: now };
    if (now - row.t > CHAT_WINDOW_MS) {
      row.n = 0;
      row.t = now;
    }
    row.n += 1;
    this.chatHits.set(key, row);
    return row.n <= CHAT_MAX;
  }

  private allowMint(): boolean {
    const now = Date.now();
    if (now - this.mintHits.t > TOKEN_MINT_WINDOW_MS) {
      this.mintHits = { n: 0, t: now };
    }
    this.mintHits.n += 1;
    return this.mintHits.n <= TOKEN_MINT_MAX;
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
