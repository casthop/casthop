import type { ComposeBackend } from "./compose-backend";
import type { LayoutMode } from "./wasm";

export type ComposeWorkerIn =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      backend: ComposeBackend;
      width: number;
      height: number;
      writable?: WritableStream<VideoFrame>;
    }
  | { type: "add"; id: string; readable: ReadableStream<VideoFrame> }
  | { type: "remove"; id: string }
  | { type: "meta"; mode: LayoutMode; title: string; subtitle: string }
  | { type: "snapshot" }
  | { type: "stop" };

export type ComposeWorkerOut =
  | { type: "ready"; backend: ComposeBackend }
  | { type: "stats"; frames: number; dropped: number; frameMs: number[]; backend: ComposeBackend }
  | { type: "error"; message: string };
