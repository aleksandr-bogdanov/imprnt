# Obsidian

**One-line:** A free, closed-source, local-first note app that stores every note as a plain-text Markdown file on your own device, with a paid Sync and Publish service on top.
**Status (checked 2026-06-20):** active - shipping regular desktop releases (1.13.1 on June 9, 2026 per the official changelog) and actively maintained. No database pivot. Notes remain plain `.md` files, and the new Bases feature reads YAML properties out of those same Markdown files rather than moving data into a DB.
**Latest release:** 1.13.1 Desktop, June 9, 2026 (official changelog) | **Stars:** 18.9k on `obsidianmd/obsidian-releases` (the public release/registry repo. The app itself is closed-source, so there is no app source repo to star) | **License:** proprietary / closed-source. Free to use, "open file formats" but not open source | **Hosting:** self-host / local-first. Notes live on your device, with optional paid cloud Sync and Publish.

## What it is
Obsidian is a desktop and mobile knowledge base that keeps your notes as a folder of plain Markdown files on disk. The app is free, the company makes money from optional add-on services (Sync, Publish) and a commercial license. The pitch is data ownership and longevity over cloud convenience.

> "Obsidian stores your notes locally as plain text Markdown files."

> "Obsidian uses open file formats, so you're never locked in."

> "Obsidian stores notes privately on your device, so you can access them quickly, even offline. No one else can read them, not even us."

- https://obsidian.md/ - accessed 2026-06-20

The base app ships no AI. AI is added by community plugins (Smart Connections, Copilot for Obsidian) or an external MCP bridge, each of which builds its own sidecar vector index. Out of the box, retrieval is human-driven: wikilinks, tags, full-text search, the graph view, and now the Bases core plugin (database-like views over note properties).

## Status, timeline, recency
- 2020-03-13: public beta launch. Built by Shida Li and Erica Xu (the Dynalist founders), during the early COVID lockdown. Legally the company is Dynalist Inc. - https://en.wikipedia.org/wiki/Obsidian_(software) , https://obsidian.md/about (accessed 2026-06-20). The About page is explicit about the funding model: "We are 100% supported by our users, not investors." - https://obsidian.md/about
- Company stays small and bootstrapped: the About page describes "a small team focused on helping you think better" and lists roughly 8 core team members (plus "Sandy," the office cat). CEO is Steph Ango. Shida Li is CTO, Erica Xu is COO. No venture capital. - https://obsidian.md/about (accessed 2026-06-20)
- 2025-05: Bases announced. Obsidian's official account: "Introducing Bases, a new core plugin that lets you turn any set of notes into a powerful database... Bases are now available in Obsidian 1.9.0 for early access users." - https://x.com/obsdmd/status/1925210385935913139 (accessed 2026-06-20)
- 2025-08-18: Bases reaches general availability. Bases shipped to early-access users in 1.9.0 (mid-2025) and became available to everyone in 1.9.10. - https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/ , https://www.neowin.net/news/obsidian-1910-lands-with-a-new-core-plugin-bug-fixes-and-more/ (accessed 2026-06-20). This corrects the prior note's "shipped as a core plugin in the 1.9 release": correct that 1.9 introduced it, but it was early-access-only until 1.9.10.
- 2026-03-23: desktop 1.12.7. - https://obsidian.md/changelog/ (accessed 2026-06-20)
- 2026-05-28: desktop 1.13.0. - https://obsidian.md/changelog/ (accessed 2026-06-20)
- 2026-06-09: desktop 1.13.1, the latest release. Confirmed verbatim on the changelog entry: "1.13.1 Desktop" and "June 9, 2026". - https://obsidian.md/changelog/2026-06-09-desktop-v1.13.1/ (accessed 2026-06-20)
- Recency note: the `obsidianmd/obsidian-releases` GitHub releases page lagged at v1.12.7 (March 23) at access time, while the official changelog already lists 1.13.1 (June 9, 2026). The changelog is the authoritative version source. The GitHub repo is a distribution/registry, not the canonical version list. - https://github.com/obsidianmd/obsidian-releases/releases (accessed 2026-06-20)
- No database pivot. Unlike Logseq (which announced a move to a SQLite-backed database file format), Obsidian's data stays in plain Markdown. Even Bases, the "database" feature, reads YAML properties already stored inside the `.md` files. Official help: "All the data in Obsidian Bases is stored in your local Markdown files and their properties." - https://obsidian.md/help/bases (accessed 2026-06-20)

