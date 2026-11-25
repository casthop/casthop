export type PerfBaseline = {
  version: 1;
  recordedAt: string;
  seconds: number;
  tiles: number;
  backend: string;
  thread: string;
  p50FrameMs: number;
  p95FrameMs: number;
  droppedFrames: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  inputLatencyP95Ms: number;
  notes?: string;
};

export type PerfMeasured = {
  p50FrameMs: number;
  p95FrameMs: number;
  droppedFrames: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  inputLatencyP95Ms: number;
  frames: number;
  thread: string;
  backend: string;
  tiles: number;
  seconds: number;
};

export type PerfRow = {
  name: string;
  measured: number;
  baseline: number;
  limit: number;
  gate: boolean;
  ok: boolean;
};

const PCT = 0.15;

export function regressionLimit(baseline: number, floor: number, pct = PCT): number {
  return Math.max(baseline * (1 + pct), baseline + floor);
}

export function comparePerf(measured: PerfMeasured, baseline: PerfBaseline): { rows: PerfRow[]; ok: boolean } {
  const rows: PerfRow[] = [
    row("p95 frame ms", measured.p95FrameMs, baseline.p95FrameMs, 4, true),
    row("long task total ms", measured.longTaskTotalMs, baseline.longTaskTotalMs, 50, true),
    row("p50 frame ms", measured.p50FrameMs, baseline.p50FrameMs, 2, false),
    row("dropped frames", measured.droppedFrames, baseline.droppedFrames, 8, false),
    row("long task count", measured.longTaskCount, baseline.longTaskCount, 2, false),
    row("input latency p95 ms", measured.inputLatencyP95Ms, baseline.inputLatencyP95Ms, 8, false),
  ];
  return { rows, ok: rows.filter((r) => r.gate).every((r) => r.ok) };
}

export function compareWorkerToMain(worker: PerfMeasured, main: PerfMeasured): { rows: PerfRow[]; ok: boolean } {
  const rows: PerfRow[] = [
    row("p95 frame ms", worker.p95FrameMs, main.p95FrameMs, 1, true),
    row("long task total ms", worker.longTaskTotalMs, main.longTaskTotalMs, 50, true),
    row("p50 frame ms", worker.p50FrameMs, main.p50FrameMs, 2, false),
    row("dropped frames", worker.droppedFrames, main.droppedFrames, 8, false),
    row("long task count", worker.longTaskCount, main.longTaskCount, 2, false),
    row("input latency p95 ms", worker.inputLatencyP95Ms, main.inputLatencyP95Ms, 8, false),
  ];
  return { rows, ok: rows.filter((r) => r.gate).every((r) => r.ok) };
}

function row(name: string, measured: number, baseline: number, floor: number, gate: boolean): PerfRow {
  const limit = regressionLimit(baseline, floor);
  return { name, measured, baseline, limit, gate, ok: measured <= limit };
}

export function formatPerfTable(rows: PerfRow[], measuredLabel = "measured", baselineLabel = "baseline"): string {
  const head = pad("metric", 24) + pad(measuredLabel, 12) + pad(baselineLabel, 12) + pad("limit", 12) + "gate";
  const line = "-".repeat(head.length);
  const body = rows.map((r) => {
    const flag = r.gate ? (r.ok ? "ok" : "FAIL") : "info";
    return pad(r.name, 24) + pad(fmt(r.measured), 12) + pad(fmt(r.baseline), 12) + pad(fmt(r.limit), 12) + flag;
  });
  return [head, line, ...body].join("\n");
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s} ` : s + " ".repeat(n - s.length);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
