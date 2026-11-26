# Measurements

Prototype run on a 4 vCPU / 15 GB Linux VM, 2026-11-25. LiveKit, Egress, Redis, and MediaMTX on Docker host networking. App via `bun run dev` (Cloudflare Worker locally). Publishers: Chrome fake camera, canvas fallback, and `lk room join --publish-demo`.

Estimates are marked **(estimate)**. Direct observations are not.

## Method

1. **On-stage glass-to-glass.** Canvas flash (white 180 ms every 2.5 s) published through LiveKit, read back from the subscribed video element. Delay = `performance.now()` at flash minus first frame whose luma &gt; 180. Page: `/internal/probe`.
2. **RTMP delay.** Time from Go Live until Egress logs `pipeline playing` and `stream started`, plus `ffprobe` on `rtmp://127.0.0.1:1935/live/youtube`. MediaMTX HLS (`/live/youtube/index.m3u8`) 404s on this image, so HLS is **not** the proof path.
3. **CPU / memory.** `docker stats` after ~45 s of live composite. Egress also reports `avgCPU` / `maxCPU` in its own metrics.
4. **WASM vs JS.** `bun run bench:wasm` (Bun, same algorithms) and Chrome `/internal/bench`. Denoise: RNNoise (nnnoiseless) vs a JS DC-remove + gate. Compose: WASM nearest-neighbor blit vs the same blit in JS. Canvas2D/WebGPU use the GPU and are a different class of work.

Cost unit prices are from the attached OpenStudio model (2026-11-24): Stream delivery $1/1,000 min, Realtime SFU $0.05/GB, R2 $0.015/GB-month, Containers compositor **(model estimate)** $0.45/h + N×0.675 GB×$0.05.

## 1. Delay

| Path | Result | Notes |
|---|---|---|
| On-stage glass-to-glass (loopback flash) | **p50 45 ms**, last 61 ms (n=4) | `/internal/probe`, same-machine LiveKit. WAN guests add RTT. |
| Subscriber jitter buffer (getStats) | included in the 45 ms hop **(not split out)** | Probe measures encode + SFU + decode + jitter. |
| Go Live → START_RECORDING | **~0.3 s** after Chrome init (~0.8 s after API) | Custom template logs immediately. |
| Go Live → pipeline playing / RTMP started | **~1.9–3 s** | 2026-11-25T13:20 run: `timeToPlaying` 1.945 s; three RTMP URLs `stream started`. |
| Program → RTMP playhead | **~2 s ingest** (ffprobe sees h264 1280×720 + aac) | YouTube CDN would add more. HLS stand-in 404s on MediaMTX 1.21 in this compose. |

## 2. CPU and bandwidth

Docker `NetIO` is 0B because of host networking; bitrates below are from file size / duration and ffprobe.

| On stage | Browser CPU / client | LiveKit CPU | Egress CPU | RAM (egress) | Observed bitrate |
|---|---|---|---|---|---|
| 2 | Denoise WASM **~0.9% of one core** at 48 kHz (0.088 ms / 10 ms frame). Studio UI not separately sampled. | 2.44% of 4 vCPU, 69 MiB | 32.63%, 442 MiB | 442 MiB | Egress MP4 14.5 s, 5.2 MB → **2.96 Mbps** |
| 4 | same denoise (per publisher) | 3.08%, 78 MiB | 24.99%, 443 MiB | 443 MiB | same encode preset (H264 720p30) |
| 6 | same denoise | 0.89–3.60%, ~59 MiB | 25.56–26.24%, 428–515 MiB | 428–515 MiB | MediaMTX fMP4 ~30 MB / 81.6 s / dest → **~3.0 Mbps**. Egress metrics: avgCPU 0.28, maxCPU 1.14, maxMemory 1.70 GB. |

Egress CPU per live hour ≈ 0.26–0.33 × 4 vCPU ≈ **1.0–1.3 vCPU** during the live window. It does **not** climb much from 2 → 6 on stage; the compositor Chrome is the floor.

## 3. Cost per live hour

Model assumptions we **do not** reuse blindly: 1.5 Mbps per guest, N×(N−1) full-quality links, Stream simulcast as delivery minutes. This prototype uses **simulcast + dynacast** (guests get h180/h360; Egress wants the high layer) and **Egress fan-out** (one transcode, N RTMP URLs) instead of Stream Live.

Self-host destination bandwidth is free on this box. Cloudflare Realtime $0.05/GB would apply if the SFU were Cloudflare Calls.

