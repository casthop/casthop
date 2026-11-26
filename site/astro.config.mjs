import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { rehypeExternal } from "./src/lib/rehype-external.mjs";
import { rehypeLocaleLinks } from "./src/lib/rehype-locale-links.mjs";

export default defineConfig({
  site: "https://casthop.com",
  integrations: [mdx()],
  markdown: {
    rehypePlugins: [rehypeExternal, rehypeLocaleLinks],
    shikiConfig: { theme: "github-dark-default" },
  },
  build: { format: "directory" },
});
