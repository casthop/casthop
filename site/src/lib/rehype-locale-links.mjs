function localeFromPath(path = "") {
  const normalized = String(path).replaceAll("\\", "/");
  const match = normalized.match(/content\/docs\/([^/]+)\//);
  const locale = match?.[1];
  if (locale && locale !== "en") return locale;
  return "en";
}

function localize(href, locale) {
  if (typeof href !== "string") return href;
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  if (locale === "en") return href;
  if (href === "/") return `/${locale}/`;
  return `/${locale}${href}`;
}

function visit(node, locale) {
  if (node.type === "element" && node.tagName === "a") {
    const href = node.properties?.href;
    if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
      node.properties.href = localize(href, locale);
    }
  }
  node.children?.forEach((child) => visit(child, locale));
}

export function rehypeLocaleLinks() {
  return (tree, file) => {
    const path = file?.path || file?.history?.[0] || "";
    visit(tree, localeFromPath(path));
  };
}
