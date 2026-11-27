import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { cloudflare } from "@cloudflare/vite-plugin";

function copyMediapipeWasm() {
  execFileSync(process.execPath, ["scripts/copy-mediapipe.mjs"], { stdio: "inherit" });
}

copyMediapipeWasm();

const skipReact = [/\/node_modules\//, /\/workers\//, /\/worklets\//];

// The Cloudflare plugin mounts Miniflare's data explorer at
// /cdn-cgi/local/explorer with no login: raw D1 SQL, R2, request logs.
// Off unless a developer sets X_LOCAL_EXPLORER=true for their own session.
process.env.X_LOCAL_EXPLORER ??= "false";

// Egress writes program MP4s and RTMP captures here. Vite matches deny globs
// that contain a slash against absolute paths, so this must be absolute.
export const dataDir = normalizePath(fileURLToPath(new URL("./data", import.meta.url)));

export default defineConfig({
  plugins: [
    react({
      exclude: skipReact,
    }),
    // plugin-react 6 dropped the inline babel option; keep the compiler on Babel.
    babel({
      exclude: [...skipReact, /\0rolldown\/runtime\.js/],
      presets: [reactCompilerPreset({ target: "19" })],
    }),
    cloudflare(),
  ],
  assetsInclude: ["**/*.tflite"],
  worker: {
    format: "es",
  },
  server: {
    // Loopback only. Dev sign-in, the data explorer and data/ assume nobody
    // else can reach this port. Egress and LiveKit use host networking, so
    // they still reach 127.0.0.1:5173.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Setting deny replaces Vite's defaults, so repeat them, plus secrets and data/.
    fs: { deny: [".env", ".env.*", ".dev.vars*", "*.{crt,pem}", "**/.git/**", `${dataDir}/**`] },
  },
  build: {
    rollupOptions: {
      plugins: [
        {
          name: "copy-mediapipe-wasm",
          buildStart() {
            copyMediapipeWasm();
          },
        },
      ],
    },
  },
});
