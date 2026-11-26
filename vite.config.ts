import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { cloudflare } from "@cloudflare/vite-plugin";

function copyMediapipeWasm() {
  execFileSync(process.execPath, ["scripts/copy-mediapipe.mjs"], { stdio: "inherit" });
}

copyMediapipeWasm();

const skipReact = [/\/node_modules\//, /\/workers\//, /\/worklets\//];

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
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
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
