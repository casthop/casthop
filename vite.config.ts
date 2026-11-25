import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

function copyMediapipeWasm() {
  execFileSync(process.execPath, ["scripts/copy-mediapipe.mjs"], { stdio: "inherit" });
}

copyMediapipeWasm();

export default defineConfig({
  plugins: [react(), cloudflare()],
  assetsInclude: ["**/*.tflite"],
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
