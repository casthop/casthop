export const ISO_TIMESLICE_MS = 2000;

export type IsoAuth = {
  identity: string;
  name: string;
  guestSecret?: string;
};

export function pickRecorderMime(stream: MediaStream): string {
  const hasVideo = stream.getVideoTracks().some((t) => t.readyState === "live");
  const types = hasVideo
    ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

export async function startIsoTrack(
  studioId: string,
  auth: IsoAuth,
  body: { sessionId: string; kind: "camera" | "screen"; mimeType: string; startedAt: number },
): Promise<{ id: string }> {
  const data = await postJson<{ track: { id: string } }>(`/api/studios/${encodeURIComponent(studioId)}/iso`, {
    identity: auth.identity,
    guestSecret: auth.guestSecret,
    name: auth.name,
    ...body,
  });
  return { id: data.track.id };
}

export const ISO_UPLOAD_MAX_FAILS = 8;

export class IsoHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IsoHttpError";
  }
}

export function isoUploadRetryable(err: unknown): boolean {
  if (!(err instanceof IsoHttpError)) return true;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

export async function uploadIsoChunk(
  studioId: string,
  trackId: string,
  index: number,
  blob: Blob,
  auth: IsoAuth,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Casthop-Identity": auth.identity,
  };
  if (auth.guestSecret) headers["X-Casthop-Guest-Secret"] = auth.guestSecret;
  const res = await fetch(`/api/studios/${encodeURIComponent(studioId)}/iso/${encodeURIComponent(trackId)}/chunks/${index}`, {
    method: "PUT",
    credentials: "same-origin",
    headers,
    body: blob,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new IsoHttpError(res.status, data.error || `${res.status} upload`);
  }
}

export async function completeIsoTrack(studioId: string, trackId: string, auth: IsoAuth): Promise<void> {
  await postJson(`/api/studios/${encodeURIComponent(studioId)}/iso/${encodeURIComponent(trackId)}/complete`, {
    identity: auth.identity,
    guestSecret: auth.guestSecret,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ChunkUploader {
  private queue: Blob[] = [];
  private index = 0;
  private fail = 0;
  private closed = false;
  private abandoned = false;
  private pump: Promise<void> = Promise.resolve();

  constructor(
    private studioId: string,
    private trackId: string,
    private auth: IsoAuth,
  ) {}

  enqueue(blob: Blob): void {
    if (this.closed || this.abandoned || blob.size < 1) return;
    this.queue.push(blob);
    this.pump = this.pump.then(() => this.flush());
  }

  private async flush(): Promise<void> {
    while (this.queue.length && !this.abandoned) {
      const blob = this.queue[0];
      if (!blob) break;
      try {
        await uploadIsoChunk(this.studioId, this.trackId, this.index, blob, this.auth);
        this.queue.shift();
        this.index += 1;
        this.fail = 0;
      } catch (err) {
        // A retry hitting 409 means the earlier put landed and was counted.
        if (this.fail > 0 && err instanceof IsoHttpError && err.status === 409 && err.message === "chunk out of order") {
          this.queue.shift();
          this.index += 1;
          this.fail = 0;
          continue;
        }
        this.fail += 1;
        if (!isoUploadRetryable(err) || this.fail >= ISO_UPLOAD_MAX_FAILS) {
          this.queue.length = 0;
          this.abandoned = true;
          return;
        }
        await sleep(Math.min(8000, 400 * 2 ** Math.min(this.fail, 4)));
      }
    }
  }

  async finish(): Promise<void> {
    this.closed = true;
    await this.pump;
    await this.flush();
    try {
      await completeIsoTrack(this.studioId, this.trackId, this.auth);
    } catch {
      /* stop even if complete is gone */
    }
  }
}

class TrackRecorder {
  private recorder: MediaRecorder;
  private uploader: ChunkUploader | null = null;
  private pending: Blob[] = [];
  readonly ready: Promise<void>;
  failed = false;

  constructor(
    studioId: string,
    auth: IsoAuth,
    sessionId: string,
    kind: "camera" | "screen",
    stream: MediaStream,
    mimeType: string,
  ) {
    const opts: MediaRecorderOptions = { mimeType };
    if (stream.getVideoTracks().length) opts.videoBitsPerSecond = 2_000_000;
    if (stream.getAudioTracks().length) opts.audioBitsPerSecond = 128_000;
    this.recorder = new MediaRecorder(stream, opts);
    this.ready = startIsoTrack(studioId, auth, { sessionId, kind, mimeType, startedAt: Date.now() })
      .then((track) => {
        this.uploader = new ChunkUploader(studioId, track.id, auth);
        for (const blob of this.pending) this.uploader.enqueue(blob);
        this.pending = [];
      })
      .catch((err: unknown) => {
        this.failed = true;
        if (this.recorder.state !== "inactive") this.recorder.stop();
        throw err;
      });
    this.recorder.addEventListener("dataavailable", (ev) => {
      if (!ev.data.size) return;
      if (this.uploader) this.uploader.enqueue(ev.data);
      else this.pending.push(ev.data);
    });
  }

  start(): void {
    if (this.failed || this.recorder.state !== "inactive") return;
    this.recorder.start(ISO_TIMESLICE_MS);
  }

  async stop(): Promise<void> {
    await this.ready.catch(() => undefined);
    if (this.recorder.state !== "inactive") {
      const ended = new Promise<void>((resolve) => {
        this.recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      this.recorder.stop();
      await ended;
    }
    await this.uploader?.finish();
  }
}

export type IsoStreams = {
  camera: MediaStream | null;
  screen: MediaStream | null;
};

export class IsoRecorder {
  private camera: TrackRecorder | null = null;
  private screen: TrackRecorder | null = null;
  private stopped = false;

  constructor(
    private studioId: string,
    private sessionId: string,
    private auth: IsoAuth,
    private onError?: () => void,
  ) {}

  async sync(streams: IsoStreams): Promise<void> {
    if (this.stopped) return;
    if (this.camera?.failed) this.camera = null;
    if (this.screen?.failed) this.screen = null;
    if (streams.camera && !this.camera) {
      const mime = pickRecorderMime(streams.camera);
      if (mime) {
        try {
          this.camera = new TrackRecorder(this.studioId, this.auth, this.sessionId, "camera", streams.camera, mime);
          this.camera.start();
          void this.camera.ready.catch(() => {
            if (!this.stopped) this.onError?.();
          });
        } catch {
          this.camera = null;
        }
      }
    }
    if (streams.screen && !this.screen) {
      const mime = pickRecorderMime(streams.screen);
      if (mime) {
        try {
          this.screen = new TrackRecorder(this.studioId, this.auth, this.sessionId, "screen", streams.screen, mime);
          this.screen.start();
          void this.screen.ready.catch(() => {
            if (!this.stopped) this.onError?.();
          });
        } catch {
          this.screen = null;
        }
      }
    }
    if (!streams.screen && this.screen) {
      const rec = this.screen;
      this.screen = null;
      await rec.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const camera = this.camera;
    const screen = this.screen;
    this.camera = null;
    this.screen = null;
    await Promise.all([camera?.stop(), screen?.stop()]);
  }
}
