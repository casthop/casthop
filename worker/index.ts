import { Hono, type Context } from "hono";
import type { AppEnv, Env, PublicStudio } from "./types";
import { MAX_ON_STAGE } from "./types";
import { StudioDurableObject } from "./studio";
import {
  asEmail,
  asIdentity,
  asName,
  clearCookie,
  devKeyGuardError,
  hostKeyFor,
  hostIdentityFor,
  isHostIdentity,
  isSecureRequest,
  OAUTH_COOKIE,
  originAllowed,
  publicOrigin,
  randomId,
  requestIp,
  sha256hex,
  TOKEN_IP_MAX,
  TOKEN_IP_WINDOW_MS,
} from "./security";
import {
  guestSecretFor,
  guestSecretOk,
  livekitHealth,
  GUEST_TOKEN_TTL_SEC,
  HOST_TOKEN_TTL_SEC,
  isParticipantMissingError,
  mintParticipantToken,
  publishPermissionError,
  removeParticipant,
  retryUpdateParticipantPublish,
  updateParticipantPublish,
  verifyLivekitWebhook,
  verifyParticipantToken,
} from "./livekit";
import { isComposerIdentity, webhookRoomName } from "./egress";
import {
  accountByEmail,
  accountById,
  allowRate,
  deleteCohost,
  deleteInvite,
  ensureDb,
  insertInvite,
  insertMember,
  insertStudioRow,
  invitesForStudio,
  listStudiosFor,
  memberFor,
  membersOf,
} from "./db";
import { MailSendError, mailerFor } from "./mail";
import {
  attachSessionCookie,
  consumeMagicToken,
  createSession,
  magicConfirmPage,
  magicLinkPending,
  destroySession,
  finishGithub,
  githubConfigured,
  hostAuth,
  issueMagicLink,
  loadSession,
  startGithub,
} from "./auth";
import { destChatConfigured } from "./chat-ingest";
import {
  concatChunkStream,
  downloadChunkKeys,
  downloadName,
  ISO_CHUNK_MAX,
  ISO_CHUNK_MAX_BYTES,
  ISO_CHUNK_WINDOW_MS,
  isoChunkKey,
  isoPrefix,
  listIsoChunkKeys,
  parseChunkIndex,
} from "./iso";
import type { IsoTrack } from "./types";

export { StudioDurableObject };

export const app = new Hono<AppEnv>();

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

function errorStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err) {
    const status = (err as Error & { status: unknown }).status;
    if (typeof status === "number") return status;
  }
}

function rateError(err: unknown): err is Error & { status: number } {
  return errorStatus(err) === 429;
}

app.use("/api/*", async (c, next) => {
  const err = devKeyGuardError(c.env);
  if (err) return c.json({ error: err }, 503);
  await ensureDb(c.env.DB);
  await next();
  const cookie = c.get("sessionCookie");
  if (cookie) c.res.headers.append("Set-Cookie", cookie);
});

app.get("/api/health", async (c) => {
  const lk = await livekitHealth(c.env);
  return c.json({
    ok: lk.ok,
    livekit: { ok: lk.ok },
    maxOnStage: MAX_ON_STAGE,
  });
});

app.get("/api/config", async (c) => {
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  return c.json({
    livekitUrl: c.env.PUBLIC_LIVEKIT_URL,
    maxOnStage: MAX_ON_STAGE,
    github: githubConfigured(c.env),
    signedIn: Boolean(sess),
    destinationChat: destChatConfigured(c.env),
  });
});

app.get("/api/auth/me", async (c) => {
  const sess = await loadSession(c);
  if (!sess) {
    c.header("Set-Cookie", await destroySession(c), { append: true });
    return c.json({ error: "signed out" }, 401);
  }
  attachSessionCookie(c, sess.cookie);
  return c.json({
    id: sess.account.id,
    email: sess.account.email,
    name: sess.account.name,
    githubId: sess.account.githubId,
  });
});

