# crates/

Rust/WASM rules. Root `AGENTS.md` still applies.

## casthop-media

Default build is `src/wasm/casthop_media.wasm`: C ABI, no wasm-bindgen, no JS imports (AudioWorklet-safe). Camera background blur (mask smooth / box-blur / composite) lives here; the selfie-segmentation model is a separate lazy load. `--features gpu` builds a second artifact, `src/wasm/casthop_gpu_bg.wasm` + `casthop_gpu.js` (WebGPU compositor, wasm-bindgen). After crate changes, `bun run build:wasm` and commit both.

- Preallocate. No `Vec` / `String` / `Box` in `process`, `blit`, or per-sample paths.
- No `unwrap`, `expect`, or `panic!` outside `#[cfg(test)]`. Bad handles return 0 / no-op.
- `clippy::pedantic` is on. If a lint is wrong here, `#[expect(...)]` with one line of why. Do not `#[allow]` unused code — delete it.
- Keep the JS fallback (`src/lib/effects.ts`, `?fx=js`, `?compose=wasm` / `?compose=webgpu` / `?compose=webgpu-ts`). Canvas2D stays the live default until wgpu wins on `/internal/bench`.
- Vendored `nnnoiseless` is 0.5.1; bump it only with a toolchain that matches its MSRV.
- `simd128` is already on for wasm32 (`.cargo/config.toml`).

```bash
cargo test -p casthop-media
cargo clippy -p casthop-media --all-targets --no-deps -- -D warnings
```

## casthop-post

CLI for recordings. Do not turn it into the live fan-out path without measurements.

```bash
cargo run -p casthop-post -- inspect data/recordings/<file>.mp4
```

## casthop-hot

Separate Cargo workspace (not a root member). workers-rs 0.7.0 + `worker-build` 0.1.12 on rustc 1.100; worker 0.9 wants a newer compiler. Comparison harness only — live `/api` stays on the Hono Worker. JWT claims match `worker/livekit.ts`. CI `cargo audit` does not scan this lockfile: workers-rs 0.7 still pulls idna 0.5 / ruzstd 0.7 / url 2.5.2, and this Worker is never deployed.

```bash
cargo test --manifest-path crates/casthop-hot/Cargo.toml
cargo fmt --manifest-path crates/casthop-hot/Cargo.toml -- --check
cargo clippy --manifest-path crates/casthop-hot/Cargo.toml --all-targets --no-deps -- -D warnings
cargo clippy --manifest-path crates/casthop-hot/Cargo.toml --target wasm32-unknown-unknown --no-deps -- -D warnings
bun run bench:worker
```
