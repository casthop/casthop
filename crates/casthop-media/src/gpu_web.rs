//! WebGPU compositor. Lives in a second wasm so the `AudioWorklet` module
//! stays C ABI with zero JS imports.
//!
//! Device creation stays in JS: wgpu 23's `Adapter::request_device` fails on
//! current Chrome (`A valid external Instance reference no longer exists`).
//! The draw path is Rust talking to the same WebGPU API wgpu uses on wasm.

use std::cell::RefCell;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::gpu_buffer_usage::{COPY_DST as BUF_COPY_DST, VERTEX};
use web_sys::gpu_texture_usage::{COPY_DST, RENDER_ATTACHMENT, TEXTURE_BINDING};
use web_sys::{
    GpuAutoLayoutMode, GpuBindGroup, GpuBindGroupDescriptor, GpuBindGroupEntry, GpuBindGroupLayout,
    GpuBuffer, GpuBufferDescriptor, GpuCanvasAlphaMode, GpuCanvasConfiguration, GpuCanvasContext,
    GpuColorDict, GpuColorTargetState, GpuCommandEncoder, GpuCopyExternalImageDestInfo,
    GpuCopyExternalImageSourceInfo, GpuDevice, GpuExtent3dDict, GpuFilterMode, GpuFragmentState,
    GpuLoadOp, GpuPrimitiveState, GpuPrimitiveTopology, GpuQueue, GpuRenderPassColorAttachment,
    GpuRenderPassDescriptor, GpuRenderPipeline, GpuRenderPipelineDescriptor, GpuSampler,
    GpuSamplerDescriptor, GpuShaderModuleDescriptor, GpuStoreOp, GpuTexture, GpuTextureDescriptor,
    GpuTextureFormat, GpuVertexAttribute, GpuVertexBufferLayout, GpuVertexFormat, GpuVertexState,
    GpuVertexStepMode, HtmlCanvasElement, HtmlVideoElement,
};

use crate::gpu::{pack_instances, INSTANCE_BYTES, INSTANCE_STRIDE, SHADER};
use crate::layout::MAX_TILES;

const MAX_TILES_U32: u32 = 6;

struct TileSlot {
    width: u32,
    height: u32,
    texture: GpuTexture,
    bind_group: GpuBindGroup,
}

impl Drop for TileSlot {
    fn drop(&mut self) {
        self.texture.destroy();
    }
}

struct GpuInner {
    device: GpuDevice,
    queue: GpuQueue,
    ctx: GpuCanvasContext,
    pipeline: GpuRenderPipeline,
    sampler: GpuSampler,
    bgl: GpuBindGroupLayout,
    instance_buf: GpuBuffer,
    tiles: [Option<TileSlot>; MAX_TILES],
}

impl Drop for GpuInner {
    fn drop(&mut self) {
        self.instance_buf.destroy();
    }
}

thread_local! {
    static GPU: RefCell<Option<GpuInner>> = const { RefCell::new(None) };
}

/// Build pipelines on a JS-created `GPUDevice`.
#[wasm_bindgen]
pub fn gpu_compositor_create(
    device: GpuDevice,
    canvas: &HtmlCanvasElement,
    width: u32,
    height: u32,
    format: &str,
) -> Result<(), JsValue> {
    let inner = create_inner(device, canvas, width, height, format)?;
    GPU.with(|slot| {
        *slot.borrow_mut() = Some(inner);
    });
    Ok(())
}

/// Draw `sources` (HTMLVideoElement or HTMLCanvasElement) using layout `mode`.
/// Returns 1 on success, 0 if the frame could not be submitted.
#[wasm_bindgen]
pub fn gpu_compositor_draw(sources: &js_sys::Array, mode: u32) -> u32 {
    GPU.with(|slot| {
        let mut inner = slot.borrow_mut();
        inner
            .as_mut()
            .map_or(0, |gpu| u32::from(draw_frame(gpu, sources, mode)))
    })
}

fn js_err(msg: &str) -> JsValue {
    JsValue::from_str(msg)
}

