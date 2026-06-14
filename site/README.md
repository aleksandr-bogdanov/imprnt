# imprnt website

The readable face of imprnt. A static [Astro](https://astro.build) site, dark dev-tool
aesthetic, scroll motion, deployed to Railway.

## Stack

- **Astro 5** static output. Most of the page is plain HTML and CSS.
- **React islands** (`src/islands/`) hydrate only the interactive parts: the hero visual,
  the typing terminal, the copy buttons, the expanders, the axis explorer, the magnetic CTAs.
- **Tailwind CSS 4** via the Vite plugin. The design tokens live in `src/styles/global.css`
  under `@theme`.
- **Motion**: Lenis smooth scroll synced to GSAP ScrollTrigger, plus Framer Motion inside the
  islands. All of it is gated behind `prefers-reduced-motion` (`src/scripts/motion.ts`).
- **Docs**: [Starlight](https://starlight.astro.build) (Astro's docs framework), themed dark to
  match the landing (`src/styles/starlight.css`). Doc pages are markdown in `src/content/docs/`.
  Add a file, add it to the sidebar in `astro.config.mjs`, and it becomes a page.

The landing (`src/pages/index.astro`) sells and stays short. The docs describe in depth.

## Develop

```sh
bun install
bun run dev        # local dev server
bun run build      # static build to dist/
bun run preview    # serve the built dist/
```

Node 18 or newer also works with `npm`.

## Where the copy lives

All site copy is data in `src/lib/content.ts`, one place to read and one place to scan. The
anti-slop rules apply to every word: no em-dashes, no semicolons, no banned words, no
negate-then-affirm. Scan before shipping.

## Deploy (Railway, config as code)

The site ships as a small container: a build stage compiles the static output with bun, and a
Caddy stage serves `dist/`. See `Dockerfile` and `Caddyfile` here, and `railway.toml` at the
repository root.

Deploys are driven from GitHub. The Railway service is connected to this repo with its **Root
Directory set to `site`**, which makes the build context `site/` and auto-detects the Dockerfile.
The config file lives at the **repository root** (`railway.toml`), because Railway reads its config
from the repo root by default and does not look inside the Root Directory. It deploys on every push
to `master`, and `build.watchPatterns = ["site/**", "railway.toml"]` scopes deploys to pushes that
actually touch the site, so a push elsewhere in the monorepo does not rebuild it.

To deploy by hand (or before the GitHub connection is wired):

```sh
railway up --service imprnt    # build + deploy this directory
```

Railway injects `$PORT`, which Caddy binds. The public URL is set in `astro.config.mjs` as
`SITE` (currently `https://imprnt.dev`), which feeds the canonical tag, the Open Graph tags, and
the sitemap. To change the domain, point it at the Railway service and update `SITE`.

## Assets

- `public/favicon.svg` is the imprnt mark.
- `public/og.png` is the social share card (1200x630). It is rendered from a standalone HTML
  card, so to change it, edit the card and re-screenshot at 1200x630.
