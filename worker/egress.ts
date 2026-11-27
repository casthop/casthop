import { defaultCaptions } from "./captions";
import { destAspectOf, type DestAspect, type Destination, type DestStatus, type LivePhase, type StudioState } from "./types";

export const WATCH_MS = 3_000;
export const EMPTY_GRACE_MS = 45_000;
/** Chrome can take a few seconds to join after StartRoomComposite returns. */
export const COMPOSITOR_GRACE_MS = 15_000;
/** Give up restarting a dead compositor after this window; host can Retry. */
export const RECOVERY_BUDGET_MS = 30_000;
/** Bound StartRoomComposite so recovery and the RPC timeout share one deadline. */
export const START_EGRESS_TIMEOUT_MS = 30_000;
/** Don't block recovery on a hung StopEgress. */
export const STOP_ABANDON_MS = 2_500;
/** Compositor page posts a beat every 1s; miss a couple and reconnect within 5s. */
export const HEARTBEAT_BEAT_MS = 1_000;
export const HEARTBEAT_STALE_MS = 3_000;
/** ListEgress often while connecting so Live tracks bytes/duration, not the 3s watch. */
export const STARTING_WATCH_MS = 500;
/**
 * LiveKit 1.15 leaves stream duration/bytes at 0 while RTMP is already publishing.
 * started_at lands ~1–3 s before MediaMTX; wait this long unless duration/bytes appear.
 */
export const OUTPUT_SETTLE_MS = 3_000;
export const MAX_ABANDONED_EGRESS = 16;
export const MAX_BACKOFF_MS = 30_000;
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, MAX_BACKOFF_MS] as const;
export const MAX_STREAM_RETRIES = BACKOFF_MS.length;

export type EgressHealth = "starting" | "active" | "ending" | "complete" | "failed" | "unknown";

export type StreamHealth = "active" | "finished" | "failed" | "unknown";

export type StreamResult = {
  url: string;
  status: StreamHealth;
  error: string;
  destId?: string;
  startedAt?: number | null;
  duration?: number | null;
  bytes?: number | null;
};

