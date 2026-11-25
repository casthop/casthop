# Casthop website and docs

Static Astro site: marketing home at `/` and MDX docs at `/docs/...`. Bun only.

```bash
cd site
bun install
bun run dev       # http://localhost:4321
bun run build     # static output in dist/
bun run preview   # serve dist/ locally
```

## Editing

- Docs live in `src/content/docs/*.mdx`. Frontmatter: `title`, `description`, `group`, `order`.
- The docs sidebar, "On this page" rail and Ctrl/Cmd-K search are built from those files. The search index is inlined in each docs page, so it works offline.
- Fonts (Instrument Serif, Geist) are self-hosted through `@fontsource`. No runtime requests to third parties.
- `public/studio.png` and `public/guest.png` are copies of `docs/screenshots/` in the repo root.

## Deploy

`dist/` is plain static files. On Cloudflare Pages (project name `casthop-site`, so it does not collide with the waitlist Worker named `casthop`):

```bash
bun run build
bunx wrangler pages deploy dist --project-name casthop-site
```

Build command `bun run build`, output directory `dist`, root directory `site`.
