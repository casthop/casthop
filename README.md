# Casthop

[![CI](https://github.com/casthop/casthop/actions/workflows/ci.yml/badge.svg)](https://github.com/casthop/casthop/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/github/license/casthop/casthop)](LICENSE)

Casthop is an open-source live studio that runs in the browser, and you can run it yourself. You sign in as the host, send guests a link, put up to six people on stage, and stream one mixed video to several sites at once. The show is recorded.

![The Casthop host studio: a dark booth with a two-person stage, backstage guest, and a white Go live button.](docs/screenshots/studio.png)

## What it does

- **Guests join from a link.** No account, no install. They wait backstage until you bring them on. Up to six people on stage.
- **Co-hosts.** Invite someone by email. They become a co-host once they accept.
- **Layouts.** Solo, side by side, and screen plus cameras. Screen share, lower-third banner, background blur and noise suppression, all on the device.
- **Stream to several sites at once.** One mix goes to every RTMP address you add, each with its own status. If a stream drops, it retries on its own.
- **Wide and vertical together.** Each destination can take 16:9 or a stacked 9:16 version for Shorts, Reels or TikTok.
- **Recording, replays and clips.** The mixed show is saved as an MP4. Publish it as a private or public replay. While live, Clip saves the last 30 or 60 seconds.
- **Per-person tracks.** Turn on Separate recordings and each person on stage records their own audio and video in their browser.
- **Chat.** Studio chat, plus YouTube, Twitch and Kick comments while live. Pin one onto the video.

Not done yet: TURN for guests on strict networks, X and LinkedIn chat, and live captions.

How it is built: LiveKit, Egress, Redis and an RTMP server for media, and a Cloudflare Worker with Durable Objects and D1 for the app. The audio and video hot paths are Rust compiled to WebAssembly. See [Architecture](site/src/content/docs/en/architecture.mdx).

## Quick start

You need Linux with Docker, and [Bun](https://bun.com) 1.4.5 or newer. Do not use npm.

```bash
git clone https://github.com/casthop/casthop.git && cd casthop
cp .env.example .env
cp .dev.vars.example .dev.vars
mkdir -p data/recordings data/rtmp && chmod 777 data/recordings
docker compose up -d       # starts LiveKit, Egress, Redis and MediaMTX
bun install
bun run dev                # prints Local: http://127.0.0.1:5173/
```

Check it: `curl http://127.0.0.1:5173/api/health` should print `{"ok":true,"livekit":{"ok":true},"maxOnStage":6}`.

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173) and enter your email. No mail is sent locally: the sign-in link is printed in the `bun run dev` terminal. Open a studio, copy the guest link, bring people on stage and press **Go live**. The default destinations are local test servers, so nothing goes public.

Step by step, with expected results and troubleshooting: [Getting started](site/src/content/docs/en/getting-started.mdx). Every setting: [Configuration](site/src/content/docs/en/configuration.mdx).

## Self-hosting

Run the media servers on your own machine, then deploy the app with `bun run build && bunx wrangler deploy`. Use your own LiveKit keys (`lk generate-keys`). The public `devkey` only works on `127.0.0.1`. See [Self-hosting](site/src/content/docs/en/self-hosting.mdx).

A hosted version of Casthop is coming. Self-hosting stays free.

## Languages

The studio and the site at [casthop.com](https://casthop.com) ship in English, Português (pt-BR), Español, Français, Deutsch, and 日本語. English is the source and the fallback. The first visit follows `navigator.languages`; after that the dropdown choice is stored in `localStorage` (`casthop.locale`).

To add a language: add the locale code in `src/i18n/locales.ts` and `site/src/i18n/locales.ts`, copy `src/i18n/en.ts` / `site/src/i18n/en.ts` into a new file and translate, lazy-load it from `src/i18n/load.ts`, add `site/src/content/docs/<locale>/` MDX, and keep the missing-key test in `tests/i18n.test.ts` green.

## Docs and site

The marketing site and docs are an Astro app in [`site/`](site/) (`cd site && bun install && bun run dev`), served at [casthop.com](https://casthop.com). Localized routes live at `/pt-BR/`, `/es/`, `/fr/`, `/de/`, `/ja/` (English at `/`). Recorded numbers live in [MEASUREMENTS.md](MEASUREMENTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Issues labeled [`good first issue`](https://github.com/casthop/casthop/labels/good%20first%20issue) or [`help wanted`](https://github.com/casthop/casthop/labels/help%20wanted) are a good place to start.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/casthop/casthop/security/advisories/new).

## License

[AGPL-3.0-only](LICENSE). The server is the product. Hosted forks must share their changes.

`crates/vendor/nnnoiseless` is [BSD-3-Clause](crates/vendor/nnnoiseless/COPYING) (Xiph RNNoise via [nnnoiseless](https://github.com/jneem/nnnoiseless)).

Background blur vendors Google’s [MediaPipe Selfie Segmenter](https://github.com/google-ai-edge/mediapipe) landscape float16 model ([Apache-2.0](src/vendor/mediapipe/LICENSE)). Compatible with this repo’s AGPL-3.0-only license; the model stays Apache-2.0. `@mediapipe/tasks-vision` and its WASM runtime load only when blur is on, from this origin (no CDN).
