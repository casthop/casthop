import { composeFrame, pickComposeBackend, pickComposeThread, spawnComposeWorker, type ComposeBackend } from "./compositor";
import type { ComposeWorkerIn, ComposeWorkerOut } from "./compose-messages";
import { FRAME_SAMPLE_CAP, pushSample, supportsOffscreenCompose, supportsTrackGenerator, usedSamples } from "./compose-support";
import { OUT_H, OUT_W } from "./draw-canvas";
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
  setMeta: (mode: LayoutMode, title: string, subtitle: string) => void;
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
}): Promise<ProgramCompose> {
  const worker = spawnComposeWorker();
  const offscreen = opts.canvas.transferControlToOffscreen();
  let outputTrack: MediaStreamTrack | null = null;
  const transfer: Transferable[] = [offscreen];
  let writable: WritableStream<VideoFrame> | undefined;
  if (supportsTrackGenerator()) {
    const gen = new MediaStreamTrackGenerator({ kind: "video" });
    outputTrack = gen;
    writable = gen.writable;
    transfer.push(writable);
  } else if (typeof opts.canvas.captureStream === "function") {
    try {
      outputTrack = opts.canvas.captureStream(30).getVideoTracks()[0] ?? null;
    } catch {
      outputTrack = null;
    }
  }
  post(
    worker,
    {
      type: "init",
      canvas: offscreen,
      backend: opts.backend,
      width: OUT_W,
      height: OUT_H,
      writable,
    },
    transfer,
  );
  const backend = await waitReady(worker, 4000);
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
    setMeta: (mode, title, subtitle) => {
      post(worker, { type: "meta", mode, title, subtitle });
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
}): ProgramCompose {
  const videos = new Map<string, HTMLVideoElement>();
  const owned: HTMLVideoElement[] = [];
  let mode = opts.mode;
  let title = opts.title;
  let subtitle = opts.subtitle;
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
      canvas: opts.canvas,
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
    setMeta: (nextMode, nextTitle, nextSubtitle) => {
      mode = nextMode;
      title = nextTitle;
      subtitle = nextSubtitle;
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
}): Promise<ProgramCompose> {
  const backend = opts.backend ?? pickComposeBackend();
  const mode = opts.mode ?? "grid";
  const title = opts.title ?? "Casthop";
  const subtitle = opts.subtitle ?? "live";
  const thread = pickComposeThread();
  const wantWorker = opts.preferWorker ?? thread !== "main";
  if (wantWorker && (thread === "worker" || supportsOffscreenCompose())) {
    try {
      return await startWorker({ canvas: opts.canvas, backend, mode, title, subtitle });
    } catch (err) {
      console.warn("offthread compose fallback", err);
      const canvas = opts.canvas.parentElement ? replaceCanvas(opts.canvas) : opts.canvas;
      return startMain({ canvas, backend, mode, title, subtitle });
    }
  }
  return startMain({ canvas: opts.canvas, backend, mode, title, subtitle });
}