fn parse_format(format: &str) -> Result<GpuTextureFormat, JsValue> {
    match format {
        "bgra8unorm" => Ok(GpuTextureFormat::Bgra8unorm),
        "rgba8unorm" => Ok(GpuTextureFormat::Rgba8unorm),
        "bgra8unorm-srgb" => Ok(GpuTextureFormat::Bgra8unormSrgb),
        "rgba8unorm-srgb" => Ok(GpuTextureFormat::Rgba8unormSrgb),
        _ => Err(js_err("unsupported canvas format")),
    }
}

fn create_inner(
    device: GpuDevice,
    canvas: &HtmlCanvasElement,
    width: u32,
    height: u32,
    format: &str,
) -> Result<GpuInner, JsValue> {
    if width < 16 || height < 16 {
        return Err(js_err("canvas too small"));
    }
    canvas.set_width(width);
    canvas.set_height(height);
    let format = parse_format(format)?;
    let ctx = canvas
        .get_context("webgpu")?
        .ok_or_else(|| js_err("no webgpu canvas context"))?
        .dyn_into::<GpuCanvasContext>()?;
    let config = GpuCanvasConfiguration::new(&device, format);
    config.set_alpha_mode(GpuCanvasAlphaMode::Opaque);
    ctx.configure(&config)?;

    let (pipeline, sampler, bgl) = make_pipeline(&device, format)?;
    let instance_buf = device.create_buffer(&GpuBufferDescriptor::new(
        f64::from(u32::try_from(INSTANCE_BYTES).unwrap_or(0)),
        VERTEX | BUF_COPY_DST,
    ))?;
    Ok(GpuInner {
        queue: device.queue(),
        device,
        ctx,
        pipeline,
        sampler,
        bgl,
        instance_buf,
        tiles: [None, None, None, None, None, None],
    })
}

fn make_pipeline(
    device: &GpuDevice,
    format: GpuTextureFormat,
) -> Result<(GpuRenderPipeline, GpuSampler, GpuBindGroupLayout), JsValue> {
    let shader = device.create_shader_module(&GpuShaderModuleDescriptor::new(SHADER));
    let attr = GpuVertexAttribute::new(GpuVertexFormat::Float32x4, 0.0, 0);
    let attrs = js_sys::Array::of1(&attr);
    let vbuf = GpuVertexBufferLayout::new(
        f64::from(u32::try_from(INSTANCE_STRIDE).unwrap_or(0)),
        &attrs,
    );
    vbuf.set_step_mode(GpuVertexStepMode::Instance);
    let vertex = GpuVertexState::new(&shader);
    vertex.set_entry_point("vs");
    vertex.set_buffers(&js_sys::Array::of1(&vbuf));
    let target = GpuColorTargetState::new(format);
    let fragment = GpuFragmentState::new(&shader, &js_sys::Array::of1(&target));
    fragment.set_entry_point("fs");
    let primitive = GpuPrimitiveState::new();
    primitive.set_topology(GpuPrimitiveTopology::TriangleList);
    let desc = GpuRenderPipelineDescriptor::new(&JsValue::from(GpuAutoLayoutMode::Auto), &vertex);
    desc.set_fragment(&fragment);
    desc.set_primitive(&primitive);
    let pipeline = device.create_render_pipeline(&desc)?;
    let samp_desc = GpuSamplerDescriptor::new();
    samp_desc.set_mag_filter(GpuFilterMode::Linear);
    samp_desc.set_min_filter(GpuFilterMode::Linear);
    let sampler = device.create_sampler_with_descriptor(&samp_desc);
    let bgl = pipeline.get_bind_group_layout(0);
    Ok((pipeline, sampler, bgl))
}

