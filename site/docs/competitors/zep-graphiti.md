# Zep / Graphiti

**One-line:** Graphiti is an Apache-2.0 open-source engine that builds bi-temporal knowledge graphs for AI agents (extracting entities, facts, and relationships into a graph database like Neo4j, FalkorDB, or Amazon Neptune, with hybrid semantic + BM25 + graph-traversal retrieval), and Zep is the commercial hosted SaaS built on top of it (a managed "Context Lake" served over an API, founded 2023, YC W24, Daniel Chalef).

**Status (checked 2026-06-20):** active - both alive and shipping. Graphiti repo `getzep/graphiti` pushed 2026-06-19, latest release v0.29.2 published 2026-06-08, `archived: false`. GitHub API reports `pushed_at: 2026-06-19T00:37:03Z`, `archived: false`, 27,639 stars ([api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti), accessed 2026-06-20). Zep Cloud is a live commercial product with a public pricing page and active blog ([getzep.com/pricing](https://www.getzep.com/pricing), accessed 2026-06-20). Note: the self-hostable Zep server (Community Edition) is dead - "Zep Community Edition, which allows you to host Zep locally, is deprecated and no longer supported" ([help.getzep.com/faq](https://help.getzep.com/faq), accessed 2026-06-20). Graphiti is the only open-source path that remains.

**Latest release:** v0.29.2, 2026-06-08 | **Stars:** 27,639 | **License:** Apache-2.0 | **Hosting:** both (Graphiti self-host on Apache-2.0, Zep cloud SaaS / enterprise BYOC)

## What it is

Graphiti is a framework for building temporal knowledge graphs that an AI agent reads as its memory. It ingests "episodes" (chat turns, documents, JSON), an LLM extracts entities and relationships into a graph database, every fact carries a validity window, and queries hit a hybrid retriever. The repo README states the purpose directly.

> "Graphiti is a framework for building and querying temporal context graphs for AI agents. Unlike static knowledge graphs, Graphiti's context graphs track how facts change over time, maintain provenance to source data, and support both prescribed and learned ontology — making them purpose-built for agents operating on evolving, real-world data."

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - accessed 2026-06-20

The GitHub repo description is terser.

> "Build Real-Time Knowledge Graphs for AI Agents"

- [api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti) - accessed 2026-06-20

Zep is the commercial layer on top. The official docs define the split between the open-source engine and the hosted service.

> "Graphiti builds temporal knowledge graphs — Context Graphs — for AI agents, fusing semantic, full-text, and graph search over evolving entities, facts, and relationships."

> "agent memory at enterprise scale, built on Graphiti: a governed Context Lake of millions of Context Graphs served in milliseconds on top of Zep's proprietary Context Graph Engine."

- [help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview) - accessed 2026-06-20

So the relationship is: Graphiti = the open engine you self-host (one graph at a time, you bring the DB). Zep = the proprietary, hosted, multi-tenant "Context Graph Engine" that serves millions of those graphs with governance, SLA, SOC 2, and HIPAA. The proprietary serving engine is not open source.

## Status, timeline, recency

- **2023** - Zep founded. YC company page lists "Founding Year: 2023" and founders Daniel Chalef, Paul, Preston ([ycombinator.com/companies/zep-ai](https://www.ycombinator.com/companies/zep-ai), accessed 2026-06-20).
- **Winter 2024 (W24)** - Zep's Y Combinator batch. YC page tagline: "Agent Context Is Hard. We Fixed It." Team size listed as 5, location San Francisco, status Active ([ycombinator.com/companies/zep-ai](https://www.ycombinator.com/companies/zep-ai), accessed 2026-06-20). Specific funding amount is unverified (see Confidence and gaps).
- **2024-08-08** - Graphiti repo created. GitHub API `created_at: 2024-08-08T22:08:30Z` ([api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti), accessed 2026-06-20).
- **2025-01-20** - The Zep paper "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" submitted to arXiv (2501.13956). Authors: Preston Rasmussen, Pavlo Paliychuk, Travis Beauvais, Jack Ryan, Daniel Chalef. Submission date "Monday, 20 January 2025", v1 only, no listed revisions ([arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956), accessed 2026-06-20).
- **~early 2025** - Graphiti crossed 20k GitHub stars "in under 12 months" per third-party coverage ([generational.pub/p/building-ai-products-with-zep](https://www.generational.pub/p/building-ai-products-with-zep), accessed 2026-06-20). Now 27,639 (primary, below).
- **2025-04 (April 2025)** - Zep Community Edition (the self-hostable Zep server) deprecated. After this, Graphiti is the only open-source component. Confirmed via FAQ: "Zep Community Edition, which allows you to host Zep locally, is deprecated and no longer supported" ([help.getzep.com/faq](https://help.getzep.com/faq), accessed 2026-06-20). The exact April-2025 date is from third-party summaries and is partially unverified (see gaps).
- **2025-05-06** - Zep publishes its rebuttal blog "Is Mem0 Really SOTA in Agent Memory?" reporting a corrected LoCoMo J score of 75.14% for itself. Page dated "May 6, 2025 (with updates through June 3, 2026)" ([blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), accessed 2026-06-20).
- **2025-05-08** - Mem0 CTO Deshraj files the public correction (zep-papers issue #5) reporting 58.44% for Zep on LoCoMo, not 84% ([github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5), accessed 2026-06-20).
- **2025-05-31** - Zep platform feature retirements take effect (memory search, session summaries, document collections) per the May 2025 retirements blog ([blog.getzep.com/zep-feature-retirements-may-2025/](https://blog.getzep.com/zep-feature-retirements-may-2025/), accessed 2026-06-20).
- **2026-04-27** - Graphiti v0.29.0, "Major efficiency and Internal Architecture changes" ([github.com/getzep/graphiti/releases](https://github.com/getzep/graphiti/releases), accessed 2026-06-20). Note: the GitHub releases summarizer rendered the year as 2024 for several tags, but the latest-release API call returns `published_at: 2026-06-08T14:25:35Z` for v0.29.2, and the repo `pushed_at` is 2026-06-19, so these releases are 2026, not 2024. The year in the bullets reflects the corrected 2026 timeline.
- **2026-06-08** - Graphiti v0.29.2 "FalkorDB Bug Fixes" published. GitHub API `releases/latest` returns `tag_name: v0.29.2`, `published_at: 2026-06-08T14:25:35Z` ([api.github.com/repos/getzep/graphiti/releases/latest](https://github.com/getzep/graphiti/releases), accessed 2026-06-20).
- **2026-06-19** - last push to the Graphiti repo. GitHub API `pushed_at: 2026-06-19T00:37:03Z`, `updated_at: 2026-06-20T03:28:25Z` ([api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti), accessed 2026-06-20). Recency: this is one day before the access date. The project is actively maintained, not dormant.
- **Recency snapshot (2026-06-20):** 27,639 stars, 2,770 forks, 388 open issues, default branch `main`, license Apache-2.0, `archived: false` ([api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti), accessed 2026-06-20).

## Where memory lives (storage and architecture)

Memory lives in a graph database, as a bi-temporal knowledge graph. Graphiti does not store flat Markdown or use a vector store alone. It writes typed nodes (entities) and typed edges (facts/relationships), and each edge carries time fields, into one of a small set of supported graph backends.

Supported backends per the README:

> "Neo4j 5.26"
> "FalkorDB 1.1.2"
> "Amazon Neptune Database Cluster or Neptune Analytics Graph"
> "Kuzu 0.11.2 (deprecated)"

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - accessed 2026-06-20

The docs list three first-class backends ("Graphiti operates on three database backends: Neo4j, FalkorDB, or Amazon Neptune") and the README marks Kuzu deprecated, so the prior note's "defaults to Neo4j (also FalkorDB, Neptune, Kuzu)" is correct in spirit, with Kuzu now deprecated ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20).

The defining storage property is the bi-temporal model with fact invalidation, not deletion.

> "Facts have validity windows. When information changes, old facts are invalidated — not deleted. Query what's true now, or what was true at any point in time."

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - accessed 2026-06-20

The paper abstract describes the engine as fusing two data shapes into one graph.

> "Zep addresses this fundamental limitation through its core component Graphiti -- a temporally-aware knowledge graph engine that dynamically synthesizes both unstructured conversational data and structured business data while maintaining historical relationships."

- [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956) - accessed 2026-06-20

On the Zep side, the store is a hosted multi-tenant abstraction over the same model. The docs call it "a governed Context Lake of millions of Context Graphs served in milliseconds on top of Zep's proprietary Context Graph Engine" ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20). With Zep you do not provision a graph DB. With Graphiti you do, and the docs are explicit that self-hosting "now requires Graphiti plus a compatible graph database," which is a real operational commitment (third-party summary of the docs at [help.getzep.com/faq](https://help.getzep.com/faq), accessed 2026-06-20).

## Retrieval

Retrieval is hybrid: semantic embeddings + keyword (BM25) + graph traversal, combined so the system avoids per-query LLM summarization.

> "semantic embeddings, keyword (BM25), and graph traversal for low-latency, high-precision queries without reliance on LLM summarization."

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - accessed 2026-06-20

The docs restate the same three-way fusion: "fusing semantic, full-text, and graph search over evolving entities, facts, and relationships" ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20).

So BM25 is present, but it is one of three signals, and it runs over the graph backend, not over plain files. The retriever needs embeddings (a vectorizer/embedding model) and a graph database to traverse edges. The temporal model also shapes retrieval: you can query "what's true now" or "what was true at any point in time," which a plain keyword search cannot do ([raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md), accessed 2026-06-20). Zep Cloud serves retrieval at "sub-200ms latency" per the docs ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20).

## Capture

Capture is automatic and LLM-driven, per episode. You hand Graphiti an episode (a message, a document chunk, structured JSON) and an LLM extracts the entities, relationships, and time-stamped facts and writes them into the graph, resolving against what is already there.

The README frames the engine as one that tracks change and keeps provenance: "track how facts change over time, maintain provenance to source data, and support both prescribed and learned ontology" ([raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md), accessed 2026-06-20). The docs describe the local building blocks as "entity and edge extraction, the bi-temporal model, fact invalidation, and hybrid retrieval" ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20).

The capture cost is real: every ingested episode runs LLM extraction (entity/edge extraction plus dedup/invalidation), which is why Zep meters usage in credits and rate-limits "processing" on the Free tier (see Pricing). This is the opposite of a deterministic, free write step. The intelligence is spent on every write, and the same model that extracts also decides invalidation. "Custom entity & edge types" and "custom extraction instructions" let you steer the extractor (per the pricing tiers below).

## How the AI reads it

The AI reads Graphiti through an SDK/API and through an MCP server, and reads Zep through its hosted Cloud API and SDKs.

For Graphiti self-host, the README documents two components: an MCP server and a REST service.

> "The `mcp_server` directory contains a Model Context Protocol (MCP) server implementation for Graphiti."
> "The `server` directory contains an API service for interacting with the Graphiti API. It is built using FastAPI."

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - accessed 2026-06-20

So an agent talks to Graphiti either via the Python SDK (calling search/add-episode), via the bundled FastAPI REST service, or via the bundled MCP server so a tool-using assistant (Claude, Cursor) can query the graph as tools. The MCP server queries the graph, it does not let the model grep files, there are no files to grep. For Zep Cloud the agent uses Zep's hosted API and SDKs against the managed Context Lake, with the proprietary Context Graph Engine doing extraction and retrieval server-side ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-06-20).

## Pricing and license

License: Graphiti is Apache-2.0 (GitHub API `license.spdx_id: Apache-2.0`, name "Apache License 2.0", [api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti), accessed 2026-06-20). The Zep Cloud serving engine is proprietary and closed. The previously self-hostable Zep server (Community Edition) is deprecated and unsupported ([help.getzep.com/faq](https://help.getzep.com/faq), accessed 2026-06-20).

Zep Cloud pricing, verbatim tiers ([getzep.com/pricing](https://www.getzep.com/pricing), accessed 2026-06-20):

| Tier | Price | Key inclusions |
|------|-------|----------------|
| Free | $0/month | 1,000 credits/month (no rollover), 2 projects, 5 custom entity & edge types, variable rate limits, lower priority processing |
| Flex | $125/month ($1,250/year, saves 17%) | 50,000 credits/month with 30-day rollover, 600 requests/minute, 5 projects, 10 custom entity & edge types, 1-day API logs, unlimited memories/retrieval/users. Overage: $25 per 10,000 credits; auto top-up at 20% ($25) |
| Flex Plus | $375/month ($3,750/year, saves 17%) | 200,000 credits/month with 60-day rollover, 1,000 requests/minute, 10 projects, 20 custom entity & edge types, Observations, custom extraction instructions, Webhooks, Analytics, 7-day API logs, unlimited memories/retrieval/users. Overage: $75 per 40,000 credits; auto top-up at 20% ($75) |
| Enterprise | Custom (negotiated rates) | Custom credits, guaranteed rate limits with SLA, unlimited projects, SOC 2 Type II, HIPAA BAA, 1-year API/audit logs, dedicated Slack/Teams support and account manager |

Note from the pricing page: "Memory, retrieval, storage, and users are unmetered." The metered unit is credits, which are consumed by processing (extraction/ingest), so the cost scales with how much you capture, not how much you store ([getzep.com/pricing](https://www.getzep.com/pricing), accessed 2026-06-20). Enterprise adds BYOC: "For enterprise customers who need VPC residency and maximum control, we offer BYOC deployments where Zep runs in your own cloud infrastructure" ([help.getzep.com/faq](https://help.getzep.com/faq), accessed 2026-06-20).

## Benchmarks (vendor self-reported)

These are the vendor's own numbers. Treat them as marketing claims with a published methodology, not neutral third-party results. The LoCoMo figure is disputed (below), and this dossier names no winner there.

From the Zep paper abstract ([arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956), accessed 2026-06-20):

> "In the DMR benchmark, which the MemGPT team established as their primary evaluation metric, Zep demonstrates superior performance (94.8% vs 93.4%)."

> "In this evaluation, Zep achieves substantial results with accuracy improvements of up to 18.5% while simultaneously reducing response latency by 90% compared to baseline implementations."

So: DMR 94.8% (vs MemGPT 93.4%), LongMemEval up to +18.5% accuracy with 90% lower latency vs baseline. The paper is a single arXiv submission (v1, 2025-01-20) by Zep's own team, so it is self-published, not independently peer-reviewed.

The LoCoMo dispute (no winner declared here):

- Zep originally claimed roughly 84% on LoCoMo. Mem0's CTO Deshraj filed a public correction (zep-papers issue #5, 2025-05-08) reporting 58.44% instead, alleging two methodology errors: "The evaluation incorrectly incorporated questions from the adversarial (5th) category, which was specifically designated for exclusion" and "Your modifications to both the `system_prompt` and the retrieval `TEMPLATE` deviate from the settings used by all other baselines" ([github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5), accessed 2026-06-20).
- Zep rebutted in its blog (2025-05-06), reporting a corrected score for itself: "Zep achieving an **75.14% +/- 0.17** J score, significantly outperforming Mem0's best configuration (_Mem0 Graph_) by approximately **10%** relative improvement," and arguing "These implementation errors fundamentally misrepresent how Zep is designed to function, inevitably leading to the suboptimal performance reported in Mem0's paper" ([blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), accessed 2026-06-20).

So three numbers exist for the same Zep-on-LoCoMo question: ~84% (Zep original), 58.44% (Mem0's correction), 75.14% (Zep's re-run). Each side accuses the other of a flawed harness. No neutral third party has settled it. This dossier cites all three and declares no winner.

## vs imprnt

The two systems answer the same need (an AI that remembers across sessions) with opposite engineering philosophies.

- **Storage substrate.** Graphiti stores memory as a bi-temporal graph inside Neo4j / FalkorDB / Neptune. imprnt stores memory as plain Markdown files on disk with YAML frontmatter. With imprnt the data is human-readable text you own with no engine. With Graphiti the data is rows in a graph DB you must run, and is only meaningful through Graphiti's query layer.
- **Retrieval cost model.** Graphiti's retrieval is hybrid semantic + BM25 + graph traversal, which needs an embedding model and a graph DB in the loop. imprnt's retrieval is BM25 + grep over files, pure local arithmetic, zero embeddings, zero server, zero vectors. imprnt explicitly forbids embeddings/vectors/MCP-over-the-vault on the read path. Graphiti makes the opposite bet: more machinery for temporal precision.
- **Capture cost model.** Graphiti runs LLM extraction on every ingested episode (entities, edges, invalidation), metered in credits on Zep. imprnt spends the LLM once on the WRITE path then keeps it out of the READ hot path. Both invest intelligence at write time, but Graphiti's write is heavier and, on Zep, billed per use.
- **The contract.** imprnt has a small typed entity contract (people/orgs/holdings with aliases, summary, tags) that a human can read and edit by hand. Graphiti has a richer ontology (typed nodes/edges with validity windows and provenance), but it lives in a DB, not in editable text, and on Zep the serving engine is closed.
- **Survival.** imprnt's central promise is that the files outlive the tool: delete imprnt and your Markdown is still readable. With Graphiti your knowledge is a graph DB dump that needs Graphiti (or a custom reader) to interpret, and with Zep Cloud your data sits in a proprietary managed service. Zep's own history makes this concrete: the self-hostable Zep server (Community Edition) was deprecated and is "no longer supported," and a batch of platform features was retired in May 2025, so the hosted path is one the vendor actively prunes ([help.getzep.com/faq](https://help.getzep.com/faq) and [blog.getzep.com/zep-feature-retirements-may-2025/](https://blog.getzep.com/zep-feature-retirements-may-2025/), accessed 2026-06-20).
- **Temporal reasoning.** This is Graphiti's genuine edge. It can answer "what was true at time T" and invalidate stale facts with validity windows. imprnt handles contradiction by marking a stale line superseded and correcting the one entity note, which is auditable but not a queryable time-travel index. If point-in-time history queries are the requirement, Graphiti does something imprnt does not.

## When it wins over imprnt

- You need point-in-time temporal queries ("what did we believe about this customer last March") with automatic fact invalidation. imprnt marks supersession but does not give you a queryable bi-temporal index.
- You are ingesting high-volume streams (every chat turn, structured business records) where automatic per-episode entity/edge extraction at scale matters more than hand-curated notes, and you accept paying the LLM on every write.
- You want a managed, governed service with SOC 2 Type II, a HIPAA BAA, SLAs, and sub-200ms retrieval at enterprise scale, and you are fine with a proprietary hosted engine ([help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview) and [getzep.com/pricing](https://www.getzep.com/pricing), accessed 2026-06-20).
- Your retrieval genuinely needs multi-hop graph traversal across many connected entities (relationship-heavy queries), where a graph DB beats BM25 over flat files.
- You are building a multi-agent or multi-user product (millions of separate graphs / users) rather than one person's private vault. Zep's Context Lake is built for "millions of Context Graphs," which is a fleet-of-users shape, not a single-owner local store.

## Sources

- [raw.githubusercontent.com/getzep/graphiti/main/README.md](https://raw.githubusercontent.com/getzep/graphiti/main/README.md) - Graphiti README (primary, repo) - accessed 2026-06-20
- [api.github.com/repos/getzep/graphiti](https://api.github.com/repos/getzep/graphiti) - GitHub API repo metadata (stars, license, pushed_at, archived) - accessed 2026-06-20
- [github.com/getzep/graphiti/releases](https://github.com/getzep/graphiti/releases) - Graphiti releases page - accessed 2026-06-20
- [api.github.com/repos/getzep/graphiti/releases/latest](https://github.com/getzep/graphiti/releases) - latest release (v0.29.2, 2026-06-08) - accessed 2026-06-20
- [help.getzep.com/graphiti/getting-started/overview](https://help.getzep.com/graphiti/getting-started/overview) - Zep / Graphiti docs overview (Context Lake, Context Graph Engine, backends, latency) - accessed 2026-06-20
- [help.getzep.com/faq](https://help.getzep.com/faq) - Zep FAQ (Community Edition deprecation, BYOC, self-host) - accessed 2026-06-20
- [getzep.com/pricing](https://www.getzep.com/pricing) - Zep Cloud pricing tiers - accessed 2026-06-20
- [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956) - "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (DMR, LongMemEval) - accessed 2026-06-20
- [blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) - Zep's LoCoMo rebuttal (75.14%) - accessed 2026-06-20
- [github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5) - Mem0's LoCoMo correction (58.44%) - accessed 2026-06-20
- [blog.getzep.com/zep-feature-retirements-may-2025/](https://blog.getzep.com/zep-feature-retirements-may-2025/) - Zep feature retirements, May 2025 - accessed 2026-06-20
- [ycombinator.com/companies/zep-ai](https://www.ycombinator.com/companies/zep-ai) - YC company page (W24, 2023, founders, location) - accessed 2026-06-20
- [generational.pub/p/building-ai-products-with-zep](https://www.generational.pub/p/building-ai-products-with-zep) - third-party (20k stars in under 12 months, corroborating only) - accessed 2026-06-20

## Confidence and gaps

- **High confidence (primary-verified):** Graphiti is active (pushed 2026-06-19, latest release v0.29.2 on 2026-06-08, `archived: false`), Apache-2.0, 27,639 stars, supported backends (Neo4j, FalkorDB, Neptune, Kuzu deprecated), bi-temporal model with fact invalidation, hybrid semantic+BM25+graph retrieval, MCP server + FastAPI REST service, Zep Cloud pricing tiers and prices, the arXiv paper's DMR 94.8% and LongMemEval up to 18.5% / 90% latency claims, the LoCoMo three-way dispute (84% / 58.44% / 75.14%), Community Edition deprecation, Zep founded 2023, YC W24.
- **Release-date rendering caveat:** the GitHub releases-page summarizer initially printed "2024" for several tags (v0.29.0 through v0.29.2). The authoritative `releases/latest` API returns `published_at: 2026-06-08T14:25:35Z` and the repo `pushed_at` is `2026-06-19`, so the real timeline is 2026. The "2024" strings were a fetch artifact, corrected above.
- **Funding amount: unverified.** The YC page lists status Active and team size 5 but no funding stage or dollar amount, and I did not find a primary press release stating a round size or total raised. Zep is YC-backed (W24) and described as "backed" in third-party pieces, but the specific amount is unverified from a primary source.
- **Community Edition deprecation exact date: partially verified.** The FAQ confirms it is "deprecated and no longer supported" (primary). The specific "April 2025" date comes from third-party summaries, not a dated primary announcement I could fetch, so the month is partially unverified while the fact of deprecation is confirmed.
- **arXiv paper is self-published, not peer-reviewed.** Benchmarks are vendor self-reported by Zep's own team. The LoCoMo number specifically is contested by Mem0, and no neutral arbiter has resolved it. Per the brief, no winner is declared.
- **Founders "Paul, Preston" first-name-only:** the YC page rendered two co-founders by first name. The paper authors include Preston Rasmussen and Paul (likely Pavlo) and others, so full founder identities beyond Daniel Chalef are only partially verified.
- **Last-commit timestamp vs last-push:** I used `pushed_at` (2026-06-19) as the recency proxy. The exact last individual commit SHA/time was not separately fetched, but `pushed_at` reflects the most recent push and is sufficient to label the project active.
