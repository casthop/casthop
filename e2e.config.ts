import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { fakeMediaChromium } from "./e2e/fake-media-chromium.ts";

export const studioEngine = web({
  browser: fakeMediaChromium(),
  viewport: { width: 1440, height: 900 },
});

function ci(): boolean {
  const value = process.env.CI;
  return Boolean(value) && value !== "0" && value !== "false";
}

const app = {
  url: "http://127.0.0.1:5173",
  readyUrl: "http://127.0.0.1:5173/api/health",
  permissions: "all" as const,
  // CI ignores reuseExisting and would collide with the job's `bun run dev`.
  ...(ci()
    ? {}
    : {
        command: {
          executable: "bun",
          args: ["run", "dev"],
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
          reuseExisting: true,
          inheritEnv: ["USER", "LOGNAME", "LANG", "LC_*", "XDG_*", "NODE_*", "BUN_*", "CLOUDFLARE_*", "CF_*", "WRANGLER_*"],
        },
      }),
};

export default {
  tests: "tests/studio/**/*.e2e.ts",
  timeout: 180_000,
  launchTimeout: 120_000,
  assertionTimeout: 15_000,
  retries: 0,
  workers: 1,
  cache: "read-write",
  targets: [
    {
      name: "studio",
      engine: studioEngine,
      app,
    },
  ],
} satisfies E2EConfig;
