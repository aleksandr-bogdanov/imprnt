# Khoj (and the khoj-ai pivot: Pipali, Open Paper)

**One-line:** Khoj is an open-source, self-hostable "personal AI second brain" built on a Django/Postgres backend with neural vector search (bi-encoder embeddings in pgvector plus a cross-encoder reranker), whose hosted cloud service was sunset on April 15, 2026 while the khoj-ai team pivoted to two unrelated products, Pipali (a desktop "AI co-worker") and Open Paper (a research-paper reading assistant).

**Status (checked 2026-06-20):** pivoting (and the hosted service is sunset) - Khoj Cloud was shut down on April 15, 2026 ("Khoj Cloud Has Been Sunset", app.khoj.dev), the open-source repo is left running but coasting (last release 2.0.0-beta.28 on 26 Mar 2026, no new releases in ~3 months as of the access date), and active engineering moved to Pipali and Open Paper.

**Latest release:** Khoj 2.0.0-beta.28, 26 Mar 2026 | **Stars:** 35.2k | **License:** AGPL-3.0 | **Hosting:** self-host only (cloud sunset 15 Apr 2026)

## What it is

Khoj is a self-hostable personal-AI app that indexes your documents and the web, then lets you chat with, search, and run agents over them using local or remote LLMs. The GitHub repo describes it this way:

> "Your AI second brain. Self-hostable. Get answers from the web or your docs. Build custom agents, schedule automations, do deep research. Turn any online or local LLM into your personal, autonomous AI (gpt, claude, gemini, llama, qwen, mistral). Get started - free."

[github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj) - accessed 2026-06-20

The README frames it as scaling from on-device to enterprise:

> "[Khoj](https://khoj.dev) is a personal AI app to extend your capabilities. It smoothly scales up from an on-device personal AI to a cloud-scale enterprise AI."

[raw.githubusercontent.com/khoj-ai/khoj/master/README.md](https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md) - accessed 2026-06-20

It indexes many file types and reaches you across many clients:

> "Get answers from the internet and your docs (including image, pdf, markdown, org-mode, word, notion files)"

> Multi-platform access listed as: "Browser, Obsidian, Emacs, Desktop, Phone, WhatsApp"

[raw.githubusercontent.com/khoj-ai/khoj/master/README.md](https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md) - accessed 2026-06-20

## Status, timeline, recency

