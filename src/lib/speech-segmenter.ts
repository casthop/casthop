export type SpeechSegment = { samples: Float32Array; durationMs: number };

export type SegmenterOptions = {
  sampleRate: number;
  /** Quiet this long after speech ends a segment. */
  silenceMs?: number;
  /** A segment is cut at this length even if the person keeps talking. */
  maxMs?: number;
  /** Less speech than this is a click or a cough, not a segment. */
  minSpeechMs?: number;
  threshold?: number;
};

const PREROLL_MS = 200;
const MAX_FRAME = 4096;

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) * (frame[i] ?? 0);
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Cuts a mic stream into speech segments by loudness. Buffers are allocated once. */
export class SpeechSegmenter {
  private readonly rate: number;
  private readonly silenceSamples: number;
  private readonly maxSamples: number;
  private readonly minSpeechSamples: number;
  private readonly prerollSamples: number;
  private readonly threshold: number;
  private readonly buf: Float32Array;
  private len = 0;
  private inSpeech = false;
  private quiet = 0;
  private voiced = 0;

  constructor(opts: SegmenterOptions) {
    this.rate = opts.sampleRate;
    const ms = (v: number) => Math.round((v / 1000) * opts.sampleRate);
    this.silenceSamples = ms(opts.silenceMs ?? 400);
    this.maxSamples = ms(opts.maxMs ?? 5000);
    this.minSpeechSamples = ms(opts.minSpeechMs ?? 250);
    this.prerollSamples = ms(PREROLL_MS);
    this.threshold = opts.threshold ?? 0.015;
    this.buf = new Float32Array(this.maxSamples + MAX_FRAME);
  }

  /** Feed one frame. Returns a segment when one just ended. */
  push(frame: Float32Array): SpeechSegment | null {
    if (frame.length > MAX_FRAME) return null;
    const loud = rms(frame) >= this.threshold;
    this.buf.set(frame, this.len);
    this.len += frame.length;

    if (!this.inSpeech) {
      if (!loud) {
        this.keepPreroll();
        return null;
      }
      this.inSpeech = true;
      this.quiet = 0;
      this.voiced = 0;
    }
    if (loud) {
      this.quiet = 0;
      this.voiced += frame.length;
    } else {
      this.quiet += frame.length;
    }
    if (this.quiet >= this.silenceSamples || this.len >= this.maxSamples) return this.finish();
    return null;
  }

  private keepPreroll(): void {
    if (this.len <= this.prerollSamples) return;
    this.buf.copyWithin(0, this.len - this.prerollSamples, this.len);
    this.len = this.prerollSamples;
  }

  private finish(): SpeechSegment | null {
    const enough = this.voiced >= this.minSpeechSamples;
    const samples = enough ? this.buf.slice(0, this.len) : null;
    this.len = 0;
    this.inSpeech = false;
    this.quiet = 0;
    this.voiced = 0;
    return samples ? { samples, durationMs: Math.round((samples.length / this.rate) * 1000) } : null;
  }
}
