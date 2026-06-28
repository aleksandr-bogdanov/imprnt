# mem0 (and OpenMemory)

**One-line:** mem0 is an open-source plus hosted "universal memory layer for AI Agents" that extracts facts from conversation turns with an LLM, stores them across a managed vector store (plus optional graph and key-value history), and serves them back through SDKs, a REST API, an MCP server, and a cloud platform.

**Status (checked 2026-06-20):** active - very actively developed. The GitHub repo description reads "Universal memory layer for AI Agents", the latest core SDK releases (Python v2.0.7, Node v3.0.9) are dated June 17 2026, the most recent commit on `main` is dated June 19 2026, and the company raised a $24M Series A announced October 28 2025. The OpenMemory sub-component, by contrast, is being sunset (see the OpenMemory subsection).

**Latest release:** Mem0 Python SDK v2.0.7, June 17 2026 (Node SDK v3.0.9 same day) | **Stars:** 58.9k | **License:** Apache-2.0 (open-source SDK). The hosted platform is proprietary/commercial | **Hosting:** both (self-host the OSS SDK or use the cloud platform at app.mem0.ai)

## What it is

mem0 is a memory layer you drop in front of an LLM app so it remembers across sessions. At write time it sends conversation turns to an LLM that extracts durable facts, then it stores those facts in a vector database (with optional graph and history stores). At read time it retrieves the relevant facts and injects them into the prompt, instead of replaying the full transcript.

> "Mem0 ("mem-zero") enhances AI assistants and agents with an intelligent memory layer, enabling personalized AI interactions."
- https://raw.githubusercontent.com/mem0ai/mem0/main/README.md (accessed 2026-06-20)

> "Universal memory layer for AI Agents"
- https://github.com/mem0ai/mem0 (repo description, accessed 2026-06-20)

> "a universal, self-improving memory layer for LLM applications that enables persistent context across sessions."
- https://docs.mem0.ai (accessed 2026-06-20)

The pitch is token efficiency at scale: instead of stuffing a full transcript into context, mem0 retrieves a small set of extracted facts.

> "competitive accuracy while using under 7,000 tokens per retrieval call" compared to full-context methods that "routinely consume 25,000+ tokens per query."
- https://mem0.ai/research (accessed 2026-06-20)

## Status, timeline, recency

- 2024-01 - Company launched by Taranjeet Singh and Deshraj Yadav. Per TechCrunch, "The YC-backed startup, launched in January 2024, has raised $24 million", and Yadav is described as having "led the AI Platform at Tesla Autopilot". https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/ (accessed 2026-06-20)
- 2025-05-13 - OpenMemory MCP launched as a local-first MCP memory server. "Mem0 announced the OpenMemory MCP Server on May 13, 2025, introducing a local-first memory layer compliant with the Model Context Protocol (MCP)". https://mem0.ai/blog/introducing-openmemory-mcp (accessed 2026-06-20)
- 2025-10-28 - $24M Series A announced. "Mem0 Raises $24M Series A to Build Memory Layer for AI Agents". Seed led by Kindred Ventures, Series A led by Basis Set Ventures, with Peak XV Partners, GitHub Fund, and Y Combinator, plus angels (Scott Belsky, Dharmesh Shah, Olivier Pomel, Paul Copplestone, James Hawkins, Thomas Dohmke, Lukas Biewald). https://mem0.ai/series-a and https://finance.yahoo.com/news/mem0-raises-24m-series-build-170000229.html (accessed 2026-06-20)
- 2026-04-16 - New "token-efficient" memory algorithm (V3) shipped: single-pass extraction plus multi-signal retrieval. "The new algorithm collapses extraction into a single LLM call that only adds." LoCoMo 71.4 -> 91.6, LongMemEval 67.8 -> 93.4. https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm (accessed 2026-06-20)
- 2026-06-17 - Latest core releases: Mem0 Python SDK v2.0.7 and Mem0 Node SDK v3.0.9 (plus a Mem0 OpenCode Plugin v0.2.0). 343 releases total. https://github.com/mem0ai/mem0/releases (accessed 2026-06-20)
- 2026-06-19 - Most recent commit on `main`. https://github.com/mem0ai/mem0/commits/main (accessed 2026-06-20)
- Recency verdict: not dormant. Active development, multiple releases per week, commit within the last 48 hours of the access date, 58.9k stars (up from the ~48k in the prior notes). https://github.com/mem0ai/mem0 (accessed 2026-06-20)

