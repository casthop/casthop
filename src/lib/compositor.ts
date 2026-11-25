import { layoutRects, loadWasm, type LayoutMode, type Rect, WasmCompositor } from "./wasm";
import { jsComposeNearest, jsLayout } from "./js-pipeline";

export type ComposeBackend = "wasm-cpu" | "js-cpu" | "canvas2d" | "webgpu";

export type TileSource = CanvasImageSource & { width?: number; height?: number };

const OUT_W = 1280;
const OUT_H = 720;

export async function composeFrame(opts: {
  backend: ComposeBackend;
  videos: HTMLVideoElement[];
  mode: LayoutMode;
  title: string;
  subtitle: string;
  canvas: HTMLCanvasElement;
}): Promise<{ backend: ComposeBackend; ms: number }> {
  const t0 = performance.now();
  const { videos, mode, title, subtitle, canvas } = opts;
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const n = Math.max(1, videos.length);

  if (opts.backend === "webgpu") {
    const ok = await drawWebGpu(canvas, videos, mode, title, subtitle);
    if (ok) return { backend: "webgpu", ms: performance.now() - t0 };
    return composeFrame({ ...opts, backend: "canvas2d" });
  }

  if (opts.backend === "canvas2d") {
    await drawCanvas2d(canvas, videos, mode, title, subtitle);
    return { backend: "canvas2d", ms: performance.now() - t0 };
  }

  if (opts.backend === "js-cpu") {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const dst = ctx.createImageData(OUT_W, OUT_H);
    dst.data.fill(0);
    fillBg(dst.data, OUT_W, OUT_H, 11, 11, 13);
    const rects = jsLayout(n, mode === "solo" ? 0 : mode === "side" ? 1 : mode === "screen" ? 3 : 2);
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
    videos.forEach((video, i) => {
      const r = rects[i];
      if (!r || !video.videoWidth) return;
      scratch.width = 640;
      scratch.height = 360;
      sctx.drawImage(video, 0, 0, 640, 360);
      const tile = sctx.getImageData(0, 0, 640, 360);
      jsComposeNearest(
        dst.data,
        OUT_W,
        OUT_H,
        tile.data,
        640,
        360,
        Math.round(r.x * OUT_W),
        Math.round(r.y * OUT_H),
        Math.round(r.w * OUT_W),
        Math.round(r.h * OUT_H),
      );
    });
    ctx.putImageData(dst, 0, 0);
    drawBanner2d(ctx, title, subtitle);
    return { backend: "js-cpu", ms: performance.now() - t0 };
  }

  const api = await loadWasm();
  const comp = new WasmCompositor(api, OUT_W, OUT_H);
  comp.clear();
  const rects = layoutRects(api, n, mode, OUT_W, OUT_H);
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
  videos.forEach((video, i) => {
    const r = rects[i];
    if (!r || !video.videoWidth) return;
    scratch.width = 640;
    scratch.height = 360;
    sctx.drawImage(video, 0, 0, 640, 360);
    const tile = sctx.getImageData(0, 0, 640, 360);
    comp.blit(tile.data, 640, 360, r, false);
  });
  comp.banner(title, subtitle);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(comp.imageData(), 0, 0);
  return { backend: "wasm-cpu", ms: performance.now() - t0 };
}

