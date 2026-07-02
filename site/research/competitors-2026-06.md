# AI-memory field: competitor research (2026-06-18)

Backing research for `site/docs/comparison.mdx`. Facts are pulled from each project's
own README, docs, or primary site, verified 2026-06-18 via web research (one agent per
tool). Benchmark numbers are self-reported by each vendor under its own harness. Treat
them as "the project claims X", never a settled leaderboard. The next refresh should
diff against this file.

imprnt's position (what every entry compares against): plain Markdown files the user
owns, local and owner-only, no account or hosted mode. Retrieval is BM25 + grep with
zero embeddings and no model in the read loop. The AI greps the files directly, no
server and no MCP over the vault. Capture is conscious and on-demand. A typed entity
contract (people/orgs/holdings with aliases and canonical resolution). The LLM is spent
only on the write path. Single-owner personal vault. The files survive the tool being
deleted.

## Changes since the 2026-06-16 page pass

- **Khoj killed its hosted cloud** (shut down 15 April 2026). Self-host only now.
- **iai renamed its repo** to `CodeAbra/iai-mcp` (was `iai-personal-memory-engine`),
  shipped v1.1.2 on 2026-06-18, out of experimental into a stable 1.x line.
- **Reor was archived 7 March 2026** and was already dormant since its April 2025
  release. "archived 2026" undersells it.
- **mem0** lists ~20 vector backends in the current Python SDK (the page said 24).
  Reconcile before shipping a number.
- **Letta is pivoting** toward "Letta Code" + git-backed context repositories,
  deprecating some server-side memory. Its best LoCoMo result came from a filesystem
  variant beating its own tool-based memory.

---

## Same floor: plain files you own

### Karpathy's LLM Wiki
- **Status (2026-06):** A pattern, not a product. Gist published 2026-04-04 (CC0). Live
  implementations, all actively maintained: nashsu/llm_wiki (desktop app, ~11.9k stars),
  ar9av/obsidian-wiki (~2.2k), Astro-Han/karpathy-llm-wiki (Agent Skills, ~1.2k),
  lucasastorian/llmwiki (MCP + hosted variant, ~1.1k). A "LLM Wiki v2" follow-up gist
  extends it with agent-memory lessons.
- **Where memory lives:** Plain Markdown in a three-layer repo: `raw/` (immutable
  sources), `wiki/` (LLM-compiled pages with `[[wikilinks]]`), a `CLAUDE.md`-style schema.
  Control files `index.md` (one-line-per-page catalog) and append-only `log.md`.
- **Retrieval:** No embeddings by design. At small scale the LLM reads `index.md`, then
  opens the relevant full pages. The gist points to optional external search (qmd, hybrid
  BM25 + vector with rerank) past moderate scale, as opt-in not core.
- **Capture:** Conscious. The user adds a source and asks the LLM to compile it.
- **AI reads via:** The agent reads files directly. No server in the base pattern (some
  implementations add MCP / a hosted mode).
- **Benchmark:** none (a pattern).
- **vs imprnt:** Same lineage and near-identical bones. imprnt makes the pattern
  deterministic and typed: a real BM25 ranker so recall never asks the model to scan
  `index.md`, a typed entity contract with alias resolution, a shipped CLI + plugin
  contract instead of a wire-it-yourself convention.
- **Wins when:** a wiki browsed visually in Obsidian where index-reading is fine and you
  want no schema discipline.
- **Sources:** https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f ,
  https://github.com/lucasastorian/llmwiki , https://github.com/ar9av/obsidian-wiki

### Basic Memory
- **Status (2026-06):** Active. v0.22.1 (2026-06-12). AGPL-3.0. Closest shipped kin to imprnt.
- **Where memory lives:** Standard Markdown on disk (default `~/basic-memory`,
  Obsidian-compatible wikilinks + frontmatter) plus a derived SQLite index (full-text +
  parsed entity/observation/relation graph + a SQLite vector store). Markdown is the
  source of truth, the index is rebuilt from it.
- **Retrieval:** Hybrid full-text + vector is the DEFAULT since v0.19.0 (2026-03-07).
  `semantic_search_enabled` defaults true, embeddings backfill automatically. Default
  embeddings local FastEmbed (bge-small-en-v1.5). SQLite default, Postgres optional.
