# Casthop

Open-source browser live studio. TypeScript UI + Cloudflare Worker / Durable Objects / D1; LiveKit + Egress for the SFU and RTMP composite; Rust compiled to WASM (`crates/casthop-media`) for denoise, VAD/meters, and layout. TypeScript stays on UI and Worker glue. Do not replace LiveKit.

This file is the source of truth. Nested `AGENTS.md` files add tree-specific rules; the closest one wins. Pointers: `CLAUDE.md`, `.cursor/rules/casthop.mdc`, `.github/copilot-instructions.md`.

## Layout

- `src/` — React UI, AudioWorklets, WASM loader
- `worker/` — Hono Worker, studio Durable Object, LiveKit tokens, Egress
- `crates/casthop-media` — WASM media (C ABI, zero JS imports)
- `crates/casthop-post` — inspect / remux / HLS package recordings
- `crates/casthop-hot` — workers-rs bench Worker (JWT CPU vs TS; not on the live path)
- `tests/auth.test.ts` — owner / co-host / guest / signed-out / expired session matrix for every Worker route
- `tests/egress.test.ts` — start/stop, crash retry, RTMP dest status, empty-studio cleanup
- `tests/replays.test.ts` — R2 HLS ingest, playlist safety, private/public access (mocked R2)
- `tests/studio/*.e2e.ts` — studio UI flows (e2e / Playwright locators; no model)
- `MEASUREMENTS.md` — recorded numbers; update on hot-path changes
- `PRODUCT.md` — product intent

## Commands

Bun is the package manager and script runner (`packageManager` in `package.json`). Do not use npm or npx. Linux + Docker host networking is the supported local path. Rebuild WASM only with rustc 1.83+ and `wasm32-unknown-unknown`.

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d
bun install
bun run dev                 # http://127.0.0.1:5173
```

```bash
bun run build               # Vite + Worker
bun run typecheck           # tsc --noEmit (strict)
bun run test                # bun test --max-concurrency=1
bun test tests/auth.test.ts
bun test tests/egress.test.ts
bun run check:wasm          # < 500 KiB, zero imports
bun audit --audit-level=high
cargo audit                  # needs rustc 1.88+ (CI audit job uses stable)

cargo test -p casthop-media
cargo test -p casthop-media -p casthop-post
cargo fmt -p casthop-media -p casthop-post -- --check
cargo clippy -p casthop-media -p casthop-post --all-targets --no-deps -- -D warnings
cargo fmt --manifest-path crates/casthop-hot/Cargo.toml -- --check
cargo test --manifest-path crates/casthop-hot/Cargo.toml
cargo clippy --manifest-path crates/casthop-hot/Cargo.toml --all-targets --no-deps -- -D warnings

