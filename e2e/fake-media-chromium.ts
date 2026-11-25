import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserLease, BrowserProvider } from "@e2e-dev/web";
import { chromium } from "playwright-core";

const procs = new Map<string, ChildProcess>();

function waitForCdp(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onAbort = () => {
      cleanup();
      reject(new Error("chromium launch aborted"));
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`chromium exited ${code ?? sig}: ${buf.trim()}`));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    signal.addEventListener("abort", onAbort);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

/**
 * Local Chromium with fake camera/mic flags. `web()` has no `args`, so a
 * BrowserProvider launches Chrome over CDP instead of the engine's default.
 */
export function fakeMediaChromium(): BrowserProvider {
  return {
    name: "fake-media-chromium",
    scope: "worker",
    async acquire(request) {
      const executable = chromium.executablePath();
      const userDataDir = mkdtempSync(join(tmpdir(), "casthop-e2e-chrome-"));
      const child = spawn(
        executable,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-features=WebRtcHideLocalIpsWithMdns",
          `--user-data-dir=${userDataDir}`,
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const cdpEndpoint = await waitForCdp(child, request.signal);
      const id = `${request.runId}-${request.slot}-${child.pid}`;
      procs.set(id, child);
      return { id, cdpEndpoint };
    },
    async release(lease: BrowserLease) {
      const child = procs.get(lease.id);
      procs.delete(lease.id);
      if (!child || child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}
