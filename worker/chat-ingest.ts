import { asIdentity, asName } from "./security";
import type { ChatMessage, Env } from "./types";

const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_TOKEN = "https://oauth2.googleapis.com/token";

export const DEST_CHAT_BACKOFF_MS = 15_000;
export const DEST_CHAT_POLL_MIN_MS = 2_000;
export const DEST_CHAT_POLL_MAX_MS = 60_000;
export const DEST_CHAT_POLL_DEFAULT_MS = 5_000;
export const DEST_CHAT_FETCH_MS = 4_000;

export type DestChatComment = ChatMessage & { source: "youtube" };

export type DestChatCursor = {
  liveChatId?: string;
  pageToken?: string;
};

export type DestChatPage = {
  comments: DestChatComment[];
  pageToken?: string;
  pollAfterMs: number;
};

export type YoutubeTokenCache = {
  access: string;
  expiresAt: number;
};

export type YoutubeEnv = Pick<
  Env,
  | "YOUTUBE_API_KEY"
  | "YOUTUBE_LIVE_CHAT_ID"
  | "YOUTUBE_VIDEO_ID"
  | "YOUTUBE_OAUTH_CLIENT_ID"
  | "YOUTUBE_OAUTH_CLIENT_SECRET"
  | "YOUTUBE_OAUTH_REFRESH_TOKEN"
  | "YOUTUBE_CHAT_STUDIO_ID"
>;

export type DestChatPollResult = {
  page: DestChatPage | null;
  liveChatId?: string;
  cache: YoutubeTokenCache | null;
};

/** One ingest adapter per destination. X and LinkedIn need paid/partner APIs, so they are not shipped. */
export type DestChatProvider = {
  id: "youtube";
  configured: (env: YoutubeEnv) => boolean;
  poll: (
    env: YoutubeEnv,
    cursor: DestChatCursor,
    cache: YoutubeTokenCache | null,
    fetchImpl?: typeof fetch,
  ) => Promise<DestChatPollResult>;
};

export function youtubeOauthConfigured(env: YoutubeEnv): boolean {
  return Boolean(
    env.YOUTUBE_OAUTH_CLIENT_ID?.trim() &&
      env.YOUTUBE_OAUTH_CLIENT_SECRET?.trim() &&
      env.YOUTUBE_OAUTH_REFRESH_TOKEN?.trim(),
  );
}

export function youtubeAuthConfigured(env: YoutubeEnv): boolean {
  return Boolean(env.YOUTUBE_API_KEY?.trim()) || youtubeOauthConfigured(env);
}

/** True when we can actually resolve a live chat (credentials plus a chat/video id or OAuth). */
export function youtubeChatConfigured(env: YoutubeEnv): boolean {
  if (!youtubeAuthConfigured(env)) return false;
  return Boolean(env.YOUTUBE_LIVE_CHAT_ID?.trim() || env.YOUTUBE_VIDEO_ID?.trim() || youtubeOauthConfigured(env));
}

/** Studios allowed to use the deployment's YouTube chat (comma-separated ids). */
export function youtubeChatStudios(env: YoutubeEnv): string[] {
  return (env.YOUTUBE_CHAT_STUDIO_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// The credentials and chat id are the operator's, not any one account's. Without this binding
// every account's live studio would poll the operator's quota and republish its chat.
export function destChatConfigured(env: YoutubeEnv, studioId: string): { youtube: boolean } {
  return { youtube: youtubeChatConfigured(env) && youtubeChatStudios(env).includes(studioId) };
}

function asObj(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function clampPollMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEST_CHAT_POLL_DEFAULT_MS;
  return Math.min(DEST_CHAT_POLL_MAX_MS, Math.max(DEST_CHAT_POLL_MIN_MS, Math.floor(n)));
}

export function parseYoutubeChatPage(payload: unknown): DestChatPage | null {
  const obj = asObj(payload);
  if (!obj) return null;
  const nextPageToken = str(obj, "nextPageToken") || undefined;
  const items = Array.isArray(obj.items) ? obj.items : [];
  const comments: DestChatComment[] = [];
  for (const item of items) {
    const rec = asObj(item);
    if (!rec) continue;
    const id = str(rec, "id").slice(0, 80);
    if (!id) continue;
    const snippet = asObj(rec.snippet);
    const author = asObj(rec.authorDetails);
    const text = (snippet ? str(snippet, "displayMessage") : "").trim().slice(0, 400);
    if (!text) continue;
    const name = asName(author ? str(author, "displayName") : "", "Viewer");
    const channelId = author ? str(author, "channelId") : "";
    const from = asIdentity(channelId ? `yt:${channelId}` : `yt:${id}`) || `yt:${id}`;
    const published = snippet ? str(snippet, "publishedAt") : "";
    const parsedAt = published ? Date.parse(published) : NaN;
    comments.push({
      id,
      from,
      name,
      text,
      at: Number.isFinite(parsedAt) ? parsedAt : 0,
      source: "youtube",
    });
  }
  return { comments, pageToken: nextPageToken, pollAfterMs: clampPollMs(obj.pollingIntervalMillis) };
}

export function parseYoutubeLiveChatIdFromVideos(payload: unknown): string | null {
  const obj = asObj(payload);
  const items = obj && Array.isArray(obj.items) ? obj.items : [];
  for (const item of items) {
    const rec = asObj(item);
    const details = rec ? asObj(rec.liveStreamingDetails) : null;
    const id = details ? str(details, "activeLiveChatId").trim() : "";
    if (id) return id.slice(0, 80);
  }
  return null;
}

export function parseYoutubeLiveChatIdFromBroadcasts(payload: unknown): string | null {
  const obj = asObj(payload);
  const items = obj && Array.isArray(obj.items) ? obj.items : [];
  for (const item of items) {
    const rec = asObj(item);
    const snippet = rec ? asObj(rec.snippet) : null;
    const id = snippet ? str(snippet, "liveChatId").trim() : "";
    if (id) return id.slice(0, 80);
  }
  return null;
}

async function youtubeAccessToken(
  env: YoutubeEnv,
  cache: YoutubeTokenCache | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<YoutubeTokenCache | null> {
  if (cache && cache.access && cache.expiresAt - 60_000 > now) return cache;
  if (!youtubeOauthConfigured(env)) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.YOUTUBE_OAUTH_REFRESH_TOKEN!.trim(),
    client_id: env.YOUTUBE_OAUTH_CLIENT_ID!.trim(),
    client_secret: env.YOUTUBE_OAUTH_CLIENT_SECRET!.trim(),
  });
  try {
    const res = await fetchImpl(YT_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(DEST_CHAT_FETCH_MS),
    });
    if (!res.ok) return null;
    const json = asObj(await res.json().catch(() => null));
    const access = json ? str(json, "access_token") : "";
    if (!access) return null;
    const expiresIn = json ? Number(json.expires_in) : NaN;
    const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
    return { access, expiresAt: now + ttl };
  } catch {
    return null;
  }
}