bun run build:wasm          # crate → src/wasm/casthop_media.wasm
bun run bench:wasm          # Bun WASM vs JS
bun run bench:worker        # wrangler TS vs workers-rs JWT CPU (Node fetch)
bun run measure             # load + silent-audio check
bash scripts/check-silent-audio.sh data/recordings/<file>.mp4
cargo run -p casthop-post -- inspect data/recordings/<file>.mp4
cargo run -p casthop-post -- hls data/recordings/<file>.mp4 /tmp/replay-hls
E2E=1 bun run test:e2e      # headless Go Live → MediaMTX, audio not silent
bun run test:e2e-ui         # studio UI flows (e2e, locators, --strict-cache, no model)
PERF=1 bun run test:perf    # headless main vs worker p95 / long tasks (~30 s each)
```

CI (`.github/workflows/ci.yml`): parallel `lint` (rustfmt), `typecheck`, `test`, `rust` (test + clippy), `wasm` budget, `audit` (`bun audit` + `cargo audit`), `perf` (Chrome compositor budget), `e2e` (compose + Chrome, Go Live → MediaMTX release gate), `e2e-studio` (compose + e2e UI flows, no secrets, no model). No ESLint script; typecheck is the TS gate. Dependabot: `.github/dependabot.yml`.

## Code

Small functions, clear names, no dead code, no clever tricks. Comments explain why, not what.

TypeScript: `strict` on. No `any`, no `as any`, no `as unknown as`. No unused locals. Named exports.

Rust: see `crates/AGENTS.md`. No `unwrap` / `expect` / `panic!` outside tests.

## Performance

Budgets from `MEASUREMENTS.md`. Beat them, or record why not:

| Path | Budget | Measured |
|---|---|---|
| Denoise | < 1 ms / 10 ms frame | WASM RNNoise 0.088 ms |
| CPU compose blit | not on the live path if ≥ 8 ms/frame @ 1280×720 | WASM ~5.4 ms, JS ~4.1 ms; live is Canvas2D in a Worker |
| WASM binary | < 500 KiB, zero imports | ~384 KiB (+ 33 KiB GPU wasm, lazy) |
| Camera blur 1280×720 | < 33 ms/frame (30 fps) | WASM 14.2 ms, JS 14.1 ms |
| Worker HTTP glue | < 10 ms CPU | Cloudflare Worker CPU |
| Durable Object write | < 50 ms | stage / live / destinations |
| Glass-to-glass (loopback) | p50 < 80 ms | 45 ms |

Hot-path change: measure before and after (`bun run bench:wasm`, `/internal/bench`, `/internal/probe`, or `bun run measure`). Put both numbers in `MEASUREMENTS.md` in the same PR. No allocations in audio/video loops. Use Rust/WASM or GPU only when it measurably wins; keep the JS fallback (`?fx=js`, `?compose=wasm` / `?compose=webgpu` / `?compose=webgpu-ts`).

## Security

- Stream keys and full destination URLs never go to guests or public GET / WebSocket state. Owners and co-hosts get full URLs on a signed-in GET (session cookie).
- Auth every action on the server. Hosting is an account session (owner or invited co-host). Identities are assigned by the Worker (`host` / `host-…` / `g-…`). Guests cannot impersonate host. Guests join by invite link without an account.
- Validate input (names, layout, RTMP URLs). Reject non-`rtmp:` and RFC1918 destinations from clients.
- Secrets live in `.dev.vars` / Worker secrets. Never in git, client bundles, or logs. Default `devkey` is loopback-only.
- `LIVEKIT_API_SECRET` is never sent to the browser.

## Tests

Every change ships tests. The owner / co-host / guest / signed-out / expired matrix in `tests/auth.test.ts` must stay green. CI must pass. Extend that matrix for new API or auth rules.

Studio UI flows: `tests/studio/*.e2e.ts`, run with `bun run test:e2e-ui`. Write locators and `expect` (no `agent.act` unless a control has no accessible name). If you do use `agent.act`, commit `.e2e/cache/` so CI can `--strict-cache` with no model and no API key. Keep `bun run test:e2e` as the Go Live → MediaMTX release gate.

Coding agents: `.cursor/mcp.json` registers `e2e mcp`. With `bun run dev` up, open a session, drive the studio with `run_code` / locators, and write tests from that. Do not start a second app on port 5173; the config uses `reuseExisting` locally. In CI, `reuseExisting` is ignored and the job starts its own `bun run dev`.

## Git and PRs

One concern per PR. Conventional commits (`feat:`, `fix:`, `perf:`, `test:`, `docs:`, `refactor:`, `chore:`). PR body: what changed, why, and measurements if relevant. Short. Plain words. No agent session history.

Never force-push. Never delete source. Never commit secrets. Never add a paid service (including Cloudflare Stream) or deploy publicly without the maintainer's OK.

## Writing

Code comments, PR descriptions, and reviews: brief, clear, human words. Write for someone who did not see the chat.

## Code Review Rules

When reviewing a PR:

- Put every finding as an inline comment on the exact line. If the fix is small, include a GitHub suggestion block.
- Write little, in plain words. Say what to change.
- Do not recommend merge. Do not label severity. Do not split must vs nice. Everything gets addressed.

## Design

Modern, minimal, lots of whitespace, few elements per screen. Restrained palette (`src/styles.css`: dark booth `#121316`, accent `#6d64f7`, light guest/home). No AI-looking template copy. Host studio is the dark booth; guest join is light until they enter.
