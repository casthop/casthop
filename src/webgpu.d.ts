interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPUAdapter {
  requestDevice(): Promise<GPUDevice>;
}

type GPUTextureFormat = string;
type GPUShaderStage = { FRAGMENT: number };
type GPUTextureUsage = { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
type GPUBufferUsage = { VERTEX: number; COPY_DST: number };

interface GPUSupportedLimits {
  maxTextureDimension2D: number;
  maxBufferSize: number;
  maxBindGroups: number;
  maxBindingsPerBindGroup: number;
  maxSampledTexturesPerShaderStage: number;
  maxSamplersPerShaderStage: number;
  maxVertexBuffers: number;
  maxVertexAttributes: number;
  maxVertexBufferArrayStride: number;
  maxColorAttachments: number;
}

interface GPUDevice {
  limits: GPUSupportedLimits;
  createShaderModule(desc: { code: string }): GPUShaderModule;
  createBindGroupLayout(desc: unknown): GPUBindGroupLayout;
  createPipelineLayout(desc: unknown): GPUPipelineLayout;
  createRenderPipeline(desc: unknown): GPURenderPipeline;
  createSampler(desc: unknown): GPUSampler;
  createTexture(desc: unknown): GPUTexture;
  createBuffer(desc: unknown): GPUBuffer;
  createBindGroup(desc: unknown): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
  queue: GPUQueue;
  lost: Promise<{ reason: string; message: string }>;
  destroy(): void;
}

interface GPUShaderModule {}
interface GPUBindGroupLayout {}
interface GPUPipelineLayout {}
interface GPURenderPipeline {}
interface GPUSampler {}
interface GPUTexture {
  createView(): GPUTextureView;
  destroy(): void;
}
interface GPUTextureView {}
interface GPUBuffer {
  destroy(): void;
}
interface GPUBindGroup {}
interface GPUQueue {
  copyExternalImageToTexture(src: { source: CanvasImageSource }, dst: { texture: GPUTexture }, size: { width: number; height: number }): void;
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView): void;
  submit(cmds: GPUCommandBuffer[]): void;
}
interface GPUCommandBuffer {}
interface GPUCommandEncoder {
  beginRenderPass(desc: unknown): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}
interface GPURenderPassEncoder {
  setPipeline(p: GPURenderPipeline): void;
  setBindGroup(index: number, g: GPUBindGroup): void;
  setVertexBuffer(slot: number, buf: GPUBuffer): void;
  draw(v: number, i?: number, fv?: number, fi?: number): void;
  end(): void;
}
interface GPUCanvasContext {
  configure(desc: unknown): void;
  getCurrentTexture(): GPUTexture;
}

interface Navigator {
  gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: "webgpu"): GPUCanvasContext | null;
}

declare const GPUShaderStage: GPUShaderStage;
declare const GPUTextureUsage: GPUTextureUsage;
declare const GPUBufferUsage: GPUBufferUsage;