- **Capture:** Deliberate `write_note` MCP tool. Not auto-extracted from turns.
- **AI reads via:** An MCP server (`search_notes`, `read_note`, `build_context`).
- **Benchmark:** none prominent.
- **vs imprnt:** Both keep Markdown as the owned floor. Basic Memory derives a SQLite
  index that now defaults to hybrid vector, so a model and embeddings sit in the read
  loop, reached through an MCP server. imprnt is BM25 + grep, no server, the AI greps the
  files directly. Basic Memory also sells a hosted tier ($15/mo) + Postgres for sync;
  imprnt is single-owner local. The sharpest single line in the field, because they share
  the floor and split only on the machinery above it.
- **Wins when:** you want semantic recall and cross-device sync out of the box.
- **Sources:** https://docs.basicmemory.com/concepts/semantic-search ,
  https://github.com/basicmachines-co/basic-memory/blob/main/CHANGELOG.md

### Obsidian
- **Status (2026-06):** Active. Closed-source freemium (free core, optional paid
  Sync/Publish), but every note is a plain Markdown file the user owns, no lock-in. Bases
  shipped as a core plugin in the 1.9 release (mid-2025), joining the community Dataview
  plugin. The base app ships no AI.
- **Where memory lives:** Plain Markdown in a local folder you fully own. AI plugins add a
  sidecar vector index (Smart Connections writes to `.smart-env/`, Copilot keeps its own).
- **Retrieval:** Base app human-driven (links, tags, full-text search, graph view,
  Dataview/Bases queries over frontmatter), no AI by default. Semantic retrieval only via
  an installed AI plugin.
- **Capture:** Manual and conscious. The base app extracts nothing from chat.
- **AI reads via:** A community plugin inside the GUI (Smart Connections, Copilot), or an
  external MCP bridge (REST-API servers needing the Local REST API plugin, or filesystem
  servers reading the Markdown directly).
- **Benchmark:** none (a PKM app).
- **vs imprnt:** Same floor, arguably the field's strongest your-files stance, no DB pivot
  like Logseq took. The split is who the reader is. Obsidian's reader is a human in a GUI,
  and AI is a bolt-on that builds a separate embedding store beside your notes. imprnt's
  reader is an agent that greps directly, no sidecar to keep in sync, plus a typed entity
  contract Obsidian leaves to the user's own conventions + Dataview.
- **Wins when:** a human wants to browse, link, and visually explore a vault by hand in a
  polished cross-platform GUI.
- **Sources:** https://obsidian.md/ ,
  https://github.com/brianpetro/obsidian-smart-connections ,
  https://github.com/logancyang/obsidian-copilot

### Logseq
- **Status (2026-06):** Active, mid-pivot. The original (OG) version is Markdown/org files
  with the files canonical (v0.10.x). A new SQLite-backed "DB version" (v0.11.x+) makes a
  local SQLite store canonical and Markdown an export, and adds real-time-collaboration sync.
- **Where memory lives:** Plain Markdown or org-mode files (original); a canonical local
  SQLite database (`db.sqlite`) in the DB version.
- **Retrieval:** Human-driven. Datascript / Datalog query engine, block references,
  bidirectional links, a graph view, advanced Datalog queries. No AI by default, no vectors.
- **Capture:** Conscious. You outline blocks and links as you write.
- **AI reads via:** Its own desktop/mobile app and query engine. AI only via a sidecar
  community plugin.
- **Benchmark:** none (a PKM app).
- **vs imprnt:** Its file version shares imprnt's floor and carries no vectors either, but
  recall is Datalog queries and a graph you run by hand, not an agent's read path. The DB
  version is walking away from the plain-files property imprnt is built on, a live example
  of how fast the ground moves here.
- **Wins when:** outliner workflows: daily notes, block references, and Datalog queries you
  drive yourself.
- **Sources:** https://github.com/logseq/docs/blob/master/db-version.md ,
  https://discuss.logseq.com/t/logseq-og-markdown-vs-logseq-db-sqlite/34608

