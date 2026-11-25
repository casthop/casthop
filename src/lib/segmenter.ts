/**
 * Lazy MediaPipe selfie segmenter. Imported only when blur is turned on.
 * WASM + model are same-origin (`public/mediapipe` and the bundled .tflite).
 */
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import modelUrl from "../vendor/mediapipe/selfie_segmenter_landscape.tflite?url";

export type LiveSegmenter = {
  maskWidth: number;
  maskHeight: number;
  mask: Uint8Array;
  segment(source: TexImageSource, timestampMs: number): boolean;
  close(): void;
};

function wasmDir(): string {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(`${root}mediapipe/wasm`, document.baseURI).toString().replace(/\/$/, "");
}

export async function createSegmenter(): Promise<LiveSegmenter> {
  const fileset = await FilesetResolver.forVisionTasks(wasmDir());
  const segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  let mask = new Uint8Array(256 * 144);
  let maskWidth = 256;
  let maskHeight = 144;

  return {
    get maskWidth() {
      return maskWidth;
    },
    get maskHeight() {
      return maskHeight;
    },
    get mask() {
      return mask;
    },
    segment(source: TexImageSource, timestampMs: number) {
      let ok = false;
      segmenter.segmentForVideo(source, timestampMs, (result) => {
        const layer = result.confidenceMasks?.[0];
        if (!layer) return;
        const w = layer.width;
        const h = layer.height;
        if (mask.length !== w * h) mask = new Uint8Array(w * h);
        maskWidth = w;
        maskHeight = h;
        if (layer.hasFloat32Array()) {
          const f = layer.getAsFloat32Array();
          const n = Math.min(f.length, mask.length);
          for (let i = 0; i < n; i++) {
            const v = f[i] ?? 0;
            mask[i] = v <= 1 ? Math.round(v * 255) : Math.min(255, v | 0);
          }
        } else {
          mask.set(layer.getAsUint8Array().subarray(0, mask.length));
        }
        ok = true;
      });
      return ok;
    },
    close() {
      segmenter.close();
    },
  };
}
