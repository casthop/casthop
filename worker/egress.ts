import type { Destination, DestStatus, LivePhase, StudioState } from "./types";

export const WATCH_MS = 3_000;
export const EMPTY_GRACE_MS = 45_000;
/** Chrome can take a few seconds to join after StartRoomComposite returns. */
export const COMPOSITOR_GRACE_MS = 15_000;
export const MAX_BACKOFF_MS = 30_000;
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, MAX_BACKOFF_MS] as const;
export const MAX_STREAM_RETRIES = BACKOFF_MS.length;

export type EgressHealth = "starting" | "active" | "ending" | "complete" | "failed" | "unknown";

export type StreamHealth = "active" | "finished" | "failed" | "unknown";

export type StreamResult = {
  url: string;
  status: StreamHealth;
  error: string;
};

export type ParsedEgress = {
  egressId: string;
  roomName: string;
  status: EgressHealth;
  error: string;
  streams: StreamResult[];
};

export function emptyGraceMs(raw: string | undefined): number {
  if (raw == null || raw === "") return EMPTY_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : EMPTY_GRACE_MS;
}

export function compositorGraceMs(raw: string | undefined): number {
  if (raw == null || raw === "") return COMPOSITOR_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : COMPOSITOR_GRACE_MS;
}

export function nextBackoffMs(retryCount: number, overrideMs?: string): number {
  if (overrideMs === "0") return 0;
  if (overrideMs) {
    const n = Number(overrideMs);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const i = Math.min(Math.max(0, retryCount), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i] ?? MAX_BACKOFF_MS;
}

export function isActiveHealth(status: EgressHealth): boolean {
  return status === "starting" || status === "active" || status === "ending";
}

export function isRunningHealth(status: EgressHealth): boolean {
  return status === "starting" || status === "active";
}

export function isTerminalHealth(status: EgressHealth): boolean {
  return status === "complete" || status === "failed";
}

/** True when this info is for a compositor we should not apply. */
export function isForeignEgress(
  ownedId: string | null,
  infoId: string,
  status: EgressHealth,
  wantLive = true,
): boolean {
  if (!wantLive) return isActiveHealth(status) || infoId !== ownedId;
  if (infoId === ownedId) return false;
  if (ownedId) return true;
  return !isRunningHealth(status);
}

export function streamRetryDue(dest: Destination, now = Date.now()): boolean {
  if ((dest.retryCount ?? 0) >= MAX_STREAM_RETRIES) return false;
  return (dest.retryAt ?? 0) <= now;
}

export function livePhaseOf(state: StudioState, now = Date.now()): LivePhase {
  const want = state.wantLive ?? state.live;
  if (!want && (state.live || state.egressId)) return "stopping";
  if (!want) return "idle";
  if (state.live && state.egressId) return "live";
  const starting = typeof state.liveStartingAt === "number" && now - state.liveStartingAt < 30_000;
  if (starting && !state.egressId) return "starting";
  return "retrying";
}

/** Strip ingest URLs so guests never see a stream key in an error string. */
export function publicError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\b(?:rtmps?|mux|twitch):\/\/\S+/gi, "rtmp://…")
    .replace(/[\w.-]+(?::\d+)?\/\S+/gi, "rtmp://…")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 140);
}

export function enabledUrls(destinations: Destination[]): string[] {
  return destinations.filter((d) => d.enabled && d.url).map((d) => d.url);
}

/** LiveKit `RedactIdentifier`: keep up to 3 prefix/suffix chars when the key is long enough. */
export function redactIdentifier(identifier: string): string {
  let prefix = "";
  let suffix = "";
  for (let i = 3; i > 0; i--) {
    if (identifier.length >= i * 3) {
      prefix = identifier.slice(0, i);
      suffix = identifier.slice(-i);
      break;
    }
  }
  return `{${prefix}...${suffix}}`;
}

function redactUrlQueryValues(raw: string): string {
  const cut = raw.indexOf("?");
  if (cut < 0) return raw;
  const query = raw.slice(cut + 1);
  if (!query) return raw;
  const params = query.split("&").map((p) => {
    const eq = p.indexOf("=");
    if (eq < 0) return p;
    return p.slice(eq + 1) ? `${p.slice(0, eq)}={...}` : p;
  });
  return `${raw.slice(0, cut + 1)}${params.join("&")}`;
}

