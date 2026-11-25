#![expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::needless_range_loop,
    reason = "layout math uses tile counts of 1..=6"
)]

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub const MAX_TILES: usize = 6;
const GUTTER: f32 = 0.012;

/// Normalized 0..1 tiles. Gutter 1.2%. Writes into `out`, no heap.
pub fn fill(n: u32, mode: u32, out: &mut [Rect]) -> usize {
    if out.is_empty() {
        return 0;
    }
    let n = n.clamp(1, 6);
    match mode {
        0 => {
            out[0] = Rect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            };
            1
        }
        3 => fill_screen(n, out),
        1 if n <= 2 => fill_side(n, out),
        _ => fill_grid(n, out),
    }
}

/// Heap copy of [`fill`]. Tests and callers that want a `Vec`.
#[cfg(test)]
pub fn layout(n: u32, mode: u32) -> Vec<Rect> {
    let mut buf = [Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    }; MAX_TILES];
    let count = fill(n, mode, &mut buf);
    buf[..count].to_vec()
}

fn fill_side(n: u32, out: &mut [Rect]) -> usize {
    if n <= 1 {
        return fill(1, 0, out);
    }
    if out.len() < 2 {
        return 0;
    }
    let w = (1.0 - GUTTER) / 2.0;
    out[0] = Rect {
        x: 0.0,
        y: 0.0,
        w,
        h: 1.0,
    };
    out[1] = Rect {
        x: w + GUTTER,
        y: 0.0,
        w,
        h: 1.0,
    };
    2
}

fn fill_grid(n: u32, out: &mut [Rect]) -> usize {
    let (cols, rows) = match n {
        1 => (1, 1),
        2 => (2, 1),
        3 | 4 => (2, 2),
        _ => (3, 2),
    };
    let cw = (1.0 - GUTTER * (cols as f32 - 1.0)) / cols as f32;
    let rh = (1.0 - GUTTER * (rows as f32 - 1.0)) / rows as f32;
    let count = (n as usize).min(out.len());
    for i in 0..count {
        let c = (i as u32 % cols) as f32;
        let r = (i as u32 / cols) as f32;
        out[i] = Rect {
            x: c * (cw + GUTTER),
            y: r * (rh + GUTTER),
            w: cw,
            h: rh,
        };
    }
    count
}

fn fill_screen(n: u32, out: &mut [Rect]) -> usize {
    // Keep the old screen(1) behaviour: one main pane plus one camera stack slot.
    let cams = n.saturating_sub(1).clamp(1, 3);
    let need = 1 + cams as usize;
    if out.len() < need {
        return 0;
    }
    let main_w = 0.72;
    out[0] = Rect {
        x: 0.0,
        y: 0.0,
        w: main_w,
        h: 1.0,
    };
    let stack_x = main_w + GUTTER;
    let stack_w = 1.0 - stack_x;
    let ch = (1.0 - GUTTER * (cams as f32 - 1.0)) / cams as f32;
    for i in 0..cams {
        out[1 + i as usize] = Rect {
            x: stack_x,
            y: i as f32 * (ch + GUTTER),
            w: stack_w,
            h: ch,
        };
    }
    need
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_unit_square_solo() {
        let r = layout(1, 0);
        assert_eq!(r.len(), 1);
        assert!((r[0].w - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn fill_matches_vec_for_grid_six() {
        let mut buf = [Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        }; MAX_TILES];
        let n = fill(6, 2, &mut buf);
        let v = layout(6, 2);
        assert_eq!(n, v.len());
        for (a, b) in buf.iter().take(n).zip(v.iter()) {
            assert!((a.x - b.x).abs() < f32::EPSILON);
            assert!((a.w - b.w).abs() < 0.02);
        }
    }

    #[test]
    fn screen_one_still_has_a_camera_slot() {
        assert_eq!(layout(1, 3).len(), 2);
    }
}
