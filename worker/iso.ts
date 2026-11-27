import type { IsoTrack } from "./types";
import type { ObjectStore } from "./tenant";

export const ISO_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const ISO_MAX_CHUNKS = 20_000;
export const ISO_TRACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ISO_SESSION_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const ISO_CHUNK_WINDOW_MS = 60_000;
/** Camera + screen at a 2 s timeslice is 60 PUTs/min; extra headroom is for retries. */
export const ISO_CHUNK_MAX = 180;
/** Hard cap on one chunk's R2 put. The reservation is aborted when it fires. */
export const ISO_PUT_TIMEOUT_MS = 15_000;

/** Rejects if `work` takes longer than `ms`; the caller then aborts its reservation. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("put timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
/** Camera + screen, plus a remount, per person per live. */
export const ISO_TRACKS_PER_IDENTITY = 4;
/** Per live session, and the max listed history after dropping the oldest. */
export const ISO_TRACKS_MAX = 100;

export type IsoStartPlan = { kept: IsoTrack[]; dropped: string[] };

/** Null if this start should 429. Otherwise the list to append to, with old history trimmed. */
export function isoTracksForStart(tracks: IsoTrack[], identity: string, sessionId: string): IsoStartPlan | null {
  const mine = tracks.filter((row) => row.identity === identity && row.sessionId === sessionId);
  const sessionCount = tracks.filter((row) => row.sessionId === sessionId).length;
  if (mine.length >= ISO_TRACKS_PER_IDENTITY || sessionCount >= ISO_TRACKS_MAX) return null;
  if (tracks.length < ISO_TRACKS_MAX) return { kept: tracks, dropped: [] };
  const overflow = tracks.length - ISO_TRACKS_MAX + 1;
  const drop = tracks
    .filter((row) => row.sessionId !== sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, overflow)
    .map((row) => row.id);
  if (drop.length < overflow) return null;
  const dropSet = new Set(drop);
  return { kept: tracks.filter((row) => !dropSet.has(row.id)), dropped: drop };
}

/** False if adding this chunk would pass the per-track or per-session byte cap. */
export function isoChunkFits(tracks: IsoTrack[], track: IsoTrack, bytes: number): boolean {
  const sessionBytes = tracks.filter((row) => row.sessionId === track.sessionId).reduce((sum, row) => sum + row.bytes, 0);
  return track.bytes + bytes <= ISO_TRACK_MAX_BYTES && sessionBytes + bytes <= ISO_SESSION_MAX_BYTES;
}

export function isoPrefix(studioId: string, trackId: string): string {
  return `iso/${studioId}/${trackId}/`;
}

export function isoChunkKey(studioId: string, trackId: string, index: number): string {
  return `${isoPrefix(studioId, trackId)}${String(index).padStart(6, "0")}`;
}

export function parseChunkIndex(raw: string): number | null {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= ISO_MAX_CHUNKS) return null;
  return n;
}

export function isoMimeOk(mime: string): boolean {
  const type = mime.trim().toLowerCase().split(";")[0]?.trim();
  return type === "video/webm" || type === "audio/webm" || type === "video/mp4" || type === "audio/mp4";
}

export function isoKindOk(kind: unknown): kind is IsoTrack["kind"] {
  return kind === "camera" || kind === "screen";
}

export function mixedFilename(path: string | null): string | null {
  if (!path) return null;
  const name = path.split("/").pop();
  return name || null;
}

export function downloadName(track: IsoTrack): string {
  const safe = track.name.replace(/[^\w.-]+/g, "_").slice(0, 40) || "guest";
  const ext = track.mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
  return `${safe}-${track.kind}.${ext}`;
}

export function chunkKeysFromList(objects: { key: string }[], prefix: string): string[] {
  return objects
    .map((o) => o.key)
    .filter((key) => {
      if (!key.startsWith(prefix)) return false;
      return /^\d{6}$/.test(key.slice(prefix.length));
    })
    .sort();
}

/** Only the indexes the Durable Object accepted, so extra objects in the prefix cannot join the file. */
export function downloadChunkKeys(keys: string[], prefix: string, chunks: number): string[] {
  return keys.filter((key) => {
    const n = parseChunkIndex(key.slice(prefix.length));
    return n !== null && n < chunks;
  });
}

export async function listIsoChunkKeys(bucket: ObjectStore, studioId: string, trackId: string): Promise<string[]> {
  const prefix = isoPrefix(studioId, trackId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...chunkKeysFromList(page.objects, prefix));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deleteIsoTrackObjects(bucket: ObjectStore, studioId: string, trackId: string): Promise<void> {
  const keys = await listIsoChunkKeys(bucket, studioId, trackId);
  if (keys.length) await bucket.delete(keys);
}

export function concatChunkStream(bucket: ObjectStore, keys: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      while (i < keys.length) {
        const key = keys[i];
        i += 1;
        if (!key) continue;
        const obj = await bucket.get(key);
        if (!obj) continue;
        const buf = new Uint8Array(await obj.arrayBuffer());
        if (buf.byteLength) {
          controller.enqueue(buf);
          return;
        }
      }
      controller.close();
    },
  });
}
