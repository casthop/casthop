# Casthop

Open-source browser live studio. A host signs in and opens a room in the browser, guests join from a link (no account), up to six people sit on stage, and the composite goes live to several RTMP destinations at once, with a recording kept.

This repository is the first working prototype: prove the core, measure it, then polish.

## Architecture

```
Browser (host + guests)  TypeScript UI
    │  WebRTC simulcast
    │  Rust/WASM in AudioWorklet: RNNoise + VAD/meters
    │  Rust/WASM layout; Canvas2D (default) / Rust WebGPU / TS WebGPU / WASM-CPU compositor
    ▼
LiveKit SFU (Go)  ─────────────────────────────────────────┐
    │                                                      │
    │  full-quality subscribe                              │
    ▼                                                      ▼
LiveKit Egress (custom /egress-template)             Durable Object
    │  one transcode, N RTMP URLs                    (stage, layout,
    ├──────────────┬──────────────┐                   chat, destinations)
    ▼              ▼              ▼
 MediaMTX       MediaMTX       MediaMTX              Cloudflare Worker
 youtube        linkedin       x                     + D1 (studio index)
    │              │              │                  + R2 seam (replays)
    ▼              ▼              ▼                  Rust casthop-post
 local RTMP    local RTMP     local RTMP             (inspect / remux)
 + Egress MP4 at ./data/recordings
```

**Why not Cloudflare Stream Live for fan-out?** Stream Live ingest and simulcast outputs need a Cloudflare account with Stream enabled. Stream storage is prepaid; running out blocks new live inputs. This prototype does not sign up for paid services. Egress already transcodes once and can emit many RTMP URLs from that encode, which is the right self-host path. Hosted Casthop can still put a single RTMP into Stream later if Stream’s delivery math wins; see `MEASUREMENTS.md`.

**Cloudflare pieces in this repo:** the app is a Worker (Hono) with a Durable Object per studio and D1 for the studio index. Local `bun run dev` runs that stack through the Cloudflare Vite plugin. R2 (`RECORDINGS`) stores HLS replays; Egress still writes the source MP4 to `./data/recordings`. Package with `casthop-post hls`, then `POST /api/studios/:id/replays`. Hot Worker endpoints are still TypeScript; a workers-rs port is a next step.

**LiveKit stays the SFU** (Go). It is already the fast path. The LiveKit Rust SDK is unused in v0.

**Browser media** lives in `crates/casthop-media`, compiled to `src/wasm/casthop_media.wasm` (no JS imports; AudioWorklet-safe). `src/lib/effects.ts` runs RNNoise on the mic before LiveKit publish (`?fx=js` or `?fx=off` to compare). The egress page uses WASM layout + Canvas2D blit by default (`?compose=wasm` for the CPU compositor, `?compose=webgpu` for the Rust WebGPU path, `?compose=webgpu-ts` for the TypeScript WebGPU path). Canvas2D stays default; the GPU path did not win on the bench.

## Local run