---

## Vector memory engines

### Reor
- **Status (2026-06):** Archived 7 March 2026 (read-only). Last release v0.2.32 (April
  2025), so dormant ~a year before the archive. No named successor.
- **Where memory lives:** Plain Markdown in one chosen directory + an internal LanceDB
  vector database holding the embeddings.
- **Retrieval:** Vector similarity over embeddings. A RAG app with a related-notes sidebar.
- **Capture:** Automatic. Every note is chunked and embedded on write.
- **AI reads via:** The app's in-process RAG against LanceDB. Self-contained desktop app
  (local models via Ollama / Transformers.js, or an OpenAI-compatible endpoint). No MCP.
- **Benchmark:** none.
- **vs imprnt:** Embeddings read path + a closed GUI that owns the index, against imprnt's
  BM25 + grep over files the agent reads directly. No typed entity contract, notes are
  undifferentiated chunks.
- **Wins when:** (historical) a non-technical user wanting one-click local-model semantic
  linking, no CLI or git.
- **Sources:** https://github.com/reorproject/reor

### Khoj
- **Status (2026-06):** Active open source, self-host only. v2.0.0-beta.28 (late March
  2026), ~35k stars. Khoj Cloud shut down 15 April 2026. No acquisition, self-host continues.
- **Where memory lives:** Its own PostgreSQL + pgvector DB (vector embeddings + document
  chunks). Self-hosted, but a database + Django web server you stand up and operate.
- **Retrieval:** Two-stage neural. A bi-encoder builds vectors, similarity pulls candidates
  from pgvector, a cross-encoder reranks. Swapping the embedding model forces a full
  re-index. No BM25/keyword stage documented.
- **Capture:** Connect sources, Khoj indexes them on sync (PDF, plaintext, Markdown,
  org-mode, Word, Notion). Whole-corpus indexing, not per-item filing.
- **AI reads via:** The Khoj server / API. On MCP it is a client (integrates external MCP
  tools into its agents), with no documented MCP server over its own store.
- **Benchmark:** none prominent.
- **vs imprnt:** A running server stack (Django + Postgres) that owns your data in its
  schema, with a model in the read path and a full re-index on embed-model change. imprnt
  is plain files with BM25 + grep, no server. Khoj is an MCP client, not a server.
- **Wins when:** a large multi-format corpus where semantic recall over fuzzy meaning beats grep.
- **Sources:** https://github.com/khoj-ai/khoj , https://docs.khoj.dev/features/search

### mem0
- **Status (2026-06):** Active, ~48k stars. mem0ai raised a $24M Series A (Oct 2025).
  Apache-2.0 SDK + hosted platform. OpenMemory MCP is its local-MCP offering.
- **Where memory lives:** Managed multi-store. Vector store (~20 backends in the Python
  SDK: Qdrant, Chroma, pgvector, Milvus, Pinecone, Redis, Weaviate, Elasticsearch, FAISS,
  MongoDB, Supabase, etc.), optional graph store (Neo4j / Memgraph, unverified on the page
  checked), plus a key-value history store. Default embeddings OpenAI text-embedding-3-small.
- **Retrieval:** Hybrid multi-signal. The April 2026 algorithm scores semantic, BM25
  keyword, and entity matching in parallel and fuses them. BM25 is a fused component of a
  vector-led hybrid, not a standalone or rerank.
- **Capture:** Automatic, LLM-driven extraction from conversation turns.
- **AI reads via:** SDK (Python/TS), REST API, CLI, MCP server, agent skills for Claude
  Code/Codex/Cursor/Windsurf. A server or hosted service mediates access.
- **Benchmark:** Vendor claim ~92.5% LoCoMo, 94.4% LongMemEval, 64.1% BEAM-1M. The
  mem0/Zep dispute: mem0 recut Zep's LoCoMo to 58.44% by excluding adversarial categories;
  Zep rebutted that mem0 misconfigured it and a correct run scores 75.14% vs mem0 ~68%.
  Cite no winner.
