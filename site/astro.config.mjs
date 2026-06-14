// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

// The public URL. Feeds the sitemap and the canonical/OG tags. Point imprnt.dev
// at the Railway service, then this is the canonical home.
const SITE = "https://imprnt.dev";
const REPO = "https://github.com/aleksandr-bogdanov/imprnt";

// https://astro.build
export default defineConfig({
  site: SITE,
  integrations: [
    react(),
    // Docs live in src/content/docs/. The custom landing (src/pages/index.astro)
    // owns "/", Starlight serves the doc pages at their own slugs.
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
            { label: "Plugins", slug: "plugins" },
          ],
        },
      ],
    }),
    sitemap(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
