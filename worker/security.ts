import { livePhaseOf } from "./egress";
import { destAspectOf, type DestAspect, type Destination, type DestStatus, type Env, type PublicDestination, type PublicStudio, type StudioState } from "./types";

export const DEV_API_KEY = "devkey";
export const DEV_API_SECRET = "casthop_dev_secret_not_for_production_use_32b";
export const HOST_IDENTITY = "host";
export const MAX_PARTICIPANTS = 64;
export const SESSION_COOKIE = "casthop_session";
export const OAUTH_COOKIE = "casthop_oauth";
export const CLAIM_STALE_MS = 30_000;
export const GUEST_STALE_MS = 2 * 60 * 60 * 1000;
export const TOKEN_MINT_WINDOW_MS = 60_000;
export const TOKEN_MINT_MAX = 20;
export const TOKEN_IP_WINDOW_MS = 60_000;
export const TOKEN_IP_MAX = 60;
/** New guest identities one network can take per studio per mint window. */
export const GUEST_MINT_PER_SOURCE = 10;
/** Guest slots one network can hold in a studio. */
export const GUESTS_PER_SOURCE = 16;
/** A full studio frees guests who have not shown up in the room for this long. */
export const ABSENT_GUEST_GRACE_MS = 60_000;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
export const SIGNIN_IP_MAX = 5;
export const SIGNIN_EMAIL_MAX = 3;
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_MAX = 8;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_ROTATE_MS = 60 * 60 * 1000;
export const SESSION_PREV_GRACE_MS = 60_000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "::1" || h === "::" || h === "0.0.0.0") return true;
  return /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw.replace(/^ws/i, "http"));
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/** Public site origin for mail and OAuth. Falls back to the request only on loopback. */
export function publicOrigin(env: Pick<Env, "PUBLIC_ORIGIN">, requestUrl: string): string | null {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  try {
    if (isLoopbackUrl(requestUrl)) return new URL(requestUrl).origin;
  } catch {
    return null;
  }
  return null;
}

/** Missing Origin is allowed (same-document form). A present Origin must match the request. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function claimIsHeld(startedAt: number | undefined, now = Date.now()): boolean {
  return typeof startedAt === "number" && now - startedAt < CLAIM_STALE_MS;
}

export function isDefaultDevSecret(env: Pick<Env, "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET">): boolean {
  return env.LIVEKIT_API_KEY === DEV_API_KEY || env.LIVEKIT_API_SECRET === DEV_API_SECRET;
}

export function allowDevLogin(env: Pick<Env, "CASTHOP_ALLOW_DEV_KEYS" | "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET">): boolean {
  return env.CASTHOP_ALLOW_DEV_KEYS === "1" || isDefaultDevSecret(env);
}

/** Refuse the published local keypair unless LiveKit is on loopback (or CASTHOP_ALLOW_DEV_KEYS=1). */
export function devKeyGuardError(env: Env): string | null {
  if (env.CASTHOP_ALLOW_DEV_KEYS === "1") return null;
  if (!isDefaultDevSecret(env)) return null;
  if (isLoopbackUrl(env.LIVEKIT_HTTP_URL) && isLoopbackUrl(env.PUBLIC_LIVEKIT_URL.replace(/^ws/i, "http"))) {
    return null;
  }
  return "Refusing default LiveKit devkey/secret outside local loopback. Set CASTHOP_ALLOW_DEV_KEYS=1 only for tests, or generate keys with `lk generate-keys`.";
}

export function maskRtmpUrl(url: string): string {
  if (!url) return "";
  const trimmed = url.trim();
  const slash = trimmed.lastIndexOf("/");
  const key = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const suffix = key.slice(-4);
  return suffix ? `rtmp://…/${suffix}` : "rtmp://…";
}

export function publicDestinations(destinations: Destination[], includeUrls: boolean): PublicDestination[] {
  return destinations.map((d) => {
    const pub: PublicDestination = {
      id: d.id,
      kind: d.kind,
      label: d.label,
      detail: d.detail,
      enabled: d.enabled,
      hasKey: Boolean(d.url),
      urlMasked: maskRtmpUrl(d.url),
      status: d.status ?? "idle",
      error: d.error ?? null,
      aspect: destAspectOf(d),
    };
    if (includeUrls) pub.url = d.url;
    return pub;
  });
}

