import type { Account, ClipRecord, Env, LivePhase, PublicClip } from "./types";
import {
  canViewReplay,
  hlsContentType,
  hlsFilenamesInPlaylist,
  HLS_INDEX,
  isHlsFilename,
  MAX_FILE_BYTES,
  playlistError,
} from "./replays";
import { randomId } from "./security";

export const CLIP_SECONDS = [30, 60] as const;
export type ClipSeconds = (typeof CLIP_SECONDS)[number];
export const MAX_CLIPS_PER_STUDIO = 100;
export const LIVE_HLS_MAX_FILES = 32;

export function parseClipSeconds(value: unknown): ClipSeconds | null {
  if (value === 30 || value === 60) return value;
  return null;
}

export function newClipId(): string {
  return randomId(10);
}

export function livePrefix(studioId: string): string {
  return `live/${studioId}/`;
}

export function liveObjectKey(studioId: string, file: string): string {
  return `${livePrefix(studioId)}${file}`;
}

export function clipPrefix(studioId: string, clipId: string): string {
  return `clips/${studioId}/${clipId}/`;
}

export function clipObjectKey(studioId: string, clipId: string, file: string): string {
  return `${clipPrefix(studioId, clipId)}${file}`;
}

export function clipPlaylistUrl(clipId: string): string {
  return `/api/clips/${clipId}/hls/${HLS_INDEX}`;
}

export function clipDownloadUrl(clipId: string): string {
  return `/api/clips/${clipId}/file`;
}

export function publicClip(row: ClipRecord, viewerCanEdit: boolean): PublicClip {
  const { studioId, ...rest } = row;
  return {
    ...rest,
    playlistUrl: clipPlaylistUrl(row.id),
    downloadUrl: clipDownloadUrl(row.id),
    viewerCanEdit,
    ...(viewerCanEdit ? { studioId } : {}),
  };
}

export function liveHlsWritable(phase: LivePhase): boolean {
  return phase === "starting" || phase === "live" || phase === "retrying";
}

export type HlsSegment = {
  duration: number;
  uri: string;
};

export type HlsSlice = {
  playlist: string;
  files: string[];
  durationMs: number;
};

function uniqueNames(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function parseHlsSegments(text: string): { mapUri: string | null; targetDuration: number; version: string; segments: HlsSegment[] } {
  const segments: HlsSegment[] = [];
  let mapUri: string | null = null;
  let targetDuration = 4;
  let version = "7";
  let pending: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-VERSION:")) {
      const v = line.slice("#EXT-X-VERSION:".length).trim();
      if (v) version = v;
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const n = Number(line.slice("#EXT-X-TARGETDURATION:".length).trim());
      if (Number.isFinite(n) && n > 0) targetDuration = n;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = /URI="([^"]+)"/i.exec(line);
      if (match?.[1]) mapUri = match[1];
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const n = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pending = Number.isFinite(n) && n > 0 ? n : null;
      continue;
    }
    if (line && !line.startsWith("#") && pending != null) {
      segments.push({ duration: pending, uri: line });
      pending = null;
    }
  }
  return { mapUri, targetDuration, version, segments };
}

export function sliceHlsPlaylist(text: string, seconds: number): HlsSlice | { error: string } {
  const err = playlistError(text);
  if (err) return { error: err };
  const parsed = parseHlsSegments(text);
  if (parsed.segments.length === 0) return { error: "no program yet" };
  if (parsed.mapUri && !isHlsFilename(parsed.mapUri)) return { error: "playlist has an unsafe URI" };
  for (const seg of parsed.segments) {
    if (!isHlsFilename(seg.uri)) return { error: "playlist has an unsafe URI" };
  }
  let acc = 0;
  const kept: HlsSegment[] = [];
  for (let i = parsed.segments.length - 1; i >= 0; i--) {
    const seg = parsed.segments[i];
    if (!seg) continue;
    kept.unshift(seg);
    acc += seg.duration;
    if (acc >= seconds) break;
  }
  let target = 1;
  for (const seg of kept) {
    const ceil = Math.ceil(seg.duration);
    if (ceil > target) target = ceil;
  }
  if (parsed.targetDuration > target) target = parsed.targetDuration;
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${parsed.version}`,
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  if (parsed.mapUri) lines.push(`#EXT-X-MAP:URI="${parsed.mapUri}"`);
  for (const seg of kept) {
    lines.push(`#EXTINF:${seg.duration.toFixed(1)},`, seg.uri);
  }
  lines.push("#EXT-X-ENDLIST", "");
  const files = uniqueNames([...(parsed.mapUri ? [parsed.mapUri] : []), ...kept.map((s) => s.uri), HLS_INDEX]);
  return { playlist: lines.join("\n"), files, durationMs: Math.round(acc * 1000) };
}

export async function deletePrefix(env: Env, prefix: string): Promise<void> {
  if (typeof env.RECORDINGS.list !== "function") return;
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.RECORDINGS.list(
      cursor ? { prefix, limit: 1000, cursor } : { prefix, limit: 1000 },
    );
    if (listed.objects.length) {
      await env.RECORDINGS.delete(listed.objects.map((obj) => obj.key));
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }
}

export async function deleteLivePrefix(env: Env, studioId: string): Promise<void> {
  await deletePrefix(env, livePrefix(studioId));
}

export async function deleteClipPrefix(env: Env, studioId: string, clipId: string): Promise<void> {
  await deletePrefix(env, clipPrefix(studioId, clipId));
}

