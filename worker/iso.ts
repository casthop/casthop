import type { IsoTrack } from "./types";

export const ISO_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const ISO_MAX_CHUNKS = 20_000;
export const ISO_CHUNK_WINDOW_MS = 60_000;
/** Camera + screen at a 2 s timeslice is 60 PUTs/min; extra headroom is for retries. */
export const ISO_CHUNK_MAX = 180;
/** Camera + screen, plus a remount, per person per live. */
export const ISO_TRACKS_PER_IDENTITY = 4;
export const ISO_TRACKS_MAX = 100;

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

export async function listIsoChunkKeys(bucket: R2Bucket, studioId: string, trackId: string): Promise<string[]> {
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

export function concatChunkStream(bucket: R2Bucket, keys: string[]): ReadableStream<Uint8Array> {
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
