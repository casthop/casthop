import { composeFrame, pickComposeBackend, pickComposeThread, spawnComposeWorker, type ComposeBackend, type ComposeCaption, type ComposePin } from "./compositor";
import type { ComposeWorkerIn, ComposeWorkerOut } from "./compose-messages";
import { FRAME_SAMPLE_CAP, pushSample, supportsOffscreenCompose, supportsTrackGenerator, usedSamples } from "./compose-support";
import { OUT_H, OUT_W, VERT_H, VERT_W } from "./draw-canvas";
import type { LayoutMode } from "./wasm";

export type ComposeStats = {
  thread: "worker" | "main";
  backend: ComposeBackend;
  frames: number;
  dropped: number;
  frameMs: number[];
};

export type ProgramCompose = {
  thread: "worker" | "main";
  backend: ComposeBackend;
  outputTrack: MediaStreamTrack | null;
  addSource: (id: string, source: MediaStreamTrack | HTMLVideoElement) => void;
  removeSource: (id: string) => void;
  setMeta: (
    mode: LayoutMode,
    title: string,
    subtitle: string,
    pin?: ComposePin | null,
    caption?: ComposeCaption | null,
  ) => void;
  snapshot: () => Promise<ComposeStats>;
  stop: () => void;
};

function waitReady(worker: Worker, timeoutMs: number): Promise<ComposeBackend> {
  return new Promise((resolve, reject) => {
    const t = self.setTimeout(() => reject(new Error("compose worker init timeout")), timeoutMs);
    const onMsg = (ev: MessageEvent<ComposeWorkerOut>) => {
      if (ev.data.type === "ready") {
        self.clearTimeout(t);
        worker.removeEventListener("message", onMsg);
        resolve(ev.data.backend);
        return;
      }
      if (ev.data.type === "error") {
        self.clearTimeout(t);
        worker.removeEventListener("message", onMsg);
        reject(new Error(ev.data.message));
      }
    };
    worker.addEventListener("message", onMsg);
  });
}

function replaceCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const next = document.createElement("canvas");
  next.width = old.width || OUT_W;
  next.height = old.height || OUT_H;
  next.setAttribute("style", old.getAttribute("style") ?? "");
  old.replaceWith(next);
  return next;
}

function post(worker: Worker, msg: ComposeWorkerIn, transfer: Transferable[] = []): void {
  worker.postMessage(msg, transfer);
}

async function startWorker(opts: {
  canvas: HTMLCanvasElement;
  backend: ComposeBackend;
  mode: LayoutMode;
  title: string;
  subtitle: string;
  width: number;
  height: number;
}): Promise<ProgramCompose> {
  const worker = spawnComposeWorker();
  let outputTrack: MediaStreamTrack | null = null;
  // One 30 fps compose paints the OffscreenCanvas; captureStream samples that same frame.
  if (typeof opts.canvas.captureStream === "function") {
    try {
      outputTrack = opts.canvas.captureStream(30).getVideoTracks()[0] ?? null;
    } catch {
      outputTrack = null;
    }
  }
  const offscreen = opts.canvas.transferControlToOffscreen();
  const transfer: Transferable[] = [offscreen];
  let writable: WritableStream<VideoFrame> | undefined;
  if (!outputTrack && supportsTrackGenerator()) {
    const gen = new MediaStreamTrackGenerator({ kind: "video" });
    outputTrack = gen;
    writable = gen.writable;
    transfer.push(writable);
  }
  if (!outputTrack) {
    worker.terminate();
    throw new Error("compose worker has no output track");
  }
  post(
    worker,
    {
      type: "init",
      canvas: offscreen,
      backend: opts.backend,
      width: opts.width,
      height: opts.height,
      mode: opts.mode,
      writable,
    },
    transfer,
  );
  const backend = await waitReady(worker, 4000).catch((err: unknown) => {
    worker.terminate();
    outputTrack?.stop();
    throw err;
  });
  post(worker, { type: "meta", mode: opts.mode, title: opts.title, subtitle: opts.subtitle });

  const processors = new Map<string, MediaStreamTrackProcessor>();

  return {
    thread: "worker",
    backend,
    outputTrack,
    addSource: (id, source) => {
      const track = source instanceof MediaStreamTrack ? source : source.srcObject instanceof MediaStream ? source.srcObject.getVideoTracks()[0] : null;
      if (!track) return;
      try {
        const processor = new MediaStreamTrackProcessor({ track });
        processors.set(id, processor);
        post(worker, { type: "add", id, readable: processor.readable }, [processor.readable]);
      } catch (err) {
        console.warn("compose track processor", err);
      }
    },
    removeSource: (id) => {
      processors.delete(id);
      post(worker, { type: "remove", id });
    },
    setMeta: (mode, title, subtitle, pin, caption) => {
      post(worker, { type: "meta", mode, title, subtitle, pin: pin ?? null, caption: caption ?? null });
    },
    snapshot: () =>
      new Promise((resolve, reject) => {
        const onMsg = (ev: MessageEvent<ComposeWorkerOut>) => {
          if (ev.data.type !== "stats") return;
          worker.removeEventListener("message", onMsg);
          resolve({ thread: "worker", backend: ev.data.backend, frames: ev.data.frames, dropped: ev.data.dropped, frameMs: ev.data.frameMs });
        };
        worker.addEventListener("message", onMsg);
        post(worker, { type: "snapshot" });
        self.setTimeout(() => {
          worker.removeEventListener("message", onMsg);
          reject(new Error("compose snapshot timeout"));
        }, 2000);
      }),
    stop: () => {
      processors.clear();
      post(worker, { type: "stop" });
      worker.terminate();
      outputTrack?.stop();
    },
  };
}