/** Same shape LiveKit returns on ListEgress / webhooks after it redacts stream keys. */
export function redactStreamKey(url: string): string {
  const shorthand = /^(mux|twitch):\/\/(\S+)$/i.exec(url);
  if (shorthand) return `${shorthand[1]}://${redactIdentifier(shorthand[2] ?? "")}`;
  const rtmp = /^(rtmps?:\/\/)(.*\/)(.*\/)(\S*?)( live=1)?$/i.exec(url);
  if (!rtmp) return redactUrlQueryValues(url);
  return `${rtmp[1]}${rtmp[2]}${rtmp[3]}${redactIdentifier(rtmp[4] ?? "")}${rtmp[5] ?? ""}`;
}

export function streamUrlMatches(reported: string, destUrl: string): boolean {
  return reported === destUrl || reported === redactStreamKey(destUrl);
}

function matchStreamForDest(destUrl: string, streams: StreamResult[], used: Set<number>): StreamResult | undefined {
  const exact = streams.findIndex((s, i) => !used.has(i) && s.url === destUrl);
  if (exact >= 0) {
    used.add(exact);
    return streams[exact];
  }
  const hits = streams.map((_, i) => i).filter((i) => !used.has(i) && streamUrlMatches(streams[i]!.url, destUrl));
  const first = hits[0];
  if (first == null) return undefined;
  used.add(first);
  return streams[first];
}

export function setDestStatuses(destinations: Destination[], status: DestStatus, error: string | null = null): void {
  for (const d of destinations) {
    if (!d.enabled || !d.url) {
      d.status = "idle";
      d.error = null;
      continue;
    }
    d.status = status;
    d.error = error;
    if (status === "connecting" || status === "idle" || status === "stopped" || status === "live") {
      d.retryCount = 0;
      d.retryAt = null;
    }
  }
}

export function applyStreamResults(
  destinations: Destination[],
  streams: StreamResult[],
  live: boolean,
  now = Date.now(),
): boolean {
  const used = new Set<number>();
  let needsRetry = false;
  for (const d of destinations) {
    if (!d.enabled || !d.url) {
      d.status = "idle";
      d.error = null;
      d.retryCount = 0;
      d.retryAt = null;
      continue;
    }
    if (!live) {
      d.status = d.status === "idle" ? "idle" : "stopped";
      continue;
    }
    const stream = matchStreamForDest(d.url, streams, used);
    if (!stream) {
      d.status = d.status === "failed" || d.status === "retrying" ? d.status : "connecting";
      continue;
    }
    if (stream.status === "active") {
      d.status = "live";
      d.error = null;
      d.retryCount = 0;
      d.retryAt = null;
    } else if (stream.status === "failed") {
      d.error = publicError(stream.error) ?? "RTMP dropped";
      if (!streamRetryDue(d, now)) {
        d.status = (d.retryCount ?? 0) >= MAX_STREAM_RETRIES ? "failed" : "retrying";
      } else {
        d.status = "retrying";
        needsRetry = true;
      }
    } else if (stream.status === "finished") {
      d.status = "stopped";
      d.error = publicError(stream.error);
    } else {
      d.status = "connecting";
    }
  }
  return needsRetry;
}

