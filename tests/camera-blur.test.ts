import assert from "node:assert/strict";
import { test } from "node:test";
import { startCameraBlur, type CameraBlurDeps } from "../src/lib/camera-blur.ts";
import type { LiveSegmenter } from "../src/lib/segmenter.ts";

type FakeTrack = {
  kind: string;
  stopped: boolean;
  stop: () => void;
  getSettings: () => { width: number; height: number };
};

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeVideo {
  muted = false;
  playsInline = false;
  autoplay = false;
  videoWidth = 64;
  videoHeight = 64;
  srcObject: FakeMediaStream | null = null;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  playError: Error | null = null;

  async play() {
    this.playCalls += 1;
    if (this.playError) throw this.playError;
    this.paused = false;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  ctx: object | null;
  captureTracks: FakeTrack[];

  constructor(ctx: object | null, captureTracks: FakeTrack[]) {
    this.ctx = ctx;
    this.captureTracks = captureTracks;
  }

  getContext() {
    return this.ctx;
  }

  captureStream() {
    return new FakeMediaStream(this.captureTracks);
  }
}

function fakeTrack(): FakeTrack {
  return {
    kind: "video",
    stopped: false,
    stop() {
      this.stopped = true;
    },
    getSettings() {
      return { width: 64, height: 64 };
    },
  };
}

function fakeSegmenter(onClose: () => void): LiveSegmenter {
  const mask = new Uint8Array(16 * 16);
  return {
    maskWidth: 16,
    maskHeight: 16,
    mask,
    segment() {
      return false;
    },
    close: onClose,
  };
}

function installDom(opts: { ctx?: object | null; captureTracks?: FakeTrack[]; video?: FakeVideo }) {
  const videos: FakeVideo[] = [];
  const captureTracks = opts.captureTracks ?? [fakeTrack()];
  const ctx =
    opts.ctx === undefined
      ? {
          drawImage() {},
          createImageData(w: number, h: number) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          },
          getImageData(_x: number, _y: number, w: number, h: number) {
            return { data: new Uint8ClampedArray(w * h * 4) };
          },
          putImageData() {},
        }
      : opts.ctx;
  const previous = {
    document: globalThis.document,
    MediaStream: globalThis.MediaStream,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => undefined;
  globalThis.document = {
    createElement(tag: string) {
      if (tag === "video") {
        const video = opts.video ?? new FakeVideo();
        videos.push(video);
        return video;
      }
      if (tag === "canvas") {
        return new FakeCanvas(ctx, captureTracks);
      }
      throw new Error(`unexpected element ${tag}`);
    },
  } as unknown as Document;
  return {
    videos,
    restore() {
      globalThis.document = previous.document;
      globalThis.MediaStream = previous.MediaStream;
      globalThis.requestAnimationFrame = previous.requestAnimationFrame;
      globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    },
  };
}

test("startCameraBlur releases the hidden video if the segmenter fails to load", async () => {
  const dom = installDom({});
  try {
    await assert.rejects(
      () =>
        startCameraBlur(fakeTrack() as unknown as MediaStreamTrack, "js", {
          createSegmenter: async () => {
            throw new Error("model missing");
          },
        }),
      /model missing/,
    );
    const video = dom.videos[0]!;
    assert.equal(video.pauseCalls, 1);
    assert.equal(video.srcObject, null);
  } finally {
    dom.restore();
  }
});

test("startCameraBlur closes the segmenter and video if composite setup throws", async () => {
  const dom = installDom({});
  let closed = 0;
  try {
    await assert.rejects(
      () =>
        startCameraBlur(fakeTrack() as unknown as MediaStreamTrack, "js", {
          createSegmenter: async () => fakeSegmenter(() => {
            closed += 1;
          }),
          makeComposite: async () => {
            throw new Error("wasm missing");
          },
        }),
      /wasm missing/,
    );
    assert.equal(closed, 1);
    assert.equal(dom.videos[0]!.srcObject, null);
  } finally {
    dom.restore();
  }
});

test("startCameraBlur throws and cleans up if composite.setup returns false", async () => {
  const dom = installDom({});
  let closed = 0;
  let freed = 0;
  try {
    await assert.rejects(
      () =>
        startCameraBlur(fakeTrack() as unknown as MediaStreamTrack, "js", {
          createSegmenter: async () => fakeSegmenter(() => {
            closed += 1;
          }),
          makeComposite: async () => ({
            setup: () => false,
            process: () => true,
            free: () => {
              freed += 1;
            },
          }),
        }),
      /blur setup failed/,
    );
    assert.equal(closed, 1);
    assert.equal(freed, 1);
    assert.equal(dom.videos[0]!.srcObject, null);
  } finally {
    dom.restore();
  }
});

test("startCameraBlur stop releases video, segmenter, and composite once", async () => {
  const out = fakeTrack();
  const dom = installDom({ captureTracks: [out] });
  let closed = 0;
  let freed = 0;
  const deps: CameraBlurDeps = {
    createSegmenter: async () => fakeSegmenter(() => {
      closed += 1;
    }),
    makeComposite: async () => ({
      setup: () => true,
      process: () => true,
      free: () => {
        freed += 1;
      },
    }),
  };
  try {
    const handle = await startCameraBlur(fakeTrack() as unknown as MediaStreamTrack, "js", deps);
    handle.stop();
    handle.stop();
    assert.equal(closed, 1);
    assert.equal(freed, 1);
    assert.equal(dom.videos[0]!.srcObject, null);
    assert.equal(out.stopped, true);
  } finally {
    dom.restore();
  }
});

test("startCameraBlur releases the video if play() fails", async () => {
  const video = new FakeVideo();
  video.playError = new Error("play blocked");
  const dom = installDom({ video });
  try {
    await assert.rejects(
      () => startCameraBlur(fakeTrack() as unknown as MediaStreamTrack, "js"),
      /play blocked/,
    );
    assert.equal(video.pauseCalls, 1);
    assert.equal(video.srcObject, null);
  } finally {
    dom.restore();
  }
});
