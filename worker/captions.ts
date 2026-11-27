import type { CaptionCue, CaptionSettings } from "./types";

export const CAPTION_FLUSH_MS = 1000;
export const CAPTION_TEXT_MAX = 200;
/** Longest span one transcribed segment can claim. */
export const CAPTION_SPAN_MAX_MS = 30_000;
export const CAPTION_BUFFER_MAX = 200;
export const CAPTION_CHUNK_MAX = 50;
/** Storage chunks per live (one per flush, so about five hours). */
export const CAPTION_CHUNKS_MAX = 20_000;
export const CAPTION_WINDOW_MS = 10_000;
export const CAPTION_RATE_MAX = 12;
/** The program stops showing a line this long after it was spoken. */
export const CAPTION_SHOW_MS = 6000;
export const CAPTION_VTT_FILE = "captions.vtt";

export function defaultCaptions(): CaptionSettings {
  return { on: false, burn: false };
}

export function parseCaptionSettings(body: Record<string, unknown>, prev: CaptionSettings): CaptionSettings | null {
  const on = body.on === undefined ? prev.on : body.on;
  const burn = body.burn === undefined ? prev.burn : body.burn;
  if (typeof on !== "boolean" || typeof burn !== "boolean") return null;
  return { on, burn };
}

// Whisper prints these for silence and noise; they are not speech.
const NOISE = /^[[(*♪\s].*[\])*♪\s]$/;

export function cleanCaptionText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.replace(/\s+/g, " ").trim().slice(0, CAPTION_TEXT_MAX);
  return NOISE.test(text) ? "" : text;
}

export function captionStorageKey(n: number): string {
  return `cap:${String(n).padStart(6, "0")}`;
}

function stamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(t % 1000, 3)}`;
}

function vttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");
}

/** WebVTT with one cue per segment. `baseMs` is the epoch time of 00:00:00. */
export function writeVtt(cues: CaptionCue[], baseMs: number): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const blocks = sorted.map((cue) => {
    const start = Math.max(0, cue.start - baseMs);
    const end = Math.max(start + 500, cue.end - baseMs);
    const who = cue.name.replace(/[\r\n<>&]/g, " ").trim() || "Speaker";
    return `${stamp(start)} --> ${stamp(end)}\n<v ${who}>${vttText(cue.text)}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

/** Collects cues between flushes. Drops the oldest past the cap. */
export class CaptionBuffer {
  private cues: CaptionCue[] = [];

  add(cue: CaptionCue): void {
    this.cues.push(cue);
    if (this.cues.length > CAPTION_BUFFER_MAX) this.cues.splice(0, this.cues.length - CAPTION_BUFFER_MAX);
  }

  get size(): number {
    return this.cues.length;
  }

  take(): CaptionCue[] {
    const out = this.cues;
    this.cues = [];
    return out;
  }

  clear(): void {
    this.cues = [];
  }
}

export function chunkCues(cues: CaptionCue[]): CaptionCue[][] {
  const out: CaptionCue[][] = [];
  for (let i = 0; i < cues.length; i += CAPTION_CHUNK_MAX) out.push(cues.slice(i, i + CAPTION_CHUNK_MAX));
  return out;
}
