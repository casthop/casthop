//! C ABI for the AudioWorklet-safe media module.

use std::cell::RefCell;

use crate::blur::Pipeline;
use crate::compose::Compositor;
use crate::denoise::Denoiser;
use crate::layout;

const FRAME: usize = crate::denoise::FRAME_SIZE;

struct World {
    denoisers: Vec<Denoiser>,
    compositors: Vec<Compositor>,
    blurs: Vec<Option<Pipeline>>,
}

impl World {
    fn new() -> Self {
        Self {
            denoisers: Vec::new(),
            compositors: Vec::new(),
            blurs: Vec::new(),
        }
    }
}

thread_local! {
    static WORLD: RefCell<World> = RefCell::new(World::new());
}

fn with_world<T>(f: impl FnOnce(&mut World) -> T) -> T {
    WORLD.with(|w| f(&mut w.borrow_mut()))
}

fn blur_mut(w: &mut World, handle: u32) -> Option<&mut Pipeline> {
    w.blurs
        .get_mut(handle.wrapping_sub(1) as usize)
        .and_then(Option::as_mut)
}

fn buf_ptr(buf: &mut [u8]) -> u32 {
    if buf.is_empty() {
        0
    } else {
        buf.as_mut_ptr() as u32
    }
}

#[no_mangle]
pub extern "C" fn casthop_frame_size() -> u32 {
    FRAME as u32
}

#[no_mangle]
pub extern "C" fn casthop_version() -> u32 {
    2
}

