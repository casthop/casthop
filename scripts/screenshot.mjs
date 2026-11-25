#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const chromePath = process.env.CHROME || "/usr/local/bin/chrome";
const url = process.argv[2];
const out = process.argv[3];
const waitMs = Number(process.argv[4] || 4000);
const port = Number(process.env.CDP_PORT || 9333);
if (!url || !out) {
  console.error("usage: screenshot.mjs <url> <out.png> [waitMs]");
  process.exit(2);
}

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/casthop-cdp-${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900",
    url,
  ],
  { stdio: "ignore" },
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitJson() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error("no CDP page");
}

try {
  const tab = await waitJson();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
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
  await sleep(waitMs);
  if (out.endsWith(".txt")) {
    const result = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
    writeFileSync(out, String(result.result?.value ?? ""));
    console.log("text", out);
  } else {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("wrote", out, "bytes", Buffer.from(shot.data, "base64").length);
  }
  ws.close();
} finally {
  chrome.kill("SIGKILL");
}
