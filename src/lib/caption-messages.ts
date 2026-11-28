export type CaptionWorkerIn =
  | { type: "init"; runtimeUrl: string; runtimeBase: string; modelBase: string; model: string }
  | { type: "frame"; samples: Float32Array };

export type CaptionWorkerOut =
  | { type: "ready" }
  | { type: "unsupported"; reason: "model" | "run" }
  | { type: "segment"; text: string; durationMs: number; ageMs: number };
