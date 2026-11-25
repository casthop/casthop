#!/usr/bin/env node
/**
 * Headless: create a studio, join as host in Chrome, Go Live to local MediaMTX,
 * fail if program audio is digital silence.
 *
 * Needs docker compose (LiveKit, Egress, MediaMTX), `npm run dev`, ffmpeg, Chrome.
 * Skip unless CI=true or E2E=1 when the stack is not up.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const required = process.env.CI === "true" || process.env.E2E === "1";
const app = process.env.APP_URL || "http://127.0.0.1:5173";
const rtmp = process.env.RTMP_URL || "rtmp://127.0.0.1:1935/live/youtube";
const chromePath = process.env.CHROME || process.env.CHROME_PATH || "/usr/local/bin/chrome";
const cdpPort = Number(process.env.CDP_PORT || 9334);

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

async function health() {
  try {
    const res = await fetch(`${app}/api/health`);
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body.ok);
  } catch {
    return false;
  }
}

if (!(await health())) {
  if (!required) {
    log("stack not up; skip (set E2E=1 to require)");
    process.exit(0);
  }
  console.error("app /api/health is not ok; start docker compose and npm run dev");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const created = await fetch(`${app}/api/studios`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "E2E live" }),
});
if (!created.ok) {
  console.error("create studio failed", created.status, await created.text());
  process.exit(1);
}
const studio = await created.json();
log(`studio ${studio.id}`);

const dir = mkdtempSync(join(tmpdir(), "casthop-e2e-"));
const wav = join(dir, "tone.wav");
const tone = await run("ffmpeg", [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=60",
  wav,
]);
if (tone.code !== 0) {
  console.error("ffmpeg tone failed", tone.err);
  process.exit(1);
}

const studioUrl = `${app}/studio/${studio.id}?host=${encodeURIComponent(studio.hostKey)}&fx=off`;
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
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900",
    studioUrl,
  ],
  { stdio: "ignore" },
);

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
  throw new Error("no CDP page");
}

let failed = 0;
try {
  const wsUrl = await waitCdp();
  const ws = new WebSocket(wsUrl);
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

  let clicked = false;
  for (let i = 0; i < 40; i++) {
    const result = await send("Runtime.evaluate", {
      expression: `(() => {
        const btn = document.querySelector("button.go-live");
        if (!btn || btn.disabled) return { ok: false, text: document.body.innerText.slice(0, 400) };
        btn.click();
        return { ok: true };
      })()`,
      returnByValue: true,
    });
    if (result.result?.value?.ok) {
      clicked = true;
      break;
    }
    await sleep(500);
  }
  if (!clicked) throw new Error("Go Live button never appeared");
  log("clicked Go Live");

  let rtmpUp = false;
  for (let i = 0; i < 45; i++) {
    const probe = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      rtmp,
    ]);
    if (probe.code === 0 && probe.out.includes("aac")) {
      rtmpUp = true;
      break;
    }
    await sleep(1000);
  }
  if (!rtmpUp) throw new Error(`RTMP not playing at ${rtmp}`);
  log("rtmp playing");

  const vol = await run("ffmpeg", [
    "-hide_banner",
    "-t",
    "4",
    "-i",
    rtmp,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const logText = `${vol.out}\n${vol.err}`;
  const mean = /mean_volume:\s+([-0-9.]+)\s+dB/.exec(logText)?.[1];
  if (!mean) {
    writeFileSync(join(dir, "volumedetect.txt"), logText);
    throw new Error("volumedetect did not report mean_volume");
  }
  const db = Number(mean);
  log(`mean_volume=${db} dB`);
  if (db <= -90) throw new Error(`silent audio: mean_volume ${db} dB`);

  await fetch(`${app}/api/studios/${studio.id}/live`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-casthop-host-key": studio.hostKey },
    body: JSON.stringify({ live: false, hostKey: studio.hostKey }),
  });
  ws.close();
  log("ok");
} catch (err) {
  failed = 1;
  console.error(err instanceof Error ? err.message : err);
} finally {
  chrome.kill("SIGKILL");
}

process.exit(failed);