app.post("/api/auth/magic-link", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = asEmail(body.email);
  if (!email) return c.json({ error: "valid email required" }, 400);
  try {
    const result = await issueMagicLink(c, email);
    return c.json(result);
  } catch (err) {
    if (rateError(err)) return c.json({ error: "too many attempts" }, 429);
    if (errorStatus(err) === 503) return c.json({ error: "PUBLIC_ORIGIN required" }, 503);
    if (err instanceof MailSendError) return c.json({ error: "could not send sign-in email" }, 502);
    throw err;
  }
});

app.get("/api/auth/callback", async (c) => {
  const token = c.req.query("token") ?? "";
  if (!(await magicLinkPending(c, token))) return c.redirect("/?auth=invalid");
  return c.html(magicConfirmPage(token));
});

app.post("/api/auth/callback", async (c) => {
  if (!originAllowed(c.req.raw)) return c.json({ error: "bad origin" }, 403);
  let token = c.req.query("token") ?? "";
  if (!token) {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const value = (form as { token?: unknown }).token;
    if (typeof value === "string") token = value;
  }
  const account = token ? await consumeMagicToken(c, token) : null;
  if (!account) return c.redirect("/?auth=invalid");
  const cookie = await createSession(c, account);
  c.header("Set-Cookie", cookie, { append: true });
  return c.redirect("/");
});

app.get("/api/auth/github", async (c) => {
  try {
    const started = await startGithub(c);
    if (!started) return c.json({ error: "GitHub sign-in is not configured" }, 404);
    c.header("Set-Cookie", started.cookie, { append: true });
    return c.redirect(started.url);
  } catch (err) {
    if (rateError(err)) return c.json({ error: "too many attempts" }, 429);
    if (errorStatus(err) === 503) return c.json({ error: "PUBLIC_ORIGIN required" }, 503);
    throw err;
  }
});

app.get("/api/auth/github/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const account = code ? await finishGithub(c, code, state).catch(() => null) : null;
  c.header("Set-Cookie", clearCookie(OAUTH_COOKIE, isSecureRequest(c.req.url)), { append: true });
  if (!account) return c.redirect("/?auth=invalid");
  const cookie = await createSession(c, account);
  c.header("Set-Cookie", cookie, { append: true });
  return c.redirect("/");
});

app.post("/api/auth/logout", async (c) => {
  const sess = await loadSession(c);
  const cookie = await destroySession(c, sess?.sessionId);
  c.header("Set-Cookie", cookie, { append: true });
  return c.json({ ok: true });
});

app.get("/api/studios", async (c) => {
  const sess = await loadSession(c);
  if (!sess) return c.json({ error: "sign in required" }, 401);
  attachSessionCookie(c, sess.cookie);
  const studios = await listStudiosFor(c.env.DB, sess.account.id);
  return c.json({ studios });
});

app.post("/api/studios", async (c) => {
  const sess = await loadSession(c);
  if (!sess) return c.json({ error: "sign in required" }, 401);
  attachSessionCookie(c, sess.cookie);
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = asName(body.title, "Weekly product update");
  const id = randomId(8).toLowerCase();
  const hostKey = await hostKeyFor(c.env, id);
  const hostKeyHash = await sha256hex(hostKey);
  const createdAt = Date.now();
  await insertStudioRow(c.env.DB, id, title, createdAt, sess.account.id);
  await insertMember(c.env.DB, id, sess.account.id, "owner", createdAt);
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
    role: "owner" as const,
    hostUrl: `${origin}/studio/${id}`,
    guestUrl: `${origin}/join/${id}`,
  });
});

app.get("/api/studios/:id", async (c) => {
  // Studio chrome + compositor poll (~1s). Time is D1 session + DO, not JWT CPU.
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (host) {
    const snap = await doAction(c.env, id, "host-snapshot", { hostKey: host.hostKey });
    if (snap.status === 403) return c.json({ error: "host access required" }, 403);
    if (!snap.ok) return new Response(snap.body, { status: snap.status, headers: snap.headers });
    const data = (await snap.json()) as { state: PublicStudio };
    return c.json({ ...data.state, viewerRole: host.role });
  }
  const res = await studioStub(c.env, id).fetch(`https://studio/${id}`);
  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  const state = (await res.json()) as PublicStudio;
  return c.json({ ...state, viewerRole: "guest" as const });
});

