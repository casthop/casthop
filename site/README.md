# Casthop website and docs

Static Astro site: marketing home at `/` (and `/pt-BR/`, `/es/`, `/fr/`, `/de/`, `/ja/`) and MDX docs at `/docs/...`. Bun only. Production: [casthop.com](https://casthop.com).

```bash
cd site
bun install
bun run dev       # http://localhost:4321
bun run build     # static output in dist/
bun run preview   # serve dist/ locally
```

## Editing

- UI copy lives in `src/i18n/` (English is the source). Docs live in `src/content/docs/<locale>/*.mdx`. Frontmatter: `title`, `description`, `group`, `order`.
- The docs sidebar, "On this page" rail and Ctrl/Cmd-K search are built from those files. The search index is inlined in each docs page, so it works offline.
- Fonts (Instrument Serif, Geist) are self-hosted through `@fontsource`. The only third-party runtime request is the Cloudflare Web Analytics beacon (`WebAnalytics.astro`).
- `public/studio.png` and `public/guest.png` are copies of `docs/screenshots/` in the repo root.

## Deploy

`dist/` is plain static files. `site/wrangler.jsonc` is an assets-only Worker named `casthop-site` (so it does not collide with the studio Worker named `casthop`). Wrangler 4 reads JSONC in this directory; `pages_build_output_dir` is Pages-only and `wrangler deploy` rejects it.

```bash
bun run build
bunx wrangler deploy
```
