#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Normalized 0..1 tiles. Gutter 1.2%.
pub fn layout(n: u32, mode: u32) -> Vec<Rect> {
    let n = n.clamp(1, 6);
    let g = 0.012;
    match mode {
        0 => vec![Rect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }],
        3 => screen(n, g),
        1 if n <= 2 => side(n, g),
        _ => grid(n, g),
    }
}

fn side(n: u32, g: f32) -> Vec<Rect> {
    if n == 1 {
        return layout(1, 0);
    }
    let w = (1.0 - g) / 2.0;
    vec![
        Rect {
            x: 0.0,
            y: 0.0,
            w,
            h: 1.0,
        },
        Rect {
            x: w + g,
            y: 0.0,
            w,
            h: 1.0,
        },
    ]
}

fn grid(n: u32, g: f32) -> Vec<Rect> {
    let (cols, rows) = match n {
        1 => (1, 1),
        2 => (2, 1),
        3 | 4 => (2, 2),
        _ => (3, 2),
    };
    let cw = (1.0 - g * (cols as f32 - 1.0)) / cols as f32;
    let rh = (1.0 - g * (rows as f32 - 1.0)) / rows as f32;
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let c = (i % cols) as f32;
        let r = (i / cols) as f32;
        out.push(Rect {
            x: c * (cw + g),
            y: r * (rh + g),
            w: cw,
            h: rh,
        });
    }
    out
}

fn screen(n: u32, g: f32) -> Vec<Rect> {
    let cams = n.saturating_sub(1).clamp(1, 3);
    let main_w = 0.72;
    let mut out = vec![Rect {
        x: 0.0,
        y: 0.0,
        w: main_w,
        h: 1.0,
    }];
    let stack_x = main_w + g;
    let stack_w = 1.0 - stack_x;
    let ch = (1.0 - g * (cams as f32 - 1.0)) / cams as f32;
    for i in 0..cams {
        out.push(Rect {
            x: stack_x,
            y: i as f32 * (ch + g),
            w: stack_w,
            h: ch,
        });
    }
    out
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
}
