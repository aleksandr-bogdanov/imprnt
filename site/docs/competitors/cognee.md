# cognee

**One-line:** An open-source AI-memory platform that ingests data in any format and builds a self-hosted, LLM-extracted knowledge graph (plus vector and relational stores) so AI agents get persistent long-term memory across sessions.
**Status (checked 2026-06-20):** active - latest stable release v1.1.3 shipped 2026-06-18, most recent `main` commit also 2026-06-18, and the company raised a $7.5M seed on 2026-02-19. Quote: "Cognee is the open-source AI memory platform for agents. Give your AI agents persistent long-term memory across sessions with a self-hosted knowledge graph engine." (GitHub repo description, https://github.com/topoteretes/cognee).
**Latest release:** v1.1.3, 2026-06-18 (a v1.2.0.dev1 pre-release exists, dated 2026-06-19) | **Stars:** ~17.9k | **License:** Apache-2.0 | **Hosting:** both (self-host + Cognee Cloud)

## What it is
cognee is a memory layer for AI agents. You feed it sources in any format, it runs an LLM pass to extract entities and relationships into a knowledge graph, and your agent later queries that graph (with vector hints and an LLM on the read path) to recall context.

> "Cognee is an open-source AI memory platform for AI Agents. Ingest data in any format, and Cognee continuously builds a self-hosted knowledge graph that gives your agents persistent long-term memory across sessions."

Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20)

> "Cognee combines vector embeddings, graph reasoning, and cognitive-science-grounded ontology generation to make documents both searchable by meaning and connected by relationships that evolve as your knowledge does."

Source: README "About Cognee" section, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20)

Note on framing drift: the README has been rebuilt around a four-verb API surface (`remember` / `recall` / `forget` / `improve`) with `recall` doing "auto-routing (picks best search strategy automatically)." This is a marketing wrapper over the same underlying engine. The lower-level Python API is still `add` -> `cognify` -> `search(query_type=SearchType.X)`, and the docs still enumerate the same SearchType modes (see Retrieval). Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).

## Status, timeline, recency
- 2024 - company founded in Berlin. Quote: "My team and I started Cognee in Berlin in 2024 with a simple question" and "Today, Cognee is running live in more than 70 companies." Source: https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed (accessed 2026-06-20).
- 2026-02-19 - $7.5M seed announced, led by Pebblebed (Pamela Vagata, OpenAI co-founder, and Keith Adams), with 42CAP, Vermilion Ventures, and angels from Google DeepMind, n8n, and Snowplow. Source: https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed (accessed 2026-06-20). Cross-confirmed by trade press: https://hyperight.com/cognee-seed-funding-ai-memory-technology/ and https://www.techinberlin.com/news/cognee-secures-7-5-million-seed-funding-to-develop-advanced-memory-layer-for-ai-agents (accessed 2026-06-20).
- 2026-05-29 - v1.1.1 released. Source: https://github.com/topoteretes/cognee/releases (accessed 2026-06-20).
- 2026-05-30 - v1.1.2 released. Source: https://github.com/topoteretes/cognee/releases (accessed 2026-06-20).
- 2026-06-17 - v1.2.0.dev0 pre-release. Source: https://github.com/topoteretes/cognee/releases (accessed 2026-06-20).
- 2026-06-18 - v1.1.3 released (current stable). The release "focused on making Cognee more robust when used in API (MCP) mode, clarifying documentation, and fixing several integration issues." Source: https://github.com/topoteretes/cognee/releases (accessed 2026-06-20).
- 2026-06-18 - most recent commit on `main`. Source: https://github.com/topoteretes/cognee/commits/main (accessed 2026-06-20).
- 2026-06-19 - v1.2.0.dev1 pre-release. Source: https://github.com/topoteretes/cognee/releases (accessed 2026-06-20).
- Recency verdict: active and actively developed. Stable release and last commit are both two days before the access date. Stars ~17.9k, forks ~1.9k, 7,804 commits on `main`. Source: https://github.com/topoteretes/cognee (accessed 2026-06-20).

## Where memory lives (storage and architecture)
cognee uses a three-store hybrid: a graph store, a vector store, and a relational store. The graph is the centerpiece and is built by an LLM extraction pass.

> "Cognee ships with lightweight defaults that run locally, and you can swap in production-ready backends when needed"

