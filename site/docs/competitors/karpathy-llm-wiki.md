# Karpathy's LLM Wiki

**One-line:** A design pattern (not a product) published by Andrej Karpathy as a GitHub gist, where an LLM agent incrementally compiles your raw sources into a persistent, cross-linked plain-Markdown wiki that it maintains over time, instead of re-retrieving from raw documents on every query.

**Status (checked 2026-06-20):** active (as a pattern, virally adopted) - the gist is live and dated April 4, 2026, with thousands of stars and an active comment thread, and multiple independent implementations are shipping releases as recently as June 18, 2026. It is a pattern published by one person, so there is no company, funding, SLA, or roadmap behind the pattern itself.

**Latest release:** the gist itself has no versions/releases (it is a single Markdown file, last shown created/updated April 4, 2026). **Stars:** gist shows 5,000+ stars and 5,000+ forks. **License:** no license stated on the gist (the prior note's "CC0" claim is unverified and appears wrong). **Hosting:** self-host only by construction (it is text you paste into an agent, so there is no service)

Note on scope: the brief asked for full pricing tiers, benchmarks, and version/star recency. For the gist itself most of those do not exist because it is a pattern, not a shipped tool. Where they exist they live in the third-party implementations (nashsu, ar9av, lucasastorian, Astro-Han), which I cover with live star counts and release dates below.

## What it is

Karpathy's LLM Wiki is a written pattern for an LLM-maintained knowledge base. The agent ingests your curated raw sources once, compiles them into durable Markdown wiki pages with cross-references, and answers later questions from the compiled wiki rather than re-reading raw documents every time.

> "Instead of just retrieving from raw documents at query time, the LLM **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files that sits between you and the raw sources."

> "The wiki is a persistent, compounding artifact. The cross-references are already there."

- Source: [LLM Wiki gist - karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

The gist describes itself as a pattern, not a tool, and the top filename/tagline reads "A pattern for building personal knowledge bases using LLMs." It is deliberately abstract and meant to be pasted into an agent (Claude Code or similar) and adapted to your domain.

> "Everything mentioned above is optional and modular — pick what's useful, ignore what isn't. ... The document's only job is to communicate the pattern."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

## Status, timeline, recency

- 2026-04-03: Karpathy posts the concept on X. Multiple write-ups report the tweet cleared more than 21 million views. Source: [rdworldonline - "Is Karpathy's viral LLM wiki helpful?"](https://www.rdworldonline.com/is-karpathys-viral-llm-wiki-helpful-mostly-yes-one-month-in/) - accessed 2026-06-20
- 2026-04-04: The gist itself is created (timestamp shown on the gist page: "April 4, 2026 16:25"). Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20
- 2026-04 onward: third-party implementations appear. nashsu/llm_wiki reaches a 10k-star milestone within about a month of its open-source launch. Source: [nashsu/llm_wiki repo](https://github.com/nashsu/llm_wiki) - accessed 2026-06-20
- 2026-05-29: earliest release visible on the nashsu releases page (v0.4.16). Source: [nashsu/llm_wiki releases](https://github.com/nashsu/llm_wiki/releases) - accessed 2026-06-20
- 2026-06-18: nashsu/llm_wiki latest release v0.4.25 and last commit, same day. Source: [nashsu/llm_wiki releases](https://github.com/nashsu/llm_wiki/releases) - accessed 2026-06-20
- 2026-06-18: ar9av/obsidian-wiki latest release v2026.06.6. Source: [ar9av/obsidian-wiki repo](https://github.com/ar9av/obsidian-wiki) - accessed 2026-06-20

Recency verdict: the pattern and its main implementations are active, not dormant. nashsu/llm_wiki shipped a release and a commit on June 18, 2026, two days before the access date. The gist itself does not version, so "last release" is not a meaningful axis for the gist. Its creation date is April 4, 2026 and it is still live.

Funding / pivots / archive: none apply to the gist. It is a single author's published pattern with no company, no funding round, no pricing, no SLA, and nothing to archive or sunset. The third-party implementations are independent open-source projects.

## Where memory lives (storage and architecture)

The pattern is three layers of plain Markdown, all on local disk, all human-readable.

> "**Raw sources** — your curated collection of source documents. Articles, papers, images, data files. These are immutable — the LLM reads from them but never modifies them. This is your source of truth. **The wiki** — a directory of LLM-generated markdown files. ... **The schema** — a document (e.g. CLAUDE.md for Claude Code or AGENTS.md for Codex) that tells the LLM how the wiki is structured..."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

The three layers:

1. Raw sources: your curated, immutable collection of documents. The LLM reads them but never edits them.
2. The wiki: LLM-generated Markdown pages (summaries, entities, concepts) with cross-references between them.
3. The schema: a config document (CLAUDE.md or AGENTS.md) that tells the agent the conventions and workflows for ingest, query, and lint.

Two control files anchor the wiki:

> "**index.md** is content-oriented. It's a catalog of everything in the wiki — each page listed with a link, a one-line summary, and optionally metadata like date or source count."

> "**log.md** is chronological. It's an append-only record of what happened and when — ingests, queries, lint passes."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

The gist suggests consistent line prefixes in log.md so plain unix tools can parse it (for example grepping for a leading "## [" marker), which keeps reads deterministic and dependency-free.

Implementation storage (independent projects, verified live):

- nashsu/llm_wiki: Markdown with `[[wikilinks]]` syntax and YAML frontmatter, packaged as a cross-platform Tauri desktop app with an optional local HTTP API at `127.0.0.1:19828`. Source: [nashsu/llm_wiki repo](https://github.com/nashsu/llm_wiki) - accessed 2026-06-20
- ar9av/obsidian-wiki: plain Markdown in an Obsidian vault with YAML frontmatter, wikilinks `[[page]]`, and a `.manifest.json` delta tracker. Local-first with optional private GitHub sync. Source: [ar9av/obsidian-wiki repo](https://github.com/ar9av/obsidian-wiki) - accessed 2026-06-20
- lucasastorian/llmwiki: local mode uses SQLite plus filesystem storage. The hosted mode uses Postgres plus S3. This one departs from the pure-Markdown ethos. Source: [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20

## Retrieval

The pattern's default retrieval is deliberately low-tech: the LLM reads index.md first, then opens the full pages it needs. Embeddings are explicitly described as unnecessary at moderate scale.

> "This works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and avoids the need for embedding-based RAG infrastructure."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

Past that scale, the gist points to an external tool rather than building search into the pattern:

> "[qmd](https://github.com/tobi/qmd) is a good option: it's a local search engine for markdown files with hybrid BM25/vector search and LLM re-ranking, all on-device."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

So in the base pattern there is no ranker at all: the agent reads the catalog and decides. BM25 (plus optional vectors and LLM re-ranking) only enters through the suggested external `qmd` tool once the wiki is large.

Implementation retrieval (verified live):

- nashsu/llm_wiki: "Multi-phase pipeline combining tokenized search, optional vector semantic search via LanceDB, and graph-based relevance expansion." Source: [nashsu/llm_wiki repo](https://github.com/nashsu/llm_wiki) - accessed 2026-06-20
- lucasastorian/llmwiki: full-text search across indexed content, citation-graph queries, and file-based browsing via a Next.js web UI. Source: [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20

## Capture

Capture is conscious and source-driven: you decide what raw material enters, and the LLM does the bookkeeping of compiling it into the wiki. The division of labor is stated directly.

> "You're in charge of sourcing, exploration, and asking the right questions. The LLM does all the grunt work — the summarizing, cross-referencing, filing, and bookkeeping that makes a knowledge base actually useful over time."

> "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping...LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass."

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

The pattern centers on a small set of operations: ingest a source (which touches many wiki pages, integrating rather than just appending), query (which can be filed back as a new page), and a periodic lint pass that flags contradictions, orphan pages, and stale claims. lucasastorian/llmwiki extends capture toward automation with a nightly Claude Routine:

> "deploy a nightly Claude Routine to autonomously synthesize those sources into a permanent knowledge base"

- Source: [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20

## How the AI reads it

In the base pattern there is no server and no API in the loop. The agent reads the Markdown files directly from disk: it opens index.md, picks pages, and reads them. Everything is plain text the agent can grep and open. The schema file (CLAUDE.md / AGENTS.md) is what teaches the agent the conventions for reading and writing.

Implementations layer interfaces on top. nashsu wraps it as a desktop app with an optional local HTTP API at `127.0.0.1:19828`. lucasastorian exposes it over MCP:

> "Connect Claude.ai, Claude Cowork, Claude Code, or Codex (or any other MCP-compatible app)"

- Source: [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20

ar9av/obsidian-wiki keeps the agent-reads-files model and advertises broad agent support (Claude Code, Cursor, Windsurf, Codex, Gemini CLI, and more) via skill files. Source: [ar9av/obsidian-wiki repo](https://github.com/ar9av/obsidian-wiki) - accessed 2026-06-20

## Pricing and license

The gist has no pricing because it is not a product. It also states no license. The gist page shows no license text. The prior internal note claiming "CC0" is unverified and not supported by the gist page as fetched. Treat the gist as "no license stated" unless Karpathy adds one.

- Source: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20

Implementation licenses and pricing (verified live):

- nashsu/llm_wiki: GNU GPL v3.0, open source, no pricing stated. Source: [nashsu/llm_wiki repo](https://github.com/nashsu/llm_wiki) - accessed 2026-06-20
- ar9av/obsidian-wiki: MIT, open source. Source: [ar9av/obsidian-wiki repo](https://github.com/ar9av/obsidian-wiki) - accessed 2026-06-20
- lucasastorian/llmwiki: Apache-2.0. Local mode is self-hosted, plus a hosted version at llmwiki.app described as free to try. No paid tiers stated. Source: [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20
- Astro-Han/karpathy-llm-wiki: Agent Skills-compatible skill for Claude Code, Cursor, Codex, installable via `npx add-skill`. License not separately verified here. Source: [Astro-Han/karpathy-llm-wiki repo](https://github.com/Astro-Han/karpathy-llm-wiki) - accessed 2026-06-20

## Benchmarks (vendor self-reported)

None. The gist publishes no benchmarks, no retrieval accuracy numbers, and no latency claims. It is a prose pattern. The implementations on GitHub likewise publish no formal benchmark numbers on their repo pages as fetched. The only quantitative claims available are popularity metrics (stars, forks, X views), which are adoption signals, not quality benchmarks. Any benchmark assertion would be unverified.

## vs imprnt

The shared DNA is real: both compile raw sources into plain Markdown with wikilinks, keep an index/catalog plus an append-only log, drive everything through a schema file (CLAUDE.md), keep capture conscious and on-demand, and let the agent read files directly with no embeddings in the default path. This is imprnt's closest design kin. The differences are in what imprnt ships as code versus what the gist leaves to the reader.

- Ranker: the base LLM Wiki pattern has no ranker. The agent reads index.md and decides. BM25 only appears if you bolt on the suggested external `qmd` tool at scale. imprnt ships BM25 as the core ranker in its own `recall` (term frequency times inverse document frequency with field boosts, pure local arithmetic, zero deps, no external tool), so a tight ranked candidate set comes for free from day one rather than after you grow large enough to need it.
- Typed entity contract: the gist's wiki pages are summaries, entities, and concepts with no enforced schema. imprnt defines a typed contract (people, orgs, holdings) with a singular `type`, a `kind`, tags, and a one-line `summary`, plus a checked redundancy that folder and `domain:` field must agree.
- Alias resolution and merge: imprnt's ingest greps names and `aliases[]` across the entity folders and MERGEs on hit so a person is never duplicated, with renames demoted to aliases. The gist's lint pass detects contradictions and orphans but does not specify deterministic alias-based entity resolution.
- Shipped CLI and plugin contract: imprnt is a real CLI (`ingest`, `recall`, `check`) plus a documented plugin contract (single-writer-per-path, slug-namespaced frontmatter, convention-based aggregators). The gist is text to paste into an agent. The closest shipped equivalents (nashsu, ar9av, lucasastorian) are independent third-party builds, not Karpathy's.
- Privacy model: imprnt is an owner-only local vault (`chmod 700`) with no sensitivity machinery by design. The pattern is local-first by default but says nothing prescriptive about permissions, and one implementation (lucasastorian) offers a hosted Postgres+S3 mode that leaves the local-only posture.

- Sources for the comparison: [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [imprnt CLAUDE.md vault contract](https://github.com/) (internal repo) - accessed 2026-06-20

## When it wins over imprnt

- You want zero install and zero CLI: the gist is text you paste into an agent you already use, adapted in one conversation. imprnt asks you to adopt a CLI and a contract.
- You want a polished desktop GUI today: nashsu/llm_wiki ships a cross-platform Tauri app with a real UI, which imprnt does not offer.
- You want a hosted, multi-device, MCP-connected setup with a web UI: lucasastorian/llmwiki offers that (Postgres+S3 hosted mode, MCP for Claude.ai / Cowork / Code / Codex), trading imprnt's strict local-only posture for convenience.
- You live in Obsidian and want it to be your front end: ar9av/obsidian-wiki targets exactly that, an Obsidian vault any of a dozen agents can read.
- You want the synthesis/integration emphasis as the headline feature (ingest rewrites and cross-links many pages, weekly lint catches contradictions) rather than imprnt's typed-entity and ranked-recall emphasis.

## Sources

- [LLM Wiki gist - karpathy/442a6bf555914893e9891c11519de94f](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) - accessed 2026-06-20
- [nashsu/llm_wiki repo](https://github.com/nashsu/llm_wiki) - accessed 2026-06-20
- [nashsu/llm_wiki releases](https://github.com/nashsu/llm_wiki/releases) - accessed 2026-06-20
- [ar9av/obsidian-wiki repo](https://github.com/ar9av/obsidian-wiki) - accessed 2026-06-20
- [lucasastorian/llmwiki repo](https://github.com/lucasastorian/llmwiki) - accessed 2026-06-20
- [Astro-Han/karpathy-llm-wiki repo](https://github.com/Astro-Han/karpathy-llm-wiki) - accessed 2026-06-20
- [qmd local Markdown search engine (referenced by the gist)](https://github.com/tobi/qmd) - accessed 2026-06-20
- [rdworldonline - "Is Karpathy's viral LLM wiki helpful? Mostly yes. One month in."](https://www.rdworldonline.com/is-karpathys-viral-llm-wiki-helpful-mostly-yes-one-month-in/) - accessed 2026-06-20

## Confidence and gaps

- License: high confidence the gist states no license. The prior note's "CC0" is unverified and contradicted by the gist page, flagged as wrong unless Karpathy adds a license later.
- Gist date: high confidence April 4, 2026 creation (timestamp on the page), with the X post the prior day, April 3, 2026 (reported by secondary write-ups, not directly verified on X here). The secondary source (rdworldonline) dates the post only to April 2026 generally and does not independently pin April 3, so treat the exact day as reported-not-primary.
- Gist star/fork counts: medium confidence. The fetch reported "5,000+ stars and 5,000+ forks," which is a rounded read of the page rather than an exact integer. GitHub does not always render exact gist counts cleanly to a fetcher. Treat as thousands-scale, exact number unverified.
- Verbatim gist quotes: medium-high confidence. A direct raw-file fetch was refused on copyright grounds, so quotes were pulled as short excerpts from the rendered gist page. They match across fetches and known summaries, but I could not diff them against the literal raw file byte-for-byte. The source uses em-dashes inside several of these passages and the quotes above preserve that original punctuation as returned (the surrounding author prose stays plain ASCII).
- Implementation star counts (live): nashsu 12.2k stars / 1.5k forks (corrects the prior note's "~11.9k"). ar9av 2.3k stars / 230 forks (prior note said ~2.2k, close). lucasastorian 1.2k stars / 187 forks, Apache-2.0, no published releases (151 commits on master). Astro-Han star count not separately fetched, flagged as a gap.
- Benchmarks: none exist for the pattern. Any benchmark claim would be fabricated.
- Whether nashsu's "10k in about a month" milestone is exact: medium confidence, reported via the repo/secondary context, not a primary dated GitHub event.
