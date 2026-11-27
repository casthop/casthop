import assert from "node:assert/strict";
import { test } from "node:test";
// Pure helpers; the Durable Object side is in caption-buffer.test.ts.
import {
  CAPTION_BUFFER_MAX,
  CAPTION_SHOW_MS,
  CaptionBuffer,
  chunkCues,
  cleanCaptionText,
  defaultCaptions,
  parseCaptionSettings,
  writeVtt,
} from "../worker/captions.ts";
import type { CaptionCue } from "../worker/types.ts";
import { CaptionTracker } from "../src/lib/caption-overlay.ts";
import { SpeechSegmenter } from "../src/lib/speech-segmenter.ts";

const cue = (start: number, end: number, text: string, name = "Ana"): CaptionCue => ({ from: "host", name, text, start, end });

test("captions are off by default", () => {
  assert.deepEqual(defaultCaptions(), { on: false, burn: false });
});

test("settings parse keeps the other flag and rejects non-booleans", () => {
  const prev = { on: true, burn: false };
  assert.deepEqual(parseCaptionSettings({ burn: true }, prev), { on: true, burn: true });
  assert.deepEqual(parseCaptionSettings({ on: false }, prev), { on: false, burn: false });
  assert.equal(parseCaptionSettings({ on: "yes" }, prev), null);
});

test("VTT writer: header, voice tag, times from the base, sorted", () => {
  const base = 1_000_000;
  const vtt = writeVtt([cue(base + 3_723_004, base + 3_725_000, "second"), cue(base + 1500, base + 3200, "first")], base);
  assert.equal(
    vtt,
    [
      "WEBVTT",
      "",
      "00:00:01.500 --> 00:00:03.200",
      "<v Ana>first",
      "",
      "01:02:03.004 --> 01:02:05.000",
      "<v Ana>second",
      "",
    ].join("\n"),
  );
});

test("VTT writer: escapes markup, clamps before the base, keeps end after start", () => {
  const vtt = writeVtt([cue(90, 90, "a --> b <i> & c", "X<Y")], 100);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:00\.500\n<v X Y>a --&gt; b &lt;i&gt; &amp; c\n$/);
});

test("VTT writer: no cues is still a valid file", () => {
  assert.equal(writeVtt([], 0), "WEBVTT\n\n");
});

test("caption text is trimmed, capped, and silence markers are dropped", () => {
  assert.equal(cleanCaptionText("  hello \n  world "), "hello world");
  assert.equal(cleanCaptionText("[BLANK_AUDIO]"), "");
  assert.equal(cleanCaptionText("(music)"), "");
  assert.equal(cleanCaptionText(42), "");
  assert.equal(cleanCaptionText("x".repeat(500)).length, 200);
});

test("buffer keeps the newest cues past the cap and empties on take", () => {
  const buf = new CaptionBuffer();
  for (let i = 0; i < CAPTION_BUFFER_MAX + 10; i++) buf.add(cue(i, i + 1, `t${i}`));
  assert.equal(buf.size, CAPTION_BUFFER_MAX);
  const taken = buf.take();
  assert.equal(taken[0]?.text, "t10");
  assert.equal(buf.size, 0);
});

test("cues are stored in chunks of 50", () => {
  const cues = Array.from({ length: 120 }, (_, i) => cue(i, i + 1, `t${i}`));
  assert.deepEqual(
    chunkCues(cues).map((c) => c.length),
    [50, 50, 20],
  );
});

test("program shows a burned line for a few seconds, then hides it", () => {
  const tracker = new CaptionTracker();
  const line = { name: "Ana", text: "hi there", at: 5 };
  const on = { on: true, burn: true };
  assert.deepEqual(tracker.view(on, line, 1000), { name: "Ana", text: "hi there" });
  assert.deepEqual(tracker.view(on, line, 1000 + CAPTION_SHOW_MS - 1), { name: "Ana", text: "hi there" });
  assert.equal(tracker.view(on, line, 1000 + CAPTION_SHOW_MS), null);
  // A new line starts a new window.
  assert.notEqual(tracker.view(on, { ...line, at: 6, text: "next" }, 20_000), null);
});

test("program shows nothing when captions are off or not burned in", () => {
  const tracker = new CaptionTracker();
  const line = { name: "Ana", text: "hi", at: 1 };
  assert.equal(tracker.view(defaultCaptions(), line, 0), null);
  assert.equal(tracker.view({ on: true, burn: false }, line, 0), null);
  assert.equal(tracker.view({ on: true, burn: true }, null, 0), null);
  assert.equal(tracker.view(undefined, line, 0), null);
});

const RATE = 16000;
const frame = (amp: number) => new Float32Array(1600).fill(amp);

test("segmenter cuts one segment after speech ends, and none for silence", () => {
  const seg = new SpeechSegmenter({ sampleRate: RATE });
  for (let i = 0; i < 30; i++) assert.equal(seg.push(frame(0)), null);

  const out = [];
  for (let i = 0; i < 10; i++) out.push(seg.push(frame(0.2))); // 1 s of speech
  for (let i = 0; i < 6; i++) out.push(seg.push(frame(0))); // 0.6 s quiet
  const segments = out.filter((s) => s !== null);
  assert.equal(segments.length, 1);
  assert.ok((segments[0]?.durationMs ?? 0) >= 1000 && (segments[0]?.durationMs ?? 0) <= 1800);
});

test("segmenter cuts long speech at the max length", () => {
  const seg = new SpeechSegmenter({ sampleRate: RATE, maxMs: 2000 });
  const cuts = Array.from({ length: 30 }, () => seg.push(frame(0.2))).filter((s) => s !== null);
  assert.ok(cuts.length >= 1);
  assert.ok(cuts.every((s) => s.durationMs <= 2100));
});

test("segmenter ignores a click shorter than the minimum speech", () => {
  const seg = new SpeechSegmenter({ sampleRate: RATE });
  const out = [seg.push(frame(0.3))];
  for (let i = 0; i < 8; i++) out.push(seg.push(frame(0)));
  assert.equal(out.filter((s) => s !== null).length, 0);
});
