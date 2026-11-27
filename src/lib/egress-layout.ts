import type { LayoutMode } from "./wasm";

export function isPortraitLayout(raw: string): boolean {
  const v = raw.toLowerCase();
  return v === "portrait" || v === "vertical" || v === "9:16";
}

export function egressLayoutMode(raw: string): LayoutMode {
  const v = raw.toLowerCase();
  if (isPortraitLayout(v)) return "portrait";
  return v === "solo" || v === "side" || v === "screen" ? v : "grid";
}

/** Clips come from the 16:9 program only; portrait pages must not write the shared buffer. */
export function shouldWriteLiveBuffer(rawLayout: string): boolean {
  return !isPortraitLayout(rawLayout);
}
