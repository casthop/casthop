import type { Account, Env, PublicReplay, ReplayRecord, ReplayVisibility } from "./types";
import { updateReplayBytes } from "./db";
import { asName, randomId } from "./security";
import { hostAuth } from "./auth";

export const HLS_INDEX = "index.m3u8";
const MAX_FILES = 256;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 256 * 1024;

export type ReplayFileInput = {
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
};

export function isHlsFilename(name: string): boolean {
  if (!name || name.length > 80) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(m3u8|m4s|ts|mp4)$/.test(name);
}

export function hlsContentType(name: string): string {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".m4s")) return "video/iso.segment";
  if (name.endsWith(".ts")) return "video/MP2T";
  return "video/mp4";
}

export function replayPrefix(studioId: string, replayId: string): string {
  return `replays/${studioId}/${replayId}/`;
}

export function replayObjectKey(studioId: string, replayId: string, file: string): string {
  return `${replayPrefix(studioId, replayId)}${file}`;
}

export function playlistUrlFor(replayId: string): string {
  return `/api/replays/${replayId}/hls/${HLS_INDEX}`;
}

export function publicReplay(row: ReplayRecord, viewerCanEdit: boolean): PublicReplay {
  return { ...row, playlistUrl: playlistUrlFor(row.id), viewerCanEdit };
}

export function hlsFilenamesInPlaylist(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      for (const match of trimmed.matchAll(/URI="([^"]+)"/gi)) {
        names.push(match[1]);
      }
      continue;
    }
    names.push(trimmed);
  }
  return names;
}

export function playlistError(text: string): string | null {
  if (!text.startsWith("#EXTM3U")) return "playlist must start with #EXTM3U";
  if (text.length > MAX_PLAYLIST_BYTES) return "playlist too large";
  const names = hlsFilenamesInPlaylist(text);
  if (names.length === 0) return "playlist has no segments";
  for (const name of names) {
    if (!isHlsFilename(name)) return "playlist has an unsafe URI";
  }
  return null;
}

export function durationFromPlaylist(text: string): number | null {
  let sec = 0;
  let found = false;
  const re = /#EXTINF:([\d.]+)/g;
  let match = re.exec(text);
  while (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) {
      sec += n;
      found = true;
    }
    match = re.exec(text);
  }
  return found ? Math.round(sec * 1000) : null;
}

export function parseVisibility(value: unknown, fallback: ReplayVisibility = "private"): ReplayVisibility | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "private" || value === "public") return value;
  return null;
}

export function decodeReplayFile(file: ReplayFileInput): Uint8Array | null {
  if (!isHlsFilename(file.name) || typeof file.content !== "string") return null;
  if (file.encoding === "base64") {
    try {
      const bin = atob(file.content);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return new TextEncoder().encode(file.content);
}

export async function putReplayFiles(
  env: Env,
  studioId: string,
  replayId: string,
  files: { name: string; bytes: Uint8Array }[],
): Promise<number> {
  if (files.length === 0 || files.length > MAX_FILES) {
    throw Object.assign(new Error("invalid files"), { status: 400 });
  }
  let total = 0;
  const playlist = files.find((f) => f.name === HLS_INDEX);
  if (playlist) {
    const err = playlistError(new TextDecoder().decode(playlist.bytes));
    if (err) throw Object.assign(new Error(err), { status: 400 });
  }
  for (const file of files) {
    if (!isHlsFilename(file.name)) throw Object.assign(new Error("invalid filename"), { status: 400 });
    if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_FILE_BYTES) {
      throw Object.assign(new Error("invalid file size"), { status: 400 });
    }
    const key = replayObjectKey(studioId, replayId, file.name);
    const prev = await env.RECORDINGS.head(key);
    const prevSize = prev?.size ?? 0;
    await env.RECORDINGS.put(key, file.bytes, {
      httpMetadata: { contentType: hlsContentType(file.name) },
    });
    total += file.bytes.byteLength - prevSize;
  }
  return total;
}

export async function serveReplayObject(env: Env, replay: ReplayRecord, file: string): Promise<Response> {
  if (!isHlsFilename(file)) return jsonError("not found", 404);
  const obj = await env.RECORDINGS.get(replayObjectKey(replay.studioId, replay.id, file));
  if (!obj) return jsonError("not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", hlsContentType(file));
  headers.set("Cache-Control", replay.visibility === "public" ? "public, max-age=3600" : "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

export async function canViewReplay(
  env: Env,
  replay: ReplayRecord,
  account: Account | undefined,
): Promise<{ ok: true; editor: boolean } | { ok: false; status: 401 | 403 }> {
  const host = await hostAuth(env, replay.studioId, account);
  if (host) return { ok: true, editor: true };
  if (replay.visibility === "public") return { ok: true, editor: false };
  if (!account) return { ok: false, status: 401 };
  return { ok: false, status: 403 };
}

export function newReplayId(): string {
  return randomId(10);
}

export function ingestFilesFromBody(
  body: unknown,
): { title?: string; visibility: ReplayVisibility; durationMs: number | null; files: { name: string; bytes: Uint8Array }[] } | { error: string; status: 400 } {
  if (!body || typeof body !== "object") return { error: "invalid body", status: 400 };
  const rec = body as {
    title?: unknown;
    visibility?: unknown;
    durationMs?: unknown;
    files?: unknown;
  };
  const visibility = parseVisibility(rec.visibility);
  if (!visibility) return { error: "visibility must be private or public", status: 400 };
  const filesIn = Array.isArray(rec.files) ? rec.files : [];
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const item of filesIn) {
    if (!item || typeof item !== "object") return { error: "invalid file", status: 400 };
    const file = item as ReplayFileInput;
    if (typeof file.name !== "string") return { error: "invalid filename", status: 400 };
    const bytes = decodeReplayFile(file);
    if (!bytes) return { error: "invalid file", status: 400 };
    files.push({ name: file.name, bytes });
  }
  if (files.length > 0 && !files.some((f) => f.name === HLS_INDEX)) {
    return { error: "index.m3u8 required", status: 400 };
  }
  let durationMs: number | null = null;
  if (typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) && rec.durationMs >= 0) {
    durationMs = Math.round(rec.durationMs);
  }
  const playlist = files.find((f) => f.name === HLS_INDEX);
  if (playlist && durationMs === null) {
    durationMs = durationFromPlaylist(new TextDecoder().decode(playlist.bytes));
  }
  const title = rec.title === undefined ? undefined : asName(rec.title, "Replay");
  return { title, visibility, durationMs, files };
}

export async function applyReplayBytes(env: Env, replayId: string, delta: number, current: number): Promise<number> {
  const next = Math.max(0, current + delta);
  await updateReplayBytes(env.DB, replayId, next);
  return next;
}

function jsonError(error: string, status: 400 | 404): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
