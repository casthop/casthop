//! Camera background blur: temporal mask smooth, downsample box-blur, composite.
//!
//! Buffers are allocated in `setup`. `process` does not allocate.

#![expect(
    clippy::cast_possible_truncation,
    clippy::similar_names,
    reason = "8-bit RGBA pixel loops: x/y names and truncating casts are the work"
)]

const MAX_W: u32 = 1920;
const MAX_H: u32 = 1080;
const MAX_MASK: u32 = 512;

pub struct Pipeline {
    pub width: u32,
    pub height: u32,
    pub mask_w: u32,
    pub mask_h: u32,
    radius: u32,
    temporal: u32,
    has_prev: bool,
    /// RGBA input / output, `width * height * 4`.
    pub frame: Vec<u8>,
    /// Person probability 0..=255, `mask_w * mask_h`.
    pub mask: Vec<u8>,
    mask_smooth: Vec<u8>,
    mask_feather: Vec<u8>,
    down: Vec<u8>,
    down_tmp: Vec<u8>,
    prefix: Vec<u32>,
}

impl Pipeline {
    pub(crate) fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            mask_w: 0,
            mask_h: 0,
            radius: 1,
            temporal: 0,
            has_prev: false,
            frame: Vec::new(),
            mask: Vec::new(),
            mask_smooth: Vec::new(),
            mask_feather: Vec::new(),
            down: Vec::new(),
            down_tmp: Vec::new(),
            prefix: Vec::new(),
        }
    }

    fn with_dims(
        width: u32,
        height: u32,
        mask_w: u32,
        mask_h: u32,
        radius: u32,
        temporal: u32,
    ) -> Option<Self> {
        if !valid_dims(width, height, mask_w, mask_h) {
            return None;
        }
        let px = (width as usize).saturating_mul(height as usize);
        let mx = (mask_w as usize).saturating_mul(mask_h as usize);
        let dw = down_w(width);
        let dh = down_h(height);
        let dpx = dw.saturating_mul(dh);
        let prefix_len = dw.max(dh).max(width as usize).max(height as usize) + 1;
        Some(Self {
            width,
            height,
            mask_w,
            mask_h,
            radius: radius.clamp(1, 64),
            temporal: temporal.min(255),
            has_prev: false,
            frame: vec![0; px * 4],
            mask: vec![0; mx],
            mask_smooth: vec![0; mx],
            mask_feather: vec![0; mx],
            down: vec![0; dpx * 4],
            down_tmp: vec![0; dpx * 4],
            prefix: vec![0; prefix_len],
        })
    }

    pub fn setup(
        &mut self,
        width: u32,
        height: u32,
        mask_w: u32,
        mask_h: u32,
        radius: u32,
        temporal: u32,
    ) -> bool {
        if !valid_dims(width, height, mask_w, mask_h) {
            return false;
        }
        let same = self.width == width
            && self.height == height
            && self.mask_w == mask_w
            && self.mask_h == mask_h;
        if same {
            self.radius = radius.clamp(1, 64);
            self.temporal = temporal.min(255);
            return true;
        }
        match Self::with_dims(width, height, mask_w, mask_h, radius, temporal) {
            Some(next) => {
                *self = next;
                true
            }
            None => false,
        }
    }

    pub fn process(&mut self) -> bool {
        if self.width == 0 || self.height == 0 || self.mask_w == 0 || self.mask_h == 0 {
            return false;
        }
        let mx = self.mask_w as usize * self.mask_h as usize;
        if self.mask.len() < mx || self.frame.len() < self.width as usize * self.height as usize * 4
        {
            return false;
        }
        smooth_mask(
            &self.mask,
            &mut self.mask_smooth,
            self.temporal,
            self.has_prev,
        );
        self.has_prev = true;
        box3_mask(
            &self.mask_smooth,
            &mut self.mask_feather,
            self.mask_w as usize,
            self.mask_h as usize,
        );
        let dw = down_w(self.width) as u32;
        let dh = down_h(self.height) as u32;
        downsample_rgba(&self.frame, self.width, self.height, &mut self.down, dw, dh);
        let r = blur_radius(self.radius);
        box_blur_h(
            &self.down,
            &mut self.down_tmp,
            dw as usize,
            dh as usize,
            r,
            &mut self.prefix,
        );
        box_blur_v(
            &self.down_tmp,
            &mut self.down,
            dw as usize,
            dh as usize,
            r,
            &mut self.prefix,
        );
        mix_from_down(
            &mut self.frame,
            self.width,
            self.height,
            &self.mask_feather,
            self.mask_w,
            self.mask_h,
            &self.down,
            dw,
            dh,
        );
        true
    }

    #[cfg(test)]
    fn smooth_sample(&self) -> u8 {
        self.mask_smooth.first().copied().unwrap_or(0)
    }
}

fn valid_dims(width: u32, height: u32, mask_w: u32, mask_h: u32) -> bool {
    width >= 16
        && height >= 16
        && width <= MAX_W
        && height <= MAX_H
        && mask_w >= 8
        && mask_h >= 8
        && mask_w <= MAX_MASK
        && mask_h <= MAX_MASK
}

