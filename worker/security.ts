import { livePhaseOf } from "./egress";
import type { Destination, DestStatus, Env, PublicDestination, PublicStudio, StudioState } from "./types";

export const DEV_API_KEY = "devkey";
export const DEV_API_SECRET = "casthop_dev_secret_not_for_production_use_32b";
export const HOST_IDENTITY = "host";
export const MAX_PARTICIPANTS = 64;
export const HOST_KEY_HEADER = "x-casthop-host-key";
export const CLAIM_STALE_MS = 30_000;
export const GUEST_STALE_MS = 2 * 60 * 60 * 1000;
export const TOKEN_MINT_WINDOW_MS = 60_000;
export const TOKEN_MINT_MAX = 20;
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_MAX = 8;

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === "localhost" || h === "::1" || h === "::" || h === "0.0.0.0") return true;
  return /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function isPrivateHost(host: string): boolean {
  const h = normalizeHost(host);
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h.includes(":") && (h.startsWith("fd") || h.startsWith("fc") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))) {
    return true;
  }
  return false;
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

export function claimIsHeld(startedAt: number | undefined, now = Date.now()): boolean {
  return typeof startedAt === "number" && now - startedAt < CLAIM_STALE_MS;
}

export function isDefaultDevSecret(env: Pick<Env, "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET">): boolean {
  return env.LIVEKIT_API_KEY === DEV_API_KEY || env.LIVEKIT_API_SECRET === DEV_API_SECRET;
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
    createdAt: state.createdAt,
  };
}

export function publicStateHasFullRtmpUrl(json: string, secretUrl: string): boolean {
  if (!secretUrl) return false;
  return json.includes(secretUrl);
}

const KINDS = new Set(["youtube", "linkedin", "x", "custom"]);

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
  const host = parsed.hostname;
  if (isLoopbackHost(host) && !opts.allowLoopback) return null;
  if (isPrivateHost(host)) return null;
  return url;
}

export function sanitizeDestinations(
  incoming: unknown,
  existing: Destination[],
  opts: { allowLoopback: boolean },
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
    const status: DestStatus = urlChanged ? "idle" : (prev?.status ?? "idle");
    out.push({
      id,
      kind,
      label: String(r.label ?? prev?.label ?? kind).slice(0, 40),
      detail: String(r.detail ?? prev?.detail ?? "").slice(0, 80),
      url,
      enabled: Boolean(r.enabled),
      status: Boolean(r.enabled) && url ? status : "idle",
      error: urlChanged ? null : (prev?.error ?? null),
      retryCount: urlChanged ? 0 : (prev?.retryCount ?? 0),
      retryAt: urlChanged ? null : (prev?.retryAt ?? null),
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
