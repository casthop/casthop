#!/usr/bin/env node
/**
 * TS Worker vs workers-rs for the hot /api CPU (JWT mint/verify, webhook).
 * Starts two `wrangler dev` processes, measures isolate CPU, RTT, cold start, bundle size.
 * Node fetch, not Bun: Bun's fetch cannot reach wrangler/miniflare (oven-sh/bun#39247).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data/measure");
const wranglerJs = join(root, "node_modules/wrangler/bin/wrangler.js");
const node = process.execPath;

const TS_PORT = 8788;
const RS_PORT = 8789;
const APP_PORT = 8787;
const WARM = 50;
const SAMPLES = 200;
const CPU_N = 2000;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function fmt(ms) {
  return `${ms.toFixed(3)} ms`;
}

async function waitFor(url, timeoutMs = 90_000, logPath) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    if (logPath && existsSync(logPath)) {
      const log = readFileSync(logPath, "utf8");
      if (log.includes("Ready on")) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return Date.now() - t0;
          last = `${res.status} ${await res.text()}`;
        } catch (err) {
          last = err instanceof Error ? err.message : String(err);
        }
      } else {
        last = "waiting for wrangler Ready";
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url} (${last})`);
}

function startWrangler(args, cwd, logName, inspectorPort) {
  mkdirSync(outDir, { recursive: true });
  const logPath = join(outDir, logName);
  writeFileSync(logPath, "");
  const child = spawn(
    node,
    [
      wranglerJs,
      "dev",
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      String(inspectorPort),
      "--show-interactive-dev-session",
      "false",
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const onChunk = (b) => appendFileSync(logPath, b);
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("exit", (code) => {
    if (code && code !== 0 && code !== null) {
      console.error(`${logName} exited ${code}; see ${logPath}`);
    }
  });
  return { child, logPath };
}

async function rtt(url, init, n, warm, accept = (status) => status >= 200 && status < 300) {
  for (let i = 0; i < warm; i++) await fetch(url, init);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await fetch(url, init);
    const ms = performance.now() - t0;
    if (!accept(res.status)) throw new Error(`${url} ${res.status} ${await res.text()}`);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), n: samples.length };
}

async function cpu(base, op) {
  const res = await fetch(`${base}/internal/cpu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, n: CPU_N }),
  });
  if (!res.ok) throw new Error(`cpu ${op} ${res.status} ${await res.text()}`);
  return res.json();
}

function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(name));
    try {
      const st = statSync(p);
      if (st.isFile()) total += st.size;
    } catch {
      /* skip */
    }
  }
  return total;
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function crossVerify(tsBase, rsBase) {
  const tsMint = await (await fetch(`${tsBase}/internal/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "host", name: "Ada", room: "x", role: "host" }),
  })).json();
  const rsSeesTs = await (await fetch(`${rsBase}/internal/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: `Bearer ${tsMint.token}` }),
  })).json();
  const rsMint = await (await fetch(`${rsBase}/internal/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "host", name: "Ada", room: "x", role: "host" }),
  })).json();
  const tsSeesRs = await (await fetch(`${tsBase}/internal/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: `Bearer ${rsMint.token}` }),
  })).json();
  const body = '{"event":"track_published","room":{"name":"x"}}';
  const tsHook = await fetch(`${tsBase}/api/livekit/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/webhook+json" },
    body,
  });
  // unsigned should 401 on both
  const rsHook = await fetch(`${rsBase}/api/livekit/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/webhook+json" },
    body,
  });
  return {
    rustVerifiesTsJwt: Boolean(rsSeesTs.ok),
    tsVerifiesRustJwt: Boolean(tsSeesRs.ok),
    unsignedWebhookTs: tsHook.status,
    unsignedWebhookRs: rsHook.status,
  };
}

