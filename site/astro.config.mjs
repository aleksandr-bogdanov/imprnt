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

// dev-only: load the live accent picker on the docs pages too (the landing loads
// it from Layout.astro). Self-gates to localhost, so it is inert even if built.
const DEV = process.env.NODE_ENV !== "production";

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
      head: [
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" } },
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16.png" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        // dev-only: the live accent picker (self-gates to localhost too)
        ...(DEV ? [{ tag: "script", attrs: { src: "/accent-picker.js", defer: true } }] : []),
      ],
      // The "Why imprnt?" page swaps the right-sidebar TOC for an interactive
      // story rail. Every other page keeps the default (the override falls
      // through). See src/components/overrides/TableOfContents.astro.
      components: {
        TableOfContents: "./src/components/overrides/TableOfContents.astro",
        SiteTitle: "./src/components/overrides/SiteTitle.astro",
        ThemeProvider: "./src/components/overrides/ThemeProvider.astro",
        ThemeSelect: "./src/components/overrides/ThemeSelect.astro",
        Footer: "./src/components/overrides/Footer.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Why imprnt?", slug: "why-imprnt" },
            { label: "Getting started", slug: "getting-started" },
            { label: "How it compares", slug: "comparison" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How it works", slug: "how-it-works" },
            { label: "Vault layout", slug: "vault-layout" },
            { label: "Memory and the vault", slug: "memory-and-the-vault" },
            { label: "How plugins work", slug: "plugins" },
          ],
        },
        {
          label: "Plugins",
          items: [
            { label: "Anti-slop", slug: "plugins/anti-slop" },
            { label: "Character", slug: "plugins/character" },
            { label: "Statusline", slug: "plugins/statusline" },
            { label: "Timemachine", slug: "plugins/timemachine" },
            // More pages exist as drafts (docs/plugins/telegram.mdx). When a
            // draft: true flips off, add its { label, slug: "plugins/<name>" }
            // here.
          ],
        },
        {
          label: "Going deeper",
          items: [
            { label: "The realtime hub", slug: "realtime-hub" },
            { label: "The agent fleet", slug: "fleet" },
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
