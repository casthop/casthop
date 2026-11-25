import type { Context } from "hono";
import type { Account, Env, MemberRole } from "./types";
import {
  SESSION_COOKIE,
  OAUTH_COOKIE,
  SESSION_TTL_MS,
  SESSION_ROTATE_MS,
  MAGIC_TTL_MS,
  OAUTH_TTL_MS,
  SIGNIN_WINDOW_MS,
  SIGNIN_IP_MAX,
  SIGNIN_EMAIL_MAX,
  SESSION_PREV_GRACE_MS,
  allowDevLogin,
  asEmail,
  asName,
  clearCookie,
  clientIp,
  cookieValue,
  hostIdentityFor,
  hostKeyFor,
  isSecureRequest,
  nameFromEmail,
  randomId,
  setCookie,
  sha256hex,
} from "./security";
import {
  accountByEmail,
  accountByGithub,
  accountById,
  allowRate,
  applyInvites,
  consumeMagic,
  deleteOauth,
  deleteSession,
  ensureDb,
  insertAccount,
  insertMagic,
  insertOauth,
  insertSession,
  magicByHash,
  memberFor,
  oauthByState,
  rotateSession,
  sessionByTokenHash,
  updateAccountGithub,
} from "./db";
import { mailerFor } from "./mail";

export type Authed = {
  account: Account;
  sessionId: string;
  cookie?: string;
};

type AppCtx = Context<{ Bindings: Env }>;

export function githubConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim());
}