Source: https://docs.cognee.ai/core-concepts/architecture (accessed 2026-06-20)

The three layers, verbatim from the architecture docs:
> "Relational Store - Tracks your documents, their chunks, and provenance"
> "Vector Store - Holds embeddings for semantic similarity"
> "Graph Store - Captures entities and relationships in a knowledge graph"

Source: https://docs.cognee.ai/core-concepts/architecture (accessed 2026-06-20)

Supported backends, verbatim from the README:
- Graph databases: "Kuzu, Neo4j, FalkorDB, Neptune, Memgraph"
- Vector stores: "LanceDB, Qdrant, pgvector, Pinecone, Chroma, Weaviate, Milvus"
- Relational databases: "SQLite, Postgres"

Source: https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20)

Defaults (the embedded local mode): graph = Kuzu, vector = LanceDB, relational = SQLite. The MCP server "directly imports and uses the cognee library with local databases (SQLite, LanceDB ...)" as the default, with full feature support. Source: cognee-mcp tree, https://github.com/topoteretes/cognee/tree/main/cognee-mcp and DeepWiki install/setup, https://deepwiki.com/topoteretes/cognee/1.1-installation-and-setup (accessed 2026-06-20). Flagged: the Kuzu-as-default detail is confirmed by the docs/community wiki rather than a one-line README statement, so treat "Kuzu default" as docs-sourced, not README-verbatim.

The graph is LLM-built at ingest. The "cognify" step is what runs the extraction. Source: README and docs, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).

## Retrieval
Retrieval is selectable via a `SearchType` enum. The docs now document 15 SearchType modes in the Python enum (the dossier originally counted 14, and FEELING_LUCKY, an automatic-mode-selection type, has since been added). A 16th mode, INSIGHTS, exists but is MCP-only. The docs note, verbatim: "INSIGHTS is MCP-only and is not available through the Python SearchType enum." Source: https://docs.cognee.ai/core-concepts/main-operations/search (accessed 2026-06-20).

The 14 originally enumerated modes are each still present and real, with verbatim descriptions from the search docs:
1. GRAPH_COMPLETION (default) - "Graph-aware question answering" that "Finds relevant graph triplets using vector hints across indexed fields"
2. RAG_COMPLETION - "Retrieve-then-generate over text chunks" / "Pulls top-k chunks via vector search, stitches a context window"
3. HYBRID_COMPLETION - "Blended chunk + entity retrieval with LLM completion" combining "BM25 lexical chunks, semantic (vector) chunks, and entity/graph context"
4. CHUNKS - "Direct chunk retrieval" that "Returns the most similar text chunks to your query via vector search"
5. SUMMARIES - "Search over precomputed summaries" using "Vector search on `TextSummary` content for concise, high-signal hits"
6. GRAPH_SUMMARY_COMPLETION - "Graph-aware summary answering" / "Builds graph context like GRAPH_COMPLETION, then condenses it before answering"
7. GRAPH_COMPLETION_COT - "Chain-of-thought over the graph" that runs "validation rounds, generates a follow-up question, fetches new triplets"
8. GRAPH_COMPLETION_CONTEXT_EXTENSION - "Iterative context expansion" using "extension rounds to fetch and merge additional triplets until no new triplets are found"
9. TRIPLET_COMPLETION - "Triple-based retrieval with LLM completion" / "Retrieves graph triplets by vector similarity, resolves them to text"
10. CHUNKS_LEXICAL - "Lexical (keyword-style) chunk search" using "token-based BM25 lexical ranking, not semantic embeddings"
11. CODING_RULES - "Code-focused retrieval" that "Retrieves rules or code context from the `coding_agent_rules` nodeset"
12. TEMPORAL - "Time-aware retrieval" that "Retrieves and ranks content by temporal relevance (dates, events)"
13. CYPHER - "Run Cypher directly" / "Executes your Cypher query against the graph database"
14. NATURAL_LANGUAGE - "Natural language to Cypher to execution" / "Infers a Cypher query from your question using the graph schema"

The 15th Python-enum mode added since the original read:
15. FEELING_LUCKY - automatic mode selection (the type that picks a search strategy for you).

Source: https://docs.cognee.ai/core-concepts/main-operations/search (accessed 2026-06-20)