- **vs imprnt:** A hosted/server memory layer with a managed multi-store backend, embedding-
  led hybrid retrieval with BM25 as one fused signal, auto-extracting from every turn with an
  LLM. imprnt is owned files, BM25 as the whole ranker, zero embeddings, the model only on
  the write path. mem0's state is locked in its stores.
- **Wins when:** zero-effort automatic memory and managed multi-user infra across many agents.
- **Sources:** https://github.com/mem0ai/mem0 , https://mem0.ai/research ,
  https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/

### mempalace
- **Status (2026-06):** Active. v3.4.1 (2026-06-15), MIT. (Note: a public gist alleges
  purchased stars, reputation noise, irrelevant to architecture and not for the page.)
- **Where memory lives:** Local ChromaDB vector store (default) + local SQLite metadata +
  a temporal knowledge graph. Opt-in backends: sqlite_exact, qdrant, pgvector. Organized
  as a memory palace (wings/rooms/drawers).
- **Retrieval:** Embeddings base + "Hybrid v4" (keyword boosting, temporal-proximity
  boosting, preference-pattern extraction) + optional LLM rerank of the top-20.
- **Capture:** Manual CLI + automatic auto-save hooks (Claude Code, Codex, Cursor) that
  store transcripts verbatim before context compression. No summarize/extract at ingest.
- **AI reads via:** An MCP server exposing 33 tools.
- **Benchmark:** Vendor claim LongMemEval R@5 96.6% raw semantic (no LLM), 98.4% Hybrid v4,
  >=99% with optional LLM rerank.
- **vs imprnt:** Embeddings into a vector DB behind a 33-tool MCP server, auto-capturing
  verbatim transcripts. imprnt greps plain files directly and files consciously into a typed
  contract. Data tied to the index; imprnt's files survive deletion.
- **Wins when:** zero-effort capture of full chat history with top-of-table semantic recall.
- **Sources:** https://github.com/MemPalace/mempalace ,
  https://github.com/MemPalace/mempalace/releases

### iai
- **Status (2026-06):** Active. v1.1.2 (2026-06-18), MIT. Repo `CodeAbra/iai-mcp` (renamed
  from iai-personal-memory-engine). Author Areg Noya (lcgc.dev).
- **Where memory lives:** Local-only at `~/.iai-mcp/`. A custom engine ("Hippo") holds
  encrypted records, the vector index, and the graph in one SQLite store, AES-256-GCM at
  rest. Three tiers: episodic (verbatim), semantic (idle-time summaries), procedural.
- **Retrieval:** Local bge-small-en-v1.5 embeddings (384-dim) ranked with graph-link
  strength + recency, a MOSAIC community-detection clustering. No BM25. p95 recall 77ms at
  1k records.
- **Capture:** Fully automatic and ambient. Every turn recorded verbatim via Claude Code /
  Codex hooks. No conscious filing path.
- **AI reads via:** An MCP server over stdio (`recall`, `capture`, `ask`, `status`, `last`).
  A SessionStart hook auto-injects a memory slice.
- **Benchmark:** Vendor claim R@5 0.962, R@10 0.978 on LongMemEval-S (bge-small), tie at
  0.966 on a matched embedder.
- **vs imprnt:** Captures everything verbatim from every turn into an encrypted binary tied
  to its daemon. imprnt files only what you choose, into human-readable Markdown that
  outlives the tool. Local embeddings + recency/graph rank inside SQLite vs BM25 + grep over
  files. MCP server + auto-injected prefix vs the agent grepping owned files directly.
- **Wins when:** never-miss automatic capture and high benchmark recall, behind encryption,
  with no filing decisions.
- **Sources:** https://github.com/CodeAbra/iai-mcp ,
  https://raw.githubusercontent.com/CodeAbra/iai-mcp/main/README.md

### Supermemory
- **Status (2026-06):** Active, ~27k stars. $2.6M seed (Oct 2025; Susa Ventures, Browder
  Capital, angels incl. Cloudflare CTO and Jeff Dean). Founder Dhravya Shah. MIT core.
- **Where memory lives:** Cloud-first by default (Cloudflare Workers + Postgres/pgvector).
  A self-host local binary (`npx supermemory local`, localhost:6767) stores to
  `./.supermemory` with an embedded graph engine + local embeddings. Not user-readable files.
