# Page polish guidelines

How a docs page gets from "fine" to the bar the plugins page now sets. These are
the rules that came out of polishing `docs/plugins.mdx` end to end. Apply them to
any other page. The reviewer/coder loop that enforces them is the `ux-loop` skill.

## The bar (the rubric)

Every page is judged on five things, in the owner's words:

1. As **fancy** as possible. Modern, polished, visually rich. A wall of text is a failure.
2. **ADHD-friendly.** Scannable in seconds, clear hierarchy, the point never buried.
3. **Plain words.** No jargon, no insider terms. If a phrase needs decoding, rewrite it.
4. **No section for the sake of a section.** Merge anything over-split or redundant. A one-sentence H2 is a smell.
5. **Visuals over paragraphs** where a graph, table, or diagram carries it better. Never at the cost of data.

## Hard rules (the ones we learned the hard way)

### Components and styling
- **Starlight doc pages do NOT load the site's Tailwind.** Never use Tailwind utility classes (`absolute`, `flex`, `h-*`) in anything rendered on a doc page. Astro components style through a scoped `<style>` block; React islands use **inline styles only**.
- **Theme-aware via tokens.** Colors come from Starlight's `--sl-color-*` variables (`--sl-color-bg`, `--sl-color-text-accent`, `--sl-color-white`, `--sl-color-gray-1..3`, `--sl-color-hairline-shade`, `--sl-font`, `--sl-font-mono`). They flip with light/dark for free. A React island reads the theme from `document.documentElement.dataset.theme` via a `MutationObserver` and keeps a light/dark palette.
- **React islands hydrate with `client:load`** (not `client:visible`, which can fail to fire) and must be fully self-contained.

### Visual language
- **No border-box callouts.** A box with a border line reads as AI. Use a filled surface (a subtle `color-mix` background), spacing, and color in the heading or icon. A colored left-accent bar is the worst tell. Graph node pills may keep a border, they are nodes.
- **No stale hand-maintained lists.** Anything that lists instances (every plugin, every tool) goes out of date. Let the sidebar and the per-item pages be the source of truth. A diagram shows **categories**, never instances, so adding or removing an item never touches it.
- **No headline for the sake of a headline**, and no section that restates what another section already carries. Merge.
- **Typography is consistent.** One font family per label set, consistent case. Mixing mono and sans labels in the same diagram looks broken.

### Prose
- **Plain language, concrete subject.** Say what a term means ("reads your notes, never imprnt's code"), not the insider shorthand ("reads headers not code"). Name the subject ("a plugin"), not an ambiguous "it" or "them".
- **Highlight sparingly.** Bold the one load-bearing term per idea, for scanning. Over-bolding is its own slop. (This is the one place bold-in-prose is allowed, by owner request.)
- **Anti-slop always.** No em-dash or en-dash, no semicolons, plain ASCII quotes, none of the banned words/phrases. Customer-facing prose talks to the reader, never to the author.

### Data is sacred
- **Visuals replace paragraphs, never data.** Tables, benchmark numbers, commands, and IDs stay in full. Make the prose around them fancy, never delete the table to look clean.

### Tooltips / popups / code
- **Float beside the element, paint on top.** A hover card anchors next to its node and uses a very high `z-index` (9999) so it is always above everything. Do not rely on a CSS `transform` for positioning a framer-motion element, framer drives `transform` for the animation and clobbers it, use `top`/`left`/`right` instead.
- **Code blocks: short comments.** Long trailing `# comments` cause a horizontal scrollbar. Keep them terse.

## MDX / Starlight wiring
- Pages can be `.md` or `.mdx`. The content glob is `**/*.{md,mdx}` in `src/content.config.ts`.
- `mdx()` must come AFTER `starlight()` in `astro.config.mjs` (so Starlight's expressive-code registers first).
- Import components in an `.mdx` page with a relative path: `import X from "../src/components/docs/X.astro"`.
- The build-time brand pass styles the word `imprnt` and competitor tool names. Do not bold `imprnt` or tool names yourself.

## Always verify for real
- Run `bun run build` from `site/` after every change. It must end with "Complete!".
- Judge the page from a **real screenshot** (the `ux-loop` skill captures desktop + mobile, light theme), never from assumptions about how it renders.
