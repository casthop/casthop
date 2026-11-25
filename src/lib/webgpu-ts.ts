import { layoutRects, loadWasm, type LayoutMode, type Rect } from "./wasm";
import { get2d, makeDrawCanvas, type DrawCanvas, type DrawContext } from "./draw-canvas";

export type GpuTile = CanvasImageSource | VideoFrame;

type TsTile = {
  width: number;
  height: number;
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  rectBuf: GPUBuffer;
  rect: Float32Array;
  copyDst: { texture: GPUTexture };
  copySize: { width: number; height: number };
};

function dropTile(slot: TsTile): void {
  slot.texture.destroy();
  slot.rectBuf.destroy();
}

function gpuTileSize(tile: GpuTile): { w: number; h: number } {
  if (typeof VideoFrame !== "undefined" && tile instanceof VideoFrame) {
    return { w: tile.displayWidth || tile.codedWidth, h: tile.displayHeight || tile.codedHeight };
  }
  if (typeof HTMLVideoElement !== "undefined" && tile instanceof HTMLVideoElement) {
    return { w: tile.videoWidth, h: tile.videoHeight };
  }
  const sized = tile as { width: number; height: number };
  return { w: sized.width, h: sized.height };
}

type TsGpu = {
  device: GPUDevice;
  format: GPUTextureFormat;
  sampler: GPUSampler;
  pipeline: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
  canvas: DrawCanvas;
  ctx: GPUCanvasContext;
  tiles: (TsTile | null)[];
  ready: TsTile[];
  cmds: GPUCommandBuffer[];
  layoutN: number;
  layoutMode: LayoutMode | "";
  layout: Rect[];
  maxTex: number;
};

let cached: TsGpu | null = null;
let inflight: Promise<TsGpu | null> | null = null;
let tsFail = false;
let drawFails = 0;
const DRAW_FAIL_LIMIT = 3;
let copySrc: { source: CanvasImageSource | VideoFrame } | undefined;

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
      const limits = device.limits;
      if (
        width > limits.maxTextureDimension2D ||
        height > limits.maxTextureDimension2D ||
        limits.maxBufferSize < 16 ||
        limits.maxBindGroups < 1 ||
        limits.maxBindingsPerBindGroup < 2 ||
        limits.maxSampledTexturesPerShaderStage < 1 ||
        limits.maxSamplersPerShaderStage < 1 ||
        limits.maxVertexBuffers < 1 ||
        limits.maxVertexAttributes < 1 ||
        limits.maxVertexBufferArrayStride < 16 ||
        limits.maxColorAttachments < 1
      ) {
        device.destroy();
        tsFail = true;
        return null;
      }
      const canvas = makeDrawCanvas(width, height);
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
      cached = {
        device,
        format,
        sampler,
        pipeline,
        bgl,
        canvas,
        ctx,
        tiles: [],
        ready: [],
        cmds: [],
        layoutN: -1,
        layoutMode: "",
        layout: [],
        maxTex: limits.maxTextureDimension2D,
      };
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
  dest: DrawCanvas,
  tiles: GpuTile[],
  mode: LayoutMode,
  banner: (ctx: DrawContext) => void,
): Promise<boolean> {
  const gpu = await ensureTsGpu(dest.width, dest.height);
  if (!gpu) return false;
  try {
    const api = await loadWasm();
    if (gpu.layoutN !== tiles.length || gpu.layoutMode !== mode) {
      gpu.layout = layoutRects(api, Math.max(1, tiles.length), mode, 1, 1);
      gpu.layoutN = tiles.length;
      gpu.layoutMode = mode;
    }
    const rects = gpu.layout;
    for (let i = tiles.length; i < gpu.tiles.length; i++) {
      const stale = gpu.tiles[i];
      if (stale) dropTile(stale);
      gpu.tiles[i] = null;
    }
    gpu.ready.length = 0;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      const r = rects[i];
      const { w, h } = gpuTileSize(tile);
      if (!r || !w) continue;
      if (w > gpu.maxTex || h > gpu.maxTex) return false;
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
          rect: new Float32Array(4),
          copyDst: { texture },
          copySize: { width: w, height: h },
        };
        gpu.tiles[i] = slot;
      }
      if (!copySrc) copySrc = { source: tile };
      else copySrc.source = tile;
      gpu.device.queue.copyExternalImageToTexture(copySrc, slot.copyDst, slot.copySize);
      const rect = slot.rect;
      if (rect[0] !== r.x || rect[1] !== r.y || rect[2] !== r.w || rect[3] !== r.h) {
        rect[0] = r.x;
        rect[1] = r.y;
        rect[2] = r.w;
        rect[3] = r.h;
        gpu.device.queue.writeBuffer(slot.rectBuf, 0, rect);
      }
      gpu.ready.push(slot);
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
    for (const slot of gpu.ready) {
      pass.setBindGroup(0, slot.bindGroup);
      pass.setVertexBuffer(0, slot.rectBuf);
      pass.draw(6, 1, 0, 0);
    }
    pass.end();
    gpu.cmds[0] = encoder.finish();
    gpu.device.queue.submit(gpu.cmds);
    const dst = get2d(dest);
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