## Where memory lives (storage and architecture)
A vault is a local folder of plain files. The app reads and writes them directly. There is no app database holding your content.

> "Obsidian stores your notes locally as plain text Markdown files."

- https://obsidian.md/ - accessed 2026-06-20

Supported file types in a vault, verbatim from the help docs: "Markdown: `.md` - Bases: `.base` - JSON Canvas: `.canvas`" plus image, audio, video, and PDF formats. - https://obsidian.md/help/file-formats (accessed 2026-06-20)

The `.base` file is a small view-definition file, not a data store. The data stays in the Markdown:

> "All the data in Obsidian Bases is stored in your local Markdown files and their properties."

> "the Bases syntax, which can be saved as a `.base` file or embedded in code blocks within your Markdown files."

- https://obsidian.md/help/bases - accessed 2026-06-20

AI plugins add their own sidecar indexes on disk, outside the Markdown:
- Smart Connections stores its index in a `.smart-env/` directory inside the vault. Its README advises sync users: "If you use a third party sync tool, add the `.smart-env/` directory to its ignore patterns to avoid conflicts." Embeddings are generated locally by default: "Embeddings are created locally by default. Your notes stay on your machine." - https://github.com/brianpetro/obsidian-smart-connections (accessed 2026-06-20)
- Copilot for Obsidian "maintains an index of vault files" and you can "run Force Re-Index or use List Indexed Files from the Command Palette to inspect what's included in the index." Embeddings are optional. - https://github.com/logancyang/obsidian-copilot (accessed 2026-06-20, quotes not re-verified this pass)

So the canonical store is plain Markdown the user owns. Any vector index is an optional, removable sidecar a plugin builds, never the source of truth.

## Retrieval
Base-app retrieval is deterministic and human-driven, with no AI in the loop:
- Wikilinks (`[[note]]`) and backlinks
- Tags
- Full-text search across the vault
- The graph view (visual link graph)
- Bases: database-like views (tables, cards) that "view, edit, sort, and filter files and their properties," each base supporting multiple view layouts. - https://obsidian.md/help/bases (accessed 2026-06-20)
- Dataview (a popular community plugin) for query-style views. Bases is the core-plugin answer to the same need.

Semantic / embedding retrieval is opt-in via plugins:
- Smart Connections: "Smart Connections uses local embeddings and your Smart Environment to surface notes that are semantically related to what you are working on right now," summarized as "Smart Connections finds relevant notes so you don't have to!" - https://github.com/brianpetro/obsidian-smart-connections (accessed 2026-06-20)
- Copilot adds "chat-based vault search" with optional embeddings: "Embeddings are optional. Copilot delivers results right away." - https://github.com/logancyang/obsidian-copilot (accessed 2026-06-20, quotes not re-verified this pass)

## Capture
Capture is manual and conscious: you write Markdown in the editor, on desktop or mobile. There is no automatic ingest, no background classifier, no auto-tagging in the base app. Properties (YAML frontmatter) are entered by hand or via plugins, and Bases then reads those properties to build views. Sync (paid) and Publish (paid) move already-captured notes. They do not capture.

## How the AI reads it
The base app ships no AI. There is no built-in chat, no built-in embedding index, no model calls from core Obsidian.

AI arrives only via community plugins or an external bridge, and each builds its own index over the same Markdown files:
- Smart Connections (v4.5.3, dated Jun 4, 2026, 5.2k stars) creates embeddings with a local model: "A local model starts creating embeddings right away. No extra apps, no CLI tools, and no API key required." Embeddings are "created locally by default. Your notes stay on your machine." Index lives in `.smart-env/`. - https://github.com/brianpetro/obsidian-smart-connections (accessed 2026-06-20)
- Copilot for Obsidian ("Copilot for Obsidian," v3.3.3, dated May 21, 2026, 7.2k stars) is "The Ultimate AI Assistant for Your Second Brain" with "chat-based vault search," works with "whatever LLM you like" including local models ("Tap any OpenAI-compatible or local model"), and offers a Plus tier with agentic tools. - https://github.com/logancyang/obsidian-copilot (accessed 2026-06-20, quotes and version/star count not re-verified this pass)
- External MCP bridges expose the vault to an external LLM client (community-built, not first-party).

In all cases the AI reads a copy/index of the Markdown the user already owns. Remove the plugin and the notes are untouched.