## Where memory lives (storage and architecture)

mem0 is a managed multi-store. The primary store is a vector database. There is an optional graph store and a key-value history store. Default embeddings are OpenAI (the prior-notes default of text-embedding-3-small). The README now also names GPT-5-mini as the default extraction LLM.

Vector backends - the current SDK docs list 20 (exact count confirmed live, correcting the stale page that said 24, prior notes said ~20):

> "Total Count: 20"
- https://docs.mem0.ai/components/vectordbs/overview (accessed 2026-06-20)

The full list (Python supports all, TypeScript supports a subset): Qdrant, Chroma, PGVector, Upstash Vector, Milvus, Pinecone, MongoDB, Azure, Redis, Valkey, Elasticsearch, OpenSearch, Supabase, Vertex AI, Weaviate, FAISS, LangChain, Amazon S3 Vectors, Databricks, Turbopuffer.

> "The TypeScript implementation currently only supports Qdrant, Redis, Valkey, Vectorize and in-memory vector database,"
- https://docs.mem0.ai/components/vectordbs/overview (accessed 2026-06-20)

LLMs and embedders are pluggable. The README points at component docs rather than listing exhaustively, and names a default model:

> "Mem0 supports a variety of LLMs" with GPT-5-mini as default
- https://raw.githubusercontent.com/mem0ai/mem0/main/README.md (accessed 2026-06-20). Component lists at https://docs.mem0.ai/components/llms/overview and https://docs.mem0.ai/components/embedders/overview

Graph store: the optional graph layer backs Neo4j/Memgraph (per prior notes and the multi-signal "entity graph boost" in the retrieval design below). This dossier could not independently re-fetch the graph-store component page live, so the exact graph-backend list is unverified here.

Self-host vs cloud: the OSS SDK can run fully self-hosted (`docker compose up`), or you can use the managed cloud platform.

> "Self-Hosted: `docker compose up` (server deployment)"
> "Cloud Platform: Sign up at app.mem0.ai"
- https://raw.githubusercontent.com/mem0ai/mem0/main/README.md (accessed 2026-06-20)

## Retrieval

The April 2026 V3 algorithm fuses three signals in parallel and merges the scores. This matches the prior notes (semantic + BM25 keyword + entity matching).

> "single-pass hierarchical extraction and multi-signal retrieval."
> The retrieval mechanism operates through three concurrent scoring approaches: "Semantic similarity, Keyword matching, and Entity matching. The combined score outperforms individual signal scores."
- https://mem0.ai/research (accessed 2026-06-20)

> The system employs "three scoring passes in parallel, semantic similarity, keyword matching, and entity matching, and fuses the results."
- https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm (accessed 2026-06-20)

A key nuance from the algorithm write-up: BM25 and entity matching are re-ranking boosts, not candidate generators. Only semantic (vector) search produces the candidate set.

> "Query preprocessing (lemmatize keywords, extract entities) -> Parallel scoring: 1. Semantic search (vector similarity) 2. BM25 keyword search (normalized term matching) 3. Entity matching (entity graph boost) -> Score fusion -> Top-K selection."
> "BM25 is a boost signal, not a recall expander. Only semantic search results are candidates - BM25 and entity scores boost ranking but don't add new candidates."
- https://mem0.ai/blog/state-of-ai-agent-memory-2026 / https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm (accessed 2026-06-20)

The retrieval still depends on the vector store and embeddings: the candidate set is vector-similarity-driven, with keyword/entity used only to re-rank.

## Capture

Capture is automatic LLM extraction from conversation turns. You pass messages. An LLM call extracts durable facts and writes them as memories. The V3 design collapses extraction into a single add-only LLM pass that preserves history rather than overwriting.

> "single pass ADD-only extraction," treating "agent-generated facts as first-class" with equal weight to other information types.
- https://mem0.ai/research (accessed 2026-06-20)

