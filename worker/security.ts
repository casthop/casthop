import type { Destination, Env, PublicDestination, PublicStudio, StudioState } from "./types";

export const DEV_API_KEY = "devkey";
export const DEV_API_SECRET = "casthop_dev_secret_not_for_production_use_32b";
export const HOST_IDENTITY = "host";
export const MAX_PARTICIPANTS = 64;
export const HOST_KEY_HEADER = "x-casthop-host-key";

export function isLoopbackUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
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
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (loopback && !opts.allowLoopback) return null;
  // Never allow RFC1918 / link-local RTMP targets, even in local mode.
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
    return null;
  }
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
    const parsedUrl = parseRtmpUrl(r.url, opts);
    if (parsedUrl === null) return null;
    const url = parsedUrl || prev?.url || "";
    out.push({
      id,
      kind,
      label: String(r.label ?? prev?.label ?? kind).slice(0, 40),
      detail: String(r.detail ?? prev?.detail ?? "").slice(0, 80),
      url,
      enabled: Boolean(r.enabled),
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