- **2021 (claimed origin):** The sunset page states Khoj started as a document-search tool. Verbatim: "Khoj began in 2021 as a document search tool and evolved into a cloud-based AI service" (paraphrased in the fetched summary of [app.khoj.dev](https://app.khoj.dev), accessed 2026-06-20). Note the discrepancy below with the YC record.
- **2023 (incorporation / YC):** Y Combinator lists Khoj in the S23 batch, founded 2023 by Debanjum Singh and Saba Imran, ~$500K raised. Source: [ycombinator.com/companies/khoj](https://www.ycombinator.com/companies/khoj) and YC profile aggregators - accessed 2026-06-20. The 2021 (open-source project start) vs 2023 (company / YC S23) gap is a real distinction: the OSS project predates the company. Both are reported here. The exact OSS first-commit date is unverified (see gaps).
- **02 Jan 2026:** Khoj 2.0.0-beta.24 released. [github.com/khoj-ai/khoj/releases](https://github.com/khoj-ai/khoj/releases) - accessed 2026-06-20.
- **22 Feb 2026:** Khoj 2.0.0-beta.25 released. Same source.
- **25 Mar 2026:** Khoj 2.0.0-beta.26 and 2.0.0-beta.27 released. Same source.
- **26 Mar 2026:** Khoj 2.0.0-beta.28 released (latest as of access date), described as "bug fixes for web app functionality and deprecation banner issues." This is also the latest commit on `master`: "Release Khoj version 2.0.0-beta.28" dated March 26, 2026. Sources: [github.com/khoj-ai/khoj/releases](https://github.com/khoj-ai/khoj/releases) and [github.com/khoj-ai/khoj/commits/master](https://github.com/khoj-ai/khoj/commits/master) - accessed 2026-06-20.
- **15 Apr 2026:** Khoj Cloud sunset. Verbatim heading and date from the live page: "Khoj Cloud Has Been Sunset" / "April 15, 2026". [app.khoj.dev](https://app.khoj.dev) - accessed 2026-06-20.
- **21 Apr 2026:** Pipali v0.5.0 released (the pivot product reaching beta cadence). "0.5.0 — 21 Apr 16:32". [github.com/khoj-ai/pipali/releases](https://github.com/khoj-ai/pipali/releases) - accessed 2026-06-20.
- **01 Jun 2026:** Pipali v0.6.0 released (current as of access date). "0.6.0 — 01 Jun 19:52". Same source.

**Recency call:** Khoj itself is best labeled coasting/maintenance. Its newest release (26 Mar 2026) is ~3 months stale as of 2026-06-20, the only late activity was deprecation-banner and bug fixes, the hosted service is dead, and the founders publicly redirected to Pipali and Open Paper. The codebase is still a perpetual beta (2.x line never left "beta.NN"), but it is left running, not formally archived.

## Where memory lives (storage and architecture)

Khoj stores indexed content as vector embeddings in PostgreSQL via the pgvector extension, behind a Python (Django) backend. From the architecture/search docs (as surfaced via search of docs.khoj.dev and the deploy guides):

> "Khoj uses pgvector to store and query vector embeddings of your documents, enabling semantic search."

> "Deploying Khoj involves setting up a Python backend and connecting to a PostgreSQL (pgvector) database, which Khoj uses to store and retrieve embeddings for efficient semantic search."

Source: [docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) and [railway.com/deploy/khoj](https://railway.com/deploy/khoj) - accessed 2026-06-20.

Documents are chunked, embedded, and the vectors are persisted. From the search docs:

> "A bi-encoder models is used to create meaning vectors (aka vector embeddings) of your documents and search queries."

> the bi-encoder model is used "to create and store meaning vectors of (chunks of) your documents" when syncing.

[docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) - accessed 2026-06-20.

Architecturally this is a server-plus-database product: your "memory" is rows in a Postgres database (embeddings + metadata), not plain files you can read or grep on their own. The original files are synced in from clients (Obsidian, Desktop, etc.), but the searchable index lives in pgvector. This is the opposite of a plain-Markdown vault you own as files.

## Retrieval

Two-stage neural retrieval: a bi-encoder for first-pass vector recall, then a cross-encoder for reranking. Verbatim from the search docs:

> "The slower but higher-quality cross-encoder model is than used to re-rank these documents for your given query."

> A "Bi encoder confidence threshold" field is described as "a normalized semantic distance measure between queries and documents, with values ranging from 0.0 (exact overlap) to 1.0 (no meaning overlap)."

[docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) - accessed 2026-06-20.

The embedding models are pluggable:

> "You can use bi-encoder models downloaded locally from Huggingface, served via the HuggingFace Inference API, OpenAI API, Azure OpenAI API or any OpenAI Compatible API like Ollama, LiteLLM etc."

[docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) (as surfaced) - accessed 2026-06-20.

**BM25:** Not mentioned in the search documentation. The fetched search page focuses exclusively on neural embedding-based retrieval and reranking. Verbatim from the fetch: "BM25 is not mentioned in this documentation. The page focuses exclusively on neural embedding-based search rather than traditional keyword matching approaches." No documented lexical/keyword BM25 stage was found. Source: [docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) - accessed 2026-06-20. (If Khoj does any keyword matching internally it is not described in the user-facing docs. Treat "no BM25 stage" as documented-absent rather than proven-absent.)

## Capture

Capture is sync-based, not conscious-per-item. Khoj indexes content by syncing whole sources from its clients and the web, across many file types:

> "Get answers from the internet and your docs (including image, pdf, markdown, org-mode, word, notion files)"

[raw.githubusercontent.com/khoj-ai/khoj/master/README.md](https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md) - accessed 2026-06-20.

The sunset note itself cites this sync complexity as a reason the product was hard to sustain:

> "initial bets we made for Khoj — a subscription, cloud-first service, complex document syncs, custom data integrations, multiple (6!) clients — made it very difficult to scale in utility."

[app.khoj.dev](https://app.khoj.dev) - accessed 2026-06-20.

So the capture model is: connect a source (Obsidian vault, Notion, file folder, web), Khoj bulk-syncs and re-embeds it. There is no documented "one conscious note at a time, typed entity, with aliases" capture step.

## How the AI reads it

The AI reads via the neural retrieval pipeline above (embed query -> bi-encoder recall over pgvector -> cross-encoder rerank -> feed top chunks to the chat LLM), then layers agents, automations, and deep research on top. From the repo description: "Build custom agents, schedule automations, do deep research." ([github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj) - accessed 2026-06-20). Agents can carry "custom knowledge, persona, chat model and tools."

**MCP - direction matters and the prior note needs nuance.** The user-facing self-host setup docs fetched on the access date contain no mention of MCP at all (verbatim from the fetch: "there is no mention of MCP (Model Context Protocol) anywhere in the content", source: [docs.khoj.dev/get-started/setup](https://docs.khoj.dev/get-started/setup) - accessed 2026-06-20). Separately, third-party/aggregator listings claim a "Khoj's MCP Server" exists ([ubos.tech/mcp/khoj](https://ubos.tech/mcp/khoj/faq/), [hexmos.com freedevtools](https://hexmos.com/freedevtools/mcp/cloud-services/kimbj0204--khoj/) - accessed 2026-06-20), which would make Khoj an MCP server exposing its store, not only a client. This conflicts with the prior note's flat "it is a CLIENT, not a server." Status: unverified from Khoj's own primary docs. What is verifiable from a first-party source is that the pivot product Pipali is an MCP client (see below). For Khoj specifically, the MCP server/client question is unverified against primary docs and should not be asserted either way.

## Pricing and license

- **License:** AGPL-3.0 (copyleft). Source: [github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj) - accessed 2026-06-20.
- **Self-host:** free, open-source. README: "Open-source and self-hostable" and "Get started - free." Source: [raw.githubusercontent.com/khoj-ai/khoj/master/README.md](https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md) - accessed 2026-06-20.
- **Khoj Cloud (hosted):** sunset as of 15 Apr 2026, so no current pricing tiers exist. Historical paid-subscription tiers existed (the sunset note references "a subscription, cloud-first service"), but the exact historical dollar amounts are not retrievable from the live sunset page and are marked unverified. Verbatim status: "We made the difficult decision to shut down the hosted service." ([app.khoj.dev](https://app.khoj.dev) - accessed 2026-06-20).
- **Enterprise:** README historically mentioned cloud / on-prem / hybrid enterprise offerings, but with the cloud sunset and the team's pivot, current enterprise availability and pricing are unverified.

## Benchmarks (vendor self-reported)

No vendor-reported retrieval benchmarks (precision/recall, MTEB-style numbers, latency tables) were found on the primary pages fetched (repo README, releases, search docs, setup docs). The only quantitative self-statement located is the qualitative claim that the cross-encoder is "slower but higher-quality" for reranking ([docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) - accessed 2026-06-20). Treat "no published benchmark numbers" as unverified-absent: the docs simply do not present them on the pages checked.

## vs imprnt

| Dimension | Khoj | imprnt |
|-----------|------|--------|
| Storage | Embeddings + metadata in PostgreSQL/pgvector behind a Django server. Your "memory" is DB rows. | Plain Markdown files on disk you own, no DB, no server. |
| Retrieval | Two-stage neural: bi-encoder vector recall + cross-encoder rerank. No documented BM25/lexical stage. | BM25 + grep over the files, deterministic and local. Zero embeddings, zero vectors. |
| AI reading | LLM reads top chunks returned by the neural pipeline, agents/automations on top. | The AI greps the files directly, LLM only shapes the query and reads top hits. |
| Capture | Bulk source sync + re-embed (Obsidian, Notion, folders, web). | Conscious, on-demand capture, one item at a time. |
| Entity model | Documents/chunks, agents can hold "custom knowledge", but no typed people/orgs/holdings contract found. | Typed entity contract: people/orgs/holdings with aliases, links, frontmatter. |
| Infra | Needs Postgres + pgvector + Python server to run. | No server. Files on disk. |
| Hosting | Self-host only now (cloud sunset 15 Apr 2026). | Self-host by design, private vault, owner-only. |
| Survives the tool | Memory is locked in a DB schema, losing the server/DB loses easy access to the index. | Files outlive the tool. Delete imprnt, the Markdown vault is still readable. |
| Project health | Coasting beta, hosted service dead, team pivoted away. | n/a (the comparison subject). |

The sharpest contrast is durability and the read path. Khoj's knowledge lives as vectors in a database that needs a running server, and the retrieval path runs neural models per query. imprnt keeps knowledge as plain files and ranks them with BM25 + grep, so the AI reads the files directly and the data survives the tool being deleted.

## When it wins over imprnt

- You want semantic / fuzzy recall across a large mixed corpus (PDFs, Word, Notion, images, org-mode) where conceptual similarity beats keyword overlap. Khoj's bi-encoder + cross-encoder pipeline is built for that, while BM25 + grep is literal.
- You want it to ingest many heterogeneous sources automatically via sync rather than capture items consciously one by one.
- You want many ready-made clients out of the box (Obsidian, Emacs, Desktop, Phone, WhatsApp, Browser) talking to one shared backend.
- You want built-in agents, scheduled automations, and a "deep research" mode bundled with the memory layer rather than assembled yourself.
- Caveat on all of the above: the project is coasting and the hosted option is gone, so "wins" come with the maintenance risk of a product the makers pivoted away from.

## The pivot: Pipali and Open Paper

After the cloud sunset, the khoj-ai team redirected engineering to two products. The sunset page states the redirect explicitly (paraphrased from the fetched page): the team is directing efforts toward Open Paper (openpaper.ai) "a research assistant for academic and industry literature review" and Pipali (pipali.ai) "an AI assistant for autonomous computer task completion", and that "Khoj remains fully open-source". Source: [app.khoj.dev](https://app.khoj.dev) - accessed 2026-06-20.

**Pipali** ([github.com/khoj-ai/pipali](https://github.com/khoj-ai/pipali), pipali.ai returns HTTP 403 so GitHub is the source). Verbatim repo description:

> "Research, create, automate. Work so fast it feels like play. Get an ai co-worker on your machine. It can read-write files, code safely in sandbox, use your browser."

Verbatim README tagline and features:

> "An AI co-worker on your computer that can safely interact with files + the web to finish real work."

> "Connect your tools - Integrate Jira, Linear, Slack etc. via MCP. Pipali can create issues, post messages, and interact with external APIs on your behalf."

> "Run safely - Pipali runs commands safely in a local sandbox that restricts file and network access."

[github.com/khoj-ai/pipali (README)](https://github.com/khoj-ai/pipali) - accessed 2026-06-20. Latest release: v0.6.0 on 01 Jun 2026 (v0.5.0 was 21 Apr 2026), 201 stars, Apache-2.0 license, ~522 commits on main. Sources: [github.com/khoj-ai/pipali/releases](https://github.com/khoj-ai/pipali/releases) and [github.com/khoj-ai/pipali](https://github.com/khoj-ai/pipali) - accessed 2026-06-20. Note on MCP: Pipali is explicitly an MCP client ("Integrate Jira, Linear, Slack etc. via MCP"), it consumes external MCP tools.

**Open Paper** ([github.com/khoj-ai/openpaper](https://github.com/khoj-ai/openpaper), [openpaper.ai](https://openpaper.ai)). Verbatim repo description:

> "Open Paper is a workbench for managing your research library. Read, annotate, and understand your papers all in one place. Use an AI assistant to conduct your literature review."

Verbatim README:

> "The Open Paper is a place to upload your paper, highlight, leave comments, take notes, and chat all in one place. Search through your existing corpus of annotated papers."

> "While Open Paper is open-source, it is not optimized for self-hosting. Our main focus is to make the most useful AI-assisted assistant for research."

[github.com/khoj-ai/openpaper (README)](https://github.com/khoj-ai/openpaper) - accessed 2026-06-20. 359 stars, AGPL-3.0, TypeScript-majority, ~1,973 commits on master, no tagged releases ("No releases published"). Sources: [github.com/khoj-ai/openpaper](https://github.com/khoj-ai/openpaper) and curl of the master README - accessed 2026-06-20.

**Neither Pipali nor Open Paper is a memory-vault competitor.** Pipali is a sandboxed desktop "AI co-worker" / computer-use agent that does work across files, browser, code, and SaaS tools (its README carries no mention of a memory vault, persistent knowledge store, or typed-entity layer). Open Paper is a single-purpose research-paper reading and annotation workbench scoped to a PDF library, and it is explicitly "not optimized for self-hosting." Neither stores a general personal-knowledge vault, neither offers a file-owned, grep-and-BM25 retrieval model, so neither competes with imprnt. The only product in the khoj-ai stable that is a memory-layer comparison is Khoj itself, which is now coasting.

## Sources

- [github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj) - accessed 2026-06-20 (repo description, stars 35.2k, AGPL-3.0, Python, latest tag)
- [raw.githubusercontent.com/khoj-ai/khoj/master/README.md](https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md) - accessed 2026-06-20 (project description, file types, clients, self-host)
- [github.com/khoj-ai/khoj/releases](https://github.com/khoj-ai/khoj/releases) - accessed 2026-06-20 (2.0.0-beta.24..28 dates, latest 26 Mar 2026)
- [github.com/khoj-ai/khoj/commits/master](https://github.com/khoj-ai/khoj/commits/master) - accessed 2026-06-20 (last commit 26 Mar 2026)
- [app.khoj.dev](https://app.khoj.dev) - accessed 2026-06-20 (Khoj Cloud sunset notice, 15 Apr 2026, pivot to Pipali + Open Paper)
- [docs.khoj.dev/features/search](https://docs.khoj.dev/features/search/) - accessed 2026-06-20 (bi-encoder, cross-encoder rerank, pgvector, no BM25 mentioned)
- [docs.khoj.dev/get-started/setup](https://docs.khoj.dev/get-started/setup) - accessed 2026-06-20 (no MCP mention in self-host docs)
- [docs.khoj.dev](https://docs.khoj.dev/) - accessed 2026-06-20 (overview)
- [railway.com/deploy/khoj](https://railway.com/deploy/khoj) - accessed 2026-06-20 (Postgres/pgvector deploy backend)
- [ycombinator.com/companies/khoj](https://www.ycombinator.com/companies/khoj) - accessed 2026-06-20 (YC S23, founders, ~$500K)
- [github.com/khoj-ai/pipali](https://github.com/khoj-ai/pipali) - accessed 2026-06-20 (Pipali description, README, 201 stars, Apache-2.0)
- [github.com/khoj-ai/pipali/releases](https://github.com/khoj-ai/pipali/releases) - accessed 2026-06-20 (v0.6.0 01 Jun 2026, v0.5.0 21 Apr 2026)
- [github.com/khoj-ai/openpaper](https://github.com/khoj-ai/openpaper) - accessed 2026-06-20 (Open Paper description, 359 stars, AGPL-3.0, TypeScript)
- raw.githubusercontent.com/khoj-ai/openpaper/master/README.md (via curl) - accessed 2026-06-20 (Open Paper README, "not optimized for self-hosting")
- [ubos.tech/mcp/khoj](https://ubos.tech/mcp/khoj/faq/) - accessed 2026-06-20 (third-party claim of a "Khoj's MCP Server", unverified against first-party docs)
- [hexmos.com freedevtools khoj MCP](https://hexmos.com/freedevtools/mcp/cloud-services/kimbj0204--khoj/) - accessed 2026-06-20 (third-party MCP listing)

## Confidence and gaps

- **MCP direction for Khoj: unverified.** Khoj's own self-host docs (accessed 2026-06-20) mention no MCP at all. Third-party listings claim a "Khoj's MCP Server" exists. The prior public/internal note said Khoj is "a CLIENT, not a server", and that flat claim is not confirmable from primary Khoj docs and may be wrong. Do not assert either direction for Khoj without a first-party doc. (Pipali-as-MCP-client is the one first-party-verified MCP fact.)
- **BM25 absence: documented-absent, not proven-absent.** The search docs describe only neural retrieval and do not mention BM25. That is strong evidence there is no user-facing lexical stage, but it is not a source-code audit.
- **Founding year discrepancy.** The sunset page says the project began in 2021, while YC lists the company as S23 (2023). Reported both. The exact first-commit date of the OSS project is unverified.
- **Historical Khoj Cloud pricing: unverified.** A paid subscription existed (the sunset note references it), but the live sunset page does not list the dollar tiers, and no archived pricing page was fetched. Exact tier prices are unverified.
- **Enterprise offering: unverified post-sunset.** README historically referenced enterprise cloud/on-prem/hybrid, and current availability after the pivot is not confirmed.
- **No vendor benchmarks found.** No precision/recall/latency numbers were located on the primary pages checked, so treat as unverified-absent.
- **Some architecture quotes were surfaced via WebSearch summaries of docs.khoj.dev rather than a clean direct fetch** (the /advanced/architecture path 404'd). The bi-encoder/cross-encoder/pgvector claims are consistent across the search-docs fetch and the deploy guide, so confidence is high, but the exact wording on chunking parameters is not pinned to a single clean page fetch.
- **Last-commit exact dates for Pipali and Open Paper** were not displayed numerically by GitHub in the fetches (only total commit counts: ~522 Pipali, ~1,973 Open Paper). Activity is clearly recent (Pipali v0.6.0 on 01 Jun 2026), so both are active, but a precise last-commit timestamp is unverified.
