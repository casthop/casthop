// Open absolute links in a new tab, safely. Runs on Markdown/MDX output.
function visit(node) {
  if (node.type === "element" && node.tagName === "a") {
    const href = String(node.properties?.href ?? "");
    if (/^https?:\/\//.test(href)) {
      node.properties.target = "_blank";
      node.properties.rel = "noopener noreferrer";
    }
  }
  node.children?.forEach(visit);
}

export function rehypeExternal() {
  return (tree) => visit(tree);
}
