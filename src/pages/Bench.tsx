import { useEffect, useState } from "react";
import { jsBlurComposite, jsComposeNearest, jsDenoiseFrame, JS_FRAME } from "../lib/js-pipeline";
import { composeFrame, type ComposeBackend } from "../lib/compositor";
import { loadWasm, wasmAssetUrl, WasmBlur, WasmCompositor, WasmDenoiser } from "../lib/wasm";
import { gpuWasmAssetUrl } from "../lib/gpu-compositor";

type Row = { name: string; wasmMs: number; jsMs: number; ratio: number; unit: string };
type GpuRow = { tiles: number; canvas2dMs: number; webgpuTsMs: number | null; wgpuMs: number | null };

function makeTiles(n: number): HTMLCanvasElement[] {
  const colors = ["#6d64f7", "#f59e0b", "#22c55e", "#38bdf8", "#f43f5e", "#a3e635"];
  return Array.from({ length: n }, (_, i) => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = colors[i % colors.length]!;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#0b0b0d";
    ctx.font = "48px sans-serif";
    ctx.fillText(String(i + 1), 40, 80);
    return c;
  });
}

async function benchBackend(backend: ComposeBackend, tiles: HTMLCanvasElement[], frames: number): Promise<number | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  document.body.appendChild(canvas);
  try {
    const first = await composeFrame({
      backend,
      videos: tiles,
      mode: "grid",
      title: "Casthop",
      subtitle: "bench",
      canvas,
    });
    if (first.backend !== backend) return null;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      await composeFrame({
        backend,
        videos: tiles,
        mode: "grid",
        title: "Casthop",
        subtitle: "bench",
        canvas,
      });
    }
    return (performance.now() - t0) / frames;
  } catch {
    return null;
  } finally {
    canvas.remove();
  }
}