async function youtubeGet(
  env: YoutubeEnv,
  path: string,
  query: Record<string, string>,
  cache: YoutubeTokenCache | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ json: unknown; cache: YoutubeTokenCache | null } | null> {
  const url = new URL(`${YT_API}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const apiKey = env.YOUTUBE_API_KEY?.trim();
  if (apiKey) url.searchParams.set("key", apiKey);
  const headers: Record<string, string> = {};
  let nextCache = cache;
  if (youtubeOauthConfigured(env)) {
    const authed = await youtubeAccessToken(env, cache, fetchImpl, now);
    if (authed) {
      nextCache = authed;
      headers.Authorization = `Bearer ${authed.access}`;
    } else if (!apiKey) {
      return null;
    }
  }
  try {
    const res = await fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(DEST_CHAT_FETCH_MS) });
    if (!res.ok) return { json: null, cache: nextCache };
    return { json: await res.json().catch(() => null), cache: nextCache };
  } catch {
    return null;
  }
}

async function resolveLiveChatId(
  env: YoutubeEnv,
  cursor: DestChatCursor,
  cache: YoutubeTokenCache | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ liveChatId: string; cache: YoutubeTokenCache | null } | null> {
  const fromEnv = env.YOUTUBE_LIVE_CHAT_ID?.trim();
  if (fromEnv) return { liveChatId: fromEnv.slice(0, 80), cache };
  if (cursor.liveChatId) return { liveChatId: cursor.liveChatId, cache };

  const videoId = env.YOUTUBE_VIDEO_ID?.trim();
  if (videoId) {
    const got = await youtubeGet(env, "/videos", { part: "liveStreamingDetails", id: videoId }, cache, fetchImpl, now);
    if (!got) return null;
    const id = parseYoutubeLiveChatIdFromVideos(got.json);
    if (id) return { liveChatId: id, cache: got.cache };
    return { liveChatId: "", cache: got.cache };
  }

  if (youtubeOauthConfigured(env)) {
    const got = await youtubeGet(
      env,
      "/liveBroadcasts",
      { part: "snippet", broadcastStatus: "active", mine: "true" },
      cache,
      fetchImpl,
      now,
    );
    if (!got) return null;
    const id = parseYoutubeLiveChatIdFromBroadcasts(got.json);
    if (id) return { liveChatId: id, cache: got.cache };
    return { liveChatId: "", cache: got.cache };
  }

  return null;
}

export async function pollYoutubeChat(
  env: YoutubeEnv,
  cursor: DestChatCursor,
  cache: YoutubeTokenCache | null,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<DestChatPollResult> {
  if (!youtubeChatConfigured(env)) return { page: null, cache };
  const resolved = await resolveLiveChatId(env, cursor, cache, fetchImpl, now);
  if (!resolved?.liveChatId) return { page: null, cache: resolved?.cache ?? cache };
  const query: Record<string, string> = {
    liveChatId: resolved.liveChatId,
    part: "snippet,authorDetails",
    maxResults: "200",
  };
  if (cursor.pageToken && cursor.liveChatId === resolved.liveChatId) query.pageToken = cursor.pageToken;
  const got = await youtubeGet(env, "/liveChat/messages", query, resolved.cache, fetchImpl, now);
  if (!got) return { page: null, liveChatId: resolved.liveChatId, cache: resolved.cache };
  const page = parseYoutubeChatPage(got.json);
  if (!page) return { page: null, liveChatId: resolved.liveChatId, cache: got.cache };
  return { page, liveChatId: resolved.liveChatId, cache: got.cache };
}

export const youtubeChatProvider: DestChatProvider = {
  id: "youtube",
  configured: youtubeChatConfigured,
  poll: (env, cursor, cache, fetchImpl) => pollYoutubeChat(env, cursor, cache, fetchImpl),
};

export const destChatProviders: DestChatProvider[] = [youtubeChatProvider];
