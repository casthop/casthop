#!/usr/bin/env bun
/**
 * Headless compositor perf: 6 tiles + overlay for ~30s, then compare p95
 * frame time and long-task totals to tests/perf-baseline.json.
 *
 * Needs `bun run dev` and Chrome. Skip unless CI=true or PERF=1.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WsWebSocket from "ws";
import { comparePerf, formatPerfTable } from "../src/lib/perf-gate.ts";

const Socket = globalThis.WebSocket ?? WsWebSocket;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = process.env.CI === "true" || process.env.PERF === "1";
const app = process.env.APP_URL || "http://127.0.0.1:5173";
const chromePath = process.env.CHROME || process.env.CHROME_PATH || "/usr/local/bin/chrome";
const cdpPort = Number(process.env.CDP_PORT || 9335);
const seconds = Math.max(5, Number(process.env.PERF_SECONDS || 30) || 30);
const tiles = Math.max(4, Math.min(6, Number(process.env.PERF_TILES || 6) || 6));
const thread = process.env.PERF_THREAD || "";
const updateBaseline = process.env.UPDATE_BASELINE === "1";
const baselinePath = join(root, "tests/perf-baseline.json");

function log(msg) {
  console.log(`[perf] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageUp() {
  try {
    const res = await fetch(`${app}/internal/perf`);
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await pageUp())) {
  if (!required) {
    log("app not up; skip (set PERF=1 to require)");
    process.exit(0);
  }
  console.error("http://127.0.0.1:5173/internal/perf is not ok; start bun run dev");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "casthop-perf-"));
const q = new URLSearchParams({ tiles: String(tiles), seconds: String(seconds) });
if (thread) q.set("thread", thread);
const perfUrl = `${app}/internal/perf?${q}`;
const chromeErr = [];
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
chrome.stderr.on("data", (chunk) => {
  chromeErr.push(String(chunk));
  if (chromeErr.join("").length > 8000) chromeErr.shift();
});

async function waitCdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error(`no CDP page\n${chromeErr.join("")}`);
}

let failed = 0;
try {
  const wsUrl = await waitCdp();
  const ws = new Socket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let n = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const onMsg = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: perfUrl });
  await send("Page.loadEventFired").catch(() => undefined);

  let running = false;
  for (let i = 0; i < 40; i++) {
    const result = await send("Runtime.evaluate", {
      expression: `Boolean(window.__PERF_RUNNING__)`,
      returnByValue: true,
    });
    if (result.result?.value) {
      running = true;
      break;
    }
    await sleep(250);
  }
  if (!running) throw new Error(`perf page did not start\n${chromeErr.join("")}`);
  log(`running ${tiles} tiles for ${seconds}s`);

  const deadline = Date.now() + (seconds + 8) * 1000;
  while (Date.now() < deadline) {
    await send("Runtime.evaluate", {
      expression: `document.getElementById("perf-tap")?.click()`,
      returnByValue: true,
    }).catch(() => undefined);
    const done = await send("Runtime.evaluate", {
      expression: `window.__PERF__ ?? null`,
      returnByValue: true,
    });
    if (done.result?.value) {
      const measured = done.result.value;
      if (measured.error) throw new Error(measured.error);
      log(`thread=${measured.thread} backend=${measured.backend} frames=${measured.frames}`);
      if (updateBaseline) {
        const next = {
          version: 1,
          recordedAt: new Date().toISOString().slice(0, 10),
          seconds: measured.seconds,
          tiles: measured.tiles,
          backend: measured.backend,
          thread: measured.thread,
          p50FrameMs: measured.p50FrameMs,
          p95FrameMs: measured.p95FrameMs,
          droppedFrames: measured.droppedFrames,
          longTaskCount: measured.longTaskCount,
          longTaskTotalMs: measured.longTaskTotalMs,
          inputLatencyP95Ms: measured.inputLatencyP95Ms,
          notes: "Chrome headless, fake media, 6 canvas tiles + overlay",
        };
        writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
        log(`wrote ${baselinePath}`);
      }
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const { rows, ok } = comparePerf(measured, baseline);
      console.log(formatPerfTable(rows));
      if (!ok) {
        failed = 1;
        console.error("perf regression vs tests/perf-baseline.json");
      }
      ws.close();
      process.exit(failed);
    }
    await sleep(1000);
  }
  throw new Error("timed out waiting for window.__PERF__");
} catch (err) {
  failed = 1;
  console.error(err instanceof Error ? err.message : err);
} finally {
  chrome.kill("SIGKILL");
}

process.exit(failed);
