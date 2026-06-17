// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import rehypeBrand from "./src/lib/rehype-brand.mjs";

// The public URL. Feeds the sitemap and the canonical/OG tags. Point imprnt.dev
// at the Railway service, then this is the canonical home.
const SITE = "https://imprnt.dev";
const REPO = "https://github.com/aleksandr-bogdanov/imprnt";

// https://astro.build
export default defineConfig({
  site: SITE,
  integrations: [
    react(),
    // Docs are the single source of truth in site/docs/ (see src/content.config.ts).
    // The custom landing (src/pages/index.astro) owns "/", Starlight serves the
    // doc pages at their own slugs.
    starlight({
      title: "imprnt",
      description: "A knowledge vault you own and run locally.",
      logo: { src: "./public/favicon.svg", alt: "imprnt" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/starlight.css"],
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      disable404Route: true,
      sidebar: [
        { label: "Start here", items: [{ label: "Getting started", slug: "getting-started" }] },
        {
          label: "Concepts",
          items: [
            { label: "How it works", slug: "how-it-works" },
            { label: "The model", slug: "the-model" },
            { label: "Memory and the vault", slug: "memory-and-the-vault" },
            { label: "Architecture", slug: "architecture" },
            { label: "How plugins work", slug: "plugins" },
            { label: "How it compares", slug: "comparison" },
          ],
        },
        {
          label: "Plugins",
          items: [
            { label: "Anti-slop", slug: "plugins/anti-slop" },
            { label: "Character", slug: "plugins/character" },
            { label: "Statusline", slug: "plugins/statusline" },
          ],
        },
        {
          label: "Going deeper",
          items: [
            { label: "Design decisions", slug: "design-decisions" },
            { label: "Contributing", slug: "contributing" },
          ],
        },
      ],
    }),
    // mdx() must come after starlight() so Starlight's expressive-code (code
    // blocks) registers before mdx processes .mdx pages.
    mdx(),
    sitemap(),
  ],
  // The brand pass runs on every Markdown doc: gradient "imprnt", tool-name chips.
  markdown: {
    rehypePlugins: [rehypeBrand],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