export function Bench() {
  const [log, setLog] = useState("running…");
  const [rows, setRows] = useState<Row[]>([]);
  const [gpuRows, setGpuRows] = useState<GpuRow[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = await loadWasm();
      const wasmBytes = await fetch(wasmAssetUrl()).then((r) => r.arrayBuffer());
      let gpuBytes = 0;
      try {
        gpuBytes = (await fetch(gpuWasmAssetUrl()).then((r) => r.arrayBuffer())).byteLength;
      } catch {
        gpuBytes = 0;
      }
      const denoise = new WasmDenoiser(api);
      const frames = 4_000;
      const sine = new Float32Array(JS_FRAME);
      for (let i = 0; i < JS_FRAME; i++) {
        sine[i] = Math.sin((i * 440 * 2 * Math.PI) / 48000) * 0.2 + (Math.random() - 0.5) * 0.05;
      }

      const t0 = performance.now();
      for (let i = 0; i < frames; i++) denoise.process(sine);
      const wasmDenoise = performance.now() - t0;

      const t1 = performance.now();
      for (let i = 0; i < frames; i++) jsDenoiseFrame(sine);
      const jsDenoise = performance.now() - t1;

      const tile = new Uint8ClampedArray(640 * 360 * 4);
      for (let i = 0; i < tile.length; i += 4) {
        tile[i] = (i * 13) & 255;
        tile[i + 1] = 80;
        tile[i + 2] = 110;
        tile[i + 3] = 255;
      }
      const composeFrames = 40;
      const t2 = performance.now();
      const comp = new WasmCompositor(api, 1280, 720);
      for (let i = 0; i < composeFrames; i++) {
        comp.clear();
        for (let n = 0; n < 4; n++) {
          comp.blit(tile, 640, 360, { x: (n % 2) * 640, y: Math.floor(n / 2) * 360, w: 640, h: 360 }, false);
        }
        comp.banner("Casthop", "bench");
        void comp.imageData();
      }
      const wasmCompose = performance.now() - t2;

      const dst = new Uint8ClampedArray(1280 * 720 * 4);
      const t3 = performance.now();
      for (let i = 0; i < composeFrames; i++) {
        dst.fill(11);
        for (let n = 0; n < 4; n++) {
          jsComposeNearest(dst, 1280, 720, tile, 640, 360, (n % 2) * 640, Math.floor(n / 2) * 360, 640, 360);
        }
      }
      const jsCompose = performance.now() - t3;

      const blurW = 1280;
      const blurH = 720;
      const blurSrc = new Uint8ClampedArray(blurW * blurH * 4);
      const blurMask = new Uint8Array(256 * 144);
      for (let i = 0; i < blurW * blurH; i++) {
        const x = i % blurW;
        const y = (i / blurW) | 0;
        const o = i * 4;
        const on = ((x >> 3) + (y >> 3)) & 1;
        blurSrc[o] = on ? 240 : 20;
        blurSrc[o + 1] = 80;
        blurSrc[o + 2] = on ? 20 : 200;
        blurSrc[o + 3] = 255;
      }
      for (let y = 0; y < 144; y++) {
        for (let x = 0; x < 256; x++) {
          const cx = x - 128;
          const cy = y - 72;
          blurMask[y * 256 + x] = cx * cx + cy * cy < 50 * 50 ? 255 : 0;
        }
      }
      const blur = new WasmBlur(api);
      blur.setup(blurW, blurH, 256, 144, 24, 0);
      const blurFrames = 20;
      const scratch = blurSrc.slice();
      for (let i = 0; i < 2; i++) {
        scratch.set(blurSrc);
        blur.process(scratch, blurMask);
      }
      const t4 = performance.now();
      for (let i = 0; i < blurFrames; i++) {
        scratch.set(blurSrc);
        blur.process(scratch, blurMask);
      }
      const wasmBlur = performance.now() - t4;
      blur.free();
      const jsScratch = blurSrc.slice();
      const jsState = { smooth: null, feather: null, down: null, tmp: null, prefix: null };
      jsScratch.set(blurSrc);
      jsBlurComposite(jsScratch, blurW, blurH, blurMask, 256, 144, 24, 0, jsState);
      const t5 = performance.now();
      for (let i = 0; i < blurFrames; i++) {
        jsScratch.set(blurSrc);
        jsBlurComposite(jsScratch, blurW, blurH, blurMask, 256, 144, 24, 0, jsState);
      }
      const jsBlur = performance.now() - t5;

      const gpuPresent = "gpu" in navigator ? "navigator.gpu present" : "no WebGPU";
      const gpuComposeFrames = 30;
      const gpuOut: GpuRow[] = [];
      for (const n of [2, 4, 6]) {
        const tiles = makeTiles(n);
        const canvas2dMs = await benchBackend("canvas2d", tiles, gpuComposeFrames);
        const webgpuTsMs = await benchBackend("webgpu-ts", tiles, gpuComposeFrames);
        const wgpuMs = await benchBackend("webgpu", tiles, gpuComposeFrames);
        gpuOut.push({
          tiles: n,
          canvas2dMs: canvas2dMs ?? Number.NaN,
          webgpuTsMs,
          wgpuMs,
        });
      }

      const rowsOut: Row[] = [
        {
          name: "RNNoise denoise (10 ms frame)",
          wasmMs: wasmDenoise / frames,
          jsMs: jsDenoise / frames,
          ratio: jsDenoise / wasmDenoise,
          unit: "ms/frame",
        },
        {
          name: "Layout+blit 1280×720 ×4 tiles",
          wasmMs: wasmCompose / composeFrames,
          jsMs: jsCompose / composeFrames,
          ratio: jsCompose / wasmCompose,
          unit: "ms/frame",
        },
        {
          name: "Background blur 1280×720",
          wasmMs: wasmBlur / blurFrames,
          jsMs: jsBlur / blurFrames,
          ratio: jsBlur / wasmBlur,
          unit: "ms/frame",
        },
      ];
      if (cancelled) return;
      setRows(rowsOut);
      setGpuRows(gpuOut);
      setExtra({
        wasmBytes: String(wasmBytes.byteLength),
        wasmKiB: (wasmBytes.byteLength / 1024).toFixed(1),
        gpuWasmBytes: String(gpuBytes),
        gpuWasmKiB: (gpuBytes / 1024).toFixed(1),
        webgpu: gpuPresent,
        frames: String(frames),
        composeFrames: String(composeFrames),
        gpuComposeFrames: String(gpuComposeFrames),
      });
      setLog("ok");
      window.__BENCH__ = {
        rows: rowsOut,
        gpu: gpuOut,
        extra: {
          wasmBytes: wasmBytes.byteLength,
          gpuWasmBytes: gpuBytes,
          webgpu: gpuPresent,
        },
      };
    })().catch((err) => setLog(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ padding: 32, fontFamily: "Public Sans, sans-serif", background: "#121316", minHeight: "100dvh", color: "#f3f4f6" }}>
      <h1 style={{ fontWeight: 650 }}>WASM vs JS bench</h1>
      <p style={{ color: "#9aa0ab" }}>{log}</p>
      <table style={{ borderCollapse: "collapse", minWidth: 640 }}>
        <thead>
          <tr>
            {["Path", "WASM", "JS", "JS/WASM"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #2a2b32" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ padding: "8px 12px" }}>{r.name}</td>
              <td style={{ padding: "8px 12px" }}>
                {r.wasmMs.toFixed(3)} {r.unit}
              </td>
              <td style={{ padding: "8px 12px" }}>
                {r.jsMs.toFixed(3)} {r.unit}
              </td>
              <td style={{ padding: "8px 12px" }}>{r.ratio.toFixed(2)}×</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 style={{ fontWeight: 650, marginTop: 32 }}>Compose 1280×720</h2>
      <p style={{ color: "#9aa0ab" }}>Canvas2D vs TypeScript WebGPU vs wgpu. Same tiles, reused GPU device.</p>
      <table style={{ borderCollapse: "collapse", minWidth: 640 }}>
        <thead>
          <tr>
            {["Tiles", "Canvas2D", "TS WebGPU", "wgpu"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #2a2b32" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {gpuRows.map((r) => (
            <tr key={r.tiles}>
              <td style={{ padding: "8px 12px" }}>{r.tiles}</td>
              <td style={{ padding: "8px 12px" }}>{Number.isFinite(r.canvas2dMs) ? `${r.canvas2dMs.toFixed(3)} ms/frame` : "—"}</td>
              <td style={{ padding: "8px 12px" }}>{r.webgpuTsMs == null ? "—" : `${r.webgpuTsMs.toFixed(3)} ms/frame`}</td>
              <td style={{ padding: "8px 12px" }}>{r.wgpuMs == null ? "—" : `${r.wgpuMs.toFixed(3)} ms/frame`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre style={{ marginTop: 24, color: "#9aa0ab" }}>{JSON.stringify(extra, null, 2)}</pre>
    </div>
  );
}