| Line | 3 on stage, 3 dest | 6 on stage, 3 dest | vs model |
|---|---|---|---|
| SFU egress (Realtime $0.05/GB) | **$0.05/h (estimate)** — ~0.4 Mbps × 3×2 links ≈ 1.1 GB/h | **$0.27/h (estimate)** — ~0.4 Mbps × 6×5 ≈ 5.4 GB/h | Model used 0.675 GB × N(N−1): $0.20 / $1.01. Simulcast + dynacast should beat that if guests stay on low layers. |
| Compositor (measured Egress CPU × container price) | **$0.45/h reserved** / **$0.12/h CPU-proportional (estimate)** | same (CPU did not scale with N) | Model guessed $0.45/h + full-quality feeds to compositor. Observed ~26% of a 4 vCPU box. |
| Destinations | **$0** self-host RTMP; Stream would be 3×60 min × $0.001 = **$0.18** | same $0.18 if Stream | We did not use Stream. |
| Recording archive (~1.35 GB/h at 3 Mbps to R2) | **$0.020/h-month** stored | same | Model used 1.8 GB/h → $0.027. |
| **Total live hour (self-host media plane, CF control plane)** | **~$0.17–0.52** | **~$0.39–0.74** | Range is CPU-proportional vs reserved compositor instance. |
| **Total live hour (if Stream used for fan-out)** | add **$0.18** | add **$0.18** | |

Workers / D1 / DO stay inside the $5 account floor at this volume **(estimate, matches model)**.

## 4. Rust / WASM vs JS

Bundle: `src/wasm/casthop_media.wasm` is **382.8 KiB** (392,038 bytes), zero imports, loads in AudioWorklets and Workers. The WebGPU compositor is a second module, `casthop_gpu_bg.wasm` **32.7 KiB** (33,532 bytes) plus `casthop_gpu.js` **29.1 KiB**, loaded only when `?compose=webgpu`. Chrome `/internal/bench` and Bun `bun run bench:wasm` agree. The selfie-segmenter model (245 KiB, Apache-2.0) and MediaPipe vision WASM load only when blur is on.

| Path | WASM | JS | JS/WASM | What this actually compares |
|---|---|---|---|---|
| Denoise, 10 ms / 480 samples @ 48 kHz | **0.084–0.088 ms/frame** (Node CPU 742 ms / 8000 frames) | **0.003 ms/frame** (cheap gate) | **0.03×** | RNNoise GRU vs a few arithmetic ops. WASM is slower and **under budget** (10 ms). The gain is quality, not cycles. |
| Denoise CPU % of one core @ realtime | **~0.9%** | **~0.03%** | — | Both fine on the publish path. |
| Compose 1280×720, 4 tiles, nearest blit | **5.39–5.45 ms/frame** | **4.11–4.73 ms/frame** | **0.76–0.87×** | Same algorithm. V8 wins slightly; both are ~30–45 fps CPU. Production egress uses **Canvas2D + WASM layout** (GPU `drawImage`). |
| Background blur 1280×720 (mask 256×144, box-blur + mix) | **14.16 ms/frame** | **14.08 ms/frame** | **0.99×** | Same algorithm. Both under 33 ms (30 fps). CPU 14.2 vs 14.5 ms/frame; WASM default, `?fx=js` for the fallback. Segmentation is MediaPipe (lazy), not in this number. |
| WebGPU | `navigator.gpu` **present** in this Chrome | — | — | Default live path is **Canvas2D**. Rust WebGPU is `?compose=webgpu`; TS WebGPU is `?compose=webgpu-ts`. See the compose table below. |

Compose 1280×720, Chrome 157 headless + SwiftShader, `/internal/bench`, 30 frames after one warmup, reused GPU device. Canvas2D times are JS `drawImage` submit, not GPU-synced.

| Tiles | Canvas2D | TS WebGPU | Rust WebGPU |
|---|---|---|---|
| 2 | **0.027 ms/frame** | 0.44 ms/frame | 0.26 ms/frame |
| 4 | **0.020 ms/frame** | failed (`copyExternalImageToTexture` on this SwiftShader) | 2.30 ms/frame |
| 6 | **0.023 ms/frame** | failed (same) | 3.05 ms/frame |

Rust WebGPU is **not** the live default. It does not beat Canvas2D on this bench. Use `?compose=webgpu` to force it. Device creation stays in JS: the `wgpu` crate’s `Adapter::request_device` fails on this Chrome (`A valid external Instance reference no longer exists`). Draw/layout run in Rust against the WebGPU API.

