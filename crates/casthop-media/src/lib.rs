//! Browser media helpers compiled to WebAssembly.
//!
//! C ABI so the same module can load in an AudioWorklet, a Worker, or Node
//! without wasm-bindgen glue. Handles live in thread-local storage (one
//! WASM instance per worklet/worker).

#![expect(
    clippy::missing_safety_doc,
    reason = "C ABI exports; null pointers already return 0"
)]
#![expect(
    clippy::too_many_arguments,
    reason = "blit geometry is explicit x/y/w/h, not a struct on the hot path"
)]
#![expect(
    clippy::needless_range_loop,
    reason = "glyph rows are bitmaps indexed by row and column"
)]

mod compose;
mod denoise;
mod layout;
mod meter;

use std::cell::RefCell;

use compose::Compositor;
use denoise::Denoiser;

const FRAME: usize = denoise::FRAME_SIZE;

struct World {
    denoisers: Vec<Denoiser>,
    compositors: Vec<Compositor>,
}

impl World {
    fn new() -> Self {
        Self {
            denoisers: Vec::new(),
            compositors: Vec::new(),
        }
    }
}

thread_local! {
    static WORLD: RefCell<World> = RefCell::new(World::new());
}

fn with_world<T>(f: impl FnOnce(&mut World) -> T) -> T {
    WORLD.with(|w| f(&mut w.borrow_mut()))
}

#[no_mangle]
pub extern "C" fn casthop_frame_size() -> u32 {
    FRAME as u32
}

#[no_mangle]
pub extern "C" fn casthop_version() -> u32 {
    1
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
    let m = meter::measure(samples);
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
    let rects = layout::layout(n.clamp(1, 6), mode);
    let wrote = rects.len().min((cap as usize) / 4);
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
}