function startMain(opts: {
  canvas: HTMLCanvasElement;
  backend: ComposeBackend;
  mode: LayoutMode;
  title: string;
  subtitle: string;
  width: number;
  height: number;
}): ProgramCompose {
  const videos = new Map<string, HTMLVideoElement>();
  const owned: HTMLVideoElement[] = [];
  let mode = opts.mode;
  let title = opts.title;
  let subtitle = opts.subtitle;
  let pin: ComposePin | null = null;
  let caption: ComposeCaption | null = null;
  let backend = opts.backend;
  let raf = 0;
  let busy = false;
  let dropped = 0;
  let frames = 0;
  let running = true;
  const samples = new Float64Array(FRAME_SAMPLE_CAP);
  const cursor = { i: 0, n: 0 };
  let outputTrack: MediaStreamTrack | null = null;
  if (typeof opts.canvas.captureStream === "function") {
    try {
      outputTrack = opts.canvas.captureStream(30).getVideoTracks()[0] ?? null;
    } catch {
      outputTrack = null;
    }
  }

  const tick = () => {
    if (!running) return;
    if (busy) {
      dropped += 1;
      raf = requestAnimationFrame(tick);
      return;
    }
    busy = true;
    const list = [...videos.values()].filter((v) => v.videoWidth > 0);
    void composeFrame({
      backend,
      videos: list,
      mode,
      title,
      subtitle,
      pin,
      caption,
      canvas: opts.canvas,
      width: opts.width,
      height: opts.height,
    })
      .then((result) => {
        backend = result.backend;
        pushSample(samples, cursor, result.ms);
        frames += 1;
      })
      .finally(() => {
        busy = false;
        if (running) raf = requestAnimationFrame(tick);
      });
  };
  raf = requestAnimationFrame(tick);

  return {
    thread: "main",
    get backend() {
      return backend;
    },
    outputTrack,
    addSource: (id, source) => {
      if (source instanceof HTMLVideoElement) {
        videos.set(id, source);
        return;
      }
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.srcObject = new MediaStream([source]);
      video.style.position = "absolute";
      video.style.left = "-9999px";
      document.body.appendChild(video);
      void video.play().catch(() => undefined);
      videos.set(id, video);
      owned.push(video);
    },
    removeSource: (id) => {
      const video = videos.get(id);
      videos.delete(id);
      if (video && owned.includes(video)) {
        video.pause();
        video.srcObject = null;
        video.remove();
      }
    },
    setMeta: (nextMode, nextTitle, nextSubtitle, nextPin, nextCaption) => {
      mode = nextMode;
      title = nextTitle;
      subtitle = nextSubtitle;
      pin = nextPin ?? null;
      caption = nextCaption ?? null;
    },
    snapshot: async () => ({
      thread: "main",
      backend,
      frames,
      dropped,
      frameMs: usedSamples(samples, cursor.n),
    }),
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      owned.forEach((v) => {
        v.pause();
        v.srcObject = null;
        v.remove();
      });
      owned.length = 0;
      videos.clear();
      outputTrack?.stop();
    },
  };
}

export async function startProgramCompose(opts: {
  canvas: HTMLCanvasElement;
  backend?: ComposeBackend;
  mode?: LayoutMode;
  title?: string;
  subtitle?: string;
  preferWorker?: boolean;
  width?: number;
  height?: number;
}): Promise<ProgramCompose> {
  const backend = opts.backend ?? pickComposeBackend();
  const mode = opts.mode ?? "grid";
  const title = opts.title ?? "Casthop";
  const subtitle = opts.subtitle ?? "live";
  const width = opts.width ?? (mode === "portrait" ? VERT_W : OUT_W);
  const height = opts.height ?? (mode === "portrait" ? VERT_H : OUT_H);
  const thread = pickComposeThread();
  const wantWorker = opts.preferWorker ?? thread !== "main";
  if (wantWorker && (thread === "worker" || supportsOffscreenCompose())) {
    try {
      return await startWorker({ canvas: opts.canvas, backend, mode, title, subtitle, width, height });
    } catch (err) {
      console.warn("offthread compose fallback", err);
      const canvas = opts.canvas.parentElement ? replaceCanvas(opts.canvas) : opts.canvas;
      return startMain({ canvas, backend, mode, title, subtitle, width, height });
    }
  }
  return startMain({ canvas: opts.canvas, backend, mode, title, subtitle, width, height });
}
