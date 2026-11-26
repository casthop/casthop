import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  bandLimits,
  comparePerf,
  compareWorkerToMain,
  formatPerfTable,
  regressionLimit,
  WORKER_FRAME_BUDGET_MS,
  WORKER_OUTPUT_FPS,
} from "../src/lib/perf-gate.ts";
import { percentile } from "../src/lib/compose-support.ts";
import { pickComposeThreadFrom } from "../src/lib/compose-backend.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("pickComposeThreadFrom maps ?thread=", () => {
  assert.equal(pickComposeThreadFrom(""), "auto");
  assert.equal(pickComposeThreadFrom("?compose=webgpu"), "auto");
  assert.equal(pickComposeThreadFrom("?thread=main"), "main");
  assert.equal(pickComposeThreadFrom("thread=worker"), "worker");
});

test("percentile interpolates", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([2], 95), 2);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 50) - 2.5) < 1e-9);
});

test("regressionLimit is 15% or a noise floor", () => {
  assert.equal(regressionLimit(10, 0.5), 11.5);
  assert.equal(regressionLimit(1, 0.5), 1.5);
  assert.equal(regressionLimit(0, 50), 50);
});

test("comparePerf fails only on gated metrics beyond 15%", () => {
  const baseline = {
    version: 1 as const,
    recordedAt: "2026-11-25",
    seconds: 30,
    tiles: 6,
    backend: "canvas2d",
    thread: "worker",
    p50FrameMs: 2,
    p95FrameMs: 4,
    droppedFrames: 10,
    longTaskCount: 2,
    longTaskTotalMs: 100,
    inputLatencyP95Ms: 16,
  };
  const sample = {
    p50FrameMs: 8,
    p95FrameMs: 4.2,
    droppedFrames: 40,
    longTaskCount: 9,
    longTaskTotalMs: 110,
    inputLatencyP95Ms: 80,
    frames: 900,
    thread: "worker",
    backend: "canvas2d",
    tiles: 6,
    seconds: 30,
  };
  const ok = comparePerf(sample, baseline);
  assert.equal(ok.ok, true);
  const failFrame = comparePerf({ ...sample, p95FrameMs: 16 }, baseline);
  assert.equal(failFrame.ok, false);
  const failTasks = comparePerf({ ...sample, longTaskTotalMs: 400 }, baseline);
  assert.equal(failTasks.ok, false);
  const table = formatPerfTable(ok.rows);
  assert.match(table, /p95 frame ms/);
  assert.match(table, /long task total ms/);
});

test("compareWorkerToMain gates p50 vs main, 30fps slot, frames, and drops", () => {
  const main = {
    p50FrameMs: 7,
    p95FrameMs: 10,
    droppedFrames: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    inputLatencyP95Ms: 16,
    frames: 1800,
    thread: "main",
    backend: "canvas2d",
    tiles: 6,
    seconds: 30,
  };
  const worker = { ...main, thread: "worker", frames: 900, p50FrameMs: 9, p95FrameMs: 11, longTaskTotalMs: 0 };
  assert.equal(compareWorkerToMain(worker, main).ok, true);
  assert.equal(compareWorkerToMain({ ...worker, p50FrameMs: 20 }, main).ok, false);
  assert.equal(compareWorkerToMain({ ...worker, p95FrameMs: 40 }, main).ok, false);
  assert.equal(compareWorkerToMain({ ...worker, longTaskTotalMs: 400 }, main).ok, false);
  const table = formatPerfTable(compareWorkerToMain(worker, main).rows, "worker", "main");
  assert.match(table, /worker/);
  assert.match(table, /main/);
  assert.match(table, /worker frames/);
  assert.match(table, /p95 30fps slot/);
});

test("compareWorkerToMain passes GHA fast-main tails that still hold 30fps", () => {
  const main = {
    p50FrameMs: 6.5,
    p95FrameMs: 8.6,
    droppedFrames: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    inputLatencyP95Ms: 17,
    frames: 1795,
    thread: "main",
    backend: "canvas2d",
    tiles: 6,
    seconds: 30,
  };
  const worker = { ...main, thread: "worker", frames: 902, p50FrameMs: 9.4, p95FrameMs: 13.64 };
  assert.equal(compareWorkerToMain(worker, main).ok, true);
  assert.ok(WORKER_FRAME_BUDGET_MS > 33 && WORKER_FRAME_BUDGET_MS < 34);
  assert.equal(compareWorkerToMain({ ...worker, p50FrameMs: 11.9, frames: 911 }, { ...main, p50FrameMs: 7.6, frames: 1795 }).ok, true);
  assert.equal(compareWorkerToMain({ ...worker, p50FrameMs: 13 }, main).ok, false);
  const flake = {
    ...main,
    p50FrameMs: 6.3,
    p95FrameMs: 8.1,
    frames: 1793,
  };
  assert.equal(
    compareWorkerToMain({ ...worker, frames: 910, p50FrameMs: 8.5, p95FrameMs: 9.5 }, flake).ok,
    true,
  );
});

