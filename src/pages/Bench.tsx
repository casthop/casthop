import { useEffect, useState } from "react";
import { jsBlurComposite, jsComposeNearest, jsDenoiseFrame, JS_FRAME } from "../lib/js-pipeline";
import { loadWasm, wasmAssetUrl, WasmBlur, WasmCompositor, WasmDenoiser } from "../lib/wasm";

type Row = { name: string; wasmMs: number; jsMs: number; ratio: number; unit: string };

export function Bench() {
  const [log, setLog] = useState("running…");
  const [rows, setRows] = useState<Row[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = await loadWasm();
      const wasmBytes = await fetch(wasmAssetUrl()).then((r) => r.arrayBuffer());
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
      const jsScratch = blurSrc.slice();
      const jsState = { smooth: null, feather: null, down: null, tmp: null };
      jsScratch.set(blurSrc);
      jsBlurComposite(jsScratch, blurW, blurH, blurMask, 256, 144, 24, 0, jsState);
      const t5 = performance.now();
      for (let i = 0; i < blurFrames; i++) {
        jsScratch.set(blurSrc);
        jsBlurComposite(jsScratch, blurW, blurH, blurMask, 256, 144, 24, 0, jsState);
      }
      const jsBlur = performance.now() - t5;

      const gpu = "gpu" in navigator ? "navigator.gpu present" : "no WebGPU";
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
      setExtra({
        wasmBytes: String(wasmBytes.byteLength),
        wasmKiB: (wasmBytes.byteLength / 1024).toFixed(1),
        webgpu: gpu,
        frames: String(frames),
        composeFrames: String(composeFrames),
      });
      setLog("ok");
      (window as unknown as { __BENCH__: unknown }).__BENCH__ = { rows: rowsOut, extra: { wasmBytes: wasmBytes.byteLength, webgpu: gpu } };
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
      <pre style={{ marginTop: 24, color: "#9aa0ab" }}>{JSON.stringify(extra, null, 2)}</pre>
    </div>
  );
}
