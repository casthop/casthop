# Changelog

User-facing changes. This project has no tagged releases yet; everything below is **Unreleased**.

## [Unreleased]

Working browser live studio (v0). Control plane is a Cloudflare Worker with Durable Objects and D1. Media plane is LiveKit + Egress + Redis + MediaMTX.

### Added

- Optional hosted-mode hooks for a separate control plane, all off unless their env var is set: a tenant id on studios with a `t/<tenant>/` R2 prefix, a signed sign-in handoff (`/api/auth/external`), `CASTHOP_SIGNIN=external` to turn off magic-link and GitHub sign-in, and a signed `/api/service/*` API to create, list and delete studios and tenants.
- Host studio in the browser: stage, layouts (solo, side by side, screen + cams), screen share, lower-third banner, mic/camera, guest invite.
- Guest join from a link with no account. Up to six people on stage; others wait backstage.
- Accounts: email magic link, optional GitHub OAuth, owner and co-host sessions. Auth matrix for Worker routes.
- RTMP multistream via LiveKit Egress (one transcode, several URLs). Local MediaMTX stand-ins for YouTube, LinkedIn, and X; custom `rtmp:` destinations. Per-destination status and crash retry with backoff.
- Dual output: each destination can take the 16:9 program or a second 9:16 composite (stacked cameras, captions band) from the same studio. Vertical dests get their own Egress encode.
- Egress MP4 recording of the composite.
- While live, a Clip button (and C) saves the last 30 or 60 seconds from the program HLS buffer. Clips list next to replays on the home studio list with download links, and follow the same private/public rules.
- Studio chat in the room. Optional YouTube Live chat ingest while live (`liveChatMessages.list`); hosts can pin a comment onto the compositor overlay. X and LinkedIn comments are not wired.
- Twitch and Kick chat in the same panel while live. Set `TWITCH_CHANNEL` and/or `KICK_CHATROOM_ID`; unset hides them. X chat is not supported yet because X has no free chat API.
- Camera background blur (MediaPipe Selfie Segmenter, on-device, lazy load).
- Rust/WASM RNNoise in an AudioWorklet; WASM layout; Canvas2D compositor as the live default.
- Off-thread program compose (Worker + OffscreenCanvas) when WebCodecs is present.
- Optional compose backends: `?compose=wasm` (CPU), `?compose=webgpu` (Rust), `?compose=webgpu-ts` (TypeScript). Not the live default.
- Chrome compositor perf gate in CI (`PERF=1 bun run test:perf`).
- Studio UI e2e flows and a Go Live → MediaMTX silent-audio release gate.
- Astro marketing site and docs in `site/`.
- `casthop-post` CLI to inspect / remux recordings.
- Studio and marketing site in English, Português (pt-BR), Español, Français, Deutsch, and 日本語. Browser language on first visit, then a dropdown to switch. English is the fallback.
- Separate recordings: each host and guest on stage keeps their own audio/video in the browser, uploaded in chunks during the show, listed next to the mixed MP4 for download.

### Fixed

- The studio list and sign-in look up memberships by account and invites by email through new indexes instead of reading every row in the deployment.
- Clips are always cut from the 16:9 program. A 9:16 destination no longer writes the clip buffer, so clips stop coming out 720x1280.
- Go live with a 9:16 destination no longer starts the portrait compositor several times in a few seconds. It now gets the same start grace as 16:9, only one portrait start or restart runs at a time, and a restart stops any leftover portrait compositor so two never publish to the same RTMP URL.
- Kick chat was broken after Kick left Pusher. It now uses Kick's public Centrifugo feed and reconnects with a fresh guest token when the old one expires.
- Opening `/studio/:id` as a signed-in co-host invitee now shows the Accept prompt, as the invite email says. It used to show only the guest gate. After accepting, the studio opens as a co-host. Accepting from the guest join page still works.
- The header no longer says Live when every destination has failed to connect. A failed stream no longer counts as output, even with a start time, so the header stays Starting while destinations retry and turns to Live failed once they all fail.
- A studio whose Go live failed stops polling YouTube chat and closes Twitch and Kick chat until a host presses Retry or End. It used to keep calling YouTube every few seconds, even after everyone left.
- Go live while End is still stopping the stream now gets "still stopping" instead of starting a compositor the stop never sees. End also stops any compositor the studio recorded while it was stopping, so nothing keeps streaming while the studio shows Not live.
- The background egress check no longer undoes a host action that lands while it waits on LiveKit. Taking a guest off stage, turning off a destination, or stopping the stream used to be reverted, and a stopped stream could restart.
- 9:16 destinations need a custom Egress template; overlapping starts share one portrait compositor. An already-enabled 9:16 row still saves if the template is later unset.
- 9:16 start and crash retries follow the same recovery budget as 16:9. A compositor that never beats is timed out.
- Studio tiles attach camera video when the track arrives after the first render.
- Adding a guest to stage before they connect applies once they join LiveKit. Permission errors show in the studio.
- Marketing site header on phones: Docs and GitHub move into a menu, the language switcher shows a short code, and the page no longer scrolls sideways.
- Opening the docs language menu closes the header menu, so the two panels do not stack on phones.

### Changed

