import { getCollection, type CollectionEntry } from "astro:content";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../i18n";

export type Doc = CollectionEntry<"docs">;

export function parseDocId(id: string): { locale: Locale; slug: string } {
  const slash = id.indexOf("/");
  if (slash === -1) return { locale: DEFAULT_LOCALE, slug: id };
  const head = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  return { locale: isLocale(head) ? head : DEFAULT_LOCALE, slug };
}

export async function docsFor(locale: Locale): Promise<Doc[]> {
  const docs = await getCollection("docs");
  const mine = docs.filter((d) => parseDocId(d.id).locale === locale);
  if (mine.length) return mine.sort((a, b) => a.data.order - b.data.order);
  return docs.filter((d) => parseDocId(d.id).locale === DEFAULT_LOCALE).sort((a, b) => a.data.order - b.data.order);
}

export async function sortedDocs(): Promise<Doc[]> {
  return docsFor(DEFAULT_LOCALE);
}

export function groupDocs(docs: Doc[]): { group: string; items: Doc[] }[] {
  const groups: { group: string; items: Doc[] }[] = [];
  for (const doc of docs) {
    const g = groups.find((x) => x.group === doc.data.group);
    if (g) g.items.push(doc);
    else groups.push({ group: doc.data.group, items: [doc] });
  }
  return groups;
}

export function plainText(body: string): string {
  return body
    .replace(/^import .*$/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