test("compareWorkerToMain fails when worker leaves the 30fps band or drops frames", () => {
  const main = {
    p50FrameMs: 7,
    p95FrameMs: 10,
    droppedFrames: 0,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    inputLatencyP95Ms: 16,
    frames: 1800,
    thread: "main",
    backend: "canvas2d",
    tiles: 6,
    seconds: 30,
  };
  const worker = { ...main, thread: "worker", frames: WORKER_OUTPUT_FPS * 30, p95FrameMs: 11 };
  assert.equal(WORKER_OUTPUT_FPS, 30);
  assert.equal(compareWorkerToMain(worker, main).ok, true);
  assert.equal(compareWorkerToMain({ ...worker, frames: 400 }, main).ok, false);
  assert.equal(compareWorkerToMain({ ...worker, frames: 1800 }, main).ok, false);
  assert.equal(compareWorkerToMain({ ...worker, droppedFrames: 20 }, main).ok, false);
  const { lo, hi } = bandLimits(900, 0);
  assert.equal(lo, 765);
  assert.equal(hi, 1035);
});

test("perf baseline JSON has gated fields", () => {
  const raw = JSON.parse(readFileSync(join(root, "tests/perf-baseline.json"), "utf8")) as {
    version: number;
    p95FrameMs: number;
    longTaskTotalMs: number;
    tiles: number;
    seconds: number;
  };
  assert.equal(raw.version, 1);
  assert.equal(raw.p95FrameMs, 11.6);
  assert.equal(raw.longTaskTotalMs, 0);
  assert.equal(raw.tiles, 6);
  assert.equal(raw.seconds, 30);
});

test("offthread compose uses OffscreenCanvas and VideoFrame transfer", () => {
  const worker = readFileSync(join(root, "src/workers/compose-worker.ts"), "utf8");
  const program = readFileSync(join(root, "src/lib/program-compose.ts"), "utf8");
  const egress = readFileSync(join(root, "src/pages/EgressTemplate.tsx"), "utf8");
  assert.match(program, /transferControlToOffscreen/);
  assert.match(program, /MediaStreamTrackProcessor/);
  assert.match(program, /MediaStreamTrackGenerator/);
  assert.match(program, /captureStream/);
  assert.match(program, /offthread compose fallback/);
  assert.match(worker, /OffscreenCanvas/);
  assert.match(worker, /VideoFrame/);
  assert.match(worker, /readable\.getReader/);
  assert.match(worker, /!order.includes\(id\)/);
  assert.match(worker, /signal\.addEventListener\("abort"/);
  assert.match(worker, /reader\.cancel/);
  assert.match(worker, /OUTPUT_INTERVAL_MS/);
  assert.match(worker, /const OUTPUT_FPS = 30/);
  assert.match(worker, /setTimeout\(tick/);
  assert.doesNotMatch(worker, /requestAnimationFrame/);
  const capAt = program.indexOf("captureStream(30)");
  const xferAt = program.indexOf("transferControlToOffscreen");
  assert.ok(capAt >= 0 && xferAt > capAt, "captureStream must run before transferControlToOffscreen");
  assert.match(program, /compose worker has no output track/);
  assert.match(program, /worker\.terminate\(\)/);
  assert.match(program, /outputTrack\?\.stop\(\)/);
  assert.match(egress, /startProgramCompose/);
  assert.match(egress, /sendEgressBeat\(studioId, token, egressId\)/);
  assert.match(egress, /HEARTBEAT_BEAT_MS/);
  assert.match(egress, /el\.muted = false/);
});

test("vite enables the React Compiler", () => {
  const src = readFileSync(join(root, "vite.config.ts"), "utf8");
  assert.match(src, /reactCompilerPreset/);
  assert.match(src, /@rolldown\/plugin-babel/);
  assert.match(src, /target: "19"/);
  assert.match(src, /skipReact/);
  assert.match(src, /workers/);
  assert.match(src, /worklets/);
});