> "The new algorithm collapses extraction into a single LLM call that only adds." This approach "preserves historical state changes rather than overwriting previous facts."
- https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm (accessed 2026-06-20)

So capture spends an LLM call on every write (the extraction). This is the opposite of imprnt's "conscious capture on demand" model: mem0 captures implicitly from the chat stream.

## How the AI reads it

mem0 exposes memory through multiple read/write surfaces:

> "SDK: `pip install mem0ai` or `npm install mem0ai`"
> "CLI: `npm install -g @mem0/cli` or `pip install mem0-cli`"
> "Cloud Platform: Sign up at app.mem0.ai"
- https://raw.githubusercontent.com/mem0ai/mem0/main/README.md (accessed 2026-06-20)

So: Python/TS SDK, a CLI, a REST API (cloud platform), an MCP server (OpenMemory / the self-hosted server), and an OpenCode plugin. The AI does not grep files. It calls the SDK/API, which runs a vector query plus re-rank against the configured store and returns a ranked memory set.

## Pricing and license

License: the OSS SDK is Apache-2.0. The hosted platform is a commercial SaaS with these tiers (all from https://mem0.ai/pricing, accessed 2026-06-20):

| Tier | Price | Add requests | Retrieval requests | Projects | Support | Analytics |
|------|-------|--------------|--------------------|----------|---------|-----------|
| Free (Hobby) | $0 | 10,000 | 1,000 | 1 | Community | Starter |
| Starter | $19/month | 50,000 | 5,000 | 1 | Community | Growth |
| Growth | $79/month | 200,000 | 20,000 | 3 | Email | Basic (+ Pro features) |
| Pro | $249/month | 500,000 | 50,000 | Unlimited | Private Slack | Advanced (+ Enterprise features) |
| Custom | Usage-based | custom | custom | - | Private Slack + SLA | Advanced |

End users are unlimited on every tier.

> "Not finding something that fits your need? We also support usage-based pricing."
- https://mem0.ai/pricing (accessed 2026-06-20)

## Benchmarks (vendor self-reported)

From the README (V3 before -> after):

> "LoCoMo: Old 71.4 -> New 91.6"
> "LongMemEval: Old 67.8 -> New 94.8"
> "BEAM (1M): 64.1"
> "BEAM (10M): 48.6"
- https://raw.githubusercontent.com/mem0ai/mem0/main/README.md (accessed 2026-06-20)

From the research page (slightly different headline LoCoMo/LongMemEval numbers, with token counts):

> "LoCoMo: 92.5 OVERALL" with "6956 Mean Tokens"
> "LongMemEval: 94.4 OVERALL" with "6787 Mean Tokens"
> "BEAM 1M: 64.1 OVERALL" with "6719 Mean Tokens"
> "BEAM 10M: 48.6 OVERALL" with "6914 Mean Tokens"
- https://mem0.ai/research (accessed 2026-06-20)

Note the LoCoMo figure differs between sources (91.6 in README, 92.5 on the research page) and the LongMemEval figure also differs (94.8 README, 94.4 research, 93.4 on the algorithm blog). These are all vendor self-reported and not internally consistent across mem0's own pages.

### The mem0-vs-Zep LoCoMo dispute (no winner cited)

Zep published a rebuttal arguing mem0's LoCoMo comparison was run with implementation errors that hurt Zep's reported numbers. Both sides' claims, no adjudication:

mem0's claim: mem0 reports SOTA-class LoCoMo numbers (91.6-92.5 depending on the page) and a token/latency advantage. https://mem0.ai/research (accessed 2026-06-20)

Zep's counterclaim:

> "Mem0 utilized a user graph structure designed for single user-assistant interactions but assigned the user role to _both_ participants."
> "Timestamps were passed by appending them to messages, rather than using Zep's dedicated created_at field."
> "Searches were performed sequentially instead of in parallel, artificially inflating Zep's reported search latency."
> When properly implemented, Zep reports "an 75.14% +/- 0.17 J score, significantly outperforming Mem0's best configuration (Mem0 Graph) by approximately 10% relative improvement."
> "a p95 search latency of 0.632 seconds. This is faster than the 0.778 seconds reported by Mem0 for Zep."
- https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ (accessed 2026-06-20)

This dossier cites no winner. Both numbers are vendor self-reported and the methodologies are disputed.

## OpenMemory (the local MCP) - being sunset

OpenMemory was mem0's local-first, private, open-source MCP memory server: a Docker stack (API + Qdrant + Postgres) exposing memory to MCP clients like Claude Desktop, Cursor, and Windsurf over SSE, with a dashboard for browsing/deleting memories and controlling per-client access.

> "OpenMemory is your personal memory layer for LLMs - private, portable, and open-source."
> "Your memories live locally, giving you complete control over your data."
- https://docs.mem0.ai/openmemory/overview and https://raw.githubusercontent.com/mem0ai/mem0/main/openmemory/README.md (accessed 2026-06-20)

Launch and architecture:

> "Mem0 announced the OpenMemory MCP Server on May 13, 2025"
> "You spin up OpenMemory (API, Qdrant, Postgres) with a single docker-compose command. OpenMemory MCP achieves efficient memory storage and real-time communication through Qdrant vector databases and Server-Sent Events (SSE)."
- https://mem0.ai/blog/introducing-openmemory-mcp and https://www.cometapi.com/mem0-releases-openmemory-mcp/ (accessed 2026-06-20)

It ran locally on a fixed port:

> OpenMemory runs as an MCP server at `http://localhost:8765` with API documentation at `http://localhost:8765/docs`.
- https://docs.mem0.ai/openmemory/overview (accessed 2026-06-20)

Current status - sunset:

> "Sunsetting Notice: OpenMemory is being sunset. For local self-hosted memory with a dashboard, please use the Mem0 self-hosted server instead."
- https://raw.githubusercontent.com/mem0ai/mem0/main/openmemory/README.md (accessed 2026-06-20)

So the local-MCP story that the prior notes leaned on is being retired in favor of the broader Mem0 self-hosted server. If you cared about OpenMemory specifically as the local, file-controllable option, that path is closing.

## vs imprnt

| Dimension | mem0 | imprnt |
|-----------|------|--------|
| Storage substrate | Vector DB (20 backends) + optional graph + history store | Plain Markdown files on local disk |
| Retrieval | Vector-similarity candidates, BM25/entity as re-rank boosts, needs embeddings + a vector store | BM25 + grep over the files, zero embeddings, no vector store |
| LLM in the read loop | Embedding/model calls on retrieval, managed multi-store | LLM only shapes the query and reads top-N hits, no LLM re-rank in core |
| Capture | Automatic LLM extraction from every conversation turn (add-only) | Conscious, on-demand capture (you say "ingest this") |
| Data model | Extracted "memories" (facts) | Typed entity contract: people/orgs/holdings with aliases, frontmatter, links |
| Server | MCP server / cloud platform / Docker stack | No server, the AI greps the files directly |
| Survives the tool | Memories live in a vector DB tied to mem0's schema/SDK | Files outlive the tool, delete imprnt and the Markdown remains readable |
| License/hosting | Apache-2.0 SDK + commercial SaaS tiers | local, owner-only, no SaaS |

The core philosophical split: mem0 puts an LLM on the write path (extraction per turn) and a vector store on the read path. imprnt rations the LLM to the conscious write step and the query-shaping/answer ends, with deterministic BM25 + grep in the middle and no embeddings at all. mem0's data is "memories" in a managed store. imprnt's data is plain files you own that read fine without the tool.

## When it wins over imprnt

- You are building an agent product for many end users and want a drop-in memory API/SDK with a cloud control plane, billing, and per-project isolation. mem0's whole shape (REST API, unlimited end users per tier, projects) is built for that. imprnt is a single-owner private vault.
- You need automatic capture from a high-volume chat stream without a human deciding what to file. mem0 extracts on every turn. imprnt is deliberately on-demand.
- You already run a vector database (Qdrant, Pinecone, pgvector, etc.) and want memory to plug into it across 20 backends.
- You want semantic recall over fuzzy paraphrase where embeddings genuinely beat keyword matching, and you accept the embedding cost/dependency.
- You need an MCP server today wired into Cursor/Claude/Windsurf for multiple tools (though note OpenMemory is being sunset toward the Mem0 self-hosted server).

## Sources

- [mem0 GitHub repo (description, stars, releases count)](https://github.com/mem0ai/mem0) - accessed 2026-06-20
- [mem0 README (raw, main branch)](https://raw.githubusercontent.com/mem0ai/mem0/main/README.md) - accessed 2026-06-20
- [mem0 GitHub releases](https://github.com/mem0ai/mem0/releases) - accessed 2026-06-20
- [mem0 GitHub commits (main)](https://github.com/mem0ai/mem0/commits/main) - accessed 2026-06-20
- [mem0 docs - vector DB overview (20 backends)](https://docs.mem0.ai/components/vectordbs/overview) - accessed 2026-06-20
- [mem0 docs - home/overview](https://docs.mem0.ai) - accessed 2026-06-20
- [mem0 docs - LLMs overview](https://docs.mem0.ai/components/llms/overview) - accessed 2026-06-20
- [mem0 docs - embedders overview](https://docs.mem0.ai/components/embedders/overview) - accessed 2026-06-20
- [mem0 pricing](https://mem0.ai/pricing) - accessed 2026-06-20
- [mem0 research / benchmarks](https://mem0.ai/research) - accessed 2026-06-20
- [mem0 blog - token-efficient memory algorithm (2026-04-16)](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm) - accessed 2026-06-20
- [mem0 blog - State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) - accessed 2026-06-20
- [mem0 blog - Introducing OpenMemory MCP (2025-05-13)](https://mem0.ai/blog/introducing-openmemory-mcp) - accessed 2026-06-20
- [mem0 Series A page ($24M)](https://mem0.ai/series-a) - accessed 2026-06-20
- [OpenMemory docs - overview](https://docs.mem0.ai/openmemory/overview) - accessed 2026-06-20
- [OpenMemory README (raw, sunset notice)](https://raw.githubusercontent.com/mem0ai/mem0/main/openmemory/README.md) - accessed 2026-06-20
- [Zep rebuttal - "Lies, Damn Lies, and Statistics: Is Mem0 really SOTA?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) - accessed 2026-06-20
- [TechCrunch - mem0 raises $24M (2025-10-28)](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/) - accessed 2026-06-20
- [Yahoo Finance - mem0 raises $24M Series A](https://finance.yahoo.com/news/mem0-raises-24m-series-build-170000229.html) - accessed 2026-06-20
- [CometAPI - OpenMemory MCP architecture (Qdrant/Postgres/Docker)](https://www.cometapi.com/mem0-releases-openmemory-mcp/) - accessed 2026-06-20

## Confidence and gaps

- High confidence: status (active), latest releases and dates, last commit date, star count (58.9k), Apache-2.0 SDK license, the 20 vector backends (exact count confirmed live, correcting the stale "24" page), full pricing tiers with prices, the V3 retrieval design (semantic candidates + BM25/entity re-rank boosts), automatic LLM extraction capture, the $24M Series A and investors, OpenMemory's sunset notice and original architecture.
- Benchmark inconsistency (flagged, not an error on my part): mem0's own pages disagree on LoCoMo (91.6 README vs 92.5 research) and LongMemEval (93.4 algorithm blog vs 94.4 research vs 94.8 README). All vendor self-reported. Quoted all variants rather than picking one.
- Graph store backends (Neo4j/Memgraph): carried from prior notes and consistent with the "entity graph boost" language, but I could not re-fetch the graph-store component page live, so the exact graph-backend list is unverified.
- Default embedding model: prior notes say text-embedding-3-small (OpenAI). The README I fetched named GPT-5-mini as the default extraction LLM but did not state the default embedder verbatim, so the specific default embedder is unverified against today's live README.
- Founders/founding year (Taranjeet Singh and Deshraj Yadav, launched January 2024): TechCrunch states "The YC-backed startup, launched in January 2024", which corrects the prior-notes "2023" figure. mem0's own Series A page omitted founder names in the fetched content, so the launch date and founders are sourced to TechCrunch.
- OpenMemory supported MCP clients (Claude/Cursor/Windsurf): the launch coverage names them explicitly. The current docs/README I fetched gave only a generic `<client-name>` placeholder, consistent with the sunset, so the named-client list is unverified against current source.