fn down_w(width: u32) -> usize {
    (width as usize / 4).max(1)
}

fn down_h(height: u32) -> usize {
    (height as usize / 4).max(1)
}

fn blur_radius(full: u32) -> usize {
    (full as usize / 4).clamp(1, 16)
}

fn smooth_mask(mask: &[u8], smooth: &mut [u8], temporal: u32, has_prev: bool) {
    let n = mask.len().min(smooth.len());
    if !has_prev || temporal == 0 {
        smooth[..n].copy_from_slice(&mask[..n]);
        return;
    }
    let t = temporal as u16;
    let inv = 256u16.saturating_sub(t);
    for i in 0..n {
        let v = u32::from(smooth[i]) * u32::from(t) + u32::from(mask[i]) * u32::from(inv);
        smooth[i] = (v >> 8) as u8;
    }
}

fn box3_mask(src: &[u8], dst: &mut [u8], w: usize, h: usize) {
    if src.len() < w * h || dst.len() < w * h || w == 0 || h == 0 {
        return;
    }
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            let mut n = 0u32;
            let y0 = y.saturating_sub(1);
            let y1 = (y + 2).min(h);
            let x0 = x.saturating_sub(1);
            let x1 = (x + 2).min(w);
            for yy in y0..y1 {
                let row = yy * w;
                for xx in x0..x1 {
                    sum += u32::from(src[row + xx]);
                    n += 1;
                }
            }
            dst[y * w + x] = if n == 0 { 0 } else { (sum / n) as u8 };
        }
    }
}

fn downsample_rgba(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return;
    }
    let need_src = sw as usize * sh as usize * 4;
    let need_dst = dw as usize * dh as usize * 4;
    if src.len() < need_src || dst.len() < need_dst {
        return;
    }
    for y in 0..dh {
        let sy = (u64::from(y) * u64::from(sh) / u64::from(dh)) as u32;
        let sy2 = (sy + 2).min(sh.saturating_sub(1));
        for x in 0..dw {
            let sx = (u64::from(x) * u64::from(sw) / u64::from(dw)) as u32;
            let sx2 = (sx + 2).min(sw.saturating_sub(1));
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            for &(px, py) in &[(sx, sy), (sx2, sy), (sx, sy2), (sx2, sy2)] {
                let i = (py as usize * sw as usize + px as usize) * 4;
                r += u32::from(src[i]);
                g += u32::from(src[i + 1]);
                b += u32::from(src[i + 2]);
            }
            let o = (y as usize * dw as usize + x as usize) * 4;
            dst[o] = (r / 4) as u8;
            dst[o + 1] = (g / 4) as u8;
            dst[o + 2] = (b / 4) as u8;
            dst[o + 3] = 255;
        }
    }
}

fn box_blur_h(src: &[u8], dst: &mut [u8], w: usize, h: usize, radius: usize, prefix: &mut [u32]) {
    if w == 0 || h == 0 || prefix.len() < w + 1 {
        return;
    }
    let need = w * h * 4;
    if src.len() < need || dst.len() < need {
        return;
    }
    for y in 0..h {
        let row = y * w * 4;
        for c in 0..3 {
            prefix[0] = 0;
            for x in 0..w {
                prefix[x + 1] = prefix[x] + u32::from(src[row + x * 4 + c]);
            }
            for x in 0..w {
                let x0 = x.saturating_sub(radius);
                let x1 = (x + radius + 1).min(w);
                let sum = prefix[x1] - prefix[x0];
                let n = (x1 - x0) as u32;
                dst[row + x * 4 + c] = if n == 0 { 0 } else { (sum / n) as u8 };
            }
        }
        for x in 0..w {
            dst[row + x * 4 + 3] = 255;
        }
    }
}

fn box_blur_v(src: &[u8], dst: &mut [u8], w: usize, h: usize, radius: usize, prefix: &mut [u32]) {
    if w == 0 || h == 0 || prefix.len() < h + 1 {
        return;
    }
    let need = w * h * 4;
    if src.len() < need || dst.len() < need {
        return;
    }
    for x in 0..w {
        for c in 0..3 {
            prefix[0] = 0;
            for y in 0..h {
                prefix[y + 1] = prefix[y] + u32::from(src[(y * w + x) * 4 + c]);
            }
            for y in 0..h {
                let y0 = y.saturating_sub(radius);
                let y1 = (y + radius + 1).min(h);
                let sum = prefix[y1] - prefix[y0];
                let n = (y1 - y0) as u32;
                dst[(y * w + x) * 4 + c] = if n == 0 { 0 } else { (sum / n) as u8 };
            }
        }
        for y in 0..h {
            dst[(y * w + x) * 4 + 3] = 255;
        }
    }
}