The flagship GRAPH_COMPLETION path puts an LLM on the read side and uses vectors only as a seed/hint, then traverses the graph, then generates:
1. "Vector store - seed nodes and edges are found by embedding similarity across indexed fields"
2. "Graph store - those seeds are resolved against the knowledge graph so the surrounding triplets (nodes + relationships) come back as structured context"
3. Merged graph + vector context is "formatted and (unless `only_context=True`) passed to the LLM"

Source: https://docs.cognee.ai/core-concepts/main-operations/search (accessed 2026-06-20)

So the default read mode is: embed the query, find seed nodes by vector similarity, expand to surrounding triplets in the graph, then call an LLM to write the answer. An LLM runs on essentially every default query (the read path), unless you pass `only_context=True`. cognee does include BM25-based lexical modes (CHUNKS_LEXICAL, and BM25 inside HYBRID_COMPLETION), but they are opt-in alternatives, not the default.

## Capture
Capture is a two-step explicit call the user (or agent) triggers: `add` snapshots the source, `cognify` runs the LLM extraction that builds the graph. The README's higher-level wording is `remember`:

> "remember - Store data permanently in the knowledge graph"
> "recall - Query with auto-routing for optimal search strategy"
> "forget - Delete data when needed"
> "improve - Enhance memory quality"

Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20)

The pipeline is described as "add + cognify + improve." Capture is conscious in the sense that someone calls `add`/`cognify` (or `remember`) on a source, but the entity/relationship extraction itself is automatic and LLM-driven, not hand-authored. Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).

Ingestion breadth: the pricing page lists "28+ data sources" in the free tier. Source: https://www.cognee.ai/pricing (accessed 2026-06-20).

## How the AI reads it
Multiple access surfaces:
- Python SDK - "support for custom AI agents through direct SDK connection." Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).
- CLI - the README references `cognee-cli`. Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).
- MCP server (`cognee-mcp`) - an official Model Context Protocol server lives in-repo. Source: https://github.com/topoteretes/cognee/tree/main/cognee-mcp (accessed 2026-06-20). Cross-listed at https://www.pulsemcp.com/servers/topoteretes-cognee-mcp (accessed 2026-06-20).
- Claude Code plugin - README markets cognee as "Available as a plugin for your Claude Code." Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).
- Local UI / notebooks / graph explorer. Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).
- Cognee Cloud - hosted service, invoked via `cognee.serve()`. Source: README, https://raw.githubusercontent.com/topoteretes/cognee/main/README.md (accessed 2026-06-20).

The model on the read path is the key architectural fact: the default GRAPH_COMPLETION mode calls an LLM to generate the answer from retrieved graph context (see Retrieval).

## Pricing and license
License: Apache-2.0. Source: https://github.com/topoteretes/cognee (accessed 2026-06-20).