Linux (this is the path we measured). Install [Bun](https://bun.com) 1.4+; do not use npm. Docker uses host networking so the browser, LiveKit ICE, Egress, and RTMP all see `127.0.0.1`. LiveKit, Redis, and MediaMTX bind that loopback address so the committed `devkey` is not reachable on the LAN. The Worker refuses to start with that default keypair unless LiveKit is loopback (or `CASTHOP_ALLOW_DEV_KEYS=1` for tests).

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars   # Worker secrets, gitignored
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d
bun install
bun run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Email yourself a magic link (the Worker prints it in the console), open a studio, copy the guest link, put people on stage, Go Live. Destination rows show per-RTMP status; if Egress or a stream drops, the studio retries with backoff. Optional GitHub OAuth: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.dev.vars`.

Rebuild the WASM module (needs rustc 1.83+ and the `wasm32-unknown-unknown` target):

```bash
bun run build:wasm
```

Prebuilt `src/wasm/casthop_media.wasm` and `src/wasm/casthop_gpu_bg.wasm` are committed so `bun run dev` works without a Rust toolchain.

Default destinations are local MediaMTX stand-ins for YouTube, LinkedIn, and X:

| Destination | Ingest | Watch |
|---|---|---|
| YouTube stand-in | `rtmp://127.0.0.1:1935/live/youtube` | `ffprobe rtmp://127.0.0.1:1935/live/youtube` |
| LinkedIn stand-in | `rtmp://127.0.0.1:1935/live/linkedin` | same, `/live/linkedin` |
| X stand-in | `rtmp://127.0.0.1:1935/live/x` | same, `/live/x` |

Recordings land in `data/recordings/` (Egress MP4) and `data/rtmp/` (MediaMTX fMP4). Inspect or package HLS with the Rust helper:

```bash
cargo run -p casthop-post -- inspect data/recordings/<file>.mp4
cargo run -p casthop-post -- hls data/recordings/<file>.mp4 /tmp/replay-hls
```

`POST /api/studios/:id/replays` archives the playlist and segments to R2. They show on the studio list. Private replays are owner/co-host only; public ones play at `/watch/:id`.

Health: [http://127.0.0.1:5173/api/health](http://127.0.0.1:5173/api/health)

Latency probe: [http://127.0.0.1:5173/internal/probe](http://127.0.0.1:5173/internal/probe)

WASM vs JS bench: [http://127.0.0.1:5173/internal/bench](http://127.0.0.1:5173/internal/bench) or `bun run bench:wasm`

Load measurement (2 / 4 / 6 publishers + Go Live):

```bash
bun run measure
E2E=1 bun run test:e2e   # Chrome joins, Go Live, MediaMTX audio is not silent
bun run test:e2e-ui      # studio UI flows (sign-in, guest on stage, layout, branding, destinations)
```

### Studio UI tests (e2e)

Playwright-based flows in `tests/studio/`, using the open-source [`e2e`](https://github.com/e2e-inc/e2e) runner. Locators and assertions only — no model, no API key. Chromium is launched with fake camera/mic flags.

```bash
cp .env.example .env
cp .dev.vars.example .dev.vars
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d
bun install
bunx --bun @e2e-dev/web install chromium   # once per machine
bun run test:e2e-ui
```

`test:e2e-ui` is `bunx --bun e2e run --strict-cache`. It starts `bun run dev` if nothing is on :5173 (`reuseExisting` locally). First-time Chromium install on Linux may need `bunx --bun @e2e-dev/web install chromium --with-deps`.

The Go Live → MediaMTX check (`E2E=1 bun run test:e2e`) is a separate release gate and is not replaced by this suite.

Coding agents can drive a running studio through the e2e MCP server (`.cursor/mcp.json`). See `AGENTS.md`.

### Docker Desktop (macOS / Windows)

Host networking is Linux-only. On Docker Desktop, drop `network_mode: host`, publish `127.0.0.1:7880-7882`, `127.0.0.1:1935`, `127.0.0.1:8888`, `127.0.0.1:6379`, `127.0.0.1:9090`, set LiveKit `rtc.node_ip` to `host.docker.internal`, and point Egress `ws_url` / Redis at that host. ICE from a browser on the same machine is fiddly; Linux is the supported v0 path.

### Without cameras

The app falls back to a generated canvas+silent-audio track so a VM without `/dev/video0` still joins. Chrome can also be launched with `--use-fake-device-for-media-stream`.

## Self-host

1. LiveKit + Egress + Redis + an RTMP edge (MediaMTX, nginx-rtmp, or a real destination).
2. Worker + D1 + Durable Objects (`wrangler deploy`). Put `LIVEKIT_API_SECRET` and a dedicated `HOST_KEY_SECRET` in Worker secrets, never in git. Host keys fall back to the LiveKit secret if unset; set `HOST_KEY_SECRET` so rotating LiveKit keys does not lock existing studios.
3. Generate real API keys (`lk generate-keys`) and replace the local defaults in `infra/livekit.yaml` and `infra/egress.yaml`. Point LiveKit `webhook.urls` at `https://<worker>/api/livekit/webhook` so Egress crashes and RTMP drops are signed and applied.
4. Point destination URLs at real YouTube / LinkedIn / X ingest. Stream keys stay in Durable Object storage (not the repo, and not the guest/public API). `GET /api/studios/:id` and the WebSocket `state` frame return only a masked suffix (`rtmp://…/xxxx`) plus `hasKey`. Owners and co-hosts receive full URLs on a signed-in GET (session cookie). Generate real API keys (`lk generate-keys`); the Worker returns 503 if the published `devkey` is used with a non-loopback LiveKit URL. Sign-in is email magic link (console logger by default, or `MAIL_WEBHOOK_URL`) and optional GitHub OAuth. Set `PUBLIC_ORIGIN` to the public site URL (magic-link mail, co-host invites, GitHub callback). Behind a reverse proxy set `CASTHOP_TRUST_FORWARDED=1` so per-IP sign-in limits use the real client address; without it, every client shares the `local` bucket.
5. After a show, package the Egress MP4 for the replay viewer:

```bash
cargo run -p casthop-post -- hls data/recordings/<file>.mp4 /tmp/replay-hls
```

Then `POST /api/studios/:id/replays` as the owner (JSON files: `index.m3u8`, `init.mp4`, `seg*.m4s`). Private replays stay on the studio list for owner/co-hosts. `PATCH` visibility to `public` and share `/watch/:id` — HLS is served from R2, not Stream.

The local compose file is the media plane. The Worker is the control plane. They talk over the LiveKit Twirp API.

## Website

The marketing site and docs live in [`site/`](site/) (Astro, Bun). Run `cd site && bun install && bun run dev`.

## License

[AGPL-3.0-only](LICENSE). The server is the product. Hosted forks must share their changes. A client SDK, if we split one out, could be Apache-2.0 later without weakening the server copyleft.

`crates/vendor/nnnoiseless` is [BSD-3-Clause](crates/vendor/nnnoiseless/COPYING) (Xiph RNNoise via [nnnoiseless](https://github.com/jneem/nnnoiseless)).

Background blur vendors Google’s [MediaPipe Selfie Segmenter](https://github.com/google-ai-edge/mediapipe) landscape float16 model ([Apache-2.0](src/vendor/mediapipe/LICENSE)). Compatible with this repo’s AGPL-3.0-only license; the model stays Apache-2.0. `@mediapipe/tasks-vision` and its WASM runtime load only when blur is on, from this origin (no CDN).

## Roadmap

Done in this prototype: custom compositor page with WASM layout, RNNoise in an AudioWorklet, `casthop-post` for recordings, measurements vs JS.

1. Camera background blur ships. WebGPU compositor is in `casthop-media` behind `?compose=webgpu`; Canvas2D stays the live default (see MEASUREMENTS.md).
2. workers-rs for hot `/api` endpoints.
3. Destination chat ingest (YouTube liveChat, LinkedIn, X).
4. ~~R2 replay viewer; HLS from R2 instead of Stream for public VODs.~~ Recordings show on the studio list; private replays are owner/co-host only, public ones play from `/watch/:id` as HLS on R2.
5. ~~Auth (email) and studio list~~ — accounts, magic link, optional GitHub, owner/co-host sessions.
6. TURN for guests behind strict NAT.
7. Decide Stream Live vs Egress fan-out with production numbers.

Numbers from this prototype are in [MEASUREMENTS.md](MEASUREMENTS.md).