export function publicState(state: StudioState, opts: { includeUrls: boolean }): PublicStudio {
  return {
    id: state.id,
    title: state.title,
    layout: state.layout,
    live: state.live,
    liveStartedAt: state.liveStartedAt,
    liveError: state.liveError ?? null,
    livePhase: livePhaseOf(state),
    egressId: opts.includeUrls ? state.egressId : null,
    bannerTitle: state.bannerTitle,
    bannerSubtitle: state.bannerSubtitle,
    destinations: publicDestinations(state.destinations, opts.includeUrls),
    participants: state.participants,
    chat: state.chat,
    pinnedChat: state.pinnedChat ?? null,
    createdAt: state.createdAt,
    separateRecordings: Boolean(state.separateRecordings),
    isoSessionId: state.isoSessionId ?? null,
  };
}

export function publicStateHasFullRtmpUrl(json: string, secretUrl: string): boolean {
  if (!secretUrl) return false;
  return json.includes(secretUrl);
}

const KINDS = new Set(["youtube", "linkedin", "x", "custom"]);

type HostClass = "public" | "loopback" | "internal";

function ipv4Class(octets: number[]): HostClass {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 127) return "loopback";
  if (a === 0 || a === 10 || a >= 224) return "internal";
  if (a === 100 && b >= 64 && b <= 127) return "internal";
  if (a === 169 && b === 254) return "internal";
  if (a === 172 && b >= 16 && b <= 31) return "internal";
  if (a === 192 && (b === 168 || (b === 0 && c === 0))) return "internal";
  if (a === 198 && (b === 18 || b === 19)) return "internal";
  return "public";
}

function ipv6Class(literal: string): HostClass {
  const [head = "", tail = ""] = literal.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const fill = literal.includes("::") ? 8 - front.length - back.length : 0;
  const words = [...front, ...Array<string>(Math.max(0, fill)).fill("0"), ...back].map((g) => parseInt(g || "0", 16));
  if (words.length !== 8 || words.some((n) => !Number.isInteger(n))) return "internal";
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const v4 = [w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff];
  const zeroHigh = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  if (zeroHigh && w5 === 0 && w6 === 0 && w7 === 1) return "loopback";
  // IPv4-mapped, IPv4-compatible and NAT64 addresses reach the embedded IPv4 address.
  if (zeroHigh && (w5 === 0xffff || w5 === 0)) return ipv4Class(v4);
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return ipv4Class(v4);
  if ((w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00) return "internal";
  return "public";
}

const INTERNAL_SUFFIXES = [".local", ".internal", ".home.arpa", ".localdomain", ".lan"];

/** Classify an RTMP host. Spellings other than the canonical one (167772161, 0x0a000001, 127.1) are "internal". */
export function rtmpHostClass(host: string): HostClass {
  const lower = host.toLowerCase();
  let canonical: string;
  try {
    canonical = new URL(`http://${lower}`).hostname;
  } catch {
    return "internal";
  }
  if (canonical !== lower || !canonical) return "internal";
  if (canonical.startsWith("[")) return ipv6Class(canonical.slice(1, -1));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(canonical)) return ipv4Class(canonical.split(".").map(Number));
  if (canonical === "localhost" || canonical.endsWith(".localhost")) return "loopback";
  // A single label (redis, intranet) or a trailing dot resolves through local search domains.
  if (!canonical.includes(".") || canonical.endsWith(".")) return "internal";
  if (INTERNAL_SUFFIXES.some((s) => canonical.endsWith(s))) return "internal";
  return "public";
}

export function parseRtmpUrl(raw: unknown, opts: { allowLoopback: boolean }): string | null {
  if (raw == null) return "";
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url) return "";
  if (url.length > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "rtmp:" && parsed.protocol !== "rtmps:") return null;
  // Hostnames are not resolved here, so a public name that points at an internal address
  // still passes. This only refuses what the URL itself says.
  const kind = rtmpHostClass(parsed.hostname);
  if (kind === "internal") return null;
  if (kind === "loopback" && !opts.allowLoopback) return null;
  return url;
}