#[no_mangle]
pub extern "C" fn casthop_denoise_new() -> u32 {
    with_world(|w| {
        w.denoisers.push(Denoiser::new());
        w.denoisers.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn casthop_denoise_in_ptr(handle: u32) -> u32 {
    with_world(|w| {
        w.denoisers
            .get_mut(handle.wrapping_sub(1) as usize)
            .map(|d| d.input.as_mut_ptr() as u32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn casthop_denoise_out_ptr(handle: u32) -> u32 {
    with_world(|w| {
        w.denoisers
            .get(handle.wrapping_sub(1) as usize)
            .map(|d| d.output.as_ptr() as u32)
            .unwrap_or(0)
    })
}

/// Run RNNoise on the 480-sample input buffer. Returns VAD in 0..10_000.
#[no_mangle]
pub extern "C" fn casthop_denoise_process(handle: u32) -> u32 {
    with_world(|w| {
        w.denoisers
            .get_mut(handle.wrapping_sub(1) as usize)
            .map(|d| (d.process() * 10_000.0) as u32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn casthop_denoise_free(handle: u32) {
    with_world(|w| {
        let i = handle.wrapping_sub(1) as usize;
        if i < w.denoisers.len() {
            w.denoisers[i] = Denoiser::new();
        }
    });
}

/// RMS (0..10_000), peak (0..10_000), VAD flag packed: rms | peak<<16, vad in return via out ptr.
#[no_mangle]
pub unsafe extern "C" fn casthop_meter(
    ptr: *const f32,
    len: u32,
    out_rms: *mut f32,
    out_peak: *mut f32,
) -> u32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let samples = std::slice::from_raw_parts(ptr, len as usize);
    let m = crate::meter::measure(samples);
    if !out_rms.is_null() {
        *out_rms = m.rms;
    }
    if !out_peak.is_null() {
        *out_peak = m.peak;
    }
    u32::from(m.voice)
}

/// Layout mode: 0 solo, 1 side, 2 grid, 3 screen. Writes n * 4 f32 (x,y,w,h) in 0..1.
#[no_mangle]
pub unsafe extern "C" fn casthop_layout(n: u32, mode: u32, out: *mut f32, cap: u32) -> u32 {
    if out.is_null() || cap < 4 {
        return 0;
    }
    let mut rects = [layout::Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    }; layout::MAX_TILES];
    let wrote = layout::fill(n, mode, &mut rects).min((cap as usize) / 4);
    for (i, r) in rects.iter().take(wrote).enumerate() {
        *out.add(i * 4) = r.x;
        *out.add(i * 4 + 1) = r.y;
        *out.add(i * 4 + 2) = r.w;
        *out.add(i * 4 + 3) = r.h;
    }
    wrote as u32
}

#[no_mangle]
pub extern "C" fn casthop_compose_new(width: u32, height: u32) -> u32 {
    with_world(|w| {
        w.compositors
            .push(Compositor::new(width.max(16), height.max(16)));
        w.compositors.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn casthop_compose_ptr(handle: u32) -> u32 {
    with_world(|w| {
        w.compositors
            .get(handle.wrapping_sub(1) as usize)
            .map(|c| c.pixels.as_ptr() as u32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn casthop_compose_len(handle: u32) -> u32 {
    with_world(|w| {
        w.compositors
            .get(handle.wrapping_sub(1) as usize)
            .map(|c| c.pixels.len() as u32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn casthop_compose_clear(handle: u32, rgba: u32) {
    with_world(|w| {
        if let Some(c) = w.compositors.get_mut(handle.wrapping_sub(1) as usize) {
            c.clear(rgba);
        }
    });
}

#[no_mangle]
pub extern "C" fn casthop_tile_ptr(handle: u32) -> u32 {
    with_world(|w| {
        w.compositors
            .get_mut(handle.wrapping_sub(1) as usize)
            .map(|c| c.tile.as_mut_ptr() as u32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn casthop_tile_reserve(handle: u32, bytes: u32) -> u32 {
    with_world(|w| {
        if let Some(c) = w.compositors.get_mut(handle.wrapping_sub(1) as usize) {
            c.reserve_tile(bytes as usize);
            return c.tile.as_mut_ptr() as u32;
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn casthop_compose_blit(
    handle: u32,
    src_w: u32,
    src_h: u32,
    dx: u32,
    dy: u32,
    dw: u32,
    dh: u32,
    filter: u32,
) {
    with_world(|w| {
        if let Some(c) = w.compositors.get_mut(handle.wrapping_sub(1) as usize) {
            c.blit(src_w, src_h, dx, dy, dw, dh, filter != 0);
        }
    });
}

#[no_mangle]
pub unsafe extern "C" fn casthop_compose_banner(
    handle: u32,
    title: *const u8,
    title_len: u32,
    subtitle: *const u8,
    subtitle_len: u32,
) {
    let title = if title.is_null() {
        ""
    } else {
        std::str::from_utf8(std::slice::from_raw_parts(title, title_len as usize)).unwrap_or("")
    };
    let subtitle = if subtitle.is_null() {
        ""
    } else {
        std::str::from_utf8(std::slice::from_raw_parts(subtitle, subtitle_len as usize))
            .unwrap_or("")
    };
    with_world(|w| {
        if let Some(c) = w.compositors.get_mut(handle.wrapping_sub(1) as usize) {
            c.banner(title, subtitle);
        }
    });
}

#[no_mangle]
pub extern "C" fn casthop_compose_free(handle: u32) {
    with_world(|w| {
        let i = handle.wrapping_sub(1) as usize;
        if i < w.compositors.len() {
            w.compositors[i] = Compositor::new(16, 16);
        }
    });
}

#[no_mangle]
pub extern "C" fn casthop_blur_new() -> u32 {
    with_world(|w| {
        if let Some(i) = w.blurs.iter().position(Option::is_none) {
            w.blurs[i] = Some(Pipeline::empty());
            return (i + 1) as u32;
        }
        w.blurs.push(Some(Pipeline::empty()));
        w.blurs.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn casthop_blur_setup(
    handle: u32,
    width: u32,
    height: u32,
    mask_w: u32,
    mask_h: u32,
    radius: u32,
    temporal: u32,
) -> u32 {
    with_world(|w| {
        blur_mut(w, handle).map_or(0, |b| {
            u32::from(b.setup(width, height, mask_w, mask_h, radius, temporal))
        })
    })
}

#[no_mangle]
pub extern "C" fn casthop_blur_frame_ptr(handle: u32) -> u32 {
    with_world(|w| blur_mut(w, handle).map_or(0, |b| buf_ptr(&mut b.frame)))
}

#[no_mangle]
pub extern "C" fn casthop_blur_frame_len(handle: u32) -> u32 {
    with_world(|w| blur_mut(w, handle).map_or(0, |b| b.frame.len() as u32))
}

#[no_mangle]
pub extern "C" fn casthop_blur_mask_ptr(handle: u32) -> u32 {
    with_world(|w| blur_mut(w, handle).map_or(0, |b| buf_ptr(&mut b.mask)))
}

#[no_mangle]
pub extern "C" fn casthop_blur_mask_len(handle: u32) -> u32 {
    with_world(|w| blur_mut(w, handle).map_or(0, |b| b.mask.len() as u32))
}

/// Smooth the person mask, blur the background, composite in-place on the frame buffer.
#[no_mangle]
pub extern "C" fn casthop_blur_process(handle: u32) -> u32 {
    with_world(|w| blur_mut(w, handle).map_or(0, |b| u32::from(b.process())))
}

#[no_mangle]
pub extern "C" fn casthop_blur_free(handle: u32) {
    with_world(|w| {
        let i = handle.wrapping_sub(1) as usize;
        if i < w.blurs.len() {
            w.blurs[i] = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_six_grid() {
        let mut buf = [0f32; 24];
        let n = unsafe { casthop_layout(6, 2, buf.as_mut_ptr(), 24) };
        assert_eq!(n, 6);
        assert!((buf[2] - 1.0 / 3.0).abs() < 0.02);
    }

    #[test]
    fn denoise_roundtrip() {
        let h = casthop_denoise_new();
        assert!(h >= 1);
        let p = casthop_denoise_in_ptr(h);
        assert!(p != 0);
        let vad = casthop_denoise_process(h);
        assert!(vad <= 10_000);
    }

    #[test]
    fn blur_handle_and_bad_id() {
        let h = casthop_blur_new();
        assert!(h >= 1);
        assert_eq!(casthop_blur_process(0), 0);
        assert_eq!(casthop_blur_frame_ptr(99_999), 0);
        assert_eq!(casthop_blur_frame_ptr(h), 0);
        assert_eq!(casthop_blur_setup(h, 64, 64, 16, 16, 24, 0), 1);
        assert!(casthop_blur_frame_ptr(h) != 0);
        assert!(casthop_blur_mask_ptr(h) != 0);
        assert_eq!(casthop_blur_process(h), 1);
        casthop_blur_free(h);
    }

    #[test]
    fn blur_free_drops_buffers_and_new_reuses_slot() {
        let a = casthop_blur_new();
        let b = casthop_blur_new();
        assert_ne!(a, b);
        assert_eq!(casthop_blur_setup(a, 64, 64, 16, 16, 24, 0), 1);
        assert!(casthop_blur_frame_len(a) > 0);
        casthop_blur_free(a);
        assert_eq!(casthop_blur_frame_len(a), 0);
        assert_eq!(casthop_blur_process(a), 0);
        let reused = casthop_blur_new();
        assert_eq!(reused, a);
        let c = casthop_blur_new();
        assert_ne!(c, b);
        assert_ne!(c, reused);
    }
}
