import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import { rehypeExternal } from "./src/lib/rehype-external.mjs";

export default defineConfig({
  integrations: [mdx()],
  markdown: {
    rehypePlugins: [rehypeExternal],
    shikiConfig: { theme: "github-dark-default" },
  },
  build: { format: "directory" },
});
