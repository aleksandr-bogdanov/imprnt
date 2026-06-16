import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Docs are the single source of truth and live in site/docs/ (real markdown,
// browsable + editable on GitHub). Starlight reads them straight from there, so
// editing a file in site/docs/ is the only place a doc page is defined.
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "./docs" }),
    schema: docsSchema(),
  }),
};