## Pricing and license
The core app is free with no account required:
> "Free without limits. No sign-up required. No strings attached."
- https://obsidian.md/pricing - accessed 2026-06-20

Paid add-ons and tiers, verbatim prices (accessed 2026-06-20, https://obsidian.md/pricing):

| Tier | Price (verbatim) |
|------|------------------|
| Free | "Free without limits. No sign-up required. No strings attached." |
| Sync (annual) | "$4 USD Per user, per month, billed annually" |
| Sync (monthly) | "$5 USD Per user, per month, billed monthly" |
| Publish (annual) | "$8 USD Per site, per month, billed annually" |
| Publish (monthly) | "$10 USD Per site, per month, billed monthly" |
| Catalyst | "$25 USD One-time payment" (early-access builds + supporter perks) |
| Commercial License | "$50 USD Per user, per year" |

Sync details (paid): "The simple and secure way to sync your notes across any device and OS," with "Your data is automatically secured using AES-256, the strongest encryption standard," version history for every note, and offline-then-sync. - https://obsidian.md/sync (accessed 2026-06-20)

License: Obsidian is proprietary, closed-source. The public GitHub repo states it plainly: "Obsidian is not open source software and this repo _DOES NOT_ contain the source code of Obsidian." The repo's job is distribution and the community plugin/theme registry: "Community plugins list, theme list, and releases of Obsidian." - https://github.com/obsidianmd/obsidian-releases (accessed 2026-06-20). The "open" claim is about file formats, not source: "Obsidian uses open file formats, so you're never locked in." - https://obsidian.md/ (accessed 2026-06-20)

## Benchmarks (vendor self-reported)
Obsidian publishes no retrieval/accuracy benchmarks (it ships no AI to benchmark). The closest vendor-stated numbers are business/scale metrics reported in coverage of the company, not a benchmark suite: roughly 1.5M monthly active users and around $25M ARR with about 18 people and zero VC, per secondary coverage. These are secondary-source figures, not a primary Obsidian benchmark page, and are flagged as unverified against a primary source below. - https://www.versaedits.com/article/obsidian-built-350m-app-3-engineers (accessed 2026-06-20)

## vs imprnt
- Storage: both keep plain Markdown files the user owns, and both survive the tool being deleted. This is the strongest point of agreement. Obsidian's own copy ("you're never locked in," "No one else can read them, not even us") is nearly the imprnt thesis.
- Retrieval default: Obsidian's deterministic retrieval is human-driven (links, tags, full-text search, graph, Bases). imprnt's default is BM25 + grep that the AI runs against the files, so the AI does the recall without a vector index. Obsidian's base app has no AI-driven retrieval at all, so you add it via a plugin.
- AI architecture: Obsidian AI plugins build a sidecar vector index (Smart Connections writes `.smart-env/`, Copilot keeps its own). imprnt deliberately has no embeddings, so the AI greps and BM25-ranks the raw files. Different bet: Obsidian community plugins add embeddings, imprnt rejects them.
- Capture: both are conscious, on-demand. Neither auto-ingests in core. imprnt's contract is built around a typed ingest pass (classify, file, link). Obsidian capture is freeform Markdown plus optional properties.
- Schema: imprnt ships a typed entity contract (people/orgs/holdings with aliases, frontmatter `type`/`kind`/`tags`). Obsidian has YAML properties + Bases views over them, but no opinionated entity schema. Structure is whatever the user (or a plugin) imposes.
- Server: Obsidian is local-first with optional paid cloud Sync/Publish. imprnt is local, no server. Comparable on the local axis. Obsidian additionally sells a sync service.
- Cost: Obsidian core is free. Sync is $4-5/user/mo, Publish $8-10/site/mo, commercial use $50/user/yr. imprnt's cost model is the LLM tokens you spend on ingest/recall, not a subscription.

## When it wins over imprnt
- You want a mature, polished GUI app with mobile clients, a graph view, themes, and a large plugin marketplace. Obsidian is years ahead on UX and ecosystem.
- You want human-driven browsing (links, tags, graph, database views) more than AI-grep recall, and you do not want any AI in the loop by default.
- You want managed end-to-end-encrypted sync across devices as a turnkey paid service (Obsidian Sync, AES-256).
- You want to publish a subset of notes as a website (Obsidian Publish).
- You prefer a single closed, supported app over a CLI-plus-LLM workflow, and you are comfortable with the app being closed-source as long as the files stay open Markdown.

## Sources
- [Obsidian homepage](https://obsidian.md/) - accessed 2026-06-20
- [Obsidian pricing](https://obsidian.md/pricing) - accessed 2026-06-20
- [Obsidian Sync](https://obsidian.md/sync) - accessed 2026-06-20
- [Obsidian About](https://obsidian.md/about) - accessed 2026-06-20
- [Obsidian changelog (index)](https://obsidian.md/changelog/) - accessed 2026-06-20
- [Obsidian 1.13.1 Desktop changelog](https://obsidian.md/changelog/2026-06-09-desktop-v1.13.1/) - accessed 2026-06-20
- [Obsidian 1.9.10 Desktop changelog (Bases GA)](https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/) - accessed 2026-06-20
- [Obsidian Help: File formats](https://obsidian.md/help/file-formats) - accessed 2026-06-20
- [Obsidian Help: Introduction to Bases](https://obsidian.md/help/bases) - accessed 2026-06-20
- [obsidianmd/obsidian-releases GitHub repo](https://github.com/obsidianmd/obsidian-releases) - accessed 2026-06-20
- [obsidianmd/obsidian-releases GitHub releases](https://github.com/obsidianmd/obsidian-releases/releases) - accessed 2026-06-20
- [Obsidian Bases announcement (official X/Twitter)](https://x.com/obsdmd/status/1925210385935913139) - accessed 2026-06-20
- [Neowin: Obsidian 1.9.10 lands with a new core plugin](https://www.neowin.net/news/obsidian-1910-lands-with-a-new-core-plugin-bug-fixes-and-more/) - accessed 2026-06-20
- [Smart Connections GitHub repo](https://github.com/brianpetro/obsidian-smart-connections) - accessed 2026-06-20
- [Copilot for Obsidian GitHub repo](https://github.com/logancyang/obsidian-copilot) - accessed 2026-06-20
- [Wikipedia: Obsidian (software)](https://en.wikipedia.org/wiki/Obsidian_(software)) - accessed 2026-06-20
- [VersaEdits: How Obsidian Built a $350M App With Just 3 Engineers (secondary, business figures)](https://www.versaedits.com/article/obsidian-built-350m-app-3-engineers) - accessed 2026-06-20

## Confidence and gaps
- High confidence: storage model (plain Markdown, local), the "no lock-in / open file formats / closed source" framing, current pricing (all tiers and exact prices read live from the pricing page), Bases being a core plugin that keeps data in Markdown (no database pivot), latest version 1.13.1 (June 9, 2026), and the AI-via-plugin-sidecar-index architecture.
- The `obsidianmd/obsidian-releases` GitHub releases page lagged the official changelog (showed v1.12.7 / March 23 while the changelog listed 1.13.1 / June 9). Treated the changelog as authoritative. The GitHub repo is a registry/distribution channel, not the canonical version list. Star count 18.9k is for that release/registry repo, not an app-source repo (none exists, the app is closed-source).
- Bases timeline corrected vs the prior note: 1.9.0 introduced Bases in early access (mid-2025), and 1.9.10 (2025-08-18) made it available to everyone. The prior note's "shipped as a core plugin in the 1.9 release (mid-2025)" is right on the version family but conflated early-access with general availability.
- Plugin recency: Smart Connections 4.5.3 (Jun 4, 2026, 5.2k stars) confirmed live this pass, and its quotes were re-fetched verbatim. Copilot for Obsidian 3.3.3 (May 21, 2026, 7.2k stars) and its quotes were not re-verified this pass and are carried over from a prior read. Last-commit timestamps were not exposed on the repo pages, so "last commit date" is unverified for both. Latest-release dates serve as the recency proxy, and the confirmed Smart Connections release is recent (within ~2 months).
- Unverified: the business metrics (~1.5M MAU, ~$25M ARR, ~18 people, zero VC) come from secondary coverage and the About page only confirms the no-investors stance verbatim ("We are 100% supported by our users, not investors") and a small team (~8 listed). The specific MAU/ARR numbers are not on a primary Obsidian page, so they are flagged secondary/unverified. A live search shows wide disagreement across secondary sources (figures range from $2M to $25M ARR), which is why the hedge stands.
- Unverified: exact contents/perks of the Catalyst tier beyond price ($25 one-time) were not re-read from a dedicated Catalyst page in this pass. The price is verbatim from the pricing page, the "early-access + supporter" gloss is from general knowledge and flagged.
