import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { comparePerf, formatPerfTable, regressionLimit } from "../src/lib/perf-gate.ts";
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
  const gha = comparePerf({ ...sample, p95FrameMs: 13, longTaskTotalMs: 121 }, {
    ...baseline,
    p50FrameMs: 9,
    p95FrameMs: 13,
    longTaskTotalMs: 120,
  });
  assert.equal(gha.ok, true);
  const table = formatPerfTable(ok.rows);
  assert.match(table, /p95 frame ms/);
  assert.match(table, /long task total ms/);
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
  assert.ok(raw.p95FrameMs > 0);
  assert.ok(raw.longTaskTotalMs >= 0);
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
  assert.match(worker, /reader\.cancel/);
  assert.match(worker, /OUTPUT_INTERVAL_MS/);
  assert.match(worker, /requestAnimationFrame/);
  assert.match(worker, /setTimeout\(run, 16\)/);
  assert.match(program, /worker\.terminate\(\)/);
  assert.match(program, /outputTrack\?\.stop\(\)/);
  assert.match(egress, /startProgramCompose/);
  assert.match(egress, /el\.muted = false/);
});

test("vite enables the React Compiler", () => {
  const src = readFileSync(join(root, "vite.config.ts"), "utf8");
  assert.match(src, /babel-plugin-react-compiler/);
  assert.match(src, /target: "19"/);
});
