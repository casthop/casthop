#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rustup target add wasm32-unknown-unknown >/dev/null
cargo build -p casthop-media --release --target wasm32-unknown-unknown
mkdir -p src/wasm
cp -f target/wasm32-unknown-unknown/release/casthop_media.wasm src/wasm/casthop_media.wasm
ls -lh src/wasm/casthop_media.wasm