Takeaway: ship RNNoise in WASM because a JS gate is not the same filter. Do **not** put the CPU compositor on the live tab-capture path; keep it for overlays / Worker / measurement. Live Canvas2D compose runs in a dedicated Worker with OffscreenCanvas when WebCodecs is present (`?thread=main` to force the old path). Layout math from Rust is shared by Canvas2D and WebGPU. Camera blur mix is WASM by default (~14 ms/frame @ 720p, holds 30 fps); `?fx=js` is the same algorithm.

A second 9:16 output is another Egress Chrome + Canvas2D at 720×1280 (same pixel count as 1280×720). Guests still publish once. No extra WASM on the guest path; portrait layout is the same `casthop_layout` fill (mode 4). Dual output was not re-benched on this machine — expect roughly two compositor Chromes when any destination is 9:16.

## 7. Off-main-thread compose (this PR)

`/internal/perf`, 6 canvas tiles + banner overlay, 30 s after warmup. Local Chrome 157 `--disable-gpu` compared `?thread=main` vs Worker. CI runs both paths on the same runner.

The worker is **30 fps on purpose** (one compose per program frame, `captureStream(30)`). Main is ~60 fps rAF. ~900 vs ~1800 frames in 30 s is not a drop. Worker-vs-main **p95** is a bad CI gate: the loops differ (VideoFrame @ 30 fps vs `<video>` @ 60 fps rAF) and GHA ratios swing 0.8–1.6× with no code change, including 13.6 vs 8.6 while still holding 902 frames and 0 drops. CI gates worker **p50 vs main** (15% or 5 ms; VideoFrame tax is 2–3 ms, fast GHA boxes hit ~4 ms), worker **p95 vs the 33 ms 30 fps slot**, frames in 30 fps ±15%, dropped frames, and long tasks. p95 vs main stays in the table as info.

| | Main thread (local) | Worker (local) |
|---|---|---|
| Compose p50 | **5.40 ms** | 7.60 ms |
| Compose p95 | **7.20 ms** | 11.60 ms |
| Produced frames | 1800 (~60 fps rAF) | 901 (~30 fps) |
| Dropped | 0 | 0 |
| Long tasks | 0 ms | **0 ms** |
| Input latency p95 (Tap while composing) | 17.72 ms | **15.81 ms** |

GHA headless `--disable-gpu` (Chrome 158): worker 902–911 frames, 0 dropped. Main p95 7.7–17 ms. Worker p95 9.0–15.5 ms, once 13.6 vs main 8.6 on a fast box. Fast runners: worker p50 ~2–4.3 ms slower (11.70 vs 7.55, 11.30 vs 7.00). Slow runners: worker p95 can beat main because main picks up long tasks.

Compose is no longer on the UI thread. The worker paints the OffscreenCanvas once per 30 fps output frame; `captureStream(30)` samples that same frame for the program track. No second compose for preview. `tests/perf-baseline.json` is the local snapshot from this machine; CI does not loosen it. Force main with `?thread=main`.

## 5. What broke, what’s hard, what next

What broke / was hard:

- Default LiveKit room-composite Chrome template aborted (`END_RECORDING` / Start signal not received). Custom `/egress-template` that logs `START_RECORDING` immediately is the reliable path.
- Egress RTMP URLs must be `rtmp://host:1935/live/<key>`, not `rtmp://host:1935/<key>`.
- Default Egress output dir is uid 1001; `data/recordings` needs to be writable (`chmod 777` locally).
- MediaMTX 1.21 HLS index 404s even while RTMP is up. Proof is `ffprobe` on the RTMP URL + the Egress MP4.
- Host Docker networking is the Linux ICE story; Docker Desktop needs a different compose.
- Latest `nnnoiseless` / `wasm-pack` on crates.io want edition 2024. This repo vendors nnnoiseless 0.5.1 (BSD-3) and builds with `wasm-bindgen-cli` 0.2.100 + rustc 1.100.
- `lk --no-subscribe` is not a flag on livekit-cli 2.20 (default is already no auto-subscribe).

What next (called out by the product-owner Rust/WASM direction, not done in v0):

- Audio **VAD-driven** UI (worklet already posts VAD; studio chrome doesn’t show it yet).
- Dedicated Rust **RTMP fan-out** if we leave Cloudflare Stream unused in production (`casthop-post` is inspect/remux only).
- R2 replay viewer, TURN. YouTube Live chat ingest ships (poll while live; pin overlay). X and LinkedIn comments are not wired.

