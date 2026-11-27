import { seg } from "./path-segment";

const SEGMENT_MS = 4_000;
const MAX_BUFFER_MS = 64_000;

export type LiveSeg ={ name: string; duration: number };

function recorderMime(): string {
  const types = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return types.find((type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

function extFor(mime: string): "webm" | "mp4" {
  return mime.includes("mp4") ? "mp4" : "webm";
}

function programStream(canvas: HTMLCanvasElement, audios: HTMLMediaElement[]): MediaStream | null {
  if (typeof canvas.captureStream !== "function") return null;
  const stream = canvas.captureStream(30);
  for (const el of audios) {
    const capture = "captureStream" in el ? (el as HTMLMediaElement & { captureStream: () => MediaStream }).captureStream() : null;
    if (!capture) continue;
    for (const track of capture.getAudioTracks()) stream.addTrack(track);
  }
  return stream;
}

// Cluster (webm) ID bytes, and the "moof" box type (fmp4).
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const MOOF = [0x6d, 0x6f, 0x6f, 0x66];

function indexOfBytes(data: Uint8Array, needle: number[]): number {
  for (let i = 0; i + needle.length <= data.length; i++) {
    if (needle.every((byte, j) => data[i + j] === byte)) return i;
  }
  return -1;
}

/** Byte length of the container header at the start of the first chunk. */
export function initLength(first: Uint8Array): number {
  const cluster = indexOfBytes(first, CLUSTER_ID);
  if (cluster >= 0) return cluster;
  // The moof box starts 4 bytes (its size field) before its type.
  const moof = indexOfBytes(first, MOOF);
  return moof >= 4 ? moof - 4 : first.length;
}

export function playlistFor(segs: LiveSeg[], init: string): string {
  let target = 4;
  for (const seg of segs) {
    const ceil = Math.ceil(seg.duration);
    if (ceil > target) target = ceil;
  }
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${init}"`,
  ];
  for (const seg of segs) {
    lines.push(`#EXTINF:${seg.duration.toFixed(1)},`, seg.name);
  }
  return `${lines.join("\n")}\n`;
}

export async function putLiveFile(studioId: string, token: string, name: string, body: Blob | string, contentType: string): Promise<void> {
  const payload = typeof body === "string" ? new Blob([body], { type: contentType }) : body;
  const res = await fetch(`/api/studios/${seg(studioId)}/live-hls/${seg(name)}`, {
    method: "PUT",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Content-Length": String(payload.size),
    },
    body: payload,
  });
  // fetch does not throw on 4xx/5xx
  if (!res.ok) throw new Error(`live-hls PUT ${name} failed: ${res.status}`);
}

function addElementAudio(stream: MediaStream, el: HTMLMediaElement): void {
  const capture = "captureStream" in el ? (el as HTMLMediaElement & { captureStream: () => MediaStream }).captureStream() : null;
  if (!capture) return;
  for (const track of capture.getAudioTracks()) stream.addTrack(track);
}

/** Rolling HLS window of the program canvas. Runs off the compose loop. */
export function startLiveProgramBuffer(opts: {
  canvas: HTMLCanvasElement;
  audios: HTMLMediaElement[];
  studioId: string;
  token: string;
}): { stop: () => void; addAudio: (el: HTMLMediaElement) => void } {
  const mime = recorderMime();
  const stream = mime ? programStream(opts.canvas, opts.audios) : null;
  if (!mime || !stream) return { stop: () => undefined, addAudio: () => undefined };

  let stopped = false;
  let seq = 0;
  const segs: LiveSeg[] = [];
  const ext = extFor(mime);
  const initName = `init.${ext}`;
  const contentType = `video/${ext}`;
  let initBlob: Blob | null = null;
  let initStored = false;

  const store = async (blob: Blob) => {
    if (stopped) return;
    // One continuous recording: its first chunk holds the container header.
    // Playlist and clips start with it; later chunks only play after it.
    // The first chunk also carries ~4 s of media, so cut the header off it.
    if (!initBlob) {
      const cut = initLength(new Uint8Array(await blob.arrayBuffer()));
      initBlob = blob.slice(0, cut);
      if (cut >= blob.size) return;
      blob = blob.slice(cut);
    }
    const name = `seg${String(seq).padStart(3, "0")}.${ext}`;
    seq += 1;
    segs.push({ name, duration: SEGMENT_MS / 1000 });
    let acc = segs.reduce((sum, seg) => sum + seg.duration, 0);
    while (acc > MAX_BUFFER_MS / 1000 && segs.length > 1) {
      const dropped = segs.shift();
      acc -= dropped?.duration ?? 0;
    }
    try {
      if (!initStored) {
        await putLiveFile(opts.studioId, opts.token, initName, initBlob, contentType);
        initStored = true;
      }
      await putLiveFile(opts.studioId, opts.token, name, blob, contentType);
    } catch {
      // never list a segment that was not stored
      const at = segs.findIndex((seg) => seg.name === name);
      if (at >= 0) segs.splice(at, 1);
      return;
    }
    if (stopped) return;
    try {
      await putLiveFile(opts.studioId, opts.token, "index.m3u8", playlistFor(segs, initName), "application/vnd.apple.mpegurl");
    } catch {
      /* next chunk retries */
    }
  };

  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime });
  } catch {
    return { stop: () => undefined, addAudio: () => undefined };
  }
  let queue: Promise<void> = Promise.resolve();
  rec.ondataavailable = (event) => {
    if (event.data.size) queue = queue.then(() => store(event.data));
  };
  rec.start(SEGMENT_MS);
  return {
    stop: () => {
      stopped = true;
      if (rec.state !== "inactive") rec.stop();
      for (const track of stream.getTracks()) track.stop();
    },
    addAudio: (el: HTMLMediaElement) => addElementAudio(stream, el),
  };
}