export function sanitizeDestinations(
  incoming: unknown,
  existing: Destination[],
  opts: { allowLoopback: boolean; allowPortrait?: boolean },
): Destination[] | null {
  if (!Array.isArray(incoming) || incoming.length > 16) return null;
  const byId = new Map(existing.map((d) => [d.id, d]));
  const out: Destination[] = [];
  for (const row of incoming) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.slice(0, 40) : "";
    if (!id) return null;
    const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? (r.kind as Destination["kind"]) : null;
    if (!kind) return null;
    const prev = byId.get(id);
    let url: string;
    if (r.url === undefined || r.url === null) {
      url = prev?.url || "";
    } else {
      const parsedUrl = parseRtmpUrl(r.url, opts);
      if (parsedUrl === null) return null;
      url = parsedUrl;
    }
    const urlChanged = url !== (prev?.url || "");
    const aspect: DestAspect = r.aspect === "portrait" || r.aspect === "landscape" ? r.aspect : destAspectOf(prev ?? {});
    // An already-enabled 9:16 row must still save so a later missing template cannot block other dest edits.
    if (
      aspect === "portrait" &&
      Boolean(r.enabled) &&
      !opts.allowPortrait &&
      !(prev && destAspectOf(prev) === "portrait" && prev.enabled)
    ) {
      return null;
    }
    const aspectChanged = aspect !== destAspectOf(prev ?? {});
    const status: DestStatus = urlChanged || aspectChanged ? "idle" : (prev?.status ?? "idle");
    out.push({
      id,
      kind,
      label: String(r.label ?? prev?.label ?? kind).slice(0, 40),
      detail: String(r.detail ?? prev?.detail ?? "").slice(0, 80),
      url,
      enabled: Boolean(r.enabled),
      status: Boolean(r.enabled) && url ? status : "idle",
      error: urlChanged || aspectChanged ? null : (prev?.error ?? null),
      retryCount: urlChanged || aspectChanged ? 0 : (prev?.retryCount ?? 0),
      retryAt: urlChanged || aspectChanged ? null : (prev?.retryAt ?? null),
      aspect,
    });
  }
  return out;
}

export function asName(value: unknown, fallback = "Guest"): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, 40) || fallback;
}

export function asIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 64);
}

export function isHostIdentity(identity: string): boolean {
  return identity === HOST_IDENTITY || identity.startsWith("host-");
}

export function hostIdentityFor(accountId: string, role: "owner" | "cohost"): string {
  if (role === "owner") return HOST_IDENTITY;
  const slug = accountId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "cohost";
  return `host-${slug}`;
}

export function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function randomId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToB64Url(buf).replaceAll("-", "x").replaceAll("_", "y").slice(0, bytes + 4);
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256B64Url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64Url(new Uint8Array(sig));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Reconstructable host secret so the Worker can talk to the DO after checking the account. Never sent to the browser. */
export async function hostKeyFor(
  env: Pick<Env, "HOST_KEY_SECRET" | "LIVEKIT_API_SECRET">,
  studioId: string,
): Promise<string> {
  const secret = env.HOST_KEY_SECRET?.trim() || env.LIVEKIT_API_SECRET;
  return hmacSha256B64Url(secret, `hostkey:${studioId}`);
}

export function asEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "Host";
  const cleaned = local.replaceAll(/[._+\-]+/g, " ").trim();
  if (!cleaned) return "Host";
  return cleaned.replaceAll(/\b\w/g, (ch) => ch.toUpperCase()).slice(0, 40);
}

export function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

/** CF-Connecting-IP is trusted on Cloudflare (`cf` set). X-Forwarded-For only with CASTHOP_TRUST_FORWARDED=1. */
export function clientIp(
  headers: { get: (name: string) => string | null | undefined },
  opts: { trustForwarded?: boolean; cf?: unknown } = {},
): string {
  if (opts.cf) {
    const cfip = headers.get("cf-connecting-ip")?.trim();
    if (cfip) return cfip.slice(0, 64);
  }
  if (opts.trustForwarded) {
    const cfip = headers.get("cf-connecting-ip")?.trim();
    if (cfip) return cfip.slice(0, 64);
    const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return "local";
}

/** Rate-limit key for a client address. One IPv6 host usually holds a whole /64, so group by it. */
export function ipBucket(ip: string): string {
  const addr = ip.toLowerCase().replace(/%.*$/, "");
  if (!addr.includes(":")) return addr;
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1]!;
  const [head = "", tail = ""] = addr.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = addr.includes("::") ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  const prefix = groups.slice(0, 4).map((g) => parseInt(g || "0", 16));
  if (prefix.length < 4 || prefix.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return addr;
  return `${prefix.map((n) => n.toString(16)).join(":")}::/64`;
}

export function requestIp(c: { req: { raw: Request }; env: Pick<Env, "CASTHOP_TRUST_FORWARDED"> }): string {
  return clientIp(c.req.raw.headers, {
    trustForwarded: c.env.CASTHOP_TRUST_FORWARDED === "1",
    cf: c.req.raw.cf,
  });
}

export function isSecureRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setCookie(name: string, value: string, opts: { maxAge: number; secure: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${opts.maxAge}`];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return setCookie(name, "", { maxAge: 0, secure });
}
