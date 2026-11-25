import type { LiveSegmenter } from "./segmenter";
import { jsBlurComposite, type JsBlurState } from "./js-pipeline";

export type BlurBackend = "wasm" | "js";

export function blurBackendFromSearch(search = location.search): BlurBackend {
  return new URLSearchParams(search).get("fx") === "js" ? "js" : "wasm";
}

export type CameraBlurHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

export type CameraBlurComposite = {
  setup: (w: number, h: number, mw: number, mh: number) => boolean;
  process: (frame: Uint8ClampedArray, mask: Uint8Array, mw: number, mh: number) => boolean;
  free: () => void;
};

export type CameraBlurDeps = {
  createSegmenter?: () => Promise<LiveSegmenter>;
  makeComposite?: (backend: BlurBackend) => Promise<CameraBlurComposite>;
};

async function defaultCreateSegmenter(): Promise<LiveSegmenter> {
  const { createSegmenter } = await import("./segmenter");
  return createSegmenter();
}

async function makeComposite(backend: BlurBackend): Promise<CameraBlurComposite> {
  if (backend === "wasm") {
    const { loadWasm, WasmBlur } = await import("./wasm");
    const api = await loadWasm();
    const blur = new WasmBlur(api);
    return {
      setup: (w, h, mw, mh) => blur.setup(w, h, mw, mh),
      process: (frame, mask) => blur.process(frame, mask),
      free: () => blur.free(),
    };
  }
  const state: JsBlurState = { smooth: null, feather: null, down: null, tmp: null };
  let width = 0;
  let height = 0;
  return {
    setup: (w, h, mw, mh) => {
      if (width !== w || height !== h) state.smooth = null;
      width = w;
      height = h;
      return mw >= 8 && mh >= 8;
    },
    process: (frame, mask, mw, mh) => {
      jsBlurComposite(frame, width, height, mask, mw, mh, 24, 180, state);
      return true;
    },
    free: () => {
      state.smooth = null;
      state.feather = null;
      state.down = null;
      state.tmp = null;
    },
  };
}

/**
 * Draw the camera, segment the person, blur the rest, publish a canvas track.
 * Segmentation WASM/model load happens here, not at studio boot.
 */
export async function startCameraBlur(
  source: MediaStreamTrack,
  backend: BlurBackend = blurBackendFromSearch(),
  deps: CameraBlurDeps = {},
): Promise<CameraBlurHandle> {
  const settings = source.getSettings();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([source]);
  try {
    await video.play();
  } catch (err) {
    video.pause();
    video.srcObject = null;
    throw err;
  }
  const width = Math.max(16, Math.min(1920, video.videoWidth || settings.width || 1280));
  const height = Math.max(16, Math.min(1080, video.videoHeight || settings.height || 720));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const work = document.createElement("canvas");
  work.width = width;
  work.height = height;
  const ctx = canvas.getContext("2d");
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx || !workCtx) {
    video.pause();
    video.srcObject = null;
    throw new Error("no 2d canvas");
  }

  let segmenter: LiveSegmenter | undefined;
  let composite: CameraBlurComposite | undefined;
  let out: MediaStream | undefined;
  try {
    const createSegmenter = deps.createSegmenter ?? defaultCreateSegmenter;
    const buildComposite = deps.makeComposite ?? makeComposite;
    segmenter = await createSegmenter();
    composite = await buildComposite(backend);
    if (!composite.setup(width, height, segmenter.maskWidth, segmenter.maskHeight)) {
      throw new Error("blur setup failed");
    }

    out = canvas.captureStream(30);
    const outTrack = out.getVideoTracks()[0];
    if (!outTrack) throw new Error("captureStream failed");

    let running = true;
    let stopped = false;
    let frameCb = 0;
    let raf = 0;
    let lastTs = -1;
    let maskW = segmenter.maskWidth;
    let maskH = segmenter.maskHeight;
    const liveSegmenter = segmenter;
    const liveComposite = composite;
    const liveOut = out;

    const tick = (now: number, mediaTime?: number) => {
      if (!running) return;
      const ts = mediaTime !== undefined ? mediaTime * 1000 : now;
      if (ts <= lastTs) {
        schedule(tick);
        return;
      }
      lastTs = ts;
      try {
        workCtx.drawImage(video, 0, 0, width, height);
        if (liveSegmenter.segment(video, ts)) {
          if (liveSegmenter.maskWidth !== maskW || liveSegmenter.maskHeight !== maskH) {
            if (!liveComposite.setup(width, height, liveSegmenter.maskWidth, liveSegmenter.maskHeight)) {
              throw new Error("blur setup failed");
            }
            maskW = liveSegmenter.maskWidth;
            maskH = liveSegmenter.maskHeight;
          }
          const frame = workCtx.getImageData(0, 0, width, height);
          if (liveComposite.process(frame.data, liveSegmenter.mask, maskW, maskH)) {
            workCtx.putImageData(frame, 0, 0);
            ctx.drawImage(work, 0, 0);
          }
        }
      } catch (err) {
        console.warn("casthop blur", err);
      }
      schedule(tick);
    };

    const schedule = (cb: (now: number, mediaTime?: number) => void) => {
      const v = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (fn: (now: number, meta: { mediaTime: number }) => void) => number;
      };
      if (v.requestVideoFrameCallback) {
        frameCb = v.requestVideoFrameCallback((now, meta) => cb(now, meta.mediaTime));
      } else {
        raf = requestAnimationFrame((t) => cb(t));
      }
    };

    schedule(tick);

    return {
      track: outTrack,
      stop: () => {
        if (stopped) return;
        stopped = true;
        running = false;
        const v = video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
        if (frameCb && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(frameCb);
        if (raf) cancelAnimationFrame(raf);
        outTrack.stop();
        liveOut.getTracks().forEach((t) => t.stop());
        video.pause();
        video.srcObject = null;
        liveSegmenter.close();
        liveComposite.free();
      },
    };
  } catch (err) {
    out?.getTracks().forEach((t) => t.stop());
    composite?.free();
    segmenter?.close();
    video.pause();
    video.srcObject = null;
    throw err;
  }
}