fn draw_frame(inner: &mut GpuInner, sources: &js_sys::Array, mode: u32) -> bool {
    let n = sources.length().min(MAX_TILES_U32);
    let mut packed = [0u8; INSTANCE_BYTES];
    let rect_count = pack_instances(n.max(1), mode, &mut packed);
    if inner
        .queue
        .write_buffer_with_u32_and_u8_slice(&inner.instance_buf, 0, &packed)
        .is_err()
    {
        return false;
    }

    let draw_n = (n as usize).min(rect_count);
    let mut ready: [Option<(usize, u32, u32)>; MAX_TILES] = [None, None, None, None, None, None];
    for (i, slot) in ready.iter_mut().enumerate().take(draw_n) {
        let val = sources.get(u32::try_from(i).unwrap_or(MAX_TILES_U32));
        if val.is_null() || val.is_undefined() {
            continue;
        }
        let Some((w, h)) = source_size(&val) else {
            continue;
        };
        if !ensure_tile(inner, i, w, h) {
            continue;
        }
        *slot = Some((i, w, h));
        if !copy_tile(inner, i, &val, w, h) {
            *slot = None;
        }
    }

    let Ok(frame) = inner.ctx.get_current_texture() else {
        return false;
    };
    let Ok(view) = frame.create_view() else {
        return false;
    };
    let encoder: GpuCommandEncoder = inner.device.create_command_encoder();
    let color = GpuRenderPassColorAttachment::new(GpuLoadOp::Clear, GpuStoreOp::Store, &view);
    color.set_clear_value(GpuColorDict::new(1.0, 0.051, 0.043, 0.043).as_ref());
    let Ok(pass) =
        encoder.begin_render_pass(&GpuRenderPassDescriptor::new(&js_sys::Array::of1(&color)))
    else {
        return false;
    };
    pass.set_pipeline(&inner.pipeline);
    for (i, _, _) in ready.iter().flatten() {
        let Some(slot) = inner.tiles[*i].as_ref() else {
            continue;
        };
        let start = u32::try_from(*i * INSTANCE_STRIDE).unwrap_or(0);
        let size = u32::try_from(INSTANCE_STRIDE).unwrap_or(0);
        pass.set_bind_group(0, Some(&slot.bind_group));
        pass.set_vertex_buffer_with_u32_and_u32(0, Some(&inner.instance_buf), start, size);
        pass.draw_with_instance_count(6, 1);
    }
    pass.end();
    inner.queue.submit(&js_sys::Array::of1(&encoder.finish()));
    true
}

fn copy_tile(inner: &GpuInner, i: usize, source: &JsValue, w: u32, h: u32) -> bool {
    let Some(slot) = inner.tiles[i].as_ref() else {
        return false;
    };
    let Ok(obj) = source.clone().dyn_into::<js_sys::Object>() else {
        return false;
    };
    let src = GpuCopyExternalImageSourceInfo::new(&obj);
    let dest = GpuCopyExternalImageDestInfo::new(&slot.texture);
    let size = GpuExtent3dDict::new(w);
    size.set_height(h);
    inner
        .queue
        .copy_external_image_to_texture_with_gpu_extent_3d_dict(&src, &dest, &size)
        .is_ok()
}

fn ensure_tile(inner: &mut GpuInner, i: usize, w: u32, h: u32) -> bool {
    if w == 0 || h == 0 || i >= MAX_TILES {
        return false;
    }
    if let Some(slot) = &inner.tiles[i] {
        if slot.width == w && slot.height == h {
            return true;
        }
    }
    let extent = GpuExtent3dDict::new(w);
    extent.set_height(h);
    let usage = TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT;
    let desc = GpuTextureDescriptor::new(GpuTextureFormat::Rgba8unorm, &extent, usage);
    let Ok(texture) = inner.device.create_texture(&desc) else {
        return false;
    };
    let Ok(view) = texture.create_view() else {
        texture.destroy();
        return false;
    };
    let entries = js_sys::Array::of2(
        &GpuBindGroupEntry::new(0, inner.sampler.as_ref()),
        &GpuBindGroupEntry::new(1, view.as_ref()),
    );
    let bind_group = inner
        .device
        .create_bind_group(&GpuBindGroupDescriptor::new(&entries, &inner.bgl));
    if let Some(old) = inner.tiles[i].take() {
        old.texture.destroy();
    }
    inner.tiles[i] = Some(TileSlot {
        width: w,
        height: h,
        texture,
        bind_group,
    });
    true
}

fn source_size(val: &JsValue) -> Option<(u32, u32)> {
    if let Some(video) = val.dyn_ref::<HtmlVideoElement>() {
        let w = video.video_width();
        let h = video.video_height();
        if w == 0 || h == 0 {
            return None;
        }
        return Some((w, h));
    }
    if let Ok(canvas) = val.clone().dyn_into::<HtmlCanvasElement>() {
        let w = canvas.width();
        let h = canvas.height();
        if w == 0 || h == 0 {
            return None;
        }
        return Some((w, h));
    }
    None
}