Camera background blur ships: WASM mix + lazy MediaPipe selfie segmenter (toggle in the studio; `?fx=js` for the JS mix). Rust WebGPU compositor ships behind `?compose=webgpu`; Canvas2D stays the live default and runs in a Worker when `OffscreenCanvas` + `MediaStreamTrackProcessor` are present.

## 6. Silent-audio check (H3)

Egress captures the compositor tab. Audio tracks must be attached unmuted on `/egress-template` or the AAC stream is digital silence. `ffprobe` showing an AAC track is not enough.

```bash
bash scripts/check-silent-audio.sh data/recordings/<file>.mp4
```

That runs `ffmpeg -af volumedetect` and fails if `mean_volume` is at or below −90 dB (typical of a silent AAC track). The 2026-11-25 recordings were captured before the template attached audio; re-run after this fix and store the volumedetect lines under `data/measure/silent-audio.txt`.

CI asserts the template source attaches audio (`el.muted = false` on `Track.Kind.Audio`) so a regression cannot drop the attach path without failing `bun test`.

Raw command output from `bun run measure` / `bun run bench:wasm` / `bun run bench:worker` is stored under `data/measure/` (gitignored).

## 8. workers-rs vs TypeScript (hot `/api`)

Roadmap item 2. wrangler 4.168 on this VM, 2026-11-25. Isolated JWT Workers (`scripts/worker-bench` vs `crates/casthop-hot`) plus the live Hono Worker (`wrangler dev --assets dist/client`). Repeat with `bun run bench:worker` (Node fetch; Bun cannot reach miniflare — oven-sh/bun#39247).

Hot routes (called per guest join, compositor poll, or LiveKit event):

| Route | When | Work |
|---|---|---|
| `POST /api/studios/:id/token` | guest join + host refresh | rate limit (D1) + session + DO join + HS256 JWT |
| `GET /api/studios/:id` | studio chrome + compositor ~1s | session + DO snapshot |
| `POST /api/studios/:id/egress-beat` | compositor ~1s while live | participant JWT + DO |
| `POST /api/livekit/webhook` | LiveKit / Egress events | webhook JWT + SHA-256 + DO |
| `POST /api/studios/:id/live` | Go Live / stop | host session + DO + Egress HTTP |

CPU on those paths is WebCrypto HMAC-SHA256. The rest is D1 / Durable Object I/O.

Isolated JWT CPU (n=2000 in-isolate) and Worker RTT (n=200, warm=50):

| Metric | TS Worker | workers-rs | Notes |
|---|---|---|---|
| JWT mint | **15.5 µs/op** | 13.0 µs/op | same HS256 claims as `worker/livekit.ts` |
| JWT verify | **11.0 µs/op** | 11.5 µs/op | TS WebCrypto slightly faster |
| webhook verify | 14.5 µs/op | **6.5 µs/op** | still microseconds |
| `/api/health` p50 / p95 | **1.563 / 2.304 ms** | 1.735 / 2.587 ms | loopback RTT |
| wrangler Ready | **1049 ms** | 2027 ms | first listen |
| bundle | **178 KiB** (`dist/casthop/index.js`, whole Hono app) | 482 KiB (wasm + shim, JWT-only) | workers-rs ~3× larger for less code |

JWTs cross-verify (TS mint ↔ Rust verify and the reverse). Unsigned webhook is 401 on both.

Live Hono Worker (same box, n=10 token/live because `TOKEN_MINT_MAX` is 20/studio/min; other routes n=40):

| Route | p50 | p95 |
|---|---|---|
| `GET /api/health` | 3.487 ms | 4.357 ms |
| `GET /api/config` | 2.713 ms | 3.618 ms |
| `POST /api/studios/:id/token` | 6.714 ms | 9.169 ms |
| `GET /api/studios/:id` | 5.562 ms | 6.801 ms |
| `POST /api/studios/:id/live` (stop) | 7.290 ms | 8.759 ms |
| `POST /api/studios/:id/egress-beat` | 3.902 ms | 5.201 ms |
| `POST /api/livekit/webhook` | 4.378 ms | 5.276 ms |

All under the **< 10 ms Worker HTTP glue** budget. JWT is tens of microseconds; the request is D1/DO. workers-rs does not win on CPU that matters, cold start, or bundle size, and a second Worker would duplicate auth. **Keep the live routes in Hono/TypeScript.** `crates/casthop-hot` is the comparison harness, not the live path.
