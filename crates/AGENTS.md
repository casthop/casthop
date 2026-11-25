# crates/

Rust/WASM rules. Root `AGENTS.md` still applies.

## casthop-media

Builds to `src/wasm/casthop_media.wasm`: C ABI, no wasm-bindgen, no JS imports (AudioWorklet-safe). After crate changes, `npm run build:wasm` and commit the `.wasm`.

- Preallocate. No `Vec` / `String` / `Box` in `process`, `blit`, or per-sample paths.
- No `unwrap`, `expect`, or `panic!` outside `#[cfg(test)]`. Bad handles return 0 / no-op.
- `clippy::pedantic` is on. If a lint is wrong here, `#[expect(...)]` with one line of why. Do not `#[allow]` unused code — delete it.
- Keep the JS fallback (`src/lib/effects.ts`, `?fx=js`, `?compose=wasm` / `?compose=webgpu`).
- Vendored `nnnoiseless` stays on the rustc 1.83 pin unless you bump the toolchain.
- `simd128` is already on for wasm32 (`.cargo/config.toml`).

```bash
cargo test -p casthop-media
cargo clippy -p casthop-media --all-targets -- -D warnings -W clippy::pedantic
```

## casthop-post

CLI for recordings. Do not turn it into the live fan-out path without measurements.

```bash
cargo run -p casthop-post -- inspect data/recordings/<file>.mp4
```
