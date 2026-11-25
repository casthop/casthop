import { loadWasm, WasmCompositor, layoutRects, type LayoutMode } from "../lib/wasm";

let ready: Promise<void> | null = null;
let compositor: WasmCompositor | null = null;

async function ensure(width: number, height: number): Promise<WasmCompositor> {
  ready ??= loadWasm().then(() => undefined);
  await ready;
  const api = await loadWasm();
  if (!compositor || compositor.width !== width || compositor.height !== height) {
    compositor = new WasmCompositor(api, width, height);
  }
  return compositor;
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as {
    type: string;
    width?: number;
    height?: number;
    tiles?: { data: Uint8ClampedArray; w: number; h: number }[];
    mode?: LayoutMode;
    title?: string;
    subtitle?: string;
  };
  if (msg.type !== "compose") return;
  const width = msg.width ?? 1280;
  const height = msg.height ?? 720;
  void (async () => {
    const t0 = performance.now();
    const api = await loadWasm();
    const comp = await ensure(width, height);
    comp.clear();
    const tiles = msg.tiles ?? [];
    const rects = layoutRects(api, Math.max(1, tiles.length), msg.mode ?? "grid", width, height);
    tiles.forEach((tile, i) => {
      const r = rects[i];
      if (!r) return;
      comp.blit(tile.data, tile.w, tile.h, r, false);
    });
    comp.banner(msg.title ?? "Casthop", msg.subtitle ?? "live");
    const image = comp.imageData();
    const ms = performance.now() - t0;
    (self as unknown as Worker).postMessage({ type: "frame", image, ms }, [image.data.buffer]);
  })();
};