async function benchApp(appBase) {
  const health = await rtt(`${appBase}/api/health`, {}, SAMPLES, WARM);
  const config = await rtt(`${appBase}/api/config`, {}, SAMPLES, WARM);
  const magic = await fetch(`${appBase}/api/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "bench@example.com" }),
  });
  const magicBody = await magic.json();
  if (!magicBody.devLogin) {
    return { health, config, skipped: "no devLogin (need loopback default keys)" };
  }
  const login = await fetch(`${appBase}${magicBody.devLogin}`, { method: "POST", redirect: "manual" });
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith("casthop_session="))
    ?.split(";")[0];
  if (!cookie) {
    return { health, config, skipped: "no session cookie" };
  }
  const created = await fetch(`${appBase}/api/studios`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ title: "Bench" }),
  });
  const studio = await created.json();
  if (!created.ok) {
    return { health, config, skipped: `create studio ${created.status}` };
  }
  const headers = { "Content-Type": "application/json", Cookie: cookie };
  // TOKEN_MINT_MAX is 20/studio/min; keep n small so the bench does not 429.
  const token = await rtt(
    `${appBase}/api/studios/${studio.id}/token`,
    { method: "POST", headers, body: JSON.stringify({ name: "Guest", role: "guest" }) },
    10,
    4,
  );
  const studioGet = await rtt(`${appBase}/api/studios/${studio.id}`, { headers: { Cookie: cookie } }, 40, 8);
  const live = await rtt(
    `${appBase}/api/studios/${studio.id}/live`,
    { method: "POST", headers, body: JSON.stringify({ live: false }) },
    10,
    4,
  );
  const beat = await rtt(
    `${appBase}/api/studios/${studio.id}/egress-beat`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    40,
    8,
    (status) => status === 401,
  );
  const webhook = await rtt(
    `${appBase}/api/livekit/webhook`,
    { method: "POST", headers: { "Content-Type": "application/webhook+json" }, body: '{"event":"track_published"}' },
    40,
    8,
    (status) => status === 401,
  );
  return { health, config, token, studioGet, liveStop: live, egressBeat: beat, webhook, studioId: studio.id };
}

async function main() {
  if (!existsSync(wranglerJs)) {
    console.error("run bun install first");
    process.exit(1);
  }

  console.log("building workers-rs crate…");
  const build = spawn("worker-build", ["--release"], { cwd: join(root, "crates/casthop-hot"), stdio: "inherit" });
  const buildCode = await new Promise((resolve) => build.on("exit", resolve));
  if (buildCode !== 0) {
    console.error("worker-build failed");
    process.exit(1);
  }

  const rsDir = join(root, "crates/casthop-hot/build");
  const rsBytes = dirBytes(rsDir);
  const workerJs = join(root, "dist/casthop/index.js");
  const tsWorkerBytes = existsSync(workerJs) ? statSync(workerJs).size : 0;

  const tsBase = `http://127.0.0.1:${TS_PORT}`;
  const rsBase = `http://127.0.0.1:${RS_PORT}`;
  const ts = startWrangler(
    ["--port", String(TS_PORT), "--local"],
    join(root, "scripts/worker-bench"),
    "wrangler-ts-hot.log",
    9230,
  );
  let rs = null;

  try {
    const tsReady = await waitFor(`${tsBase}/api/health`, 90_000, ts.logPath);
    rs = startWrangler(
      ["--port", String(RS_PORT), "--local"],
      join(root, "crates/casthop-hot"),
      "wrangler-rs-hot.log",
      9231,
    );
    const rsReady = await waitFor(`${rsBase}/api/health`, 90_000, rs.logPath);

    const tsCold = await rtt(`${tsBase}/api/health`, {}, 1, 0);
    const rsCold = await rtt(`${rsBase}/api/health`, {}, 1, 0);
    // Restart for a true first-request after listen: already captured waitFor as ready.
    const tsHealth = await rtt(`${tsBase}/api/health`, {}, SAMPLES, WARM);
    const rsHealth = await rtt(`${rsBase}/api/health`, {}, SAMPLES, WARM);

    const tsMint = await cpu(tsBase, "jwt-mint");
    const rsMint = await cpu(rsBase, "jwt-mint");
    const tsVerify = await cpu(tsBase, "jwt-verify");
    const rsVerify = await cpu(rsBase, "jwt-verify");
    const tsHook = await cpu(tsBase, "webhook-verify");
    const rsHook = await cpu(rsBase, "webhook-verify");
    const compat = await crossVerify(tsBase, rsBase);

    let app = null;
    const appArgs = ["--port", String(APP_PORT), "--local"];
    const assets = join(root, "dist/client");
    if (existsSync(assets)) appArgs.push("--assets", assets);
    const appProc = startWrangler(appArgs, root, "wrangler-app.log", 9232);
    try {
      await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, 90_000, appProc.logPath);
      app = await benchApp(`http://127.0.0.1:${APP_PORT}`);
    } catch (err) {
      app = { skipped: err instanceof Error ? err.message : String(err) };
    } finally {
      appProc.child.kill("SIGTERM");
    }

    const report = {
      when: new Date().toISOString(),
      cpuN: CPU_N,
      samples: SAMPLES,
      readyMs: { ts: tsReady, workersRs: rsReady },
      healthRttMs: { ts: tsHealth, workersRs: rsHealth, firstAfterReady: { ts: tsCold, workersRs: rsCold } },
      cpu: {
        jwtMint: { ts: tsMint, workersRs: rsMint },
        jwtVerify: { ts: tsVerify, workersRs: rsVerify },
        webhookVerify: { ts: tsHook, workersRs: rsHook },
      },
      compat,
      bundleBytes: { workersRs: rsBytes, honoWorkerJs: tsWorkerBytes },
      app,
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "worker-hot.json"), JSON.stringify(report, null, 2));

    console.log("\n=== workers-rs vs TS (wrangler dev) ===");
    console.log(`ready:     TS ${tsReady} ms   workers-rs ${rsReady} ms`);
    console.log(`health p50: TS ${fmt(tsHealth.p50)}   workers-rs ${fmt(rsHealth.p50)}`);
    console.log(`health p95: TS ${fmt(tsHealth.p95)}   workers-rs ${fmt(rsHealth.p95)}`);
    console.log(`jwt mint:   TS ${tsMint.perOpUs.toFixed(1)} µs/op   workers-rs ${rsMint.perOpUs.toFixed(1)} µs/op  (n=${CPU_N})`);
    console.log(`jwt verify: TS ${tsVerify.perOpUs.toFixed(1)} µs/op   workers-rs ${rsVerify.perOpUs.toFixed(1)} µs/op`);
    console.log(`webhook:    TS ${tsHook.perOpUs.toFixed(1)} µs/op   workers-rs ${rsHook.perOpUs.toFixed(1)} µs/op`);
    console.log(`compat:     rust↔ts jwt ${compat.rustVerifiesTsJwt && compat.tsVerifiesRustJwt}  unsigned webhook ${compat.unsignedWebhookTs}/${compat.unsignedWebhookRs}`);
    console.log(`bundle:     workers-rs ${kib(rsBytes)}${tsWorkerBytes ? `   Hono Worker JS ${kib(tsWorkerBytes)}` : ""}`);
    if (app && app.health) {
      console.log(`app health p50 ${fmt(app.health.p50)}  config ${fmt(app.config.p50)}`);
      if (app.token) {
        console.log(
          `app token p50 ${fmt(app.token.p50)}  studio GET ${fmt(app.studioGet.p50)}  live stop ${fmt(app.liveStop.p50)}`,
        );
      }
      if (app.egressBeat) console.log(`app egress-beat (401) p50 ${fmt(app.egressBeat.p50)}  webhook (401) ${fmt(app.webhook.p50)}`);
      if (app.skipped) console.log(`app extra: ${app.skipped}`);
    }
    console.log(`wrote ${join(outDir, "worker-hot.json")}`);
  } finally {
    ts.child.kill("SIGTERM");
    rs?.child.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
