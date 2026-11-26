import { DEST_CHAT_BACKOFF_MS, destChatProviders, type YoutubeTokenCache } from "./chat-ingest";
import { defaultDestinations, destAspectOf, MAX_ON_STAGE, type Env, type LayoutId, type StudioState } from "./types";
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
import {
  guestSecretOk,
  listEgressRaw,
  listRoomParticipantsRaw,
  sha256hex,
  PORTRAIT_LAYOUT,
  startRoomComposite,
  stopEgress,
  updateEgressLayout,
  updateStream,
} from "./livekit";
import {
  applyStreamResults,
  beginRecovery,
  compositorGraceMs,
  egressIsProducing,
  emptyGraceMs,
  destsForAspect,
  enabledUrls,
  failedStreamUrls,
  heartbeatLost,
  heartbeatStaleMs,
  isActiveHealth,
  isForeignEgress,
  isRunningHealth,
  isTerminalHealth,
  MAX_STREAM_RETRIES,
  nextBackoffMs,
  nextWatchMs,
  normalizeStudio,
  parseEgressInfo,
  parseEgressList,
  parseParticipantIdentities,
  pickActiveEgress,
  skipIds,
  publicError,
  recordingPathFor,
  recoveryBudgetMs,
  recoveryTimedOut,
  remainingRecoveryMs,
  rememberAbandoned,
  setDestStatuses,
  startEgressTimeoutMs,
  STOP_ABANDON_MS,
  studioHasCompositor,
  studioHasPeople,
  WATCH_MS,
  webhookEventName,
  webhookRoomName,
} from "./egress";

type Incoming =
  | { type: "chat"; text?: string; name?: string; identity?: string; hostKey?: string; guestSecret?: string }
  | { type: "ping" };

