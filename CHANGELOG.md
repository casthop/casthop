# Changelog

User-facing changes. This project has no tagged releases yet; everything below is **Unreleased**.

## [Unreleased]

Working browser live studio (v0). Control plane is a Cloudflare Worker with Durable Objects and D1. Media plane is LiveKit + Egress + Redis + MediaMTX.

### Added

- Host studio in the browser: stage, layouts (solo, side by side, screen + cams), screen share, lower-third banner, mic/camera, guest invite.
- Guest join from a link with no account. Up to six people on stage; others wait backstage.
- Accounts: email magic link, optional GitHub OAuth, owner and co-host sessions. Auth matrix for Worker routes.
- RTMP multistream via LiveKit Egress (one transcode, several URLs). Local MediaMTX stand-ins for YouTube, LinkedIn, and X; custom `rtmp:` destinations. Per-destination status and crash retry with backoff.
- Egress MP4 recording of the composite.
- Studio chat in the room. Optional YouTube Live chat ingest while live (`liveChatMessages.list`); hosts can pin a comment onto the compositor overlay. X and LinkedIn comments are not wired.
- Camera background blur (MediaPipe Selfie Segmenter, on-device, lazy load).
- Rust/WASM RNNoise in an AudioWorklet; WASM layout; Canvas2D compositor as the live default.
- Off-thread program compose (Worker + OffscreenCanvas) when WebCodecs is present.
- Optional compose backends: `?compose=wasm` (CPU), `?compose=webgpu` (Rust), `?compose=webgpu-ts` (TypeScript). Not the live default.
- Chrome compositor perf gate in CI (`PERF=1 bun run test:perf`).
- Studio UI e2e flows and a Go Live → MediaMTX silent-audio release gate.
- Astro marketing site and docs in `site/`.
- `casthop-post` CLI to inspect / remux recordings.
- Studio and marketing site in English, Português (pt-BR), Español, Français, Deutsch, and 日本語. Browser language on first visit, then a dropdown to switch. English is the fallback.

### Fixed

- Studio tiles attach camera video when the track arrives after the first render.
- Adding a guest to stage before they connect applies once they join LiveKit. Permission errors show in the studio.
- Marketing site header on phones: Docs and GitHub move into a menu, the language switcher shows a short code, and the page no longer scrolls sideways.

### Changed

- Host studio UI matches the approved dark booth: Geist, a right icon rail, Go live in the top bar, and destination switches in the Go live dialog.
- JS toolchain is Bun (not npm). Vite 8, TypeScript 7, React 19.
- Live pill is `live` only when Egress output is flowing (bytes/duration, or a short settle after RTMP has had time to publish). Starting is shown until then.
- Hot Worker `/api` stays TypeScript after a workers-rs JWT CPU bench did not win.

### Security

- Stream keys and full destination URLs are withheld from guests and public GET / WebSocket state.
- Published LiveKit `devkey` is refused unless LiveKit is loopback.
