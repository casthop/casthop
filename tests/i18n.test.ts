import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { en, type Messages } from "../src/i18n/en.ts";
import { interpolate } from "../src/i18n/format.ts";
import { detectBrowserLocale, matchLocale } from "../src/i18n/locales.ts";
import de from "../src/i18n/locales/de.ts";
import es from "../src/i18n/locales/es.ts";
import fr from "../src/i18n/locales/fr.ts";
import ja from "../src/i18n/locales/ja.ts";
import ptBR from "../src/i18n/locales/pt-BR.ts";
import { en as siteEn } from "../site/src/i18n/en.ts";
import { siteCatalogs } from "../site/src/i18n/index.ts";
import { localeShortCode, withLocale } from "../site/src/i18n/locales.ts";

const studioCatalogs: Record<string, Messages> = {
  "pt-BR": ptBR,
  es,
  fr,
  de,
  ja,
};

function keysOf(obj: object): string[] {
  return Object.keys(obj).sort();
}

test("every studio locale has the same keys as English", () => {
  const expected = keysOf(en);
  for (const [locale, catalog] of Object.entries(studioCatalogs)) {
    assert.deepEqual(keysOf(catalog), expected, locale);
  }
});

test("every site locale has the same keys as English", () => {
  const expected = keysOf(siteEn);
  for (const [locale, catalog] of Object.entries(siteCatalogs)) {
    if (locale === "en") continue;
    assert.deepEqual(keysOf(catalog), expected, locale);
  }
});

test("matchLocale maps browser tags", () => {
  assert.equal(matchLocale("pt-BR"), "pt-BR");
  assert.equal(matchLocale("pt-PT"), "pt-BR");
  assert.equal(matchLocale("es-MX"), "es");
  assert.equal(matchLocale("fr"), "fr");
  assert.equal(matchLocale("de-DE"), "de");
  assert.equal(matchLocale("ja-JP"), "ja");
  assert.equal(matchLocale("en-US"), "en");
  assert.equal(matchLocale("zh-CN"), null);
});

test("detectBrowserLocale walks navigator.languages and falls back to English", () => {
  assert.equal(detectBrowserLocale(["zh-CN", "pt-BR", "en"]), "pt-BR");
  assert.equal(detectBrowserLocale(["zh-CN"]), "en");
});

test("interpolate formats numbers with Intl", () => {
  assert.equal(interpolate("Go live on {count}", { count: 3 }, "en"), "Go live on 3");
  assert.equal(interpolate("{name}", { name: "Ada" }, "en"), "Ada");
});

test("site localeShortCode is a compact label", () => {
  assert.equal(localeShortCode("en"), "EN");
  assert.equal(localeShortCode("pt-BR"), "PT");
  assert.equal(localeShortCode("de"), "DE");
});

test("site withLocale prefixes non-English paths", () => {
  assert.equal(withLocale("en", "/docs/guests/"), "/docs/guests/");
  assert.equal(withLocale("pt-BR", "/"), "/pt-BR/");
  assert.equal(withLocale("pt-BR", "/docs/guests/"), "/pt-BR/docs/guests/");
});

test("each locale has the same MDX docs as English", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../site/src/content/docs");
  const english = readdirSync(join(root, "en")).filter((f) => f.endsWith(".mdx")).sort();
  for (const locale of ["pt-BR", "es", "fr", "de", "ja"]) {
    const files = readdirSync(join(root, locale)).filter((f) => f.endsWith(".mdx")).sort();
    assert.deepEqual(files, english, locale);
  }
});
