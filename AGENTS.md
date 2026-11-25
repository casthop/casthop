# Casthop

Open-source browser live studio. TypeScript UI + Cloudflare Worker / Durable Objects / D1; LiveKit + Egress for the SFU and RTMP composite; Rust compiled to WASM (`crates/casthop-media`) for denoise, VAD/meters, and layout. TypeScript stays on UI and Worker glue. Do not replace LiveKit.

This file is the source of truth. Nested `AGENTS.md` files add tree-specific rules; the closest one wins. Pointers: `CLAUDE.md`, `.cursor/rules/casthop.mdc`, `.github/copilot-instructions.md`.

## Layout

- `src/` — React UI, AudioWorklets, WASM loader
- `worker/` — Hono Worker, studio Durable Object, LiveKit tokens, Egress
- `crates/casthop-media` — WASM media (C ABI, zero JS imports)
- `crates/casthop-post` — inspect / remux recordings
- `tests/auth.test.ts` — stranger / guest / host authorization matrix
- `MEASUREMENTS.md` — recorded numbers; update on hot-path changes
- `PRODUCT.md` — product intent

## Commands

Node 20+. Linux + Docker host networking is the supported local path. Rebuild WASM only with rustc 1.83+ and `wasm32-unknown-unknown`.

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d
npm install
npm run dev                 # http://127.0.0.1:5173
```

```bash
npm run build               # Vite + Worker
npm run typecheck           # tsc --noEmit (strict)
npm test                    # tsx --test tests/*.test.ts
tsx --test tests/auth.test.ts
npm audit --audit-level=high

cargo test -p casthop-media
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings -W clippy::pedantic

npm run build:wasm          # crate → src/wasm/casthop_media.wasm
npm run bench:wasm          # Node WASM vs JS
npm run measure             # load + silent-audio check
bash scripts/check-silent-audio.sh data/recordings/<file>.mp4
cargo run -p casthop-post -- inspect data/recordings/<file>.mp4
```

CI (`.github/workflows/ci.yml`): `npm ci`, `typecheck`, `test`, `npm audit --audit-level=high`, `cargo test -p casthop-media`. Run the same before you finish. No ESLint script; typecheck is the TS gate.

## Code

Small functions, clear names, no dead code, no clever tricks. Comments explain why, not what.

TypeScript: `strict` on. No `any`, no `as any`, no `as unknown as`. No unused locals. Named exports.

Rust: see `crates/AGENTS.md`. No `unwrap` / `expect` / `panic!` outside tests.

## Performance

Budgets from `MEASUREMENTS.md`. Beat them, or record why not:

| Path | Budget | Measured |
|---|---|---|
| Denoise | < 1 ms / 10 ms frame | WASM RNNoise 0.088 ms |
| CPU compose blit | not on the live path if ≥ 8 ms/frame @ 1280×720 | WASM ~5.4 ms, JS ~4.1 ms; live is Canvas2D |
| WASM binary | < 500 KiB, zero imports | ~385 KiB |
| Camera blur 1280×720 | < 33 ms/frame (30 fps) | WASM 14.2 ms, JS 14.1 ms |
| Worker HTTP glue | < 10 ms CPU | Cloudflare Worker CPU |
| Durable Object write | < 50 ms | stage / live / destinations |
| Glass-to-glass (loopback) | p50 < 80 ms | 45 ms |

Hot-path change: measure before and after (`npm run bench:wasm`, `/internal/bench`, `/internal/probe`, or `npm run measure`). Put both numbers in `MEASUREMENTS.md` in the same PR. No allocations in audio/video loops. Use Rust/WASM or GPU only when it measurably wins; keep the JS fallback (`?fx=js`, `?compose=wasm` / `?compose=webgpu`).

## Security

- Stream keys and full destination URLs never go to guests or public GET / WebSocket state. Hosts get full URLs only after `x-casthop-host-key`.
- Auth every action on the server. Identities are assigned by the Worker (`host` / `g-…`). Guests cannot impersonate host.
- Validate input (names, layout, RTMP URLs). Reject non-`rtmp:` and RFC1918 destinations from clients.
- Secrets live in `.dev.vars` / Worker secrets. Never in git, client bundles, or logs. Default `devkey` is loopback-only.
- `LIVEKIT_API_SECRET` is never sent to the browser.

## Tests

Every change ships tests. The stranger / guest / host matrix in `tests/auth.test.ts` must stay green. CI must pass. Extend that matrix for new API or auth rules.

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
