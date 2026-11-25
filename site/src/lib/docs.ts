import { getCollection, type CollectionEntry } from "astro:content";

export type Doc = CollectionEntry<"docs">;

export async function sortedDocs(): Promise<Doc[]> {
  const docs = await getCollection("docs");
  return docs.sort((a, b) => a.data.order - b.data.order);
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

// Plain text for the offline search index. Drops code fences' markers and MDX syntax noise.
export function plainText(body: string): string {
  return body
    .replace(/^import .*$/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
