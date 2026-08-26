# Supermemory

**One-line:** A cloud-first, open-source (MIT) memory and context engine for AI - an embeddings-based hybrid RAG + fact-memory + user-profile API, with a free self-host local binary (`./.supermemory`, `localhost:6767`) that stores into an embedded graph engine rather than user-readable files.

**Status (checked 2026-08-27):** active - GitHub `pushed_at` is `2026-08-26T20:50:21Z` and the latest release shipped 2026-08-17, so the project is under active daily development. Repo description: "Memory and context engine + app that is extremely fast, scalable, and can be run fully locally. The Memory API for the AI era." [GitHub API](https://api.github.com/repos/supermemoryai/supermemory) - accessed 2026-08-27

**Latest release:** `server-v0.0.8`, published `2026-08-17T18:39:22Z` | **Stars:** 29,087 | **License:** MIT (Copyright (c) 2025 supermemory) | **Hosting:** both (cloud-first hosted platform + self-host local binary, see the re-check note on the new 10,000-document self-host cap)

**Re-check 2026-08-27:** stars 27,209 -> 29,087, server release 0.0.3 -> 0.0.8 ([releases](https://github.com/supermemoryai/supermemory/releases), accessed 2026-08-27). One claim moved: the server-v0.0.7 release notes (2026-08-15) introduce "**supermemory lite** — self-hosted is licensed up to 10,000 documents (read the license at git.new/memory); the cap is enforced at the API and shown at boot", which qualifies the unlimited free-self-host framing below. The repo LICENSE file is still plain MIT, the self-hosting docs still say the binary "is free, open source", and git.new/memory redirects to the repo itself (all accessed 2026-08-27), so the cap is currently sourced only to the release notes. Also since: pluggable embeddings (v0.0.5) and a v0.0.8 emergency fix for a 0.0.7 migration that "silently wiped search vectors".

## What it is

Supermemory is a memory/context layer for AI applications. It auto-extracts facts from conversations, builds per-user profiles, resolves contradictions, expires stale facts, and serves RAG + personalized context through one API. It is sold both as a hosted platform and as a consumer app, with a free self-hostable local binary.

> "State-of-the-art memory and context engine for AI. And yes - you can use it as a company/personal brain."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "Supermemory is the memory and context layer for AI. **#1 on [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LoCoMo](https://github.com/snap-research/locomo), and [ConvoMem](https://github.com/Salesforce/ConvoMem)** — the three major benchmarks for AI memory."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "Your AI forgets everything between conversations. Supermemory fixes that. / It automatically learns from conversations, extracts facts, builds user profiles, handles knowledge updates and contradictions, forgets expired information, and delivers the right context at the right time. Full RAG, connectors, file processing — the entire context stack, one system."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

The team frames itself as a research lab, not just an SDK shop:

> "We are a research lab building the engine, plugins and tools around it."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

## Status, timeline, recency

- **2024-02-27** - repository created (`created_at: 2024-02-27T20:10:04Z`). [GitHub API](https://api.github.com/repos/supermemoryai/supermemory) - accessed 2026-06-20
- **2025-10-06** - TechCrunch reports the seed round. > "Nineteen-year-old founder Dhravya Shah" ... "Supermemory has secured seed funding of $2.6 million" ... "led by Susa Ventures, Browder Capital, and SF1.vc". [TechCrunch](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/) - accessed 2026-06-20
- **2025-10** - Susa Ventures publishes its investment memo, calling it a "$2.6M pre-seed round" (note: TechCrunch says "seed", Susa says "pre-seed" - the dollar figure agrees at $2.6M, the round label conflicts). > "early users are already processing billions of tokens a day on the platform." [Susa Ventures](https://susaventures.substack.com/p/our-investment-in-supermemory) - accessed 2026-06-20
- **Traction at funding time** - > "50K+ users, millions of saved items, and 10K GitHub stars in under a year." [Susa Ventures](https://susaventures.substack.com/p/our-investment-in-supermemory) - accessed 2026-06-20
- **2026-06-04** - first public `supermemory-server` release candidates (`server-v0.0.1-rc.7` at `2026-06-04T01:41:53Z`, `rc.8` at `01:47:54Z`), marking the self-host binary going public. [GitHub releases API](https://api.github.com/repos/supermemoryai/supermemory/releases?per_page=5) - accessed 2026-06-20
- **2026-06-10** - `server-v0.0.1` (`2026-06-10T13:27:40Z`) and `server-v0.0.2` (`2026-06-10T14:01:20Z`). [GitHub releases API](https://api.github.com/repos/supermemoryai/supermemory/releases?per_page=5) - accessed 2026-06-20
- **2026-06-13** - latest release `server-v0.0.3` ("supermemory-server 0.0.3"), `2026-06-13T00:59:16Z`. Release bodies are empty in the API. The releases web page shows the top note as "fix: thread issue". [GitHub releases API](https://api.github.com/repos/supermemoryai/supermemory/releases?per_page=5) - accessed 2026-06-20
- **2026-06-19/20** - last push `2026-06-19T22:12:46Z`, repo `updated_at: 2026-06-20T04:31:06Z`, 22 open issues. Active. [GitHub API](https://api.github.com/repos/supermemoryai/supermemory) - accessed 2026-06-20

Recency verdict: active and shipping. The self-host server line is brand new (first RC June 2026, latest tag a week before access date), so the local binary is early (still in `0.0.x`).

## Where memory lives (storage and architecture)

Cloud-first by default. The hosted platform handles storage. The self-host binary stores into an embedded graph engine with local embeddings, in a hidden `./.supermemory` directory. This is an opaque managed store, not the plain-Markdown user-readable files imprnt uses.

> "First boot sets up the embedded Supermemory graph engine, local embeddings, and your credentials, then prints an API key. The full Memory API — documents, memories, user profiles, hybrid search — runs against `http://localhost:6767`."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Your data, one directory** — everything lives in `./.supermemory`, easy to back up or move."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

The under-the-hood architecture diagram in the README lists five subsystems behind one entry point:

> "├── Memory Engine     Extracts facts, tracks updates, resolves contradictions, / │                     auto-forgets expired info / ├── User Profiles     Static facts + dynamic context built from engine, always fresh / ├── Hybrid Search     RAG + Memory in one query / ├── Connectors        Real-time sync from Google Drive, Gmail, Notion, GitHub... / └── File Processing   PDFs, images, videos, code → searchable chunks"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

The Susa memo describes the underlying stack as a vector-DB-centric pipeline:

> "vector database, content parser, extractors—designed to sync, store, and serve context across agents and platforms."
- [Susa Ventures](https://susaventures.substack.com/p/our-investment-in-supermemory) - accessed 2026-06-20

Self-host tiers (local free vs Enterprise) differ on the engine deployment, not on giving you raw files:

> "Local Version: Memory engine: 'Full graph engine, embedded' ... Models: 'Bring your own key (any provider, incl. fully offline)' ... Scalability: 'One machine, one process' ... Hosting: 'You run it' ... Support: 'Community'"
- [Self-hosting docs, local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) - accessed 2026-06-20

> "self-hosted binary — is free, open source, and built for individual developers: local-first workflows, prototyping, air-gapped experiments, privacy-sensitive side projects."
- [Self-hosting docs, local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) - accessed 2026-06-20

The prior-notes infra detail (Cloudflare Workers + Postgres/pgvector) is not stated verbatim in the README or the docs pages fetched here. The founder's prior work was at Cloudflare per TechCrunch/Susa, and Susa confirms a "vector database", but the exact hosted backend (Workers, Postgres, pgvector) is **unverified** from the primary sources fetched. Flagged below.

## Retrieval

Embeddings-based hybrid search with a model in the read loop. Two layers run together by default: RAG document chunks plus a fact "Memory" layer, with an auto-maintained user profile available in a single call. No grep, no BM25, no plain-text file scan.

> "🔍 **Hybrid Search** | RAG + Memory in a single query. Knowledge base docs and personalized context together."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "Hybrid (default) — RAG + Memory in one query ... // Returns deployment docs (RAG) + user's deploy preferences (Memory)"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Memory is not RAG.** RAG retrieves document chunks — stateless, same results for everyone. Memory extracts and tracks *facts about users* over time. It understands that \"I just moved to SF\" supersedes \"I live in NYC.\" Supermemory runs both together by default, so you get knowledge base retrieval *and* personalized context in every query."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

User profile retrieval is presented as a fast pre-built object:

> "👤 **User Profiles** | Auto-maintained user context — stable facts + recent activity. One call, ~50ms."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "One call. ~50ms. Inject into your system prompt and your agent instantly knows who it's talking to."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Note on the latency claim: the README's verbatim figure is "~50ms" for the profile call. The prior-notes "sub-300ms" figure is **not** found in the sources fetched here, so the specific sub-300ms number is unverified. The ~50ms profile figure is what the README states.

## Capture

Automatic by default. The engine extracts facts from conversations, builds profiles, resolves contradictions, and auto-forgets expired info. Manual add and connectors and multi-modal file ingest are also supported.

> "🧠 **Memory** | Extracts facts from conversations. Handles temporal changes, contradictions, and automatic forgetting."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Automatic forgetting.** Supermemory knows when memories become irrelevant. Temporary facts (\"I have an exam tomorrow\") expire after the date passes. Contradictions are resolved automatically. Noise never becomes permanent memory."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Background auto-capture via the MCP/plugins flow:

> "Once installed, Supermemory runs in the background: / 1. **You talk to your AI normally.** ... / 2. **Supermemory extracts and stores the important stuff.** Facts, preferences, project context — not noise. / 3. **Next conversation, your AI already knows you.**"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Manual add + multi-modal extractors + connectors:

> "📄 **Multi-modal Extractors** | PDFs, images (OCR), videos (transcription), code (AST-aware chunking). Upload and it works."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "🔌 **Connectors** | Google Drive · Gmail · Notion · OneDrive · GitHub — auto-sync with real-time webhooks."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "await client.add({ content: \"User loves TypeScript and prefers functional patterns\", containerTag: \"user_123\", });"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Memory is partitioned by container tags (their answer to scoping):

> "Memory is scoped with **projects** (container tags) so you can separate work and personal context, or organize by client, repo, or anything else."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

## How the AI reads it

Through a hosted REST API, JS/Python SDKs, an MCP server (OAuth or API key), framework adapters, and per-tool plugins. The AI never reads files directly. It calls an API. Offline mode points the same API at a local model via Ollama.

> "The Supermemory App, browser extension, plugins and MCP server gives any compatible AI assistant persistent memory."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

MCP tools exposed:

> "`memory` | Save or forget information. ... `recall` | Search memories by query. Returns relevant memories + your user profile summary. ... `context` | Injects your full profile (preferences, recent activity) into the conversation at start."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

MCP install + supported clients:

> "npx -y install-mcp@latest https://mcp.supermemory.ai/mcp --client claude --oauth=yes"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Claude Desktop** · **Cursor** · **Windsurf** · **VS Code** · **Claude Code** · **OpenCode** · **OpenClaw** · **Hermes**"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

SDKs + framework integrations:

> "npm install supermemory    # or: pip install supermemory"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Vercel AI SDK** · **LangChain** · **LangGraph** · **OpenAI Agents SDK** · **Mastra** · **Agno** · **Claude Memory Tool** · **n8n**"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Offline / bring-your-own-model:

> "**Fully offline if you want** — point it at Ollama (`gpt-oss:20b` works great) and nothing leaves your machine."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

> "**Same API as the platform** — prototype locally, ship on the hosted platform by changing `baseURL`."
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

## Pricing and license

License: MIT for the open-source core.

> "MIT License / Copyright (c) 2025 supermemory"
- [LICENSE, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/LICENSE) - accessed 2026-06-20

Hosted pricing (from the pricing page, verbatim figures). Tiers are credit/usage based:

| Tier | Price | Key inclusions |
|------|-------|----------------|
| Free | $0/mo | ~$5/mo usage credit, Hermes Plugin, Supermemory MCP, community support |
| Pro | $19/mo | ~$20/mo usage credit, unlimited storage, unlimited users, 2 teammates, Google Drive/Notion/OneDrive connectors, plugins, email support |
| Max | $100/mo | ~$130/mo usage credit, unlimited storage, unlimited users, Gmail & Granola connectors, plugins, priority support |
| Scale | $399/mo | ~$600/mo usage credit, unlimited storage/users, up to 10 teammates, all connectors, auto top-up with spend caps, priority support, SOC 2/HIPAA, self-hosted option |
| Enterprise | Custom | Unlimited usage, committed-spend, dedicated account manager, forward-deployed engineer, air-gapped self-hosting, SOC 2/HIPAA/GDPR, uptime SLA |

- [Pricing page](https://supermemory.ai/pricing) - accessed 2026-06-20

Self-host local binary is free and open source:

> "self-hosted binary — is free, open source, and built for individual developers"
- [Self-hosting docs, local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) - accessed 2026-06-20

Note: the pricing tier inclusions above are as summarized by the page fetch. The dollar figures ($0 / $19 / $100 / $399 / Custom) are the headline prices. The "~$X/mo usage credit" lines indicate this is metered/credit pricing, so real cost scales with usage beyond the included credit.

## Benchmarks (vendor self-reported)

All benchmark claims below are vendor-reported by Supermemory in its own README. Treat as marketing until independently reproduced.

> "Supermemory is state of the art across all major AI memory benchmarks: / **LongMemEval** | Long-term memory across sessions with knowledge updates | **81.6% — #1** / **LoCoMo** | Fact recall across extended conversations (single-hop, multi-hop, temporal, adversarial) | **#1** / **ConvoMem** | Personalization and preference learning | **#1**"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

They also ship their own benchmark harness (also vendor-authored):

> "We also built **[MemoryBench](https://supermemory.ai/docs/memorybench/overview)** — an open-source framework for standardized, reproducible benchmarks of memory providers. Compare Supermemory, Mem0, Zep, and others head-to-head"
- [README, raw, main branch](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20

Caveat: the "#1" rankings and the 81.6% LongMemEval figure come from the vendor's own README and its own MemoryBench tool. No independent third-party confirmation was fetched. The LoCoMo and ConvoMem "#1" claims carry no numeric score in the README, only the rank.

## vs imprnt

The core split is storage substrate and read path. Supermemory is an embeddings + vector + graph engine behind an API, cloud-first, with an LLM/model in the loop for extraction and (effectively) retrieval. imprnt is plain-Markdown files on local disk, retrieved by grep + BM25 with zero embeddings and no model in the read loop.

- **Where memory lives.** Supermemory: managed store - hosted by default, or an opaque embedded "graph engine + local embeddings" in `./.supermemory` when self-hosted. imprnt: human-readable `.md` files in a folder tree you own (`chmod 700`), no DB, no opaque blob.
- **Retrieval.** Supermemory: embeddings-based hybrid (RAG chunks + fact memory + profile), a model in the loop. imprnt: BM25 over title/tags/body + grep, pure local arithmetic, the LLM only shapes the query at the front and reads the top hits at the end, never in the middle. No embeddings, no vectors, no MCP over the corpus.
- **Capture.** Supermemory: automatic by default, runs in the background, auto-forgets and auto-resolves contradictions on its own judgment. imprnt: conscious, on-demand capture - you say "ingest this" / "harvest this", contradictions are marked `> superseded by [[...]]` not silently overwritten, nothing auto-expires behind your back.
- **Read path cost.** Supermemory: API call (often hosted) per read, model-assisted. imprnt: deterministic, free, local, runs thousands of times with no per-query LLM.
- **Outlives the tool.** imprnt's files are usable with `grep`, `cat`, Obsidian, any editor, if imprnt is deleted tomorrow. Supermemory's self-host data is in an embedded engine ("easy to back up or move" as a directory, but not a plain-text format you read with standard tools). The hosted data sits on their platform.
- **Entity model.** imprnt: typed entity contract (people/orgs/holdings) with aliases, wikilinks as graph edges, explicit folders. Supermemory: facts + user profiles (static/dynamic) + a knowledge graph it builds internally, scoped by container tags, not a user-authored typed schema.
- **License.** Both open-source-friendly: Supermemory core is MIT. imprnt is the local-vault contract. Supermemory layers a paid hosted business on top (Free -> $19 -> $100 -> $399 -> Enterprise).

## When it wins over imprnt

- You are building a product for many end-users and need a drop-in memory API with SDKs, an MCP server, and framework adapters (Vercel AI SDK, LangChain, OpenAI Agents SDK) rather than a personal file vault.
- You want fully automatic background capture and forgetting with no conscious ingest step, and you accept the engine making those calls for you.
- You need multi-modal ingest out of the box (PDF OCR, video transcription, AST-aware code chunking) and live connectors (Drive, Gmail, Notion, OneDrive, GitHub) with real-time webhooks.
- You want a hosted, scalable platform with SOC 2 / HIPAA / GDPR and an SLA (Scale/Enterprise tiers), which imprnt as a local file vault does not provide.
- You want semantic/embeddings retrieval that matches on meaning across paraphrase, where pure BM25 keyword ranking would miss, and you are fine with a model in the read loop and per-query cost.
- You want per-user profiles served as a ready object in ~50ms for injecting into an agent's system prompt at scale.

## Sources

- [Supermemory README (raw, main branch)](https://raw.githubusercontent.com/supermemoryai/supermemory/main/README.md) - accessed 2026-06-20
- [Supermemory GitHub repo page](https://github.com/supermemoryai/supermemory) - accessed 2026-06-20
- [GitHub repo metadata API (stars, license, dates)](https://api.github.com/repos/supermemoryai/supermemory) - accessed 2026-06-20
- [GitHub releases API (latest tags + dates)](https://api.github.com/repos/supermemoryai/supermemory/releases?per_page=5) - accessed 2026-06-20
- [GitHub releases page](https://github.com/supermemoryai/supermemory/releases) - accessed 2026-06-20
- [Supermemory LICENSE (raw)](https://raw.githubusercontent.com/supermemoryai/supermemory/main/LICENSE) - accessed 2026-06-20
- [Supermemory pricing page](https://supermemory.ai/pricing) - accessed 2026-06-20
- [Supermemory docs introduction](https://supermemory.ai/docs/introduction) - accessed 2026-06-20
- [Supermemory self-hosting docs: local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) - accessed 2026-06-20
- [TechCrunch: A 19-year-old nabs backing from Google execs for his AI memory startup Supermemory](https://techcrunch.com/2025/10/06/a-19-year-old-nabs-backing-from-google-execs-for-his-ai-memory-startup-supermemory/) - accessed 2026-06-20
- [Susa Ventures: Our Investment in Supermemory](https://susaventures.substack.com/p/our-investment-in-supermemory) - accessed 2026-06-20

## Confidence and gaps

- **Hosted backend (Cloudflare Workers + Postgres/pgvector):** unverified from primary sources fetched. Susa confirms a "vector database" and the founder's Cloudflare background, but the exact hosted stack (Workers, Postgres, pgvector specifically) is not stated in the README, docs, or pricing pages I fetched. Treat the prior-notes infra detail as inference.
- **Latency "sub-300ms":** unverified. The README's verbatim latency figure is "~50ms" for the user-profile call. I did not find a "sub-300ms" claim in the fetched sources. The ~50ms figure applies to one specific call, not all retrieval.
- **Round label "seed" vs "pre-seed":** conflicting primary sources. TechCrunch says "seed funding of $2.6 million". Susa Ventures says "$2.6M pre-seed round". The amount ($2.6M) and date (early October 2025) agree, the round label does not.
- **Angel list (Jeff Dean, Cloudflare CTO Dane Knecht, etc.):** verified via TechCrunch verbatim ("Cloudflare's Knecht, Google AI chief Jeff Dean, DeepMind product manager Logan Kilpatrick, Sentry founder David Cramer, and executives from OpenAI, Meta, and Google"). The prior note's phrasing "Cloudflare CTO" matches Dane Knecht.
- **Self-host data format ("not user-readable files"):** strongly implied but not stated as a negative in the docs. The README says data "lives in `./.supermemory`" via "the embedded Supermemory graph engine, local embeddings" - an engine-managed store, not plain Markdown. The docs page I fetched did not explicitly confirm or deny a human-readable on-disk format, so "not user-readable" is a reasonable inference from "graph engine + local embeddings", not a verbatim vendor statement.
- **Release-note bodies:** empty in the GitHub releases API. The web releases page surfaced "fix: thread issue" for the top release, treat as minor/patch.
- **Benchmark numbers:** vendor-self-reported in the project's own README and via its own MemoryBench tool. No independent reproduction fetched. The 81.6% LongMemEval figure and all three "#1" rankings are marketing claims by construction.
- **Star count precision:** 27,209 per the GitHub metadata API at access time (the repo web page rounds it to "27.2k"). Stars move, this is the 2026-06-20 figure.
