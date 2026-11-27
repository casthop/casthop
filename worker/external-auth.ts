import type { Context } from "hono";
import type { AppEnv } from "./types";
import { claimJti, allowRate } from "./db";
import { createSession, findOrCreateEmailAccount } from "./auth";
import { externalAuthConfig, safeNextPath, verifyExternalToken } from "./hosted";
import { requestIp, SIGNIN_WINDOW_MS } from "./security";

const EXTERNAL_IP_MAX = 30;

/** GET /api/auth/external: one-time signed token from the control plane becomes a normal session. */
export async function handleExternalAuth(c: Context<AppEnv>): Promise<Response> {
  const config = externalAuthConfig(c.env);
  if (!config) return c.json({ error: "not found" }, 404);
  if (!(await allowRate(c.env.DB, `extauth:ip:${requestIp(c)}`, EXTERNAL_IP_MAX, SIGNIN_WINDOW_MS))) {
    return c.json({ error: "too many attempts" }, 429);
  }
  const claims = await verifyExternalToken(config, c.req.query("token") ?? "");
  if (!claims || !(await claimJti(c.env.DB, claims.jti, claims.exp))) {
    return c.json({ error: "invalid_token" }, 401);
  }
  const account = await findOrCreateEmailAccount(c.env, claims.email, claims.name ?? undefined);
  c.header("Set-Cookie", await createSession(c, account), { append: true });
  return c.redirect(safeNextPath(c.req.query("next")));
}