Cloud pricing tiers (verbatim from the pricing page, https://www.cognee.ai/pricing, accessed 2026-06-20):

| Tier | Price | Key limits / inclusions |
|------|-------|--------------------------|
| Free | Free | "Build and run memory workflows with tasks and pipelines," auto-generate knowledge structures, integrated evaluations, "28+ data sources," community support |
| Developer | $35/month | 1,000 documents or 1 GB data, everything in Free, 1 user, hosted infrastructure, API endpoints, automated scaling, 10,000 API calls |
| Cloud (Team) [marked "Popular"] | $200/month | 2,500 documents or 2 GB data, everything in Developer, 10 users, multi-tenant architecture, memory grouping per user/domain, dedicated Slack channel, 10,000 API calls |
| On-Prem (Enterprise) | Custom | Everything in Cloud plus on-prem/private-cloud deployment, security/data isolation, architecture review, premium support/SLA, AI engineer access, roadmap prioritization |

Document top-ups (Developer and Team): "+1,000 docs ($35), +3,000 docs ($100), +15,000 docs ($750)." Source: https://www.cognee.ai/pricing (accessed 2026-06-20).

The open-source library is free and self-hostable under Apache-2.0. Pricing applies to the managed Cloud and on-prem support tiers.

## Benchmarks (vendor self-reported)
All numbers are cognee's own, on a tiny sample. Flag the sample size loudly.

Dataset: "a subset of 24 HotPotQA multi-hop questions designed to test complex reasoning and factual consistency." Source: https://www.cognee.ai/research-and-evaluation-results (accessed 2026-06-20).

cognee's reported scores (verbatim figures from the results page):
- Human-like correctness: 0.93
- DeepEval correctness: 0.85
- DeepEval F1: 0.84
- DeepEval EM: 0.69

Source: https://www.cognee.ai/research-and-evaluation-results (accessed 2026-06-20)

Methodology context from the companion blog: "24 questions from HotPotQA" run across "45 evaluation cycles," comparing cognee against Mem0, LightRAG, and Graphiti, with the caveat that for one competitor "we were not able to run their system, so we are including numbers they shared with us previously." The blog adds: "cognee consistently outperformed the other three platforms across all metrics." Source: https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825 (accessed 2026-06-20).

Caveat to carry forward: n = 24 questions is far too small to be statistically meaningful. The numbers are vendor-run, vendor-scored (DeepEval and "human-like correctness" are themselves LLM-graded), on a self-selected HotpotQA subset, comparing against competitors cognee ran (or did not run) itself. Treat as directional marketing, not evidence.

## vs imprnt
- Graph build cost: cognee runs an LLM extraction pass (`cognify`) at ingest to build a knowledge graph, and runs an LLM again on the default read path (GRAPH_COMPLETION generates the answer). imprnt rations the LLM: it spends tokens once on the conscious write (classify, summary, links), and keeps the read path deterministic - BM25 + grep over plain Markdown, no model in the loop unless the agent chooses to read top hits. cognee's default puts a model on essentially every query.
- Storage substrate: cognee needs three databases (graph + vector + relational, default Kuzu/LanceDB/SQLite). imprnt is plain Markdown files on disk, no database, no server, no embeddings, no vector index.
- Data ownership / longevity: imprnt's files are human-readable Markdown that outlive the tool. If imprnt vanishes, the notes are still notes. cognee's value lives in an LLM-built graph inside Kuzu/LanceDB. Delete cognee and you keep your raw inputs, but the extracted memory is in proprietary store formats, not a portable text corpus.
- Entity model: imprnt has a typed entity contract (people/orgs/holdings with explicit aliases, deterministic alias-grep resolution and merge). cognee extracts entities and relationships automatically via the LLM into a graph, which is broader but non-deterministic and not hand-curated.
- Retrieval philosophy: cognee defaults to vector-seeded graph traversal plus LLM generation across 15 SearchType modes. imprnt defaults to BM25 ranking the agent reads directly. cognee does offer lexical/BM25 modes (CHUNKS_LEXICAL, HYBRID_COMPLETION), but they are opt-in, not the default.
- Privacy posture: both can run fully local. cognee self-hosts the open-source library with embedded defaults. imprnt is local-by-construction, owner-only files, no cloud tier in the product at all. cognee additionally sells a hosted Cloud, which is a different trust surface if you opt into it.
- Capture: both are conscious/on-demand at the trigger level (you call `add`/`cognify` or you ask imprnt to ingest). The difference is what happens after: cognee auto-extracts a graph with a model, imprnt files a typed note the agent wrote with judgment.

## When it wins over imprnt
- You want multi-hop graph reasoning over a large corpus, where chained relationship traversal across many documents is the actual job (cognee's HotpotQA framing). imprnt's BM25-over-Markdown is built for retrieve-the-right-note, not for synthesizing across a dense entity graph.
- You are building for AI agents at scale and want a managed memory backend with multi-tenant isolation, per-user/per-domain memory grouping, audit trails, and a hosted API. cognee Cloud sells exactly that. imprnt is a single-owner personal vault, not an agent-fleet backend.
- You need a pluggable production database stack (Neo4j/Postgres/Qdrant/Pinecone) and want to swap backends as you grow. imprnt is deliberately just files.
- You want Cypher/natural-language-to-Cypher querying over a graph (cognee's CYPHER and NATURAL_LANGUAGE modes). imprnt has no graph query language.
- You want automatic entity/relationship extraction from raw dumps with zero hand-curation, accepting LLM cost and non-determinism in exchange. imprnt asks for a conscious write step instead.

## Sources
- [cognee README (main branch, raw)](https://raw.githubusercontent.com/topoteretes/cognee/main/README.md) - accessed 2026-06-20
- [cognee GitHub repository (description, stars, forks, license, language breakdown)](https://github.com/topoteretes/cognee) - accessed 2026-06-20
- [cognee GitHub releases](https://github.com/topoteretes/cognee/releases) - accessed 2026-06-20
- [cognee GitHub commits (main)](https://github.com/topoteretes/cognee/commits/main) - accessed 2026-06-20
- [cognee-mcp directory (in repo)](https://github.com/topoteretes/cognee/tree/main/cognee-mcp) - accessed 2026-06-20
- [Search docs - SearchType list and GRAPH_COMPLETION mechanics](https://docs.cognee.ai/core-concepts/main-operations/search) - accessed 2026-06-20
- [Architecture docs - three storage layers](https://docs.cognee.ai/core-concepts/architecture) - accessed 2026-06-20
- [Installation & Setup (DeepWiki) - default backends](https://deepwiki.com/topoteretes/cognee/1.1-installation-and-setup) - accessed 2026-06-20
- [Pricing page](https://www.cognee.ai/pricing) - accessed 2026-06-20
- [Research and evaluation results - benchmark scores](https://www.cognee.ai/research-and-evaluation-results) - accessed 2026-06-20
- [AI Memory Benchmarking blog (24 HotpotQA, 45 cycles)](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825) - accessed 2026-06-20
- [Seed funding announcement ($7.5M)](https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed) - accessed 2026-06-20
- [Hyperight - seed funding coverage](https://hyperight.com/cognee-seed-funding-ai-memory-technology/) - accessed 2026-06-20
- [Tech in Berlin - seed funding coverage](https://www.techinberlin.com/news/cognee-secures-7-5-million-seed-funding-to-develop-advanced-memory-layer-for-ai-agents) - accessed 2026-06-20
- [PulseMCP - official cognee MCP server listing](https://www.pulsemcp.com/servers/topoteretes-cognee-mcp) - accessed 2026-06-20

## Confidence and gaps
- High confidence: status (active), latest stable release (v1.1.3, 2026-06-18), last commit (2026-06-18), license (Apache-2.0), funding ($7.5M seed, 2026-02-19, Pebblebed-led), pricing tiers and prices, benchmark numbers and the 24-question sample size. All confirmed against primary sources fetched live.
- Search-mode count: the docs now document 15 SearchType modes in the Python enum (the dossier originally counted 14, before FEELING_LUCKY was added), plus a 16th MCP-only mode, INSIGHTS. The 14 originally enumerated modes are each still real and individually confirmed. The earlier "Total SearchTypes: 14" line was a paraphrase that does not appear verbatim on the live docs and has been removed. Confidence on the current count is medium-high (the enum is versioned and may keep growing). Source: https://docs.cognee.ai/core-concepts/main-operations/search (accessed 2026-06-20).
- Star count is approximate. The GitHub repo page reported "17.9k stars" at access time. Prior notes said ~18k. The live read is ~17.9k. Treat as roughly 18k, exact figure floats. Source: https://github.com/topoteretes/cognee (accessed 2026-06-20).
- Default databases (Kuzu graph / LanceDB vector / SQLite relational): the full supported-backend list is README-verbatim, but the specific "Kuzu is the default graph DB" claim is sourced from the docs/DeepWiki and the cognee-mcp directory rather than a single README sentence. LanceDB + SQLite as local defaults are stated in the MCP/local-mode docs. Confidence high, but the exact default-graph wording is docs-sourced, not README-quoted.
- Framing change is real but partly marketing: the README now leads with `remember`/`recall`/`forget`/`improve` and a "Claude Code plugin," while the underlying API is still `add`/`cognify`/`search(SearchType)`. I confirmed both layers exist. I did not independently exercise the Claude Code plugin, so its maturity is unverified.
- Benchmark validity: numbers are vendor-self-reported on n=24, LLM-graded, against vendor-run competitors. Flagged as directional only, not independent evidence. The "0.93 / 0.85" headline figures are real and quoted, but the sample is too small to generalize.
- "More than 70 live environments" and named customers (Bayer, University of Wyoming, Dilbloom, dltHub) are company self-claims from the funding post, not independently verified here.
- Exact current commit count (7,804 on main) and fork count (~1.9k) are as displayed on the repo page at access time and will drift.