export async function loadSession(c: AppCtx): Promise<Authed | null> {
  await ensureDb(c.env.DB);
  const token = cookieValue(c.req.header("Cookie"), SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await sessionByTokenHash(c.env.DB, hash);
  const now = Date.now();
  if (!row || row.expires_at < now) {
    if (row) await deleteSession(c.env.DB, row.id);
    return null;
  }
  const presentedPrev = hash === row.prev_token_hash;
  if (presentedPrev && now - row.rotated_at > SESSION_PREV_GRACE_MS) {
    return null;
  }
  const account = await accountById(c.env.DB, row.account_id);
  if (!account) {
    await deleteSession(c.env.DB, row.id);
    return null;
  }
  const presentedCurrent = hash === row.token_hash;
  if (presentedCurrent && now - row.rotated_at >= SESSION_ROTATE_MS) {
    const nextToken = randomId(32);
    const nextHash = await sha256hex(nextToken);
    await rotateSession(c.env.DB, row.id, {
      tokenHash: nextHash,
      prevHash: row.token_hash,
      rotatedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return {
      account,
      sessionId: row.id,
      cookie: setCookie(SESSION_COOKIE, nextToken, {
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: isSecureRequest(c.req.url),
      }),
    };
  }
  return { account, sessionId: row.id };
}

export function attachSessionCookie(c: AppCtx, cookie?: string): void {
  if (cookie) c.header("Set-Cookie", cookie, { append: true });
}

export async function createSession(c: AppCtx, account: Account): Promise<string> {
  const now = Date.now();
  const token = randomId(32);
  const tokenHash = await sha256hex(token);
  await insertSession(c.env.DB, {
    id: randomId(12),
    account_id: account.id,
    token_hash: tokenHash,
    prev_token_hash: null,
    expires_at: now + SESSION_TTL_MS,
    created_at: now,
    rotated_at: now,
  });
  return setCookie(SESSION_COOKIE, token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: isSecureRequest(c.req.url),
  });
}

export async function destroySession(c: AppCtx, sessionId?: string): Promise<string> {
  if (sessionId) await deleteSession(c.env.DB, sessionId);
  return clearCookie(SESSION_COOKIE, isSecureRequest(c.req.url));
}

export async function findOrCreateEmailAccount(env: Env, email: string, name?: string): Promise<Account> {
  const existing = await accountByEmail(env.DB, email);
  if (existing) {
    await applyInvites(env.DB, existing);
    return existing;
  }
  const account: Account = {
    id: randomId(12),
    email,
    name: name || nameFromEmail(email),
    githubId: null,
    createdAt: Date.now(),
  };
  await insertAccount(env.DB, account);
  await applyInvites(env.DB, account);
  return account;
}

export async function findOrCreateGithubAccount(env: Env, github: { id: string; email: string | null; name: string }): Promise<Account> {
  const byGithub = await accountByGithub(env.DB, github.id);
  if (byGithub) {
    await applyInvites(env.DB, byGithub);
    return byGithub;
  }
  if (github.email) {
    const byEmail = await accountByEmail(env.DB, github.email);
    if (byEmail) {
      await updateAccountGithub(env.DB, byEmail.id, github.id, github.name || byEmail.name);
      const linked = { ...byEmail, githubId: github.id, name: github.name || byEmail.name };
      await applyInvites(env.DB, linked);
      return linked;
    }
  }
  const account: Account = {
    id: randomId(12),
    email: github.email,
    name: asName(github.name, "Host"),
    githubId: github.id,
    createdAt: Date.now(),
  };
  await insertAccount(env.DB, account);
  await applyInvites(env.DB, account);
  return account;
}

export async function issueMagicLink(c: AppCtx, email: string): Promise<{ ok: true; devLogin?: string }> {
  const ip = clientIp(c.req.raw.headers);
  if (!(await allowRate(c.env.DB, `signin:ip:${ip}`, SIGNIN_IP_MAX, SIGNIN_WINDOW_MS))) {
    return Promise.reject(Object.assign(new Error("too many attempts"), { status: 429 }));
  }
  if (!(await allowRate(c.env.DB, `signin:email:${email}`, SIGNIN_EMAIL_MAX, SIGNIN_WINDOW_MS))) {
    return Promise.reject(Object.assign(new Error("too many attempts"), { status: 429 }));
  }
  const token = randomId(32);
  const tokenHash = await sha256hex(token);
  const now = Date.now();
  await insertMagic(c.env.DB, tokenHash, email, now + MAGIC_TTL_MS, now);
  const origin = new URL(c.req.url).origin;
  const loginPath = `/api/auth/callback?token=${encodeURIComponent(token)}`;
  const loginUrl = `${origin}${loginPath}`;
  await mailerFor(c.env).send({
    to: email,
    subject: "Sign in to Casthop",
    text: `Open this link to sign in. It expires in 15 minutes.\n\n${loginUrl}\n`,
  });
  return allowDevLogin(c.env) ? { ok: true, devLogin: loginPath } : { ok: true };
}

export async function consumeMagicToken(c: AppCtx, token: string): Promise<Account | null> {
  const tokenHash = await sha256hex(token);
  const row = await magicByHash(c.env.DB, tokenHash);
  const now = Date.now();
  if (!row || row.expires_at < now) return null;
  const claimed = await consumeMagic(c.env.DB, tokenHash, now);
  if (!claimed) return null;
  return findOrCreateEmailAccount(c.env, row.email);
}

export async function startGithub(c: AppCtx): Promise<{ url: string; cookie: string } | null> {
  if (!githubConfigured(c.env)) return null;
  const ip = clientIp(c.req.raw.headers);
  if (!(await allowRate(c.env.DB, `signin:ip:${ip}`, SIGNIN_IP_MAX, SIGNIN_WINDOW_MS))) {
    throw Object.assign(new Error("too many attempts"), { status: 429 });
  }
  const state = randomId(24);
  await insertOauth(c.env.DB, state, Date.now() + OAUTH_TTL_MS);
  const origin = new URL(c.req.url).origin;
  const redirect = `${origin}/api/auth/github/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  return {
    url: url.toString(),
    cookie: setCookie(OAUTH_COOKIE, state, {
      maxAge: Math.floor(OAUTH_TTL_MS / 1000),
      secure: isSecureRequest(c.req.url),
    }),
  };
}

export async function finishGithub(c: AppCtx, code: string, state: string): Promise<Account | null> {
  if (!githubConfigured(c.env)) return null;
  const cookieState = cookieValue(c.req.header("Cookie"), OAUTH_COOKIE);
  if (!state || !cookieState || cookieState !== state) return null;
  const row = await oauthByState(c.env.DB, state);
  await deleteOauth(c.env.DB, state);
  if (!row || row.expires_at < Date.now()) return null;
  const origin = new URL(c.req.url).origin;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/api/auth/github/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenBody.access_token) return null;
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/json", "User-Agent": "casthop" },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string; name?: string; email?: string | null };
  if (!user.id) return null;
  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/json", "User-Agent": "casthop" },
  });
  const emailsRaw = (await emailsRes.json().catch(() => [])) as { email?: string; primary?: boolean; verified?: boolean }[];
  const emails = Array.isArray(emailsRaw) ? emailsRaw : [];
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  const email = asEmail(primary?.email);
  if (!email) return null;
  return findOrCreateGithubAccount(c.env, {
    id: String(user.id),
    email,
    name: user.name || user.login || "Host",
  });
}

export async function studioMember(env: Env, studioId: string, account: Account | undefined): Promise<{ role: MemberRole } | null> {
  if (!account) return null;
  return memberFor(env.DB, studioId, account.id);
}

export async function hostAuth(
  env: Env,
  studioId: string,
  account: Account | undefined,
): Promise<{ role: MemberRole; hostKey: string; identity: string; name: string } | null> {
  const member = await studioMember(env, studioId, account);
  if (!member || !account) return null;
  return {
    role: member.role,
    hostKey: await hostKeyFor(env, studioId),
    identity: hostIdentityFor(account.id, member.role),
    name: account.name,
  };
}