export async function putLiveHlsFile(
  env: Env,
  studioId: string,
  file: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!isHlsFilename(file)) {
    throw Object.assign(new Error("invalid filename"), { status: 400 });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    throw Object.assign(new Error("invalid file size"), { status: 400 });
  }
  if (file === HLS_INDEX) {
    const err = playlistError(new TextDecoder().decode(bytes));
    if (err) throw Object.assign(new Error(err), { status: 400 });
  }
  const listed = await env.RECORDINGS.list({ prefix: livePrefix(studioId), limit: LIVE_HLS_MAX_FILES + 1 });
  const exists = listed.objects.some((obj) => obj.key === liveObjectKey(studioId, file));
  if (!exists && listed.objects.length >= LIVE_HLS_MAX_FILES) {
    throw Object.assign(new Error("too many files"), { status: 400 });
  }
  await env.RECORDINGS.put(liveObjectKey(studioId, file), bytes, {
    httpMetadata: { contentType: hlsContentType(file) },
  });
  if (file === HLS_INDEX) {
    await trimLivePrefix(env, studioId, new TextDecoder().decode(bytes));
  }
}

async function trimLivePrefix(env: Env, studioId: string, playlist: string): Promise<void> {
  const keep = new Set(hlsFilenamesInPlaylist(playlist));
  keep.add(HLS_INDEX);
  const listed = await env.RECORDINGS.list({ prefix: livePrefix(studioId), limit: 1000 });
  const drop: string[] = [];
  for (const obj of listed.objects) {
    const name = obj.key.slice(livePrefix(studioId).length);
    if (!keep.has(name)) drop.push(obj.key);
  }
  if (drop.length) await env.RECORDINGS.delete(drop);
}

export async function loadLivePlaylist(env: Env, studioId: string): Promise<string | null> {
  const obj = await env.RECORDINGS.get(liveObjectKey(studioId, HLS_INDEX));
  if (!obj) return null;
  return obj.text();
}

export async function copyLiveSliceToClip(
  env: Env,
  studioId: string,
  clipId: string,
  slice: HlsSlice,
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  for (const name of slice.files) {
    if (name === HLS_INDEX) continue;
    if (!isHlsFilename(name)) {
      throw Object.assign(new Error("invalid filename"), { status: 400 });
    }
    const src = await env.RECORDINGS.get(liveObjectKey(studioId, name));
    if (!src) throw Object.assign(new Error("no program yet"), { status: 409 });
    const payload = new Uint8Array(await src.arrayBuffer());
    bytes += payload.byteLength;
    await env.RECORDINGS.put(clipObjectKey(studioId, clipId, name), payload, {
      httpMetadata: { contentType: hlsContentType(name) },
    });
  }
  const playlistBytes = new TextEncoder().encode(slice.playlist);
  bytes += playlistBytes.byteLength;
  await env.RECORDINGS.put(clipObjectKey(studioId, clipId, HLS_INDEX), playlistBytes, {
    httpMetadata: { contentType: hlsContentType(HLS_INDEX) },
  });
  return { bytes, files: slice.files.length };
}

export async function serveClipObject(env: Env, clip: ClipRecord, file: string): Promise<Response> {
  if (!isHlsFilename(file)) return jsonError("not found", 404);
  const obj = await env.RECORDINGS.get(clipObjectKey(clip.studioId, clip.id, file));
  if (!obj) return jsonError("not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", hlsContentType(file));
  headers.set("Cache-Control", clip.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

export async function serveClipDownload(env: Env, clip: ClipRecord): Promise<Response> {
  const playlistObj = await env.RECORDINGS.get(clipObjectKey(clip.studioId, clip.id, HLS_INDEX));
  if (!playlistObj) return jsonError("not found", 404);
  const playlist = await playlistObj.text();
  const names = hlsFilenamesInPlaylist(playlist).filter((name) => !name.endsWith(".m3u8"));
  const objects: R2ObjectBody[] = [];
  let total = 0;
  for (const name of names) {
    if (!isHlsFilename(name)) return jsonError("not found", 404);
    const obj = await env.RECORDINGS.get(clipObjectKey(clip.studioId, clip.id, name));
    if (!obj) return jsonError("not found", 404);
    objects.push(obj);
    total += obj.size;
  }
  if (objects.length === 0) return jsonError("not found", 404);
  // Pipe segments one by one so the clip is never held in memory.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    for (const obj of objects) await obj.body.pipeTo(writable, { preventClose: true });
    await writable.close();
  })().catch((err) => writable.abort(err));
  const first = names[0] ?? "clip.mp4";
  const ext = first.endsWith(".webm") ? "webm" : "mp4";
  const headers = new Headers();
  headers.set("Content-Type", ext === "webm" ? "video/webm" : "video/mp4");
  headers.set("Content-Length", String(total));
  headers.set("Content-Disposition", `attachment; filename="clip-${clip.id}.${ext}"`);
  headers.set("Cache-Control", clip.visibility === "public" ? "public, max-age=0, must-revalidate" : "private, no-store");
  headers.set("Vary", "Cookie");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(readable, { headers });
}

export async function canViewClip(
  env: Env,
  clip: ClipRecord,
  account: Account | undefined,
): Promise<{ ok: true; editor: boolean } | { ok: false; status: 401 | 403 }> {
  return canViewReplay(env, clip, account);
}

function jsonError(error: string, status: 400 | 404): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