fn mix_from_down(
    frame: &mut [u8],
    width: u32,
    height: u32,
    mask: &[u8],
    mask_w: u32,
    mask_h: u32,
    down: &[u8],
    dw: u32,
    dh: u32,
) {
    if width == 0 || height == 0 || mask_w == 0 || mask_h == 0 || dw == 0 || dh == 0 {
        return;
    }
    let w = width as usize;
    let h = height as usize;
    let mw = mask_w as usize;
    let mh = mask_h as usize;
    let dwn = dw as usize;
    let dhn = dh as usize;
    if frame.len() < w * h * 4 || mask.len() < mw * mh || down.len() < dwn * dhn * 4 {
        return;
    }
    let max_mx = mw.saturating_sub(1);
    let max_my = mh.saturating_sub(1);
    let x_den = (w - 1).max(1);
    let y_den = (h - 1).max(1);
    for y in 0..h {
        let my_q = (y * max_my * 256) / y_den;
        let my0 = (my_q >> 8).min(max_my);
        let my1 = (my0 + 1).min(max_my);
        let ty = my_q & 255;
        let row0 = my0 * mw;
        let row1 = my1 * mw;
        let dy = (y * dhn / h).min(dhn - 1);
        let drow = dy * dwn;
        for x in 0..w {
            let mx_q = (x * max_mx * 256) / x_den;
            let mx0 = (mx_q >> 8).min(max_mx);
            let mx1 = (mx0 + 1).min(max_mx);
            let tx = mx_q & 255;
            let c00 = u32::from(mask[row0 + mx0]);
            let c10 = u32::from(mask[row0 + mx1]);
            let c01 = u32::from(mask[row1 + mx0]);
            let c11 = u32::from(mask[row1 + mx1]);
            let a = c00 * (256 - tx as u32) + c10 * tx as u32;
            let b = c01 * (256 - tx as u32) + c11 * tx as u32;
            let m = ((a * (256 - ty as u32) + b * ty as u32) >> 16) as u16;
            let o = (y * w + x) * 4;
            if m >= 255 {
                frame[o + 3] = 255;
                continue;
            }
            let dx = (x * dwn / w).min(dwn - 1);
            let bi = (drow + dx) * 4;
            if m == 0 {
                frame[o] = down[bi];
                frame[o + 1] = down[bi + 1];
                frame[o + 2] = down[bi + 2];
                frame[o + 3] = 255;
                continue;
            }
            let inv = 255 - m;
            frame[o] = ((u16::from(frame[o]) * m + u16::from(down[bi]) * inv) / 255) as u8;
            frame[o + 1] =
                ((u16::from(frame[o + 1]) * m + u16::from(down[bi + 1]) * inv) / 255) as u8;
            frame[o + 2] =
                ((u16::from(frame[o + 2]) * m + u16::from(down[bi + 2]) * inv) / 255) as u8;
            frame[o + 3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(p: &mut Pipeline, r: u8, g: u8, b: u8) {
        for px in p.frame.chunks_exact_mut(4) {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = 255;
        }
    }

    #[test]
    fn person_stays_background_blurs() {
        let mut p = Pipeline::empty();
        assert!(p.setup(64, 64, 16, 16, 24, 0));
        // Left half red (person), right half a sharp checker so blur is visible.
        for y in 0..64u32 {
            for x in 0..64u32 {
                let i = (y as usize * 64 + x as usize) * 4;
                if x < 32 {
                    p.frame[i] = 200;
                    p.frame[i + 1] = 10;
                    p.frame[i + 2] = 10;
                } else {
                    let on = ((x / 4) + (y / 4)) % 2 == 0;
                    p.frame[i] = if on { 0 } else { 255 };
                    p.frame[i + 1] = 0;
                    p.frame[i + 2] = if on { 255 } else { 0 };
                }
                p.frame[i + 3] = 255;
            }
        }
        for y in 0..16u32 {
            for x in 0..16u32 {
                p.mask[(y * 16 + x) as usize] = if x < 8 { 255 } else { 0 };
            }
        }
        assert!(p.process());
        let person = (16 * 64 + 8) * 4;
        assert!((p.frame[person] as i16 - 200).abs() < 8);
        let bg = (16 * 64 + 48) * 4;
        let sharp = p.frame[bg] == 0 || p.frame[bg] == 255;
        assert!(!sharp, "background should be mixed, got {}", p.frame[bg]);
    }

    #[test]
    fn temporal_eases_in() {
        let mut p = Pipeline::empty();
        assert!(p.setup(32, 32, 8, 8, 8, 200));
        solid(&mut p, 40, 40, 40);
        p.mask.fill(255);
        assert!(p.process());
        let first = p.smooth_sample();
        p.mask.fill(0);
        assert!(p.process());
        let second = p.smooth_sample();
        assert_eq!(first, 255);
        assert!(
            second > 0 && second < 255,
            "ema should be in between, got {second}"
        );
    }

    #[test]
    fn bad_setup_rejected() {
        let mut p = Pipeline::empty();
        assert!(!p.setup(0, 720, 256, 144, 24, 180));
        assert!(!p.setup(1280, 720, 0, 144, 24, 180));
        assert!(!p.setup(4000, 720, 256, 144, 24, 180));
        assert!(p.setup(1280, 720, 256, 144, 24, 180));
    }

    #[test]
    fn empty_process_is_false() {
        let mut p = Pipeline::empty();
        assert!(!p.process());
    }
}