app.get("/api/studios/:id/ws", async (c) => {
  const id = c.req.param("id");
  return studioStub(c.env, id).fetch(c.req.raw);
});

app.post("/api/studios/:id/token", async (c) => {
  // Guest join + host refresh. JWT is WebCrypto HMAC; workers-rs did not beat it (MEASUREMENTS.md).
  const id = c.req.param("id");
  const ip = requestIp(c);
  if (!(await allowRate(c.env.DB, `token:ip:${ip}`, TOKEN_IP_MAX, TOKEN_IP_WINDOW_MS))) {
    return c.json({ error: "too many joins" }, 429);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    role?: "host" | "guest";
    identity?: string;
    guestSecret?: string;
  };
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);

  if (body.role === "host") {
    const host = await hostAuth(c.env, id, sess?.account);
    if (!host) return c.json({ error: "host access required" }, 403);
    const name = asName(body.name, host.name || "Host");
    const identity = host.identity;
    const joined = await doAction(c.env, id, "join", { identity, name, role: "host", hostKey: host.hostKey });
    if (!joined.ok) return new Response(joined.body, { status: joined.status, headers: joined.headers });
    const token = await mintParticipantToken({
      env: c.env,
      identity,
      name,
      room: id,
      canPublish: true,
      canPublishData: true,
      roomAdmin: true,
      ttlSec: HOST_TOKEN_TTL_SEC,
    });
    return c.json({
      token,
      identity,
      name,
      role: "host" as const,
      url: c.env.PUBLIC_LIVEKIT_URL,
      canPublish: true,
      expiresIn: HOST_TOKEN_TTL_SEC,
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

  const name = asName(body.name, "Guest");
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
    ttlSec: GUEST_TOKEN_TTL_SEC,
  });
  return c.json({
    token,
    identity,
    name,
    role: "guest" as const,
    url: c.env.PUBLIC_LIVEKIT_URL,
    canPublish,
    guestSecret,
    expiresIn: GUEST_TOKEN_TTL_SEC,
  });
});

function waitUntil(c: Context<AppEnv>, task: () => Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task());
  } catch {
    /* app.request tests have no ExecutionContext */
  }
}

/** Latest onStage from studio state, so a delayed retry cannot revive a later off. */
async function storedStagePublish(env: Env, studioId: string, identity: string): Promise<boolean | null> {
  const res = await studioStub(env, studioId).fetch(`https://studio/${studioId}`);
  if (!res.ok) return null;
  const state = (await res.json()) as PublicStudio;
  const person = state.participants.find((p) => p.identity === identity);
  return person ? person.onStage : null;
}