export function failedStreamUrls(destinations: Destination[], streams: StreamResult[], now = Date.now()): string[] {
  const used = new Set<number>();
  const urls: string[] = [];
  for (const d of destinations) {
    if (!d.enabled || !d.url) continue;
    const stream = matchStreamForDest(d.url, streams, used);
    if (stream?.status === "failed" && streamRetryDue(d, now)) urls.push(d.url);
  }
  return urls;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function list(obj: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function parseEgressHealth(raw: unknown): EgressHealth {
  if (raw === 0 || raw === "EGRESS_STARTING" || raw === "STARTING") return "starting";
  if (raw === 1 || raw === "EGRESS_ACTIVE" || raw === "ACTIVE") return "active";
  if (raw === 2 || raw === "EGRESS_ENDING" || raw === "ENDING") return "ending";
  if (raw === 3 || raw === "EGRESS_COMPLETE" || raw === "COMPLETE") return "complete";
  if (raw === 4 || raw === "EGRESS_FAILED" || raw === "FAILED") return "failed";
  if (raw === 5 || raw === "EGRESS_ABORTED" || raw === "ABORTED") return "failed";
  if (raw === 6 || raw === "EGRESS_LIMIT_REACHED" || raw === "LIMIT_REACHED") return "failed";
  return "unknown";
}

export function parseStreamHealth(raw: unknown): StreamHealth {
  if (raw === 0 || raw === "ACTIVE" || raw === "STREAM_ACTIVE") return "active";
  if (raw === 1 || raw === "FINISHED") return "finished";
  if (raw === 2 || raw === "FAILED") return "failed";
  return "unknown";
}

export function parseStreamResult(raw: unknown): StreamResult | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const url = str(obj, "url", "Url");
  if (!url) return null;
  return {
    url,
    status: parseStreamHealth(obj.status),
    error: str(obj, "error", "Error"),
  };
}

export function parseEgressInfo(raw: unknown): ParsedEgress | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const nested = asRecord(obj.egressInfo) ?? asRecord(obj.egress_info) ?? obj;
  const egressId = str(nested, "egressId", "egress_id");
  if (!egressId) return null;
  const streams = [
    ...list(nested, "streamResults", "stream_results"),
    ...list(asRecord(nested.stream) ?? {}, "info"),
  ]
    .map(parseStreamResult)
    .filter((s): s is StreamResult => s !== null);
  return {
    egressId,
    roomName: str(nested, "roomName", "room_name"),
    status: parseEgressHealth(nested.status),
    error: str(nested, "error", "details"),
    streams,
  };
}

export function parseEgressList(raw: unknown): ParsedEgress[] {
  const obj = asRecord(raw);
  const items = obj ? list(obj, "items", "Items") : Array.isArray(raw) ? raw : [];
  return items.map(parseEgressInfo).filter((e): e is ParsedEgress => e !== null);
}

export function webhookEventName(raw: unknown): string {
  const obj = asRecord(raw);
  return obj ? str(obj, "event", "Event") : "";
}

export function webhookRoomName(raw: unknown): string {
  const obj = asRecord(raw);
  if (!obj) return "";
  const fromEgress = parseEgressInfo(obj);
  if (fromEgress?.roomName) return fromEgress.roomName;
  const room = asRecord(obj.room);
  if (room) return str(room, "name", "Name");
  return str(obj, "roomName", "room_name");
}

export function isComposerIdentity(identity: string): boolean {
  const id = identity.toLowerCase();
  return id.startsWith("eg_") || id.startsWith("egress") || id.includes("egress-");
}

export function parseParticipantIdentities(raw: unknown): string[] {
  const obj = asRecord(raw);
  const rows = obj ? list(obj, "participants", "Participants") : [];
  const out: string[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const identity = str(rec, "identity", "Identity");
    if (identity) out.push(identity);
  }
  return out;
}

export function studioHasPeople(identities: string[]): boolean {
  return identities.some((id) => !isComposerIdentity(id));
}

export function studioHasCompositor(identities: string[]): boolean {
  return identities.some(isComposerIdentity);
}

export function pickActiveEgress(items: ParsedEgress[], knownId: string | null): ParsedEgress | null {
  if (knownId) {
    const known = items.find((e) => e.egressId === knownId);
    if (known && isRunningHealth(known.status)) return known;
  }
  return items.find((e) => isRunningHealth(e.status)) ?? null;
}

export function recordingPathFor(studioId: string, at = new Date()): string {
  const stamp = at.toISOString().replaceAll(":", "").replaceAll(".", "");
  return `/out/${studioId}-${stamp}.mp4`;
}

export function normalizeStudio(state: StudioState): StudioState {
  const wantLive = state.wantLive ?? state.live;
  return {
    ...state,
    wantLive,
    liveError: state.liveError ?? null,
    egressRetryCount: state.egressRetryCount ?? 0,
    egressRetryAt: state.egressRetryAt ?? null,
    emptySince: state.emptySince ?? null,
    destinations: state.destinations.map((d) => ({
      ...d,
      status: d.status ?? (state.live && d.enabled ? "live" : "idle"),
      error: d.error ?? null,
      retryCount: d.retryCount ?? 0,
      retryAt: d.retryAt ?? null,
    })),
  };
}
