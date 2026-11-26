const SEGMENT_MS = 4_000;
const MAX_BUFFER_MS = 64_000;

type LiveSeg = { name: string; duration: number };

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

function playlistFor(segs: LiveSeg[]): string {
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
  ];
  for (const seg of segs) {
    lines.push(`#EXTINF:${seg.duration.toFixed(1)},`, seg.name);
  }
  return `${lines.join("\n")}\n`;
}

async function putLiveFile(studioId: string, token: string, name: string, body: Blob | string, contentType: string): Promise<void> {
  const payload = typeof body === "string" ? new Blob([body], { type: contentType }) : body;
  await fetch(`/api/studios/${studioId}/live-hls/${name}`, {
    method: "PUT",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Content-Length": String(payload.size),
    },
    body: payload,
  });
}

function recordWindow(stream: MediaStream, mime: string, ms: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onerror = () => resolve(null);
    rec.onstop = () => {
      resolve(chunks.length ? new Blob(chunks, { type: mime }) : null);
    };
    rec.start();
    window.setTimeout(() => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        resolve(null);
      }
    }, ms);
  });
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

  const tick = async () => {
    while (!stopped) {
      const blob = await recordWindow(stream, mime, SEGMENT_MS);
      if (stopped) return;
      if (!blob || blob.size === 0) {
        await new Promise((r) => window.setTimeout(r, SEGMENT_MS));
        continue;
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
        await putLiveFile(opts.studioId, opts.token, name, blob, blob.type || `video/${ext}`);
        if (stopped) return;
        await putLiveFile(opts.studioId, opts.token, "index.m3u8", playlistFor(segs), "application/vnd.apple.mpegurl");
      } catch {
        /* next window retries */
      }
    }
  };

  void tick();
  return {
    stop: () => {
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
    },
    addAudio: (el: HTMLMediaElement) => addElementAudio(stream, el),
  };
}