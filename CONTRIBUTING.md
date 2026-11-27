# Contributing

Thanks for working on Casthop. This file is for humans. AI coding agents should follow [AGENTS.md](AGENTS.md) (Rust crates: [crates/AGENTS.md](crates/AGENTS.md)).

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## Dev setup

Linux + Docker host networking is the supported local path. Install [Bun](https://bun.com) 1.4.5 or newer (`packageManager` in `package.json`). Do not use npm.

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d
bun install
bun run dev                 # http://127.0.0.1:5173
```

Worker secrets live in `.dev.vars` (gitignored). Do not commit `.env`, `.dev.vars`, stream keys, or anything from `data/`.

You do not need a Rust toolchain to run the UI. Prebuilt `src/wasm/casthop_media.wasm` is committed. Rebuild only if you change `crates/casthop-media`. CI rebuilds the `.wasm` files in `rust:1.100.0` and fails if the committed bytes differ, so build in that image, mounted at the path CI checks out to (the path is embedded in the bytes):

```bash
docker run --rm -v "$PWD":/__w/casthop/casthop -w /__w/casthop/casthop rust:1.100.0 bash -c 'cargo install wasm-bindgen-cli --version 0.2.100 --locked && bash scripts/build-wasm.sh'
```

Docs site: `cd site && bun install && bun run dev`.

Env vars: [.env.example](.env.example), [.dev.vars.example](.dev.vars.example), and [Configuration](site/src/content/docs/en/configuration.mdx).

## Tests

Every change ships tests. CI must pass.

```bash
bun run typecheck           # tsc --noEmit (strict); this is the TS lint gate
bun run test                # bun test --max-concurrency=1
bun test tests/auth.test.ts
bun test tests/egress.test.ts
bun test tests/chat-ingest.test.ts

cargo test -p casthop-media -p casthop-post
cargo fmt -p casthop-media -p casthop-post -- --check
cargo clippy -p casthop-media -p casthop-post --all-targets --no-deps -- -D warnings
cargo fmt --manifest-path crates/casthop-hot/Cargo.toml -- --check
cargo test --manifest-path crates/casthop-hot/Cargo.toml
cargo clippy --manifest-path crates/casthop-hot/Cargo.toml --all-targets --no-deps -- -D warnings

bun run check:wasm          # < 500 KiB, zero imports
```

Auth: keep the owner / co-host / guest / signed-out / expired matrix in `tests/auth.test.ts` green. Extend it when you add a Worker route or change an auth rule.

### End-to-end

Needs compose + `bun run dev` (same setup as above). These flows sign in through the dev shortcut, so add `CASTHOP_DEV_LOGIN=1` to `.dev.vars` first (also needed for `bun run measure` and `/internal/probe`).

```bash
bunx --bun @e2e-dev/web install chromium   # once per machine; Linux may need --with-deps
bun run test:e2e-ui         # studio UI flows in tests/studio/*.e2e.ts
E2E=1 bun run test:e2e      # headless Go Live → MediaMTX; audio must not be silent. Needs ffmpeg. Set CHROME=/path/to/chrome if it is not /usr/local/bin/chrome
```

`test:e2e-ui` uses locators and `expect` (no model, no API key). `reuseExisting` locally if something is already on :5173. Do not start a second app on that port.

### Perf gate

```bash
PERF=1 bun run test:perf    # compositor main vs worker, ~30 s each
```

CI job `perf` runs this. The live compositor is Canvas2D on a Worker + OffscreenCanvas. Do not regress that path without numbers in [MEASUREMENTS.md](MEASUREMENTS.md) in the same PR. Local snapshot: `tests/perf-baseline.json`. Force the old main-thread path with `?thread=main`.

Hot-path change (audio/video loops, WASM, compose): measure before and after (`bun run bench:wasm`, `/internal/bench`, `/internal/probe`, or `bun run measure`) and record both numbers in `MEASUREMENTS.md`.

## Branch and PR flow

1. Open an issue, or pick one labeled `good first issue` or `help wanted`.
2. Branch from `main`. One concern per PR.
3. Add tests. Run the checks above that match what you touched.
4. Open a PR against `main`. Fill in `.github/pull_request_template.md` (what changed, why, how you tested). Short. Plain words. No agent session history.
5. Wait for CI (`.github/workflows/ci.yml`). Address review comments.

Never force-push to `main`. Never delete source. Never commit secrets. Never add a paid service (including Cloudflare Stream) or deploy publicly without a maintainer’s OK.

## Commit style

[Conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `test:`, `docs:`, `refactor:`, `chore:`.

## CI

Jobs (all must pass): `lint` (rustfmt), `typecheck`, `test`, `rust` (test + clippy), `wasm` budget, `wasm-reproducible` (rebuild in `rust:1.100.0`, bytes must match `src/wasm`), `audit` (`bun audit` + `cargo audit`), `perf` (Chrome compositor budget), `e2e` (Go Live → MediaMTX), `e2e-studio` (UI flows, no secrets, no model), `e2e-site` (marketing site header). Dependabot: `.github/dependabot.yml`.

## Code review

Reviewers comment on the exact line. If the fix is small, they include a GitHub suggestion. Write little, in plain words. Say what to change. Findings are not split into must vs nice — everything gets addressed.

## Code conventions

- TypeScript: `strict` on. No `any`, no `as any`, no `as unknown as`. No unused locals. Named exports.
- Rust: no `unwrap` / `expect` / `panic!` outside tests. See `crates/AGENTS.md`.
- Comments explain why, not what. Small functions, clear names, no dead code.
- TypeScript stays on UI and Worker glue. Do not replace LiveKit. Do not put a new compositor on the live path unless it beats Canvas2D on `/internal/bench`.

## Picking up issues

- [`good first issue`](https://github.com/casthop/casthop/labels/good%20first%20issue) — scoped enough for a first PR.
- [`help wanted`](https://github.com/casthop/casthop/labels/help%20wanted) — maintainers want help.
- [`bug`](https://github.com/casthop/casthop/labels/bug) / [`enhancement`](https://github.com/casthop/casthop/labels/enhancement).

Comment on the issue if you start work so two people do not duplicate it. Security reports go through [SECURITY.md](SECURITY.md), not public issues.
