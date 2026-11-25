pub struct Meter {
    pub rms: f32,
    pub peak: f32,
    pub voice: bool,
}

/// Time-domain RMS / peak plus a cheap VAD (energy + zero-crossing).
pub fn measure(samples: &[f32]) -> Meter {
    if samples.is_empty() {
        return Meter {
            rms: 0.0,
            peak: 0.0,
            voice: false,
        };
    }
    let mut sum2 = 0.0f32;
    let mut peak = 0.0f32;
    let mut zc = 0u32;
    let mut prev = 0.0f32;
    for &s in samples {
        let a = s.abs();
        if a > peak {
            peak = a;
        }
        sum2 += s * s;
        if (s >= 0.0) != (prev >= 0.0) {
            zc += 1;
        }
        prev = s;
    }
    let rms = (sum2 / samples.len() as f32).sqrt();
    let zcr = zc as f32 / samples.len() as f32;
    // Speech: enough energy, zero-crossings not hiss-like.
    let voice = rms > 0.018 && (0.01..0.25).contains(&zcr);
    Meter { rms, peak, voice }
}
