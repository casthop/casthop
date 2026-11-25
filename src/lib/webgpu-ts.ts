import { layoutRects, loadWasm, type LayoutMode } from "./wasm";

export type GpuTile = HTMLVideoElement | HTMLCanvasElement;

function tileSize(tile: GpuTile): { w: number; h: number } {
  if (tile instanceof HTMLVideoElement) return { w: tile.videoWidth, h: tile.videoHeight };
  return { w: tile.width, h: tile.height };
}

type TsTile = {
  width: number;
  height: number;
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  rectBuf: GPUBuffer;
};

function dropTile(slot: TsTile): void {
  slot.texture.destroy();
  slot.rectBuf.destroy();
}

type TsGpu = {
  device: GPUDevice;
  format: GPUTextureFormat;
  sampler: GPUSampler;
  pipeline: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
  canvas: HTMLCanvasElement;
  ctx: GPUCanvasContext;
  tiles: (TsTile | null)[];
};

let cached: TsGpu | null = null;
let inflight: Promise<TsGpu | null> | null = null;
let tsFail = false;
let drawFails = 0;
const DRAW_FAIL_LIMIT = 3;

const SHADER = `
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
`;

function dropGpu(gpu: TsGpu): void {
  for (const slot of gpu.tiles) {
    if (slot) dropTile(slot);
  }
  gpu.device.destroy();
}

async function ensureTsGpu(width: number, height: number): Promise<TsGpu | null> {
  if (tsFail || !("gpu" in navigator)) return null;
  if (cached && cached.canvas.width === width && cached.canvas.height === height) return cached;
  if (inflight) {
    await inflight;
    if (tsFail) return null;
    if (cached && cached.canvas.width === width && cached.canvas.height === height) return cached;
  }
  const pending = openTsGpu(width, height);
  inflight = pending;
  try {
    return await pending;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

async function openTsGpu(width: number, height: number): Promise<TsGpu | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) {
      tsFail = true;
      return null;
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      tsFail = true;
      return null;
    }
    const device = await adapter.requestDevice();
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("webgpu");
      if (!ctx) {
        device.destroy();
        tsFail = true;
        return null;
      }
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: "opaque" });
      const shader = device.createShaderModule({ code: SHADER });
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
      if (cached) {
        dropGpu(cached);
        cached = null;
      }
      cached = { device, format, sampler, pipeline, bgl, canvas, ctx, tiles: [] };
      void device.lost.then(() => {
        if (cached?.device === device) cached = null;
      });
      return cached;
    } catch (err) {
      device.destroy();
      throw err;
    }
  } catch (err) {
    console.warn("webgpu-ts compositor fallback", err);
    tsFail = true;
    return null;
  }
}

/** TypeScript WebGPU compositor with a reused device (for bench vs wgpu). */
export async function drawWebGpuTs(
  dest: HTMLCanvasElement,
  tiles: GpuTile[],
  mode: LayoutMode,
  banner: (ctx: CanvasRenderingContext2D) => void,
): Promise<boolean> {
  const gpu = await ensureTsGpu(dest.width, dest.height);
  if (!gpu) return false;
  try {
    const api = await loadWasm();
    const rects = layoutRects(api, Math.max(1, tiles.length), mode, 1, 1);
    const ready: TsTile[] = [];
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      const r = rects[i];
      const { w, h } = tileSize(tile);
      if (!r || !w) continue;
      let slot = gpu.tiles[i];
      if (slot && (slot.width !== w || slot.height !== h)) {
        dropTile(slot);
        slot = null;
      }
      if (!slot) {
        const texture = gpu.device.createTexture({
          size: { width: w, height: h },
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        slot = {
          width: w,
          height: h,
          texture,
          bindGroup: gpu.device.createBindGroup({
            layout: gpu.bgl,
            entries: [
              { binding: 0, resource: gpu.sampler },
              { binding: 1, resource: texture.createView() },
            ],
          }),
          rectBuf: gpu.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          }),
        };
        gpu.tiles[i] = slot;
      }
      gpu.device.queue.copyExternalImageToTexture({ source: tile }, { texture: slot.texture }, { width: w, height: h });
      gpu.device.queue.writeBuffer(slot.rectBuf, 0, new Float32Array([r.x, r.y, r.w, r.h]));
      ready.push(slot);
    }
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.ctx.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.043, g: 0.043, b: 0.051, a: 1 },
        },
      ],
    });
    pass.setPipeline(gpu.pipeline);
    for (const slot of ready) {
      pass.setBindGroup(0, slot.bindGroup);
      pass.setVertexBuffer(0, slot.rectBuf);
      pass.draw(6, 1, 0, 0);
    }
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
    const dst = dest.getContext("2d");
    if (!dst) return false;
    dst.drawImage(gpu.canvas, 0, 0);
    banner(dst);
    drawFails = 0;
    return true;
  } catch (err) {
    console.warn("webgpu-ts compositor fallback", err);
    drawFails += 1;
    if (drawFails >= DRAW_FAIL_LIMIT) tsFail = true;
    return false;
  }
}
