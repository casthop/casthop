import { Hono } from "hono";
import type { Env, PublicStudio } from "./types";
import { MAX_ON_STAGE } from "./types";
import { StudioDurableObject } from "./studio";
import {
  asEmail,
  asName,
  clearCookie,
  devKeyGuardError,
  hostKeyFor,
  isHostIdentity,
  isSecureRequest,
  OAUTH_COOKIE,
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
  mintParticipantToken,
  startRoomComposite,
  stopEgress,
  updateParticipantPublish,
} from "./livekit";
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
  destroySession,
  finishGithub,
  githubConfigured,
  hostAuth,
  issueMagicLink,
  loadSession,
  startGithub,
} from "./auth";

export { StudioDurableObject };

export const app = new Hono<{ Bindings: Env }>();

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

function rateError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && "status" in err && (err as Error & { status: number }).status === 429;
}

app.use("/api/*", async (c, next) => {
  const err = devKeyGuardError(c.env);
  if (err) return c.json({ error: err }, 503);
  await ensureDb(c.env.DB);
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

app.get("/api/config", async (c) => {
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  return c.json({
    livekitUrl: c.env.PUBLIC_LIVEKIT_URL,
    maxOnStage: MAX_ON_STAGE,
    github: githubConfigured(c.env),
    signedIn: Boolean(sess),
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
    if (err instanceof MailSendError) return c.json({ error: "could not send sign-in email" }, 502);
    throw err;
  }
});

app.get("/api/auth/callback", async (c) => {
  const token = c.req.query("token") ?? "";
  const account = token ? await consumeMagicToken(c, token) : null;
  if (!account) {
    return c.redirect("/?auth=invalid");
  }
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
    throw err;
  }
});

app.get("/api/auth/github/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const account = code ? await finishGithub(c, code, state) : null;
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
      console.warn("updateParticipantPublish", err);
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

app.post("/api/studios/:id/live", async (c) => {
  const id = c.req.param("id");
  const sess = await loadSession(c);
  attachSessionCookie(c, sess?.cookie);
  const host = await hostAuth(c.env, id, sess?.account);
  if (!host) return c.json({ error: "host access required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { live?: boolean };
  if (typeof body.live !== "boolean") return c.json({ error: "live required" }, 400);
  const hostKey = host.hostKey;

  const snap = await doAction(c.env, id, "host-snapshot", { hostKey });
  if (snap.status === 404) return c.json({ error: "Studio not found" }, 404);
  if (!snap.ok) return c.json({ error: "host access required" }, 403);
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
  const pending = await invitesForStudio(c.env.DB, id);
  if (pending.some((p) => p.email === email)) return c.json({ error: "already invited" }, 409);
  await insertInvite(c.env.DB, randomId(10), id, email, Date.now());
  const origin = new URL(c.req.url).origin;
  try {
    await mailerFor(c.env).send({
      to: email,
      subject: "Co-host invite for a Casthop studio",
      text: `You were invited to co-host a studio. Sign in at ${origin} with this email, then open ${origin}/studio/${id}\n`,
    });
  } catch (err) {
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
  const target = await accountById(c.env.DB, accountId);
  await deleteCohost(c.env.DB, id, accountId);
  if (target?.email) await deleteInvite(c.env.DB, id, target.email);
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
