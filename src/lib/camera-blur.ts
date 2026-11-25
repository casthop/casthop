import { fxFromSearch } from "./effects";
import { jsBlurComposite, type JsBlurState } from "./js-pipeline";
import { loadWasm, WasmBlur } from "./wasm";

export type BlurBackend = "wasm" | "js";

export function blurBackendFromSearch(search = location.search): BlurBackend {
  return fxFromSearch(search) === "js" ? "js" : "wasm";
}

export type CameraBlurHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

type Composite = {
  setup: (w: number, h: number, mw: number, mh: number) => boolean;
  process: (frame: Uint8ClampedArray, mask: Uint8Array, mw: number, mh: number) => void;
  free: () => void;
};

async function makeComposite(backend: BlurBackend): Promise<Composite> {
  if (backend === "wasm") {
    const api = await loadWasm();
    const blur = new WasmBlur(api);
    return {
      setup: (w, h, mw, mh) => blur.setup(w, h, mw, mh),
      process: (frame, mask) => {
        blur.process(frame, mask);
      },
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
    },
    free: () => {
      state.smooth = null;
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
): Promise<CameraBlurHandle> {
  const settings = source.getSettings();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([source]);
  await video.play();
  const width = Math.max(16, Math.min(1920, video.videoWidth || settings.width || 1280));
  const height = Math.max(16, Math.min(1080, video.videoHeight || settings.height || 720));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    video.srcObject = null;
    throw new Error("no 2d canvas");
  }

  const { createSegmenter } = await import("./segmenter");
  const segmenter = await createSegmenter();
  const composite = await makeComposite(backend);
  composite.setup(width, height, segmenter.maskWidth, segmenter.maskHeight);

  const out = canvas.captureStream(30);
  const outTrack = out.getVideoTracks()[0];
  if (!outTrack) {
    segmenter.close();
    composite.free();
    video.srcObject = null;
    throw new Error("captureStream failed");
  }

  let running = true;
  let frameCb = 0;
  let raf = 0;
  let lastTs = -1;
  let maskW = segmenter.maskWidth;
  let maskH = segmenter.maskHeight;

  const tick = (now: number, mediaTime?: number) => {
    if (!running) return;
    const ts = mediaTime !== undefined ? mediaTime * 1000 : now;
    if (ts <= lastTs) {
      schedule(tick);
      return;
    }
    lastTs = ts;
    ctx.drawImage(video, 0, 0, width, height);
    if (segmenter.segment(video, ts)) {
      if (segmenter.maskWidth !== maskW || segmenter.maskHeight !== maskH) {
        maskW = segmenter.maskWidth;
        maskH = segmenter.maskHeight;
        composite.setup(width, height, maskW, maskH);
      }
      const frame = ctx.getImageData(0, 0, width, height);
      composite.process(frame.data, segmenter.mask, maskW, maskH);
      ctx.putImageData(frame, 0, 0);
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
      running = false;
      const v = video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
      if (frameCb && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(frameCb);
      if (raf) cancelAnimationFrame(raf);
      outTrack.stop();
      out.getTracks().forEach((t) => t.stop());
      video.pause();
      video.srcObject = null;
      segmenter.close();
      composite.free();
    },
  };
}
