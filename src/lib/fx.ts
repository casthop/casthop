export type FxBackend = "wasm" | "js" | "off";

export function fxFromSearch(search = typeof location === "undefined" ? "" : location.search): FxBackend {
  const v = new URLSearchParams(search).get("fx");
  if (v === "js" || v === "off" || v === "wasm") return v;
  return "wasm";
}

/** Query `?fx=off` always wins. The mic toggle otherwise turns the pipeline off. */
export function fxBackendForDenoise(on: boolean, search = typeof location === "undefined" ? "" : location.search): FxBackend {
  const requested = fxFromSearch(search);
  if (requested === "off" || !on) return "off";
  return requested;
}
