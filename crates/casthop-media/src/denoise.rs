//! RNNoise (nnnoiseless) 10 ms frames at 48 kHz.

use nnnoiseless::DenoiseState;

pub const FRAME_SIZE: usize = DenoiseState::FRAME_SIZE; // 480

pub struct Denoiser {
    state: Box<DenoiseState<'static>>,
    pub input: [f32; FRAME_SIZE],
    pub output: [f32; FRAME_SIZE],
    scratch_in: [f32; FRAME_SIZE],
    scratch_out: [f32; FRAME_SIZE],
}

impl Denoiser {
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            input: [0.0; FRAME_SIZE],
            output: [0.0; FRAME_SIZE],
            scratch_in: [0.0; FRAME_SIZE],
            scratch_out: [0.0; FRAME_SIZE],
        }
    }

    /// Input/output are in -1..1. nnnoiseless wants 16-bit scale.
    pub fn process(&mut self) -> f32 {
        for i in 0..FRAME_SIZE {
            self.scratch_in[i] = self.input[i] * 32768.0;
        }
        let vad = self
            .state
            .process_frame(&mut self.scratch_out, &self.scratch_in);
        for i in 0..FRAME_SIZE {
            self.output[i] = (self.scratch_out[i] / 32768.0).clamp(-1.0, 1.0);
        }
        vad.clamp(0.0, 1.0)
    }
}
