export type ComposeBackend = "wasm-cpu" | "js-cpu" | "canvas2d" | "webgpu" | "webgpu-ts";

export function pickComposeBackendFrom(search: string): ComposeBackend {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const q = new URLSearchParams(raw).get("compose");
  if (q === "wasm" || q === "cpu") return "wasm-cpu";
  if (q === "js") return "js-cpu";
  if (q === "webgpu" || q === "wgpu") return "webgpu";
  if (q === "webgpu-ts") return "webgpu-ts";
  return "canvas2d";
}

export function pickComposeBackend(): ComposeBackend {
  return pickComposeBackendFrom(typeof location === "undefined" ? "" : location.search);
}
