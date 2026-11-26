import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const DOCS_DIR = join(import.meta.dirname, "../site/src/content/docs");
const DOC_SLUGS = [
  "getting-started.mdx",
  "guests.mdx",
  "self-hosting.mdx",
  "configuration.mdx",
  "destinations.mdx",
  "architecture.mdx",
] as const;
const DOC_GROUPS: Record<string, Record<(typeof DOC_SLUGS)[number], string>> = {
  en: {
    "getting-started.mdx": "Start",
    "guests.mdx": "Start",
    "self-hosting.mdx": "Operate",
    "configuration.mdx": "Operate",
    "destinations.mdx": "Operate",
    "architecture.mdx": "Concepts",
  },
  "pt-BR": {
    "getting-started.mdx": "Começar",
    "guests.mdx": "Começar",
    "self-hosting.mdx": "Operar",
    "configuration.mdx": "Operar",
    "destinations.mdx": "Operar",
    "architecture.mdx": "Conceitos",
  },
  es: {
    "getting-started.mdx": "Empezar",
    "guests.mdx": "Empezar",
    "self-hosting.mdx": "Operar",
    "configuration.mdx": "Operar",
    "destinations.mdx": "Operar",
    "architecture.mdx": "Conceptos",
  },
  fr: {
    "getting-started.mdx": "Démarrer",
    "guests.mdx": "Démarrer",
    "self-hosting.mdx": "Exploiter",
    "configuration.mdx": "Exploiter",
    "destinations.mdx": "Exploiter",
    "architecture.mdx": "Concepts",
  },
  de: {
    "getting-started.mdx": "Start",
    "guests.mdx": "Start",
    "self-hosting.mdx": "Betrieb",
    "configuration.mdx": "Betrieb",
    "destinations.mdx": "Betrieb",
    "architecture.mdx": "Konzepte",
  },
  ja: {
    "getting-started.mdx": "スタート",
    "guests.mdx": "スタート",
    "self-hosting.mdx": "運用",
    "configuration.mdx": "運用",
    "destinations.mdx": "運用",
    "architecture.mdx": "考え方",
  },
};

function fencesOf(src: string): string[] {
  return src.match(/```[\s\S]*?```/g) ?? [];
}

test("every site locale has the same docs as English, with matching fences and groups", () => {
  const enDir = existsSync(join(DOCS_DIR, "en", "getting-started.mdx"))
    ? join(DOCS_DIR, "en")
    : DOCS_DIR;
  const locales = Object.keys(DOC_GROUPS);
  for (const locale of locales) {
    const locDir = locale === "en" ? enDir : join(DOCS_DIR, locale);
    const names = readdirSync(locDir).filter((n) => n.endsWith(".mdx")).sort();
    assert.deepEqual(names, [...DOC_SLUGS].sort());
    for (const slug of DOC_SLUGS) {
      const src = readFileSync(join(locDir, slug), "utf8");
      const enSrc = readFileSync(join(enDir, slug), "utf8");
      const group = src.match(/^group:\s*(.+)$/m)?.[1]?.trim();
      assert.equal(group, DOC_GROUPS[locale][slug], `${locale}/${slug} group`);
      assert.match(src, /^---\ntitle: .+\ndescription: .+\ngroup: .+\norder: \d+\n---\n/m, `${locale}/${slug} frontmatter`);
      assert.deepEqual(fencesOf(src), fencesOf(enSrc), `${locale}/${slug} code fences`);
      assert.equal((src.match(/^## /gm) ?? []).length, (enSrc.match(/^## /gm) ?? []).length, `${locale}/${slug} headings`);
      const localePrefixed = src.match(/\]\(\/docs\/(?:en|pt-BR|es|fr|de|ja)\//g);
      assert.equal(localePrefixed, null, `${locale}/${slug} must keep /docs/… links unprefixed`);
      if (locale !== "en") {
        assert.notEqual(src, enSrc, `${locale}/${slug} must not be an English copy`);
        assert.ok(src.length > enSrc.length * 0.5, `${locale}/${slug} looks stubby`);
      }
    }
  }
});