export class StudioDurableObject {
  private launching = false;
  private portraitLaunching = false;
  ctx: DurableObjectState;
  env: Env;
  private chatHits = new Map<string, { n: number; t: number }>();
  private mintHits = { n: 0, t: 0 };
  private youtubeToken: YoutubeTokenCache | null = null;

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
        wantLive: false,
        liveError: null,
        egressRetryCount: 0,
        egressRetryAt: null,
        emptySince: null,
        egressId: null,
        recordingPath: null,
        bannerTitle: body.title,
        bannerSubtitle: "Building in public, episode 1",
        destinations: defaultDestinations(this.env),
        participants: [],
        chat: [],
        pinnedChat: null,
        createdAt: now,
      };
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    const state = await this.getState();
    if (!state) return json({ error: "Studio not found" }, 404);

    const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const hostKey = typeof body.hostKey === "string" ? body.hostKey : "";
    const isHost = hostKey ? (await sha256hex(hostKey)) === state.hostKeyHash : false;

    if (request.method === "GET" && !action) {
      return json(publicState(state, { includeUrls: false }));
    }

    if (action === "auth") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return json({ ok: true, includeUrls: true });
    }

    if (action === "host-snapshot") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return json({
        ok: true,
        state: publicState(state, { includeUrls: true }),
        secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath },
      });
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
      state.emptySince = null;
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
      if (state.wantLive && state.egressId) {
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
      const destinations = sanitizeDestinations(body.destinations, state.destinations, {
        allowLoopback,
        allowPortrait: Boolean(this.env.EGRESS_TEMPLATE_URL),
      });
      if (!destinations) return json({ error: "invalid destinations" }, 400);
      const prevLand = enabledUrls(state.destinations, "landscape");
      const prevPort = enabledUrls(state.destinations, "portrait");
      state.destinations = destinations;
      await this.putState(state);
      if (state.wantLive) {
        try {
          await this.syncLiveDestinations(state, prevLand, prevPort);
        } catch (err) {
          console.warn("update stream failed", err);
          await this.scheduleWatch(Date.now() + WATCH_MS);
        }
        return json(publicState((await this.getState()) ?? state, { includeUrls: true }));
      }
      return json(publicState((await this.getState()) ?? state, { includeUrls: true }));
    }

    if (action === "banner") {
      if (!isHost) return json({ error: "host key required" }, 403);
      state.bannerTitle = asName(body.bannerTitle, state.bannerTitle);
      state.bannerSubtitle = String(body.bannerSubtitle ?? state.bannerSubtitle).slice(0, 80);
      state.title = asName(body.title, state.title);
      await this.putState(state);
      return json(publicState(state, { includeUrls: true }));
    }

    if (action === "egress-beat") {
      const latest = (await this.getState()) ?? state;
      const egressId = typeof body.egressId === "string" ? body.egressId : "";
      if (!latest.wantLive || !egressId) {
        return json({ ok: true, ignored: true });
      }
      const now = Date.now();
      if (egressId === latest.egressId) {
        latest.egressHeartbeatAt = now;
      } else if (egressId === latest.portraitEgressId) {
        latest.portraitHeartbeatAt = now;
      } else {
        return json({ ok: true, ignored: true });
      }
      await this.putState(latest);
      await this.scheduleWatch(now + heartbeatStaleMs(this.env.CASTHOP_HEARTBEAT_MS));
      return json({ ok: true });
    }

    if (action === "claim-live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      if (state.egressId && state.wantLive) {
        return json({
          ok: true,
          already: true,
          state: publicState(state, { includeUrls: true }),
          secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath },
        });
      }
      if (claimIsHeld(state.liveStartingAt)) return json({ error: "already starting" }, 409);
      state.liveStartingAt = Date.now();
      state.wantLive = true;
      await this.putState(state);
      return json({
        ok: true,
        already: false,
        secrets: { destinations: state.destinations, egressId: state.egressId, recordingPath: state.recordingPath },
      });
    }

    if (action === "start-live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return this.startLive(state);
    }

    if (action === "stop-live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      return this.stopLive(state, "stopped");
    }

    if (action === "live") {
      if (!isHost) return json({ error: "host key required" }, 403);
      if (typeof body.live !== "boolean") return json({ error: "live required" }, 400);
      if (body.live) return this.startLive(state);
      return this.stopLive(state, "stopped");
    }

    if (action === "webhook") {
      const latest = (await this.getState()) ?? state;
      return this.onWebhook(latest, body);
    }

    if (action === "watch") {
      await this.watchAndChat(state);
      const latest = (await this.getState()) ?? state;
      return json(publicState(latest, { includeUrls: false }));
    }

    if (action === "pin") {
      if (!isHost) return json({ error: "host key required" }, 403);
      if (body.chatId === null || body.chatId === "") {
        state.pinnedChat = null;
        await this.putState(state);
        return json(publicState(state, { includeUrls: true }));
      }
      const chatId = typeof body.chatId === "string" ? body.chatId.slice(0, 80) : "";
      const msg = state.chat.find((m) => m.id === chatId);
      if (!msg) return json({ error: "comment not found" }, 404);
      state.pinnedChat = { id: msg.id, name: msg.name, text: msg.text, source: msg.source };
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

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;
    await this.watchAndChat(state);
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
    const state = await this.getState();
    if (state?.wantLive) await this.scheduleWatch(Date.now() + WATCH_MS);
  }

  private async startLive(state: StudioState, fromWatch = false): Promise<Response> {
    if (state.live && state.egressId) {
      if (enabledUrls(state.destinations, "portrait").length && !state.portraitEgressId && !this.launching) {
        this.launching = true;
        try {
          await this.ensurePortraitEgress(state);
        } finally {
          this.launching = false;
        }
        return json(publicState((await this.getState()) ?? state, { includeUrls: true }));
      }
      await this.scheduleWatch(Date.now() + WATCH_MS);
      return json(publicState(state, { includeUrls: true }));
    }
    if (!fromWatch && state.egressId && state.wantLive && !state.liveFailed) {
      await this.scheduleWatch(Date.now() + WATCH_MS);
      return json(publicState(state, { includeUrls: true }));
    }
    const claimed = claimIsHeld(state.liveStartingAt) && !state.egressId;
    if (!fromWatch && (this.launching || claimed || (claimIsHeld(state.liveStartingAt) && !state.wantLive))) {
      return json({ error: "already starting" }, 409);
    }
    if (fromWatch && this.launching) {
      await this.scheduleWatch(Date.now() + WATCH_MS);
      return json(publicState(state, { includeUrls: true }));
    }

    this.launching = true;
    try {
      return await this.runStartLive(state, fromWatch);
    } finally {
      this.launching = false;
    }
  }

  private async runStartLive(state: StudioState, fromWatch = false): Promise<Response> {
    state.wantLive = true;
    state.liveFailed = false;
    if (!fromWatch) state.egressRecoveringSince = null;
    state.liveStartingAt = Date.now();
    await this.putState(state);

    let listed: ReturnType<typeof parseEgressList> = [];
    try {
      listed = parseEgressList(await listEgressRaw(this.env, state.id));
    } catch (err) {
      console.warn("list egress on start", err);
      const fresh = await this.getState();
      if (!fresh?.wantLive) return json(publicState(fresh ?? state, { includeUrls: true }));
      return this.markRetry(fresh, "Could not check egress");
    }
    const afterList = await this.getState();
    if (!afterList?.wantLive) return json(publicState(afterList ?? state, { includeUrls: true }));
    state = afterList;

    let identities: string[] | null = null;
    try {
      identities = parseParticipantIdentities(await listRoomParticipantsRaw(this.env, state.id));
    } catch {
      identities = null;
    }
    const afterPeople = await this.getState();
    if (!afterPeople?.wantLive) return json(publicState(afterPeople ?? state, { includeUrls: true }));
    state = afterPeople;
    const occupied = identities ? studioHasPeople(identities) : false;

    const landSkip = skipIds(state.abandonedEgressIds, state.portraitEgressId);
    const portSkip = skipIds(state.abandonedEgressIds, state.egressId);
    const active = pickActiveEgress(listed, state.egressId, landSkip);
    const portraitActive = pickActiveEgress(listed, state.portraitEgressId ?? null, portSkip);
    if (!portraitActive && state.portraitEgressId) {
      state.portraitEgressId = null;
      state.portraitHeartbeatAt = null;
    }
    const producing = active ? egressIsProducing(active, { alreadyLive: state.live }) : false;
    const portraitProducing = portraitActive ? egressIsProducing(portraitActive, { alreadyLive: false }) : false;
    const stale = heartbeatStaleMs(this.env.CASTHOP_HEARTBEAT_MS);
    const landHealthy =
      Boolean(active) &&
      producing &&
      !this.compositorGone(state, identities, active!.egressId) &&
      !heartbeatLost(state, Date.now(), stale);
    if (landHealthy && active) {
      state.wantLive = true;
      state.live = true;
      state.liveFailed = false;
      state.liveStartedAt = state.liveStartedAt ?? Date.now();
      state.liveStartingAt = undefined;
      state.egressId = active.egressId;
      state.liveError = null;
      state.egressRetryCount = 0;
      state.egressRetryAt = null;
      state.egressRecoveringSince = null;
      applyStreamResults(destsForAspect(state.destinations, "landscape"), active.streams, true, Date.now(), true);
      if (portraitActive) {
        state.portraitEgressId = portraitActive.egressId;
        applyStreamResults(
          destsForAspect(state.destinations, "portrait"),
          portraitActive.streams,
          true,
          Date.now(),
          portraitProducing,
        );
      }
      await this.putState(state);
      if (enabledUrls(state.destinations, "portrait").length && !state.portraitEgressId) {
        await this.ensurePortraitEgress(state);
      }
      await this.scheduleWatch(Date.now() + nextWatchMs(true));
      return json(publicState((await this.getState()) ?? state, { includeUrls: true }));
    }
    if (active && state.egressId === active.egressId && isRunningHealth(active.status)) {
      setDestStatuses(state.destinations, "connecting", null, "landscape");
      await this.putState(state);
      await this.scheduleWatch(Date.now() + nextWatchMs(false));
      return json(publicState(state, { includeUrls: true }));
    }
    if (active) {
      await this.abandonEgress(state, active.egressId);
      const afterStop = await this.getState();
      if (!afterStop?.wantLive) return json(publicState(afterStop ?? state, { includeUrls: true }));
      state = afterStop;
    }

    state.liveError = null;
    setDestStatuses(state.destinations, "connecting", null, "landscape");
    if (enabledUrls(state.destinations, "portrait").length && !state.portraitEgressId) {
      setDestStatuses(state.destinations, "connecting", null, "portrait");
    }
    await this.putState(state);

    if (!occupied) {
      await this.scheduleWatch(Date.now() + WATCH_MS);
      return json(publicState(state, { includeUrls: true }));
    }

    const landUrls = enabledUrls(state.destinations, "landscape");
    const portUrls = enabledUrls(state.destinations, "portrait");
    const filepath = recordingPathFor(state.id);
    const budget = recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS);
    const remaining = remainingRecoveryMs(state, Date.now(), budget);
    if (remaining !== null && remaining < 1) return this.markFailed(state, state.liveError ?? "Could not go live");
    try {
      const { egressId } = await startRoomComposite({
        env: this.env,
        room: state.id,
        layout: state.layout,
        urls: landUrls,
        filepath,
        timeoutMs: startEgressTimeoutMs(remaining),
      });
      const latest = await this.getState();
      if (!latest) return json({ error: "Studio not found" }, 404);
      if (!latest.wantLive) {
        try {
          await stopEgress(this.env, egressId);
        } catch {
          /* host already ended */
        }
        return json(publicState(latest, { includeUrls: true }));
      }
      latest.live = false;
      latest.liveStartingAt = latest.liveStartingAt ?? Date.now();
      latest.egressId = egressId;
      latest.recordingPath = filepath;
      latest.liveError = fromWatch ? latest.liveError : null;
      latest.egressRetryCount = 0;
      latest.egressRetryAt = null;
      latest.egressHeartbeatAt = null;
      setDestStatuses(latest.destinations, "connecting", null, "landscape");
      await this.putState(latest);
      if (portUrls.length) await this.ensurePortraitEgress(latest);
      await this.scheduleWatch(Date.now() + nextWatchMs(false));
      return json(publicState((await this.getState()) ?? latest, { includeUrls: true }));
    } catch (err) {
      console.warn("egress start failed", err);
      const latest = (await this.getState()) ?? state;
      if (!latest.wantLive) return json(publicState(latest, { includeUrls: true }));
      return this.markRetry(latest, "Could not go live");
    }
  }

  private async stopLive(state: StudioState, reason: string): Promise<Response> {
    state.wantLive = false;
    state.liveStartingAt = undefined;
    state.egressRetryAt = null;
    state.emptySince = null;
    await this.putState(state);
    await this.stopRoomEgress(state);
    const latest = (await this.getState()) ?? state;
    latest.wantLive = false;
    latest.live = false;
    latest.liveFailed = false;
    latest.liveStartedAt = null;
    latest.liveStartingAt = undefined;
    latest.egressId = null;
    latest.portraitEgressId = null;
    latest.liveError = reason === "stopped" ? null : reason;
    latest.egressRetryCount = 0;
    latest.egressRetryAt = null;
    latest.egressRecoveringSince = null;
    latest.egressHeartbeatAt = null;
    latest.portraitHeartbeatAt = null;
    latest.destChat = undefined;
    setDestStatuses(latest.destinations, reason === "stopped" ? "stopped" : "idle", null);
    if (reason === "stopped") {
      for (const d of latest.destinations) {
        if (!d.enabled) d.status = "idle";
        else if (d.status === "stopped") d.status = "idle";
      }
    }
    await this.putState(latest);
    await this.clearWatch();
    return json(publicState(latest, { includeUrls: true }));
  }

  private async onWebhook(state: StudioState, body: Record<string, unknown>): Promise<Response> {
    const event = webhookEventName(body);
    const room = webhookRoomName(body);
    if (room && room !== state.id) return json({ ok: true, ignored: true });

    if (event === "participant_left" || event === "participant_joined" || event === "room_finished") {
      await this.watchPresence(state, event === "room_finished");
      const latest = (await this.getState()) ?? state;
      return json(publicState(latest, { includeUrls: false }));
    }

    const info = parseEgressInfo(body);
    if (info) await this.applyEgress(state, info, event);
    else await this.watch(state);
    const latest = (await this.getState()) ?? state;
    return json(publicState(latest, { includeUrls: false }));
  }

  private async watchAndChat(state: StudioState): Promise<void> {
    await this.watch(state);
    const latest = await this.getState();
    if (latest) await this.pollDestChat(latest);
  }

  private async pollDestChat(state: StudioState): Promise<void> {
    const youtube = destChatProviders.find((p) => p.id === "youtube");
    if (!youtube?.configured(this.env)) return;
    if (!state.wantLive) {
      if (state.destChat?.youtube) {
        state.destChat = undefined;
        await this.putState(state);
      }
      return;
    }
    const now = Date.now();
    const cursor = state.destChat?.youtube;
    if (cursor && cursor.nextPollAt > now) {
      await this.scheduleWatch(cursor.nextPollAt);
      return;
    }
    try {
      const { page, liveChatId, cache } = await youtube.poll(this.env, cursor ?? {}, this.youtubeToken);
      this.youtubeToken = cache;
      const fresh = (await this.getState()) ?? state;
      if (!fresh.wantLive) {
        if (fresh.destChat?.youtube) {
          fresh.destChat = undefined;
          await this.putState(fresh);
        }
        return;
      }
      if (!page || !liveChatId) {
        const nextPollAt = now + DEST_CHAT_BACKOFF_MS;
        fresh.destChat = { youtube: { liveChatId: liveChatId || cursor?.liveChatId, pageToken: cursor?.pageToken, nextPollAt } };
        await this.putState(fresh);
        await this.scheduleWatch(nextPollAt);
        return;
      }
      const seen = new Set(fresh.chat.map((m) => m.id));
      for (const msg of page.comments) {
        if (seen.has(msg.id)) continue;
        fresh.chat.push(msg);
        seen.add(msg.id);
      }
      fresh.chat = fresh.chat.slice(-100);
      const nextPollAt = now + page.pollAfterMs;
      fresh.destChat = { youtube: { liveChatId, pageToken: page.pageToken, nextPollAt } };
      await this.putState(fresh);
      await this.scheduleWatch(nextPollAt);
    } catch (err) {
      console.warn("youtube chat poll", err);
      const fresh = (await this.getState()) ?? state;
      if (!fresh.wantLive) {
        if (fresh.destChat?.youtube) {
          fresh.destChat = undefined;
          await this.putState(fresh);
        }
        return;
      }
      const nextPollAt = now + DEST_CHAT_BACKOFF_MS;
      fresh.destChat = { youtube: { liveChatId: cursor?.liveChatId, pageToken: cursor?.pageToken, nextPollAt } };
      await this.putState(fresh);
      await this.scheduleWatch(nextPollAt);
    }
  }

  private async watch(state: StudioState): Promise<void> {
    if (!state.wantLive && !state.live && !state.egressId) {
      await this.clearWatch();
      return;
    }
    if (!state.wantLive) {
      await this.stopLive(state, "stopped");
      return;
    }
    if (state.liveFailed) {
      await this.clearWatch();
      return;
    }
    const identities = await this.watchPresence(state, false);
    const latest = await this.getState();
    if (!latest?.wantLive || latest.liveFailed) return;
    // Waiting out the empty-room grace: don't treat a missing compositor as a crash.
    if (latest.emptySince) {
      await this.scheduleWatch(latest.emptySince + emptyGraceMs(this.env.CASTHOP_EMPTY_GRACE_MS));
      return;
    }
    const now = Date.now();
    const budget = recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS);
    if (!latest.live && recoveryTimedOut(latest, now, budget)) {
      await this.markFailed(latest, latest.liveError ?? "Could not go live");
      return;
    }
    const stale = heartbeatStaleMs(this.env.CASTHOP_HEARTBEAT_MS);
    if (heartbeatLost(latest, now, stale)) {
      await this.restartDeadEgress(latest, latest.egressId, "Egress heartbeat lost");
      return;
    }
    if (latest.portraitEgressId && latest.portraitHeartbeatAt && now - latest.portraitHeartbeatAt >= stale) {
      await this.restartPortraitEgress(latest, "Egress heartbeat lost");
      return;
    }
    if (this.compositorGone(latest, identities)) {
      await this.restartDeadEgress(latest, latest.egressId, "Compositor left");
      return;
    }

    try {
      const listed = parseEgressList(await listEgressRaw(this.env, latest.id));
      const landSkip = skipIds(latest.abandonedEgressIds, latest.portraitEgressId);
      const portSkip = skipIds(latest.abandonedEgressIds, latest.egressId);
      const active = pickActiveEgress(listed, latest.egressId, landSkip);
      const portrait = pickActiveEgress(listed, latest.portraitEgressId ?? null, portSkip);
      if (active) await this.applyEgress(latest, active, "poll", identities);
      if (portrait) {
        const fresh = (await this.getState()) ?? latest;
        await this.applyEgress(fresh, portrait, "poll", identities);
      }
      const after = (await this.getState()) ?? latest;
      if (!after.wantLive) return;
      const wantPort = enabledUrls(after.destinations, "portrait").length > 0;
      if (wantPort && !after.portraitEgressId) {
        await this.ensurePortraitEgress(after);
      } else if (wantPort && !portrait) {
        const knownPort = listed.find((e) => e.egressId === after.portraitEgressId);
        if (knownPort && isTerminalHealth(knownPort.status)) {
          await this.restartPortraitEgress(after, publicError(knownPort.error) ?? "Egress ended");
        }
      }
      // Portrait-only in ListEgress must not skip a missing 16:9 compositor.
      if (active) return;
      const known = listed.find((e) => e.egressId === after.egressId);
      if (known && isTerminalHealth(known.status)) {
        await this.applyEgress(after, known, "poll", identities);
        return;
      }
      if (after.live || after.egressId) {
        if (!after.live) {
          const started = after.liveStartingAt ?? after.liveStartedAt ?? 0;
          const grace = compositorGraceMs(this.env.CASTHOP_COMPOSITOR_GRACE_MS);
          const remaining = remainingRecoveryMs(after, Date.now(), recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS));
          const wait = remaining == null ? grace : Math.min(grace, remaining);
          if (started && Date.now() - started < wait) {
            await this.scheduleWatch(Date.now() + WATCH_MS);
            return;
          }
        }
        await this.restartDeadEgress(after, after.egressId, after.liveError ?? "Egress disappeared");
        return;
      }
      if (after.egressRetryAt && Date.now() < after.egressRetryAt) {
        await this.scheduleWatch(after.egressRetryAt);
        return;
      }
      await this.startLive(after, true);
    } catch (err) {
      console.warn("egress watch", err);
      await this.scheduleWatch(Date.now() + WATCH_MS);
    }
  }

  private async applyEgress(
    state: StudioState,
    info: ReturnType<typeof parseEgressInfo>,
    event: string,
    identities: string[] | null = null,
  ): Promise<void> {
    if (!info) return;
    const portrait = Boolean(state.portraitEgressId) && info.egressId === state.portraitEgressId;
    if (
      isForeignEgress(
        state.egressId,
        info.egressId,
        info.status,
        state.wantLive,
        state.abandonedEgressIds,
        [state.portraitEgressId],
      )
    ) {
      return;
    }
    const dests = destsForAspect(state.destinations, portrait ? "portrait" : "landscape");
    const producing = egressIsProducing(info, { alreadyLive: !portrait && state.live });
    const dropped = applyStreamResults(
      dests,
      info.streams,
      isActiveHealth(info.status),
      Date.now(),
      producing && isActiveHealth(info.status),
    );
    if (isActiveHealth(info.status)) {
      const stale = heartbeatStaleMs(this.env.CASTHOP_HEARTBEAT_MS);
      const beatLost = portrait
        ? Boolean(state.portraitHeartbeatAt) && Date.now() - (state.portraitHeartbeatAt ?? 0) >= stale
        : heartbeatLost(state, Date.now(), stale);
      if (beatLost || this.compositorGone(state, identities, info.egressId)) {
        if (portrait) {
          await this.restartPortraitEgress(state, "Compositor left");
          return;
        }
        await this.restartDeadEgress(state, info.egressId, "Compositor left");
        return;
      }
      if (!producing) {
        if (!portrait && state.live) {
          await this.restartDeadEgress(state, info.egressId, "Egress output stopped");
          return;
        }
        if (portrait && state.portraitEgressId === info.egressId) {
          await this.putState(state);
          await this.scheduleWatch(Date.now() + nextWatchMs(false));
          return;
        }
        state.egressId = info.egressId;
        await this.putState(state);
        await this.scheduleWatch(Date.now() + nextWatchMs(false));
        return;
      }
      if (portrait) {
        state.portraitEgressId = info.egressId;
        if (!state.live) {
          state.live = true;
          state.liveFailed = false;
          state.liveStartedAt = state.liveStartedAt ?? Date.now();
          state.liveStartingAt = undefined;
          state.liveError = null;
        }
        await this.putState(state);
        if (dropped) await this.retryFailedStreams(state, info, "portrait");
        await this.scheduleWatch(Date.now() + WATCH_MS);
        return;
      }
      state.live = true;
      state.liveFailed = false;
      state.liveStartedAt = state.liveStartedAt ?? Date.now();
      state.liveStartingAt = undefined;
      state.egressId = info.egressId;
      state.liveError = null;
      state.egressRetryCount = 0;
      state.egressRetryAt = null;
      state.egressRecoveringSince = null;
      await this.putState(state);
      if (dropped) await this.retryFailedStreams(state, info, "landscape");
      await this.scheduleWatch(Date.now() + WATCH_MS);
      return;
    }
    if (!state.wantLive) {
      state.live = false;
      if (portrait) state.portraitEgressId = null;
      else state.egressId = null;
      await this.putState(state);
      return;
    }
    const detail = publicError(info.error) ?? (event === "egress_ended" ? "Egress ended" : "Egress failed");
    if (portrait) {
      await this.restartPortraitEgress(state, detail);
      return;
    }
    await this.markRetry(state, detail);
  }

  private async retryFailedStreams(
    state: StudioState,
    info: NonNullable<ReturnType<typeof parseEgressInfo>>,
    aspect: "landscape" | "portrait" = "landscape",
  ): Promise<void> {
    const egressId = aspect === "portrait" ? state.portraitEgressId : state.egressId;
    if (!egressId) return;
    const now = Date.now();
    const urls = failedStreamUrls(destsForAspect(state.destinations, aspect), info.streams, now);
    if (!urls.length) return;
    try {
      await updateStream(this.env, egressId, urls, urls);
      const fresh = (await this.getState()) ?? state;
      if (!fresh.wantLive) return;
      for (const d of fresh.destinations) {
        if (!urls.includes(d.url)) continue;
        const attempt = d.retryCount ?? 0;
        d.retryCount = attempt + 1;
        d.retryAt = now + nextBackoffMs(attempt, this.env.CASTHOP_BACKOFF_MS);
        d.status = d.retryCount >= MAX_STREAM_RETRIES ? "failed" : "retrying";
      }
      await this.putState(fresh);
    } catch (err) {
      console.warn("reattach stream", err);
      const fresh = (await this.getState()) ?? state;
      if (!fresh.wantLive) return;
      await this.markRetry(fresh, "RTMP dropped");
    }
  }

  private async abandonEgress(state: StudioState, egressId: string | null): Promise<void> {
    if (egressId) {
      state.abandonedEgressIds = rememberAbandoned(state.abandonedEgressIds, egressId);
      if (state.egressId === egressId) {
        state.egressId = null;
        state.live = false;
        state.egressHeartbeatAt = null;
      }
      if (state.portraitEgressId === egressId) {
        state.portraitEgressId = null;
        state.portraitHeartbeatAt = null;
      }
      await this.putState(state);
      try {
        await stopEgress(this.env, egressId, STOP_ABANDON_MS);
      } catch (err) {
        console.warn("abandon egress", err);
      }
      return;
    }
    if (state.egressId) {
      state.egressId = null;
      state.live = false;
      await this.putState(state);
    }
  }

  private async restartDeadEgress(state: StudioState, egressId: string | null, error: string): Promise<Response> {
    beginRecovery(state);
    state.live = false;
    setDestStatuses(state.destinations, "retrying", error, "landscape");
    await this.abandonEgress(state, egressId);
    const latest = (await this.getState()) ?? state;
    if (!latest.wantLive || latest.liveFailed) return json(publicState(latest, { includeUrls: true }));
    latest.egressRecoveringSince = state.egressRecoveringSince ?? latest.egressRecoveringSince;
    latest.live = false;
    if (egressId && latest.egressId === egressId) latest.egressId = null;
    if (recoveryTimedOut(latest, Date.now(), recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS))) {
      return this.markFailed(latest, error);
    }
    latest.liveError = error;
    setDestStatuses(latest.destinations, "retrying", error, "landscape");
    await this.putState(latest);
    return this.startLive(latest, true);
  }

  private async markFailed(state: StudioState, error: string): Promise<Response> {
    if (state.portraitEgressId) await this.abandonEgress(state, state.portraitEgressId);
    state.wantLive = true;
    state.live = false;
    state.liveFailed = true;
    state.liveStartingAt = undefined;
    state.egressId = null;
    state.portraitEgressId = null;
    state.liveError = error;
    state.egressRetryAt = null;
    state.egressHeartbeatAt = null;
    state.portraitHeartbeatAt = null;
    setDestStatuses(state.destinations, "failed", error);
    await this.putState(state);
    await this.clearWatch();
    return json(publicState(state, { includeUrls: true }));
  }

  private async markRetry(state: StudioState, error: string): Promise<Response> {
    beginRecovery(state);
    if (recoveryTimedOut(state, Date.now(), recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS))) {
      return this.markFailed(state, error);
    }
    const delay = nextBackoffMs(state.egressRetryCount, this.env.CASTHOP_BACKOFF_MS);
    if (state.portraitEgressId) await this.abandonEgress(state, state.portraitEgressId);
    state.wantLive = true;
    state.live = false;
    state.liveFailed = false;
    state.liveStartingAt = undefined;
    state.egressId = null;
    state.portraitEgressId = null;
    state.liveError = error;
    state.egressRetryCount += 1;
    state.egressRetryAt = Date.now() + delay;
    state.egressHeartbeatAt = null;
    state.portraitHeartbeatAt = null;
    setDestStatuses(state.destinations, "retrying", error);
    await this.putState(state);
    await this.scheduleWatch(state.egressRetryAt);
    return json(publicState(state, { includeUrls: true }), 200);
  }

  private compositorGone(state: StudioState, identities: string[] | null, egressId = state.egressId): boolean {
    if (!identities || studioHasCompositor(identities)) return false;
    if (!state.live && !egressId) return false;
    if (state.live) return true;
    const ours = Boolean(egressId) && egressId === state.egressId;
    const started = state.liveStartingAt ?? state.liveStartedAt ?? 0;
    const grace = compositorGraceMs(this.env.CASTHOP_COMPOSITOR_GRACE_MS);
    const remaining = remainingRecoveryMs(state, Date.now(), recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS));
    const wait = remaining == null ? grace : Math.min(grace, remaining);
    if (ours && started && Date.now() - started < wait) return false;
    return true;
  }

  private async watchPresence(state: StudioState, roomFinished: boolean): Promise<string[] | null> {
    if (!state.wantLive && !state.live) return [];
    let identities: string[] | null = roomFinished ? [] : null;
    let occupied = !roomFinished;
    if (!roomFinished) {
      try {
        identities = parseParticipantIdentities(await listRoomParticipantsRaw(this.env, state.id));
        occupied = studioHasPeople(identities);
      } catch {
        occupied = true;
        identities = null;
      }
    }
    if (occupied) {
      if (state.emptySince) {
        state.emptySince = null;
        await this.putState(state);
      }
      return identities;
    }
    const now = Date.now();
    const grace = emptyGraceMs(this.env.CASTHOP_EMPTY_GRACE_MS);
    if (!state.emptySince) {
      state.emptySince = now;
      await this.putState(state);
      await this.scheduleWatch(now + grace);
      return identities;
    }
    if (now - state.emptySince < grace) {
      await this.scheduleWatch(state.emptySince + grace);
      return identities;
    }
    await this.stopLive(state, "Studio empty");
    return identities;
  }

  private async syncLiveDestinations(state: StudioState, prevLand: string[], prevPort: string[]): Promise<void> {
    const nextLand = enabledUrls(state.destinations, "landscape");
    const nextPort = enabledUrls(state.destinations, "portrait");
    const addLand = nextLand.filter((u) => !prevLand.includes(u));
    const removeLand = prevLand.filter((u) => !nextLand.includes(u));
    const addPort = nextPort.filter((u) => !prevPort.includes(u));
    const removePort = prevPort.filter((u) => !nextPort.includes(u));
    if (state.egressId && (addLand.length || removeLand.length)) {
      await updateStream(this.env, state.egressId, addLand, removeLand);
    }
    const fresh = (await this.getState()) ?? state;
    if (!fresh.wantLive) return;
    if (addLand.length) {
      setDestStatuses(
        fresh.destinations.filter((d) => destAspectOf(d) === "landscape" && addLand.includes(d.url)),
        "connecting",
      );
    }
    if (!nextPort.length) {
      if (fresh.portraitEgressId) {
        const id = fresh.portraitEgressId;
        fresh.portraitEgressId = null;
        fresh.portraitHeartbeatAt = null;
        setDestStatuses(fresh.destinations, "idle", null, "portrait");
        await this.putState(fresh);
        try {
          await stopEgress(this.env, id, STOP_ABANDON_MS);
        } catch (err) {
          console.warn("stop portrait egress", err);
        }
      } else {
        await this.putState(fresh);
      }
      return;
    }
    if (!fresh.portraitEgressId) {
      await this.putState(fresh);
      await this.ensurePortraitEgress(fresh);
      return;
    }
    if (addPort.length || removePort.length) {
      await updateStream(this.env, fresh.portraitEgressId, addPort, removePort);
      const after = (await this.getState()) ?? fresh;
      if (!after.wantLive) return;
      if (addPort.length) {
        setDestStatuses(
          after.destinations.filter((d) => destAspectOf(d) === "portrait" && addPort.includes(d.url)),
          "connecting",
        );
      }
      await this.putState(after);
      return;
    }
    await this.putState(fresh);
  }

  private async ensurePortraitEgress(state: StudioState): Promise<void> {
    const urls = enabledUrls(state.destinations, "portrait");
    if (!urls.length || !state.wantLive) return;
    if (state.portraitEgressId || this.portraitLaunching) return;
    if (!this.env.EGRESS_TEMPLATE_URL) {
      setDestStatuses(state.destinations, "failed", "9:16 needs a custom Egress template", "portrait");
      await this.putState(state);
      return;
    }
    this.portraitLaunching = true;
    setDestStatuses(state.destinations, "connecting", null, "portrait");
    await this.putState(state);
    try {
      const { egressId } = await startRoomComposite({
        env: this.env,
        room: state.id,
        layout: PORTRAIT_LAYOUT,
        urls,
        timeoutMs: startEgressTimeoutMs(remainingRecoveryMs(state, Date.now(), recoveryBudgetMs(this.env.CASTHOP_RECOVERY_MS))),
      });
      const latest = (await this.getState()) ?? state;
      if (!latest.wantLive || latest.portraitEgressId) {
        try {
          await stopEgress(this.env, egressId);
        } catch {
          /* host already ended or another compositor owns 9:16 */
        }
        return;
      }
      latest.portraitEgressId = egressId;
      latest.portraitHeartbeatAt = null;
      setDestStatuses(latest.destinations, "connecting", null, "portrait");
      await this.putState(latest);
    } catch (err) {
      console.warn("portrait egress start failed", err);
      const latest = (await this.getState()) ?? state;
      if (!latest.wantLive) return;
      setDestStatuses(latest.destinations, "retrying", publicError(err instanceof Error ? err.message : "Could not start 9:16") ?? "Could not start 9:16", "portrait");
      await this.putState(latest);
      await this.scheduleWatch(Date.now() + WATCH_MS);
    } finally {
      this.portraitLaunching = false;
    }
  }

  private async restartPortraitEgress(state: StudioState, error: string): Promise<void> {
    const id = state.portraitEgressId;
    setDestStatuses(state.destinations, "retrying", error, "portrait");
    if (id) await this.abandonEgress(state, id);
    const latest = (await this.getState()) ?? state;
    if (!latest.wantLive || latest.liveFailed) return;
    latest.portraitEgressId = null;
    latest.portraitHeartbeatAt = null;
    await this.putState(latest);
    if (enabledUrls(latest.destinations, "portrait").length) await this.ensurePortraitEgress(latest);
  }

  private async stopRoomEgress(state: StudioState): Promise<void> {
    const ids = new Set<string>();
    if (state.egressId) ids.add(state.egressId);
    if (state.portraitEgressId) ids.add(state.portraitEgressId);
    try {
      for (const item of parseEgressList(await listEgressRaw(this.env, state.id))) {
        if (isActiveHealth(item.status) || item.egressId === state.egressId || item.egressId === state.portraitEgressId) {
          ids.add(item.egressId);
        }
      }
    } catch (err) {
      console.warn("list egress on stop", err);
    }
    for (const id of ids) {
      try {
        await stopEgress(this.env, id);
      } catch (err) {
        console.warn("stop egress", err);
      }
    }
  }

  private async scheduleWatch(when: number): Promise<void> {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (typeof existing === "number" && existing <= when && existing > Date.now()) return;
      await this.ctx.storage.setAlarm(when);
    } catch {
      /* tests stub storage without alarms */
    }
  }

  private async clearWatch(): Promise<void> {
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      /* tests stub storage without alarms */
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
    const raw = (await this.ctx.storage.get<StudioState>("state")) ?? null;
    return raw ? normalizeStudio(raw) : null;
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
