#!/usr/bin/env bun
/**
 * Headless compositor perf: 6 tiles + overlay for ~30s on main and worker
 * in one Chrome. Fails if the worker p95 frame time or long-task total is
 * more than 15% worse than main on the same runner.
 *
 * Needs `bun run dev` and Chrome. Skip unless CI=true or PERF=1.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WsWebSocket from "ws";
import { compareWorkerToMain, formatPerfTable } from "../src/lib/perf-gate.ts";

const Socket = globalThis.WebSocket ?? WsWebSocket;
const required = process.env.CI === "true" || process.env.PERF === "1";
const app = process.env.APP_URL || "http://127.0.0.1:5173";
const chromePath = process.env.CHROME || process.env.CHROME_PATH || "/usr/local/bin/chrome";
const cdpPort = Number(process.env.CDP_PORT || 9335);
const seconds = Math.max(5, Number(process.env.PERF_SECONDS || 30) || 30);
const tiles = Math.max(4, Math.min(6, Number(process.env.PERF_TILES || 6) || 6));

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

function perfUrl(thread) {
  const q = new URLSearchParams({ tiles: String(tiles), seconds: String(seconds), thread });
  return `${app}/internal/perf?${q}`;
}

function summarize(label, measured) {
  log(
    `${label} thread=${measured.thread} backend=${measured.backend} frames=${measured.frames} p50=${measured.p50FrameMs} p95=${measured.p95FrameMs} long=${measured.longTaskTotalMs} input=${measured.inputLatencyP95Ms}`,
  );
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

  async function measure(thread) {
    await send("Page.navigate", { url: perfUrl(thread) });
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
    if (!running) throw new Error(`${thread} perf page did not start\n${chromeErr.join("")}`);
    log(`running ${thread} ${tiles} tiles for ${seconds}s`);
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
        if (measured.error) throw new Error(`${thread}: ${measured.error}`);
        return measured;
      }
      await sleep(1000);
    }
    throw new Error(`timed out waiting for ${thread} window.__PERF__`);
  }

  const main = await measure("main");
  summarize("main", main);
  const worker = await measure("worker");
  summarize("worker", worker);
  if (main.thread !== "main") throw new Error(`expected main thread, got ${main.thread}`);
  if (worker.thread !== "worker") throw new Error(`expected worker thread, got ${worker.thread}`);

  const { rows, ok } = compareWorkerToMain(worker, main);
  console.log(formatPerfTable(rows, "worker", "main"));
  if (!ok) {
    failed = 1;
    console.error("worker path worse than main by more than 15%");
  }
  ws.close();
} catch (err) {
  failed = 1;
  console.error(err instanceof Error ? err.message : err);
} finally {
  chrome.kill("SIGKILL");
}

process.exit(failed);
