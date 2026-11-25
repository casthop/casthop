#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if ! command -v wasm-bindgen >/dev/null || ! wasm-bindgen --version | grep -q "0.2.100"; then
  echo "wasm-bindgen-cli 0.2.100 is required for the gpu wasm" >&2
  echo "cargo install wasm-bindgen-cli --version 0.2.100 --locked" >&2
  exit 1
fi
rustup target add wasm32-unknown-unknown >/dev/null

# AudioWorklet / CPU compositor (C ABI, zero JS imports).
cargo build -p casthop-media --release --target wasm32-unknown-unknown
mkdir -p src/wasm
cp -f target/wasm32-unknown-unknown/release/casthop_media.wasm src/wasm/casthop_media.wasm
ls -lh src/wasm/casthop_media.wasm

# wgpu compositor (wasm-bindgen, loaded only on the compose path).
cargo build -p casthop-media --release --target wasm32-unknown-unknown --no-default-features --features gpu
wasm-bindgen target/wasm32-unknown-unknown/release/casthop_media.wasm \
  --out-dir src/wasm \
  --out-name casthop_gpu \
  --target web \
  --no-typescript

# Restore the C ABI module (gpu build overwrites the same crate artifact name).
cargo build -p casthop-media --release --target wasm32-unknown-unknown
cp -f target/wasm32-unknown-unknown/release/casthop_media.wasm src/wasm/casthop_media.wasm
ls -lh src/wasm/casthop_media.wasm src/wasm/casthop_gpu_bg.wasm src/wasm/casthop_gpu.js
