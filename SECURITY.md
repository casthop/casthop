# Security

## Supported versions

This repository has no tagged releases yet. Security fixes land on `main`. Self-hosters should track `main` (or a commit they have reviewed) rather than an unnamed snapshot.

## Reporting a vulnerability

Report privately through GitHub: **Security tab → Report a vulnerability**, or open

<https://github.com/casthop/casthop/security/advisories/new>

Do not file a public issue, pull request, or discussion for a vulnerability. Do not email a personal address.

Please include:

- What is affected (Worker route, studio Durable Object, LiveKit token, guest link, compositor page, …)
- Steps to reproduce, or a minimal proof
- Impact (who can do what they should not)

The Casthop maintainers will acknowledge the report and say whether it is in scope. There is no bug bounty.

## Scope

In scope:

- Auth and session handling (magic link, GitHub OAuth, owner / co-host / guest)
- Guest impersonation of host, leaked stream keys, unmasked destination URLs on public GET or WebSocket `state`
- Injection or SSRF via destination URLs, names, layout, or chat
- Secrets reaching the browser (`LIVEKIT_API_SECRET`, host keys, mail webhook tokens, YouTube API keys / OAuth refresh tokens)
- The published `devkey` being accepted against a non-loopback LiveKit URL

Out of scope unless you can show a Casthop-specific bug:

- LiveKit, Egress, Redis, MediaMTX, or Cloudflare platform issues with no Casthop involvement
- Denial of service against a self-hosted media plane
- Social engineering or physical access
- Reports that need a paid third-party account we do not run

## Self-host secrets

These never go in git, client bundles, or logs:

| Name | Where |
|---|---|
| `LIVEKIT_API_SECRET` | Worker secrets (`wrangler secret put`). Never sent to the browser. |
| `HOST_KEY_SECRET` | Worker secrets. HMAC for Worker→Durable Object host keys. Falls back to `LIVEKIT_API_SECRET` if unset; set it so rotating LiveKit keys does not lock existing studios. |
| Stream keys / full RTMP URLs | Durable Object storage. Guests and public GET / WebSocket state see a masked suffix plus `hasKey`. Owners and co-hosts get full URLs on a signed-in GET (session cookie). |
| `GITHUB_CLIENT_SECRET`, `MAIL_WEBHOOK_TOKEN` | Worker secrets, if you use those features. |
| `YOUTUBE_API_KEY`, `YOUTUBE_OAUTH_CLIENT_SECRET`, `YOUTUBE_OAUTH_REFRESH_TOKEN` | Worker secrets, if you ingest YouTube Live chat. The live chat id / page token cursor is not returned to guests. |

Local defaults in `.env.example` / `.dev.vars.example` (`devkey` / `casthop_dev_secret_…`) are public and loopback-only. The Worker returns 503 if that pair is used with a non-loopback LiveKit URL. Generate real keys with `lk generate-keys` before any networked deploy.

Copy `.dev.vars.example` to `.dev.vars` locally. `.dev.vars` and `.env` are gitignored. See [Configuration](site/src/content/docs/configuration.mdx).
