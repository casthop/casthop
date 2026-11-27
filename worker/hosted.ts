import { asEmail, asName, timingSafeEqual } from "./security";
import { asTenantId } from "./tenant";
import type { Env } from "./types";

/** Hosted-mode hooks. Every one is off unless its env var is set. */

export const EXTERNAL_TOKEN_MAX_TTL_SEC = 120;
export const SERVICE_CLOCK_SKEW_SEC = 300;
const MIN_SECRET_CHARS = 32;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export function signinExternal(env: Pick<Env, "CASTHOP_SIGNIN">): boolean {
  return env.CASTHOP_SIGNIN?.trim().toLowerCase() === "external";
}

/** `kid:secret,kid2:secret2`. Entries with a short secret or no kid are dropped. Null when nothing usable is left. */
export function parseKeyList(raw: string | undefined): Map<string, string> | null {
  const keys = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    const at = entry.indexOf(":");
    if (at < 1) continue;
    const kid = entry.slice(0, at);
    const secret = entry.slice(at + 1);
    if (secret.length >= MIN_SECRET_CHARS) keys.set(kid, secret);
  }
  return keys.size ? keys : null;
}

export function externalAuthConfig(env: Pick<Env, "CASTHOP_EXTERNAL_AUTH_KEYS" | "CASTHOP_EXTERNAL_AUTH_ISSUER">): { keys: Map<string, string>; issuer: string } | null {
  const keys = parseKeyList(env.CASTHOP_EXTERNAL_AUTH_KEYS);
  const issuer = env.CASTHOP_EXTERNAL_AUTH_ISSUER?.trim();
  return keys && issuer ? { keys, issuer } : null;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function b64urlToBytes(raw: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
  try {
    const bin = atob(raw.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (raw.length % 4)) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseJsonPart(raw: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(raw);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type ExternalClaims = {
  sub: string;
  email: string;
  name: string | null;
  jti: string;
  exp: number;
};

/** Checks a compact HS256 JWS from the control plane. Null for anything wrong; the caller does not say why. */
export async function verifyExternalToken(
  config: { keys: Map<string, string>; issuer: string },
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ExternalClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = parseJsonPart(h);
  if (!header || header.alg !== "HS256" || header.typ !== "JWT" || typeof header.kid !== "string") return null;
  const secret = config.keys.get(header.kid);
  const signature = b64urlToBytes(s);
  if (!secret || !signature) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const claims = parseJsonPart(p);
  if (!claims) return null;
  const { iss, aud, sub, exp, iat, jti, name, tenant } = claims;
  if (iss !== config.issuer || aud !== "casthop") return null;
  if (typeof sub !== "string" || !sub || sub.length > 255) return null;
  const email = asEmail(claims.email);
  if (!email) return null;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp <= nowSec || exp > nowSec + EXTERNAL_TOKEN_MAX_TTL_SEC) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof jti !== "string" || !jti || jti.length > 128) return null;
  if (name !== undefined && typeof name !== "string") return null;
  if (tenant !== undefined && !asTenantId(tenant)) return null;
  return { sub, email, name: typeof name === "string" && name.trim() ? asName(name, "Host") : null, jti, exp };
}

/** Same-origin relative paths only. Anything else goes home. */
export function safeNextPath(next: string | undefined): string {
  if (!next || next.length > 2048 || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(next)) return "/";
  return new URL(next, "http://local.invalid").origin === "http://local.invalid" ? next : "/";
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function serviceSignature(secret: string, parts: { timestamp: string; nonce: string; method: string; target: string; body: ArrayBuffer }): Promise<string> {
  const canonical = `${parts.timestamp}\n${parts.nonce}\n${parts.method}\n${parts.target}\n${await sha256Bytes(parts.body)}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(canonical));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns the nonce scope (kid + nonce) and its last valid moment when the signature checks out. */
export async function verifyServiceRequest(
  keys: Map<string, string>,
  request: Request,
  body: ArrayBuffer,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ nonceKey: string; nonceExpiresAt: number } | null> {
  const kid = request.headers.get("X-Casthop-Key-Id") ?? "";
  const timestamp = request.headers.get("X-Casthop-Timestamp") ?? "";
  const nonce = request.headers.get("X-Casthop-Nonce") ?? "";
  const signature = request.headers.get("X-Casthop-Signature") ?? "";
  const secret = keys.get(kid);
  if (!secret || !NONCE.test(nonce) || !/^\d{1,12}$/.test(timestamp)) return null;
  const ts = Number(timestamp);
  if (Math.abs(nowSec - ts) > SERVICE_CLOCK_SKEW_SEC) return null;
  const url = new URL(request.url);
  const expected = await serviceSignature(secret, { timestamp, nonce, method: request.method, target: url.pathname + url.search, body });
  if (!timingSafeEqual(expected, signature)) return null;
  return { nonceKey: `${kid}:${nonce}`, nonceExpiresAt: (ts + SERVICE_CLOCK_SKEW_SEC) * 1000 };
}