app.post("/api/studios/:id/stage", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { identity?: string; on?: boolean };
  const res = await doAction(c.env, id, "stage", { ...body, hostKey: host.hostKey });
  if (res.ok && body.identity) {
    try {
      await updateParticipantPublish(c.env, id, body.identity, Boolean(body.on));
    } catch (err) {
      if (!isParticipantMissingError(err)) {
        const state = (await res.json()) as PublicStudio;
        return c.json({ ...state, warning: publishPermissionError(err) });
      }
      const identity = body.identity;
      waitUntil(c, () =>
        retryUpdateParticipantPublish(c.env, id, identity, () => storedStagePublish(c.env, id, identity)).catch(
          (retryErr) => {
            console.warn("updateParticipantPublish", retryErr);
          },
        ),
      );
    }
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/layout", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "layout", { ...(body as object), hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/destinations", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "destinations", { ...(body as object), hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/banner", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const res = await doAction(c.env, id, "banner", { ...(body as object), hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/pin", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { chatId?: unknown };
  const res = await doAction(c.env, id, "pin", { chatId: body.chatId ?? null, hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/chat", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (host) {
    body.hostKey = host.hostKey;
    body.identity = host.identity;
  } else {
    delete body.hostKey;
    if (!(typeof body.guestSecret === "string" && typeof body.identity === "string")) {
      return c.json({ error: "chat auth required" }, 403);
    }
  }
  const res = await doAction(c.env, id, "chat", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/livekit/webhook", async (c) => {
  // LiveKit / Egress events. CPU is JWT verify + SHA-256; I/O is the Durable Object.
  const raw = await c.req.text();
  if (!(await verifyLivekitWebhook(c.env, c.req.header("Authorization") ?? c.req.header("Authorize"), raw))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const room = webhookRoomName(body);
  if (!room) return c.json({ ok: true });
  const res = await doAction(c.env, room, "webhook", body);
  if (res.status === 404) return c.json({ ok: true });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/egress-beat", async (c) => {
  // Compositor posts this every 1s while live. Auth is a participant JWT.
  const id = c.req.param("id");
  const claims = await verifyParticipantToken(c.env, c.req.header("Authorization"));
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  if (claims.room !== id || !isComposerIdentity(claims.identity)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { egressId?: unknown };
  const egressId = typeof body.egressId === "string" ? body.egressId : "";
  const res = await doAction(c.env, id, "egress-beat", { identity: claims.identity, egressId });
  if (res.status === 404) return c.json({ error: "Studio not found" }, 404);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

async function isoCaller(
  c: Context<AppEnv>,
  id: string,
  body?: { identity?: unknown; guestSecret?: unknown },
): Promise<{ identity: string; guestSecret?: string; hostKey?: string } | Response> {
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (host) return { identity: host.identity, hostKey: host.hostKey };
  const identity = asIdentity(body?.identity ?? c.req.header("x-casthop-identity"));
  const guestSecret =
    (typeof body?.guestSecret === "string" ? body.guestSecret : "") || c.req.header("x-casthop-guest-secret") || "";
  if (!identity || !guestSecret) return c.json({ error: "iso auth required" }, 403);
  if (isHostIdentity(identity)) return c.json({ error: "host identity reserved" }, 403);
  if (!(await guestSecretOk(c.env, id, identity, guestSecret))) return c.json({ error: "iso auth required" }, 403);
  return { identity, guestSecret };
}

app.post("/api/studios/:id/iso-pref", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { separateRecordings?: unknown };
  const res = await doAction(c.env, id, "iso-pref", { separateRecordings: body.separateRecordings, hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/iso", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const who = await isoCaller(c, id, body);
  if (who instanceof Response) return who;
  const res = await doAction(c.env, id, "iso-start", {
    ...body,
    identity: who.identity,
    guestSecret: who.guestSecret,
    hostKey: who.hostKey,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.put("/api/studios/:id/iso/:trackId/chunks/:index", async (c) => {
  const id = c.req.param("id");
  const trackId = c.req.param("trackId");
  const index = parseChunkIndex(c.req.param("index"));
  if (index === null) return c.json({ error: "chunk required" }, 400);
  const who = await isoCaller(c, id);
  if (who instanceof Response) return who;
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > ISO_CHUNK_MAX_BYTES) return c.json({ error: "chunk too large" }, 413);
  if (!(await allowRate(c.env.DB, `iso:${id}:${who.identity}`, ISO_CHUNK_MAX, ISO_CHUNK_WINDOW_MS))) {
    return c.json({ error: "too many uploads" }, 429);
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > ISO_CHUNK_MAX_BYTES) return c.json({ error: "chunk too large" }, 413);
  if (buf.byteLength < 1) return c.json({ error: "empty chunk" }, 400);
  const res = await doAction(c.env, id, "iso-chunk", {
    identity: who.identity,
    guestSecret: who.guestSecret,
    hostKey: who.hostKey,
    trackId,
    index,
    bytes: buf.byteLength,
  });
  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  await c.env.RECORDINGS.put(isoChunkKey(id, trackId, index), buf);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.post("/api/studios/:id/iso/:trackId/complete", async (c) => {
  const id = c.req.param("id");
  const trackId = c.req.param("trackId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const who = await isoCaller(c, id, body);
  if (who instanceof Response) return who;
  const res = await doAction(c.env, id, "iso-complete", {
    identity: who.identity,
    guestSecret: who.guestSecret,
    hostKey: who.hostKey,
    trackId,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/api/studios/:id/recordings", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const res = await doAction(c.env, id, "iso-list", { hostKey: host.hostKey });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/api/studios/:id/recordings/iso/:trackId", async (c) => {
  const id = c.req.param("id");
  const trackId = c.req.param("trackId");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const res = await doAction(c.env, id, "iso-get", { hostKey: host.hostKey, trackId });
  if (!res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
  const data = (await res.json()) as { track: IsoTrack };
  const keys = downloadChunkKeys(await listIsoChunkKeys(c.env.RECORDINGS, id, trackId), isoPrefix(id, trackId), data.track.chunks);
  if (!keys.length) return c.json({ error: "track not found" }, 404);
  const filename = downloadName(data.track);
  return new Response(concatChunkStream(c.env.RECORDINGS, keys), {
    headers: {
      "Content-Type": data.track.mimeType.split(";")[0]?.trim() || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

app.post("/api/studios/:id/live", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { live?: boolean };
  if (typeof body.live !== "boolean") return c.json({ error: "live required" }, 400);
  const hostKey = host.hostKey;

  const action = body.live ? "start-live" : "stop-live";
  const res = await doAction(c.env, id, action, { hostKey });
  if (res.status === 404) return c.json({ error: "Studio not found" }, 404);
  if (res.status === 403) return c.json({ error: "host access required" }, 403);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

app.get("/api/studios/:id/cohosts", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const members = await membersOf(c.env.DB, id);
  const pending = await invitesForStudio(c.env.DB, id);
  return c.json({ members, pending });
});

app.post("/api/studios/:id/cohosts", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!sess || !host || host.role !== "owner") return c.json({ error: "owner required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = asEmail(body.email);
  if (!email) return c.json({ error: "valid email required" }, 400);
  if (sess.account.email === email) return c.json({ error: "already a member" }, 409);
  const existingAccount = await accountByEmail(c.env.DB, email);
  if (existingAccount) {
    const already = await memberFor(c.env.DB, id, existingAccount.id);
    if (already) return c.json({ error: "already a member" }, 409);
    await insertMember(c.env.DB, id, existingAccount.id, "cohost", Date.now());
    return c.json({ ok: true, member: { accountId: existingAccount.id, email, name: existingAccount.name, role: "cohost" } });
  }
  const origin = publicOrigin(c.env, c.req.url);
  if (!origin) return c.json({ error: "PUBLIC_ORIGIN required" }, 503);
  const pending = await invitesForStudio(c.env.DB, id);
  if (pending.some((p) => p.email === email)) return c.json({ error: "already invited" }, 409);
  await insertInvite(c.env.DB, randomId(10), id, email, Date.now());
  try {
    await mailerFor(c.env).send({
      to: email,
      subject: "Co-host invite for a Casthop studio",
      text: `You were invited to co-host a studio. Sign in at ${origin} with this email, then open ${origin}/studio/${id}\n`,
    });
  } catch (err) {
    await deleteInvite(c.env.DB, id, email);
    if (err instanceof MailSendError) return c.json({ error: "could not send invite" }, 502);
    throw err;
  }
  return c.json({ ok: true, pending: true, email });
});

app.delete("/api/studios/:id/cohosts/:accountId", async (c) => {
  const id = c.req.param("id");
  const accountId = c.req.param("accountId");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host || host.role !== "owner") return c.json({ error: "owner required" }, 403);
  const member = await memberFor(c.env.DB, id, accountId);
  if (member?.role !== "cohost") return c.json({ error: "co-host not found" }, 404);
  const target = await accountById(c.env.DB, accountId);
  await deleteCohost(c.env.DB, id, accountId);
  if (target?.email) await deleteInvite(c.env.DB, id, target.email);
  const identity = hostIdentityFor(accountId, "cohost");
  try {
    await removeParticipant(c.env, id, identity);
  } catch {
    /* not in the room */
  }
  await doAction(c.env, id, "remove", { hostKey: host.hostKey, identity });
  return c.json({ ok: true });
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