export type ParsedEgress = {
  egressId: string;
  roomName: string;
  status: EgressHealth;
  error: string;
  streams: StreamResult[];
  updatedAt: number | null;
  startedAt: number | null;
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

export function recoveryBudgetMs(raw: string | undefined): number {
  if (raw == null || raw === "") return RECOVERY_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : RECOVERY_BUDGET_MS;
}

export function recoveryTimedOut(state: Pick<StudioState, "egressRecoveringSince">, now = Date.now(), budgetMs = RECOVERY_BUDGET_MS): boolean {
  const since = state.egressRecoveringSince;
  if (!since) return false;
  return now - since >= budgetMs;
}

/** Remaining time in the recovery window, or null when not recovering. */
export function remainingRecoveryMs(
  state: Pick<StudioState, "egressRecoveringSince">,
  now = Date.now(),
  budgetMs = RECOVERY_BUDGET_MS,
): number | null {
  const since = state.egressRecoveringSince;
  if (!since) return null;
  return Math.max(0, budgetMs - (now - since));
}

export function startEgressTimeoutMs(remainingMs: number | null, capMs = START_EGRESS_TIMEOUT_MS): number {
  if (remainingMs == null) return capMs;
  return Math.min(capMs, Math.max(0, Math.floor(remainingMs)));
}

export function nextWatchMs(producing: boolean): number {
  return producing ? WATCH_MS : STARTING_WATCH_MS;
}

export function heartbeatStaleMs(raw: string | undefined): number {
  if (raw == null || raw === "") return HEARTBEAT_STALE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : HEARTBEAT_STALE_MS;
}

/** True once the compositor page has posted a beat and then gone quiet. */
export function heartbeatLost(
  state: Pick<StudioState, "egressHeartbeatAt">,
  now = Date.now(),
  staleMs = HEARTBEAT_STALE_MS,
): boolean {
  const at = state.egressHeartbeatAt;
  if (!at) return false;
  return now - at >= staleMs;
}

/** Start the recovery clock at the last compositor beat so crash→failed stays ~30s. */
export function beginRecovery(
  state: Pick<StudioState, "egressRecoveringSince" | "egressHeartbeatAt">,
  now = Date.now(),
): void {
  if (state.egressRecoveringSince) return;
  state.egressRecoveringSince = state.egressHeartbeatAt ?? now;
}

export function beginPortraitRecovery(
  state: Pick<StudioState, "portraitRecoveringSince" | "portraitHeartbeatAt">,
  now = Date.now(),
): void {
  if (state.portraitRecoveringSince) return;
  state.portraitRecoveringSince = state.portraitHeartbeatAt ?? now;
}

export function portraitRecoveryTimedOut(
  state: Pick<StudioState, "portraitRecoveringSince">,
  now = Date.now(),
  budgetMs = RECOVERY_BUDGET_MS,
): boolean {
  return recoveryTimedOut({ egressRecoveringSince: state.portraitRecoveringSince }, now, budgetMs);
}

export function remainingPortraitRecoveryMs(
  state: Pick<StudioState, "portraitRecoveringSince">,
  now = Date.now(),
  budgetMs = RECOVERY_BUDGET_MS,
): number | null {
  return remainingRecoveryMs({ egressRecoveringSince: state.portraitRecoveringSince }, now, budgetMs);
}

export function rememberAbandoned(ids: string[] | undefined, egressId: string): string[] {
  const next = [egressId, ...(ids ?? []).filter((id) => id !== egressId)];
  return next.slice(0, MAX_ABANDONED_EGRESS);
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
  abandoned: readonly string[] = [],
  extraOwned: readonly (string | null | undefined)[] = [],
): boolean {
  if (abandoned.includes(infoId)) return true;
  const owned = [ownedId, ...extraOwned].filter((id): id is string => Boolean(id));
  if (!wantLive) return isActiveHealth(status) || !owned.includes(infoId);
  if (owned.includes(infoId)) return false;
  if (owned.length) return true;
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
  if (state.liveFailed) return "failed";
  if (state.live && state.egressId) return "live";
  if (state.egressRecoveringSince && !state.egressId) return "retrying";
  if (state.egressId) return "starting";
  const starting = typeof state.liveStartingAt === "number" && now - state.liveStartingAt < 30_000;
  if (starting) return "starting";
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

export function destsForAspect(destinations: Destination[], aspect: DestAspect): Destination[] {
  return destinations.filter((d) => destAspectOf(d) === aspect);
}

export function enabledUrls(destinations: Destination[], aspect?: DestAspect): string[] {
  return destinations
    .filter((d) => d.enabled && d.url && (aspect == null || destAspectOf(d) === aspect))
    .map((d) => d.url);
}

export function outputPhase(
  destinations: readonly { aspect?: string | null; enabled: boolean; url?: string; status: DestStatus }[],
  aspect: DestAspect,
): DestStatus | "off" {
  const rows = destinations.filter((d) => destAspectOf(d) === aspect && d.enabled && d.url);
  if (!rows.length) return "off";
  if (rows.some((d) => d.status === "live")) return "live";
  if (rows.some((d) => d.status === "retrying")) return "retrying";
  if (rows.some((d) => d.status === "failed") && rows.every((d) => d.status === "failed" || d.status === "idle")) {
    return "failed";
  }
  if (rows.some((d) => d.status === "connecting")) return "connecting";
  if (rows.some((d) => d.status === "stopped")) return "stopped";
  return "idle";
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

/** Stamp LiveKit stream rows with destination ids so colliding redacted keys do not steal a row. */
export function assignStreamDestIds(streams: StreamResult[], destinations: Destination[]): StreamResult[] {
  const out = streams.map((s) => ({ ...s, destId: s.destId }));
  const dests = destinations.filter((d) => d.enabled && d.url);
  const claimed = new Set<string>();

  const take = (stream: StreamResult, dest: Destination): void => {
    stream.destId = dest.id;
    claimed.add(dest.id);
  };

  for (const stream of out) {
    if (stream.destId && dests.some((d) => d.id === stream.destId)) {
      claimed.add(stream.destId);
      continue;
    }
    stream.destId = undefined;
    const exact = dests.filter((d) => !claimed.has(d.id) && d.url === stream.url);
    if (exact.length === 1) take(stream, exact[0]!);
  }

  for (const stream of out) {
    if (stream.destId) continue;
    const hits = dests.filter((d) => !claimed.has(d.id) && streamUrlMatches(stream.url, d.url));
    if (hits.length !== 1) continue;
    const dest = hits[0]!;
    const rivals = out.filter((s) => s !== stream && !s.destId && streamUrlMatches(s.url, dest.url));
    if (rivals.length) continue;
    take(stream, dest);
  }

  const leftoverDests = dests.filter((d) => !claimed.has(d.id));
  const leftoverStreams = out.filter((s) => !s.destId);
  const groups = new Map<string, { dests: Destination[]; streams: StreamResult[] }>();
  for (const dest of leftoverDests) {
    const key = redactStreamKey(dest.url);
    const row = groups.get(key) ?? { dests: [], streams: [] };
    row.dests.push(dest);
    groups.set(key, row);
  }
  for (const stream of leftoverStreams) {
    for (const row of groups.values()) {
      if (row.dests.some((d) => streamUrlMatches(stream.url, d.url))) {
        row.streams.push(stream);
        break;
      }
    }
  }
  for (const row of groups.values()) {
    if (!row.dests.length || !row.streams.length) continue;
    const ordered = [
      ...row.streams.filter((s) => s.status === "active"),
      ...row.streams.filter((s) => s.status !== "active"),
    ];
    const destsSorted = [...row.dests].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < destsSorted.length; i++) {
      const stream = ordered[i];
      if (stream) take(stream, destsSorted[i]!);
    }
  }
  return out;
}

function matchStreamForDest(dest: Destination, streams: StreamResult[], used: Set<number>): StreamResult | undefined {
  const byId = streams.findIndex((s, i) => !used.has(i) && s.destId === dest.id);
  if (byId >= 0) {
    used.add(byId);
    return streams[byId];
  }
  const exact = streams.findIndex((s, i) => !used.has(i) && !s.destId && s.url === dest.url);
  if (exact >= 0) {
    used.add(exact);
    return streams[exact];
  }
  const hits = streams
    .map((_, i) => i)
    .filter((i) => !used.has(i) && !streams[i]!.destId && streamUrlMatches(streams[i]!.url, dest.url));
  if (hits.length !== 1) return undefined;
  const first = hits[0]!;
  used.add(first);
  return streams[first];
}

export function setDestStatuses(
  destinations: Destination[],
  status: DestStatus,
  error: string | null = null,
  aspect?: DestAspect,
): void {
  for (const d of destinations) {
    if (aspect && destAspectOf(d) !== aspect) continue;
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
  producing = live,
): boolean {
  const bound = assignStreamDestIds(streams, destinations);
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
    if (!producing) {
      d.status = d.status === "failed" || d.status === "retrying" ? d.status : "connecting";
      continue;
    }
    const stream = matchStreamForDest(d, bound, used);
    if (!stream) {
      d.status = d.status === "failed" || d.status === "retrying" ? d.status : "connecting";
      continue;
    }
    if (stream.status === "active" && streamOutputStarted(stream)) {
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
  if (producing) {
    const leftoverStarted = bound.filter((s, i) => !used.has(i) && s.status === "active" && streamOutputStarted(s));
    const leftoverDests = destinations.filter((d) => d.enabled && d.url && d.status === "connecting");
    const assign =
      leftoverDests.length === leftoverStarted.length
        ? leftoverDests.length
        : leftoverDests.length === 1 && leftoverStarted.length >= 1
          ? 1
          : 0;
    for (let i = 0; i < assign; i++) {
      const dest = leftoverDests[i]!;
      dest.status = "live";
      dest.error = null;
      dest.retryCount = 0;
      dest.retryAt = null;
    }
  }
  return needsRetry;
}

export function failedStreamUrls(destinations: Destination[], streams: StreamResult[], now = Date.now()): string[] {
  const bound = assignStreamDestIds(streams, destinations);
  const used = new Set<number>();
  const urls: string[] = [];
  for (const d of destinations) {
    if (!d.enabled || !d.url) continue;
    const stream = matchStreamForDest(d, bound, used);
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

function int64(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

export function parseStreamResult(raw: unknown): StreamResult | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const url = str(obj, "url", "Url");
  if (!url) return null;
  const destId = str(obj, "destId", "dest_id");
  const startedAt = egressTimeMs(obj.startedAt ?? obj.started_at);
  const duration = int64(obj.duration);
  const bytes = int64(obj.size ?? obj.bytes);
  return {
    url,
    status: parseStreamHealth(obj.status),
    error: str(obj, "error", "Error"),
    ...(destId ? { destId } : {}),
    ...(startedAt != null ? { startedAt } : {}),
    ...(duration != null ? { duration } : {}),
    ...(bytes != null ? { bytes } : {}),
  };
}

/** LiveKit timestamps are unix nanos (often JSON strings); older payloads may be ms. */
export function egressTimeMs(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return Math.floor(n / 1e6);
  return Math.floor(n);
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
    updatedAt: egressTimeMs(nested.updatedAt ?? nested.updated_at),
    startedAt: egressTimeMs(nested.startedAt ?? nested.started_at),
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

export function pickActiveEgress(
  items: ParsedEgress[],
  knownId: string | null,
  abandoned: readonly string[] = [],
): ParsedEgress | null {
  const skip = new Set(abandoned.filter(Boolean));
  if (knownId && !skip.has(knownId)) {
    const known = items.find((e) => e.egressId === knownId);
    if (known && isRunningHealth(known.status)) return known;
  }
  return items.find((e) => isRunningHealth(e.status) && !skip.has(e.egressId)) ?? null;
}

export function skipIds(abandoned: readonly string[] | undefined, ...extra: Array<string | null | undefined>): string[] {
  return [...(abandoned ?? []), ...extra.filter((id): id is string => Boolean(id))];
}

/** True when this stream has actually sent output. started_at needs a settle unless duration/bytes. */
export function streamOutputStarted(stream: StreamResult, now = Date.now()): boolean {
  if ((stream.duration ?? 0) > 0 || (stream.bytes ?? 0) > 0) return true;
  const started = stream.startedAt ?? 0;
  if (started <= 0) return false;
  return now - started >= OUTPUT_SETTLE_MS;
}

/** LiveKit stream duration / bytes, or started_at after the RTMP settle. */
export function egressOutputStarted(info: ParsedEgress, now = Date.now()): boolean {
  return info.streams.some((stream) => streamOutputStarted(stream, now));
}

function streamStillActive(stream: StreamResult): boolean {
  return stream.status === "active" && ((stream.startedAt ?? 0) > 0 || streamOutputStarted(stream));
}

/** ListEgress "active" is not enough; wait for bytes, duration, or started_at settle. */
export function egressIsProducing(
  info: ParsedEgress,
  opts?: {
    identities?: string[] | null;
    now?: number;
    staleMs?: number;
    fromUpdate?: boolean;
    alreadyLive?: boolean;
  },
): boolean {
  if (!isRunningHealth(info.status)) return false;
  const now = opts?.now ?? Date.now();
  if (egressOutputStarted(info, now)) return true;
  // Sparse later updates omit duration/bytes; do not drop Live for that.
  return Boolean(opts?.alreadyLive && info.streams.some(streamStillActive));
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
    liveFailed: state.liveFailed ?? false,
    egressRetryCount: state.egressRetryCount ?? 0,
    egressRetryAt: state.egressRetryAt ?? null,
    egressRecoveringSince: state.egressRecoveringSince ?? null,
    abandonedEgressIds: state.abandonedEgressIds ?? [],
    egressHeartbeatAt: state.egressHeartbeatAt ?? null,
    portraitEgressId: state.portraitEgressId ?? null,
    portraitHeartbeatAt: state.portraitHeartbeatAt ?? null,
    portraitRetryCount: state.portraitRetryCount ?? 0,
    portraitRetryAt: state.portraitRetryAt ?? null,
    portraitRecoveringSince: state.portraitRecoveringSince ?? null,
    emptySince: state.emptySince ?? null,
    pinnedChat: state.pinnedChat ?? null,
    captions: state.captions ?? defaultCaptions(),
    captionLine: state.captionLine ?? null,
    separateRecordings: state.separateRecordings ?? false,
    isoSessionId: state.isoSessionId ?? null,
    isoTracks: state.isoTracks ?? [],
    destinations: state.destinations.map((d) => ({
      ...d,
      aspect: destAspectOf(d),
      status: d.status ?? (state.live && d.enabled ? "live" : "idle"),
      error: d.error ?? null,
      retryCount: d.retryCount ?? 0,
      retryAt: d.retryAt ?? null,
    })),
  };
}