async function drawCanvas2d(
  canvas: HTMLCanvasElement,
  videos: HTMLVideoElement[],
  mode: LayoutMode,
  title: string,
  subtitle: string,
): Promise<void> {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  let rects: Rect[];
  try {
    const api = await loadWasm();
    rects = layoutRects(api, Math.max(1, videos.length), mode, OUT_W, OUT_H);
  } catch {
    const js = jsLayout(
      Math.max(1, videos.length),
      mode === "solo" ? 0 : mode === "side" ? 1 : mode === "screen" ? 3 : 2,
    );
    rects = js.map((r) => ({ x: r.x * OUT_W, y: r.y * OUT_H, w: r.w * OUT_W, h: r.h * OUT_H }));
  }
  videos.forEach((video, i) => {
    const r = rects[i];
    if (!r) return;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.clip();
    if (video.videoWidth) ctx.drawImage(video, r.x, r.y, r.w, r.h);
    else {
      ctx.fillStyle = "#22232b";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  });
  drawBanner2d(ctx, title, subtitle);
}

function drawBanner2d(ctx: CanvasRenderingContext2D, title: string, subtitle: string): void {
  const h = Math.round(OUT_H * 0.11);
  const y = OUT_H - h - Math.round(OUT_H / 28);
  const x = Math.round(OUT_W / 24);
  const w = OUT_W - x * 2;
  ctx.fillStyle = "rgba(18,19,22,0.9)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
  ctx.fillStyle = "#6d64f7";
  ctx.fillRect(x, y, 6, h);
  ctx.fillStyle = "#f3f4f6";
  ctx.font = "600 28px 'Public Sans', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 22, y + h / 2 - 2);
  ctx.fillStyle = "#9aa0ab";
  ctx.font = "500 20px 'Public Sans', sans-serif";
  ctx.fillText(subtitle, x + 22 + ctx.measureText(title).width + 28, y + h / 2);
}

function fillBg(data: Uint8ClampedArray, w: number, h: number, r: number, g: number, b: number): void {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
}

let gpuFail = false;

async function drawWebGpu(
  canvas: HTMLCanvasElement,
  videos: HTMLVideoElement[],
  mode: LayoutMode,
  title: string,
  subtitle: string,
): Promise<boolean> {
  if (gpuFail || !("gpu" in navigator)) return false;
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      gpuFail = true;
      return false;
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      gpuFail = true;
      return false;
    }
    const device = await adapter.requestDevice();
    const gpuCanvas = document.createElement("canvas");
    gpuCanvas.width = OUT_W;
    gpuCanvas.height = OUT_H;
    const ctx = gpuCanvas.getContext("webgpu");
    if (!ctx) {
      gpuFail = true;
      return false;
    }
    const format = gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "opaque" });
    const api = await loadWasm();
    const rects = layoutRects(api, Math.max(1, videos.length), mode, 1, 1);

    const shader = device.createShaderModule({
      code: `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32, @location(0) rect: vec4f) -> VsOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let c = corners[i];
  let x = rect.x + c.x * rect.z;
  let y = rect.y + c.y * rect.w;
  var out: VsOut;
  out.pos = vec4f(x * 2.0 - 1.0, (1.0 - y) * 2.0 - 1.0, 0.0, 1.0);
  out.uv = c;
  return out;
}
@fragment fn fs(v: VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, v.uv);
}
`,
    });
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: {
        module: shader,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 16,
            stepMode: "instance",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
          },
        ],
      },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.043, g: 0.043, b: 0.051, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]!;
      const r = rects[i];
      if (!r || !video.videoWidth) continue;
      const texture = device.createTexture({
        size: { width: video.videoWidth, height: video.videoHeight },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: video }, { texture }, { width: video.videoWidth, height: video.videoHeight });
      const bg = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: texture.createView() },
        ],
      });
      const buf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, new Float32Array([r.x, r.y, r.w, r.h]));
      pass.setBindGroup(0, bg);
      pass.setVertexBuffer(0, buf);
      pass.draw(6, 1, 0, 0);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    const dst = canvas.getContext("2d");
    if (!dst) return false;
    dst.drawImage(gpuCanvas, 0, 0);
    drawBanner2d(dst, title, subtitle);
    return true;
  } catch (err) {
    console.warn("webgpu compositor fallback", err);
    gpuFail = true;
    return false;
  }
}

export function pickComposeBackend(): ComposeBackend {
  const q = new URLSearchParams(location.search).get("compose");
  if (q === "wasm" || q === "cpu") return "wasm-cpu";
  if (q === "js") return "js-cpu";
  if (q === "webgpu") return "webgpu";
  return "canvas2d";
}

export function spawnComposeWorker(): Worker {
  return new Worker(new URL("../workers/compose-worker.ts", import.meta.url), { type: "module" });
}