- **Retrieval:** Embeddings-based hybrid (RAG chunks + a fact "Memory" layer + user
  profile). A model in the read loop. Sub-300ms hybrid search claimed.
- **Capture:** Automatic by default (extracts facts, builds profiles, resolves
  contradictions, auto-expires stale facts). Manual `add()` + connectors (Drive/Gmail/
  Notion/GitHub). Multi-modal ingest.
- **AI reads via:** REST API + JS/Python SDKs, an MCP server, framework adapters (Vercel AI
  SDK, LangChain, etc.). Self-host adds the local binary. Offline mode via Ollama.
- **Benchmark:** Vendor claim LongMemEval 81.6% (claims #1), plus LoCoMo and ConvoMem #1.
- **vs imprnt:** Cloud-first infrastructure, embeddings vector-graph engine, a model in the
  read loop, auto-extraction + contradiction resolution. imprnt is local plain files, BM25
  + grep, conscious capture, no API surface. The store is tied to the engine.
- **Wins when:** a multi-modal, multi-user memory backend that auto-extracts and
  auto-forgets at scale.
- **Sources:** https://github.com/supermemoryai/supermemory/blob/main/README.md ,
  https://supermemory.ai/docs/intro

---

## Graph memory

### Zep / Graphiti
- **Status (2026-06):** Both active. Graphiti open source (Apache-2.0, v0.17+). Zep the
  commercial SaaS (founded 2023, Daniel Chalef, YC-backed, ~seed stage). Funding past seed
  unverified.
- **Where memory lives:** A temporal knowledge graph in a graph DB. Graphiti defaults to
  Neo4j (also FalkorDB, Neptune, Kuzu). Zep is a hosted managed service ("Context Lake").
- **Retrieval:** Hybrid: semantic embeddings + BM25 + graph traversal. Bi-temporal model
  gives every fact a validity window (query what is true now or was true then). Old facts
  invalidated, not deleted.
- **Capture:** Auto-extracted. An LLM builds entities, relationships, and fact edges from
  each episode on ingest.
- **AI reads via:** Retrieval API/SDK + an MCP server (the `mcp_server` dir in Graphiti).
  Zep exposes the same through its hosted API.
- **Benchmark:** Vendor claims DMR 94.8%, up to 18.5% LongMemEval accuracy gain vs full-
  context, corrected LoCoMo 75.14% in the rebuttal vs mem0. (arXiv 2501.13956.)
- **vs imprnt:** Memory as graph nodes/edges in a database, an LLM building the graph on
  ingest. imprnt models change as superseded-line markers + typed notes in owner-only
  files, no graph DB, no model in the read loop. Zep adds compliant multi-tenant SaaS (SOC
  2, HIPAA) imprnt has no equivalent of.
- **Wins when:** automatic low-latency memory across millions of users/sessions with
  point-in-time temporal queries.
- **Sources:** https://github.com/getzep/graphiti/blob/main/README.md ,
  https://www.getzep.com/product/open-source/ , https://arxiv.org/abs/2501.13956

### cognee
- **Status (2026-06):** Active. v1.1.3 (2026-06-18), Apache-2.0, ~18k stars. topoteretes
  raised a $7.5M seed (self-reported).
- **Where memory lives:** Three-tier hybrid store. Graph (default Kuzu, also Neo4j/
  FalkorDB/Neptune/Memgraph) + vector (default LanceDB, also Qdrant/pgvector/Pinecone/
  Chroma) + relational (default SQLite, also Postgres). File-based defaults, but database
  state, and the graph is LLM-built.
- **Retrieval:** 14 search modes. Flagship GRAPH_COMPLETION uses vector similarity as a
  hint to find graph triplets, traverses the graph, then an LLM generates the answer.
  Embeddings + graph + a model on the read path.
- **Capture:** Auto-extraction during the "cognify" stage (LLM pulls entities/relations/
  summaries to build graph nodes/edges). User calls add/cognify on a source.
- **AI reads via:** Python SDK, CLI, an MCP server (cognee-mcp), and a hosted Cognee Cloud.
- **Benchmark:** Vendor claim on 24 HotpotQA questions: human-like correctness 0.93,
  DeepEval correctness 0.85. Small sample.
- **vs imprnt:** An LLM-built knowledge graph + embeddings across three databases, a model
  on the read path (vector hint -> graph traversal -> LLM answer). imprnt keeps plain files,
  BM25 + grep, the model off the read path and only on the write, with a typed entity
  contract the user controls.
- **Wins when:** multi-hop reasoning across large auto-ingested corpora where graph
  traversal beats keyword ranking.
- **Sources:** https://github.com/topoteretes/cognee ,
  https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory

---

## Agent-state runtime

### Letta / MemGPT
- **Status (2026-06):** Active. v0.16.8 (2026-05-14). UC Berkeley spinout, $10M seed
  (Felicis, Sept 2024). Pivoting toward Letta Code (a model-agnostic agent harness) +
  git-backed "context repositories", deprecating some server-side memory features.
- **Where memory lives:** Postgres (pgvector required). OS-style tiers: core memory
  (editable blocks pinned in-context), recall memory (searchable history), archival memory
  (queried by tool). Embeddings in pgvector.
- **Retrieval:** Vector/semantic search over pgvector via `archival_memory_search` /
  `conversation_search` tools. Core blocks always compiled into the prompt. A model in the
  read loop by design.
- **Capture:** Auto/self-managed. The agent self-edits its own memory mid-loop
  (`core_memory_append/replace`, `archival_memory_insert`).
- **AI reads via:** A running Letta server over REST + SDKs + the ADE UI. The agent never
  greps files, it calls tools that hit the server. Self-host or Letta Cloud.
- **Benchmark:** 74.0% LoCoMo with a filesystem approach + GPT-4o mini, self-reported above
  mem0's 68.5% (Letta blog, Aug 2025). Their filesystem variant beat their own tool-based
  memory.
- **vs imprnt:** A stateful Postgres-backed server reached through a REST API, vector search
  with a model in the read loop, the agent auto-editing its own memory blocks. imprnt is
  plain files the agent greps, conscious filing, no server. A multi-agent developer platform,
  not a file format.
- **Wins when:** an always-on agent that autonomously remembers across long sessions, and
  you will run a Postgres-backed server.
- **Sources:** https://github.com/letta-ai/letta , https://docs.letta.com/core-concepts/ ,
  https://www.letta.com/blog/benchmarking-ai-agent-memory/

---

## Addendum 2026-07-02: ECC + freshness re-check

Two things landed on 2026-07-02: one new entry (ECC, added on request) and a freshness pass
over four dossiers in `site/docs/competitors/`. The full sourced records live in that folder
(`ecc.md` plus the four edited files). Same rules as the rest of this file: primary sources,
vendor numbers are claims.

### ECC (everything-claude-code)
- **Status (2026-07):** Active, viral, effectively one maintainer (Affaan Mustafa). 225,052
  stars, pushed 2026-07-01, latest release v2.0.0 (2026-06-10), MIT. Renamed from the viral
  `everything-claude-code` (the old API URL 301-redirects to the same repository id). The
  stars are real but lopsided: ~196:1 star-to-watcher ratio and ~42k total npm installs of
  `ecc-universal`, so most stargazers never became users.
- **What it is:** The honest category is a cross-harness config and prompt pack: 268 skills,
  66 agent definitions, 122 rules files, 92 command shims, and per-harness config trees for
  eleven harnesses (Claude Code, Codex, Cursor, Gemini, Zed, and more), plus a thin npm
  installer (`ecc-universal`), lifecycle hook scripts, a sql.js state store, and a paid
  hosted GitHub App (ECC Pro, $19/seat/mo). It runs no agents of its own. Memory is one
  bolt-on subsystem among many. It enters this research because it was asked for and because
  readers will hold the field's most-starred agent repo next to imprnt anyway.
- **Where memory lives:** Plain files under the home dir: per-project markdown session
  summaries (`~/.claude/session-data/`, `ECC:SUMMARY` markers), YAML instinct files with
  confidence scores (`~/.local/share/ecc-homunculus/projects/<hash>/` or
  `~/.claude/homunculus/`), JSONL observation logs, learned skills as markdown, and a sql.js
  SQLite store for operational state.
- **Retrieval:** Recency injection, no search. The SessionStart hook prints the newest
  session summary (7-day window, 8,000-char default budget) plus up to 6 instincts at
  confidence >= 0.7 and up to 6 learned-skill summaries. No BM25, no embeddings, no vector
  store, no query-time search over memory. Older sessions only via explicit commands
  (`/sessions`, `/resume-session`).
- **Capture:** Automatic lifecycle hooks (SessionEnd summarizes the transcript, PreCompact
  preserves state, PostToolUse appends observations) plus a background Haiku observer that
  distills instincts. Local by default, stated in the hook README. Optional richer summaries
  shell out to `claude -p` with Haiku, reusing existing auth.
- **AI reads via:** Context injection at session start, through the harness itself. No MCP,
  no server, no memory tools mid-session.
- **Benchmark:** none that holds. No comparative benchmark backs the "performance
  optimization system" tagline. The mgrep token-reduction numbers are the mgrep vendor's own
  benchmark copied into ECC's guide, and the config-tip percentages ship without data.
- **vs imprnt:** Different category, one shared conviction: plain local files, zero
  embeddings, no MCP over memory. The split is the read path and the scope. ECC injects
  whatever is newest for coding-session continuity ("what was I doing"), while imprnt runs
  ranked BM25 search over a permanent typed vault ("what do I know") on any question at any
  time, with conscious capture instead of ambient hooks and a background LLM.
- **Style note:** ecc.tools and imprnt's site share only generic dev-tool-landing defaults
  (near-black background, JetBrains Mono, the stock feTurbulence grain, an install command
  with a copy button, an "Open source · MIT" chip). Side-by-side verdict: same-model house
  style, zero imprnt-specific fingerprints in ECC, no evidence of derivation either way.
- **Wins when:** you want a ready-made catalog across many harnesses, zero-effort session
  continuity, passive habit-distillation into skills, or the adjacent tooling (AgentShield,
  hosted PR audits).
- **Sources:** https://github.com/affaan-m/ECC ,
  https://raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md ,
  https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js

### Freshness deltas applied to the dossier folder (2026-07-02)

- **Zep / Graphiti:** Zep Cloud's Free tier now shows 10,000 credits/month on the live
  pricing page ("no rollover or auto-topup"), where the dossier recorded 1,000/month as of
  2026-06-20. Flex and Flex Plus annual prices unchanged ($1,250 and $3,750/year). Graphiti
  itself unchanged: latest release still v0.29.2 (2026-06-08), 28,283 stars, pushed
  2026-07-02. Dossier corrected.
- **mempalace:** v3.5.0 (2026-06-23) adds an opt-in local write daemon (`mempalace daemon`),
  opt-in HTTP transport for the MCP server, MCP tools 33 -> 35 (added
  `mempalace_checkpoint`, `mempalace_delete_by_source`), and new transcript parsers
  (Continue.dev, Gemini CLI, Pi agent). Stars ~56,900. No pricing, license, benchmark, or
  star-scandal changes. Dossier updated.
- **iai:** Seven releases since 2026-06-18 (v1.1.3 through v1.2.1, latest 2026-07-01).
  v1.2.0 (2026-06-26) added Windows support (beta), invalidating the "macOS or Linux"
  requirement. The repo description repositioned to MCP-client breadth and the README
  headline now reads "The best open-source personal memory engine for AI coding assistants".
  Stars 265 -> 325. Storage engine, benchmarks, and MIT license unchanged. Dossier updated.
- **cognee:** v1.2.x went stable: v1.2.0 and v1.2.1 on 2026-06-21 (breaking env-var renames,
  public registration disabled by default, enforced API auth), v1.2.2 on 2026-06-26 now the
  latest stable. Cloud pricing reworked from per-document seat tiers to usage-based token
  pricing (Free 1M tokens + 1 workspace, Standard $2.50 per 1M tokens + $5 per extra
  workspace, Enterprise custom). Search-mode docs re-verified unchanged. Dossier updated.
