//! Shared GPU compositor bits (shader + instance packing). No wgpu here so
//! native `cargo test --features gpu` does not need a WebGPU adapter.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use crate::layout::{fill, Rect, MAX_TILES};

/// Same textured-quad shader the TypeScript WebGPU path used.
pub const SHADER: &str = r"
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
";

pub const INSTANCE_STRIDE: usize = 16;
pub const INSTANCE_BYTES: usize = MAX_TILES * INSTANCE_STRIDE;

/// Pack normalized layout rects into the instance buffer (x,y,w,h f32s).
pub fn pack_instances(n: u32, mode: u32, bytes: &mut [u8]) -> usize {
    if bytes.len() < INSTANCE_BYTES {
        return 0;
    }
    let mut rects = [Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    }; MAX_TILES];
    let count = fill(n, mode, &mut rects);
    for (i, r) in rects.iter().take(count).enumerate() {
        let off = i * INSTANCE_STRIDE;
        write_f32(&mut bytes[off..], r.x);
        write_f32(&mut bytes[off + 4..], r.y);
        write_f32(&mut bytes[off + 8..], r.w);
        write_f32(&mut bytes[off + 12..], r.h);
    }
    count
}

fn write_f32(dst: &mut [u8], v: f32) {
    dst[..4].copy_from_slice(&v.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shader_has_entry_points() {
        assert!(SHADER.contains("@vertex fn vs"));
        assert!(SHADER.contains("@fragment fn fs"));
        assert!(SHADER.contains("textureSample"));
    }

    #[test]
    fn pack_four_grid_tiles() {
        let mut bytes = [0u8; INSTANCE_BYTES];
        let n = pack_instances(4, 2, &mut bytes);
        assert_eq!(n, 4);
        let x0 = f32::from_le_bytes(bytes[0..4].try_into().expect("x0"));
        assert!(x0.abs() < f32::EPSILON);
        let w0 = f32::from_le_bytes(bytes[8..12].try_into().expect("w0"));
        assert!((w0 - 0.494).abs() < 0.01);
    }
}