- Docs rewritten for new users: step-by-step quick start with expected results, troubleshooting, plain-word configuration with when to change each setting, and self-hosting steps for D1, R2, build and deploy.
- Host studio UI matches the approved dark booth: Geist, a right icon rail, Go live in the top bar, and destination switches in the Go live dialog.
- JS toolchain is Bun (not npm). Vite 8, TypeScript 7, React 19.
- Live pill is `live` only when Egress output is flowing (bytes/duration, or a short settle after RTMP has had time to publish). Starting is shown until then.
- Hot Worker `/api` stays TypeScript after a workers-rs JWT CPU bench did not win.

### Security

- Stream keys and full destination URLs are withheld from guests and public GET / WebSocket state.
- Published LiveKit `devkey` is refused unless LiveKit is loopback.
- Two uploads to the same ISO chunk can no longer store bytes the per-track and per-session caps never counted. The first upload reserves the chunk; a second one gets a retryable 429 until it lands.
- A guest's publish token lasts 10 minutes instead of 6 hours (the studio renews it before it expires and on reconnect, for guests as well as hosts), and when someone joins the LiveKit room the studio re-applies its own decision: a removed co-host or guest is removed again, and a guest who is not on stage loses publish permission.
- YouTube chat ingest runs only for the studio(s) in the new `YOUTUBE_CHAT_STUDIO_ID`. The YouTube credentials and chat id are deployment-wide, and every account's live studio used to poll them and show that chat. If you use YouTube chat, set this to your studio id.
- Local development is now the explicit `CASTHOP_DEV=1` (in `.dev.vars.example`), not "the LiveKit key is the published one". It turns on the terminal sign-in links and is refused unless LiveKit and `PUBLIC_ORIGIN` are on loopback. **Existing local setups:** add `CASTHOP_DEV=1` to `.dev.vars`, or sign-in mail fails with "no mail sender configured".
- The local MediaMTX HLS (:8888) and playback (:9996) servers allow no browser origin. MediaMTX allows every origin by default, so any page open in the developer's browser could read the live program and the recordings.
- CI rebuilds the committed `.wasm` files from the Rust source in `rust:1.100.0` and fails if the bytes differ, so the binaries every participant's browser runs match the reviewed source.
- The app encodes studio, replay, clip, track and account ids in API paths, and refuses `.` and `..` ids. A crafted link (for example an egress template token whose room is `../auth/logout?x=`) could make the page call other API routes with the visitor's cookie.
- A studio refuses socket upgrades when it does not exist and caps open sockets at 256; every state write goes to each socket. Chat text and names drop control characters, which were invisible but six bytes each in every broadcast.
- Cookie-authenticated POST, PUT, PATCH and DELETE requests under `/api` are refused when the browser says they come from another origin, including a sibling subdomain or the `http://` version of the site, which SameSite=Lax does not cover.
- RTMP destinations are refused when the host is an internal address in any spelling (IPv4-mapped IPv6, NAT64, decimal, hex, octal or shortened IPv4), a multicast or special-use range, a single-label name, or a name under `.localhost`, `.local`, `.internal`, `.home.arpa`, `.localdomain` or `.lan`.
- ISO chunk uploads need a Content-Length of at most 8 MiB and are refused before the body is read. A streamed upload with no length used to be buffered in full first.
- Inviting a co-host gives the same answer whether or not the email has an account, and no longer returns that person's account id or name. Existing accounts get the invite mail and become co-hosts when they accept on the studio link or next sign in, not straight away. A co-host can leave a studio.
- Co-host invite mail is rate limited: 10 invites per inviting account and 2 per recipient across all studios every 15 minutes.
- Replay, clip and live playlists are checked against the tags casthop and ffmpeg write, and only `index.m3u8` may be a playlist. Lone CR line breaks, text after an `#EXTINF` duration, unquoted `URI=`, interstitials and nested playlists used to get past the check and make viewers' players fetch outside URLs.
- The magic-link response includes the dev sign-in link only when `CASTHOP_DEV_LOGIN=1` is set. Under `bun run dev` the Host header and client IP the old check used are controlled by the client. CI sets the flag; set it in `.dev.vars` to run e2e or `bun run measure` locally.
- One network can no longer take a studio's whole guest join budget or all 64 guest slots. Each network (an IPv4 address or an IPv6 /64) gets up to 10 new guests a minute and 16 slots, and a full studio frees guests who have not been in the room for a minute.
- `bun run dev` listens on `127.0.0.1` only, not every interface. Miniflare's data explorer is off unless you set `X_LOCAL_EXPLORER=true`, and the dev server no longer serves files under `data/`.
- New studios copy `RTMP_YOUTUBE`, `RTMP_LINKEDIN` and `RTMP_X` only when they are loopback stand-ins. A real ingest URL there used to reach every account that created a studio. Studios created earlier keep what they copied; if you set real keys there, rotate them.
- `GET /api/studios/:id/ws` only upgrades to the state socket. It used to pass the caller's query string to the studio, so a signed-out caller could run internal actions such as `watch`. The studio now refuses any action that is not a POST or PUT from the Worker.
- Only the host, co-hosts and guests on stage can start a per-person (ISO) recording. Guests waiting off stage used to be able to fill the session's track slots and push earlier recordings out of storage.
