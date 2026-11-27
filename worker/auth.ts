import type { Context } from "hono";
import type { Account, AppEnv, Env, MemberRole } from "./types";
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
  SIGNIN_TO_MAX,
  SESSION_PREV_GRACE_MS,
  allowDevLogin,
  asEmail,
  asName,
  clearCookie,
  cookieValue,
  hostIdentityFor,
  hostKeyFor,
  ipBucket,
  isLoopbackHost,
  isLoopbackUrl,
  isSecureRequest,
  publicOrigin,
  requestIp,
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
  refundRate,
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

type AppCtx = Context<AppEnv>;

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
    const rotated = await rotateSession(
      c.env.DB,
      row.id,
      {
        tokenHash: nextHash,
        prevHash: row.token_hash,
        rotatedAt: now,
        expiresAt: now + SESSION_TTL_MS,
      },
      row.token_hash,
    );
    if (!rotated) return { account, sessionId: row.id };
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
  if (cookie) c.set("sessionCookie", cookie);
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
  if (existing) return existing;
  const account: Account = {
    id: randomId(12),
    email,
    name: name || nameFromEmail(email),
    githubId: null,
    createdAt: Date.now(),
  };
  await insertAccount(env.DB, account);
  return account;
}

export async function findOrCreateGithubAccount(env: Env, github: { id: string; email: string | null; name: string }): Promise<Account | null> {
  const byGithub = await accountByGithub(env.DB, github.id);
  if (byGithub) return byGithub;
  if (github.email) {
    const byEmail = await accountByEmail(env.DB, github.email);
    if (byEmail) {
      if (byEmail.githubId) return null;
      await updateAccountGithub(env.DB, byEmail.id, github.id, github.name || byEmail.name);
      return { ...byEmail, githubId: github.id, name: github.name || byEmail.name };
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
  return account;
}

function showDevLogin(c: AppCtx, ip: string): boolean {
  // In the Vite dev server the Host header and CF-Connecting-IP come from the client
  // (Miniflare stamps 127.0.0.1), so they cannot prove a local peer. Opt in explicitly too.
  return (
    c.env.CASTHOP_DEV_LOGIN === "1" &&
    allowDevLogin(c.env) &&
    isLoopbackUrl(c.req.url) &&
    (ip === "local" || isLoopbackHost(ip))
  );
}

export async function issueMagicLink(c: AppCtx, email: string): Promise<{ ok: true; devLogin?: string }> {
  const ip = requestIp(c);
  // One IPv6 host holds a whole /64; key limits on the network, not each address in it.
  const client = ipBucket(ip);
  if (!(await allowRate(c.env.DB, `signin:ip:${client}`, SIGNIN_IP_MAX, SIGNIN_WINDOW_MS))) {
    return Promise.reject(Object.assign(new Error("too many attempts"), { status: 429 }));
  }
  if (!(await allowRate(c.env.DB, `signin:email:${email}:${client}`, SIGNIN_EMAIL_MAX, SIGNIN_WINDOW_MS))) {
    return { ok: true };
  }
  // Take the inbox slot before send so parallel clients cannot race past the cap.
  if (!(await allowRate(c.env.DB, `signin:to:${email}`, SIGNIN_TO_MAX, SIGNIN_WINDOW_MS))) {
    return { ok: true };
  }
  try {
    const token = randomId(32);
    const tokenHash = await sha256hex(token);
    const now = Date.now();
    await insertMagic(c.env.DB, tokenHash, email, now + MAGIC_TTL_MS, now);
    const origin = publicOrigin(c.env, c.req.url);
    if (!origin) throw Object.assign(new Error("PUBLIC_ORIGIN required"), { status: 503 });
    const loginPath = `/api/auth/callback?token=${encodeURIComponent(token)}`;
    const loginUrl = `${origin}${loginPath}`;
    await mailerFor(c.env).send({
      to: email,
      subject: "Sign in to Casthop",
      text: `Open this link and click Sign in. It expires in 15 minutes.\n\n${loginUrl}\n`,
    });
    return showDevLogin(c, ip) ? { ok: true, devLogin: loginPath } : { ok: true };
  } catch (err) {
    await refundRate(c.env.DB, `signin:to:${email}`, SIGNIN_WINDOW_MS);
    throw err;
  }
}

export async function magicLinkPending(c: AppCtx, token: string): Promise<boolean> {
  if (!token) return false;
  const row = await magicByHash(c.env.DB, await sha256hex(token));
  const now = Date.now();
  return Boolean(row && row.expires_at >= now && !row.consumed_at);
}

export function magicConfirmPage(token: string): string {
  const safe = token.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Casthop</title>
<style>
  html,body{margin:0;min-height:100%;background:#f4f4f6;color:#16171c;font-family:"Public Sans","Segoe UI",sans-serif}
  main{max-width:420px;margin:0 auto;padding:28px}
  h1{margin:18vh 0 12px;font-size:44px;letter-spacing:-.045em;font-weight:650}
  p{color:#5c616b;font-size:16px;margin:0 0 28px;line-height:1.45}
  button{border:0;border-radius:999px;height:44px;padding:0 18px;background:#6d64f7;color:#fff;font:inherit;font-weight:600;cursor:pointer}
</style>
<main>
  <h1>Sign in</h1>
  <p>This confirms it is you, not a mail scanner.</p>
  <form method="post" action="/api/auth/callback">
    <input type="hidden" name="token" value="${safe}">
    <button type="submit">Sign in</button>
  </form>
</main>
`;
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
  const ip = ipBucket(requestIp(c));
  if (!(await allowRate(c.env.DB, `signin:ip:${ip}`, SIGNIN_IP_MAX, SIGNIN_WINDOW_MS))) {
    throw Object.assign(new Error("too many attempts"), { status: 429 });
  }
  const state = randomId(24);
  await insertOauth(c.env.DB, state, Date.now() + OAUTH_TTL_MS);
  const origin = publicOrigin(c.env, c.req.url);
  if (!origin) throw Object.assign(new Error("PUBLIC_ORIGIN required"), { status: 503 });
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
  const origin = publicOrigin(c.env, c.req.url);
  if (!origin) return null;
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
