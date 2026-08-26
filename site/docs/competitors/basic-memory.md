# Basic Memory

**One-line:** A local-first, open-source AI memory system that stores knowledge as plain Markdown files on disk, derives a SQLite index over them (full-text plus a vector store), and puts an MCP server between the AI and the files so assistants read and write notes through tools like `write_note`, `search_notes`, `read_note`, and `build_context`.

**Status (checked 2026-08-27):** active - repo `basicmachines-co/basic-memory` pushed 2026-08-25, latest release v0.23.2 published 2026-08-25, not archived. GitHub API `archived: false`, `pushed_at: 2026-08-25T20:43:52Z` ([api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory), accessed 2026-08-27).

**Latest release:** v0.23.2, 2026-08-25 | **Stars:** 3,768 | **License:** AGPL-3.0 | **Hosting:** both (free self-host, paid cloud)

**Re-check 2026-08-27:** stars 3,265 -> 3,768, release v0.22.1 -> v0.23.2 (releases page accessed 2026-08-27). v0.23.x is fix and MCP/CI work ("fix(core): repair FTS half of hybrid search for natural-language queries", v0.23.0 release body). The semantic-on-by-default claim still holds, now living in `config_models.py` after a config split: `semantic_search_enabled` uses `default_factory=_default_semantic_search_enabled` (on when fastembed + sqlite_vec exist, "included by default") and `default_search_type` "defaults to 'hybrid' if semantic search is enabled" ([raw config_models.py](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config_models.py), accessed 2026-08-27). New since: an opt-in reranker (`reranker_enabled`, fastembed or litellm) and a Milvus vector-index option. Verdict unchanged.

## What it is

Basic Memory is a knowledge base for AI assistants and humans that keeps everything in plain Markdown on the local machine and exposes it to an LLM through the Model Context Protocol. The repo description states it plainly.

> "AI conversations that actually remember. Never re-explain your project to your AI again."

- [api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20

The marketing site frames it as one shared knowledge graph written in Markdown that the user owns.

> "One knowledge base. For you, your AI tools, and your team."
> "Your chats, docs, decisions, tasks, and research, connected in a living knowledge graph. Plain markdown you control."

- [basicmemory.com](https://basicmemory.com) - accessed 2026-06-20

The docs describe the mechanism in one line.

> "Basic Memory runs an MCP server that can read and write Markdown files. A SQLite index keeps search fast."

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

This is imprnt's closest shipped kin: same Markdown-on-disk floor, Obsidian-compatible, owner-controlled. The split is the read path. Basic Memory derives a SQLite index that defaults to hybrid full-text plus vector search and routes the AI through an MCP server, while imprnt is BM25 plus grep with the AI reading the files directly and no resident server.

## Status, timeline, recency

- **2024-12-02** - repository created (`created_at: 2024-12-02T22:40:43Z`). [api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20.
- **2025-12** - v0.16.3 added Postgres as an alternative to SQLite. Changelog: "Full PostgreSQL/Neon database support as alternative to SQLite" with "Async connection pooling with asyncpg." [raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md) - accessed 2026-06-20.
- **2026-03-07** - v0.19.0 made semantic/vector search a default. Release body: "feat: add semantic vector search for SQLite and Postgres" and "chore: Make semantic deps default, auto-backfill embeddings, and default search to semantic" (`published_at: 2026-03-07T20:28:32Z`). [api.github.com/repos/basicmachines-co/basic-memory/releases/tags/v0.19.0](https://api.github.com/repos/basicmachines-co/basic-memory/releases/tags/v0.19.0) - accessed 2026-06-20.
- **2026-05-16** - v0.21.0 unified MCP tools and CLI under one workspace/project model. build_context gained cross-project traversal. Changelog. [raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md) - accessed 2026-06-20.
- **2026-06-11** - v0.22.0 added team-safe cloud sync: "additive `bm cloud push` and `bm cloud pull` commands" while "destructive mirror commands are gated to Personal workspaces." Also vector/FastEmbed fixes: "fix(core): L2-normalize FastEmbed vectors to satisfy unit-vector contract", "perf(core): speed up vector sync and tune fastembed defaults." [github.com/basicmachines-co/basic-memory/releases](https://github.com/basicmachines-co/basic-memory/releases) - accessed 2026-06-20.
- **2026-06-13** - latest release v0.22.1 (`published_at: 2026-06-13T03:35:06Z`). The body is a "What's Changed" commit list. Paraphrased, it is a bug-fix release covering fresh-install project resolution, MCP workspace routing, sync project selection, and CLI startup latency. The verbatim commit lines include "fix(core): use (type, id) keys in vector search hydration to prevent id collisions", "fix(mcp): resolve workspace display names and tenant ids in qualified project routes", "fix(api): point fresh installs at project setup when resolve finds an empty projects table", "fix(cli): defer FastAPI and app imports out of CLI startup", and "fix(core): require line-anchored frontmatter fences in file_utils." [api.github.com/repos/basicmachines-co/basic-memory/releases/latest](https://api.github.com/repos/basicmachines-co/basic-memory/releases/latest) - accessed 2026-06-20.
- **2026-06-14** - last push to default branch `main` (`pushed_at: 2026-06-14T22:25:17Z`), repo updated 2026-06-19. Active by any measure. [api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20.
- **Stars:** 3,265 | **Forks:** 216 | **Open issues:** 78 | **Watchers (subscribers):** 18. [api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20.
- **Funding:** unverified. No primary-source funding announcement found via search for the company `basicmachines-co` / Basic Machines. Flagged in Confidence and gaps.

Recency verdict: actively developed, multiple releases per month through June 2026, last commit days before the access date. Not dormant, not archived.

## Where memory lives (storage and architecture)

Markdown files on local disk are the source of truth. A derived SQLite index sits on top for search.

> "Basic Memory runs an MCP server that can read and write Markdown files. A SQLite index keeps search fast."

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

Default storage location and Obsidian compatibility (from the README):

> Default Storage Location: "~/basic-memory"
> "Point Obsidian at ~/basic-memory (or your project folder) and the same wikilinks, frontmatter, and Markdown your AI writes appear."

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20

The note model is an entity/observation/relation knowledge graph encoded inside each Markdown file's frontmatter and body:

> "Entities: Each note functions as a distinct entity with title, content, and metadata"
> "Observations: Categorized facts extracted from notes, labeled as `[decision]`, `[requirement]`, `[risk]`, etc."
> "Relations: Typed links connecting entities (`implements`, `depends_on`, `relates_to`)"

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

README structure summary:

> Frontmatter: Title, type, permalink, optional tags
> Observations: "Facts about the entity. Categories in [brackets], tags with #"
> Relations: "Wiki-style links that form the graph"

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20

Database backend: SQLite by default, Postgres/Neon optional. README: "indexed with SQLite (default) or Postgres." Postgres landed in v0.16.3 ("Full PostgreSQL/Neon database support as alternative to SQLite," "Async connection pooling with asyncpg"). The vector store rides inside SQLite via `sqlite-vec`, and the config gates semantic search on `fastembed` and `sqlite_vec` both being present.

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20
- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py) - accessed 2026-06-20

No-lock-in claim from the homepage:

> "No lock-in, no proprietary store — just Markdown files and an open standard"

- [basicmemory.com](https://basicmemory.com) - accessed 2026-06-20

## Retrieval

Hybrid full-text plus vector is the shipped default since v0.19.0. The config file's defaults confirm it (verbatim field names and values read from source):

> `semantic_search_enabled` defaults to `True` (enabled by default when required dependencies exist)
> `semantic_embedding_model` defaults to `"bge-small-en-v1.5"`
> `semantic_embedding_provider`: `"fastembed"`
> `semantic_vector_k`: `100`
> `semantic_min_similarity`: `0.55`
> `default_search_type`: defaults to `"hybrid"` when semantic search is enabled

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py) - accessed 2026-06-20

The embedding model is the local FastEmbed `bge-small-en-v1.5` (384-dimensional, ONNX, CPU-friendly), so semantic search runs locally with no external API. The README markets the two ranking modes:

> "Semantic vector search. Find notes by meaning, not just keywords."

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20

v0.19.0 release notes describe the hybrid mechanism: "FastEmbed-based embeddings with automatic backfill" and "Hybrid search combining full-text and vector similarity," plus the default switch: "Make semantic deps default, auto-backfill embeddings, and default search to semantic."

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md) - accessed 2026-06-20
- [api.github.com/repos/basicmachines-co/basic-memory/releases/tags/v0.19.0](https://api.github.com/repos/basicmachines-co/basic-memory/releases/tags/v0.19.0) - accessed 2026-06-20

Retrieval is also graph-aware, not flat text matching. The docs describe a search-then-traverse-then-synthesize flow:

> "When your AI assistant searches your knowledge base, it doesn't just find text - it navigates a semantic graph of connected ideas."

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

Note the contrast with imprnt's prior-note claim. The prior note said "Hybrid full-text + vector is DEFAULT since v0.19.0 (2026-03-07), semantic_search_enabled defaults true." Confirmed correct against the live `config.py` and the v0.19.0 release body.

## Capture

Capture is deliberate: the AI (or the human) writes a note through an explicit MCP tool, not via passive auto-extraction from chat. The primary write tool is `write_note`, with `edit_note` and `append_note` as supporting writers.

> Capture Mechanism: The `write_note` MCP tool, with supporting tools `edit_note` and `append_note`.

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20

Docs confirm `write_note` "Creates new notes with parameters like title, content, and folder."

- [docs.basicmemory.com/guides/mcp-tools](https://docs.basicmemory.com/guides/mcp-tools) - accessed 2026-06-20 (via search index of docs.basicmemory.com)

Because writes go through the MCP server, the same SQLite index and embeddings are kept in sync on write (the v0.19.0 "auto-backfill embeddings" and v0.22.0 "speed up vector sync" entries are about keeping the derived index current as notes change).

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md) - accessed 2026-06-20

This matches the prior note ("Capture via deliberate write_note MCP tool, not auto-extracted") and matches imprnt's conscious-capture philosophy. The difference is the writer. In Basic Memory the AI writes through a tool against a server. In imprnt the agent runs `ingest`, which writes files directly.

## How the AI reads it

The AI reads through an always-on MCP server that exposes typed tools. It does not grep the files itself. It calls tools and the server queries the SQLite index and the Markdown.

> "Basic Memory runs an MCP server that can read and write Markdown files, and your assistant calls tools like search_notes, read_note, and write_note to work with your notes."

- [docs.basicmemory.com (search index)](https://docs.basicmemory.com) - accessed 2026-06-20

The read-side tool set:

> - search_notes and read_note for direct retrieval
> - build_context, which navigates `memory://` URLs to traverse your knowledge graph
> - search, providing hybrid full-text and vector ranking

- [github.com/basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) - accessed 2026-06-20

`build_context` resolves a stable `memory://` URL scheme and walks relations:

> ```
> memory://api-authentication          # By permalink
> memory://api-authentication/relates_to/*  # Follow relation links
> memory://folder/note-title           # By path
> ```

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

Supported clients: any MCP-compatible assistant.

> "Connect to Claude, ChatGPT, Gemini, Cursor, VS Code, and more via the Model Context Protocol."

- [docs.basicmemory.com](https://docs.basicmemory.com) - accessed 2026-06-20

This is the architectural fork from imprnt. imprnt has no MCP server over the vault by design. The agent that is already talking to the user shapes keywords, runs a deterministic BM25 + grep `recall`, and reads the top-N files directly. Basic Memory inserts a resident server and tool layer (and a vector index) between the model and the files.

## Pricing and license

License: AGPL-3.0 (`license spdx_id: AGPL-3.0`). [api.github.com/repos/basicmachines-co/basic-memory](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20.

Tiers (from the pricing page):

| Tier | Price | Key inclusions (verbatim where quoted) |
|------|-------|----------------------------------------|
| Free (Local) | Free | "Open source and free on your own machine", full app under AGPL-3.0 for self-hosting, install via `uv tool install basic-memory` |
| Cloud (Team) | "$15/seat/month" | "AI collaboration via MCP", "Shared workspaces for teams and agents", "Team member management and audit logs", "Full-text search across notes and projects", "Desktop, mobile, and web access", "Private, exportable Markdown files", "50,000 notes per seat", "1,000 note updates per seat per day", "Cancel anytime, your data stays yours" |
| Agent Infrastructure | Custom (credits / metered) | "Credit-based usage for agent fleets and automation", "Higher limits with budget controls and clear guardrails", "Custom deployment, enterprise, or on-prem options", "Written limits, support expectations, and operational safeguards" |

- [basicmemory.com/pricing](https://basicmemory.com/pricing) - accessed 2026-06-20

The hosted price confirms the prior note's "~$15/mo," with the precision that it is $15 per seat per month, billed per seat, with note-count and update-rate caps (50,000 notes/seat, 1,000 updates/seat/day). The cloud tier exposes "Full-text search" in its feature list. Semantic/vector retrieval is the local default per `config.py`, but the cloud feature copy lists full-text search specifically (flagged in gaps).

## Benchmarks (vendor self-reported)

No formal benchmark numbers (latency, recall@k, MTEB scores, token cost) are published by the vendor in the sources fetched. The README and docs make qualitative performance claims only:

> "A SQLite index keeps search fast."

- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20

The embedding model `bge-small-en-v1.5` is a known MTEB performer (third-party, not a Basic Memory benchmark), and FastEmbed quantizes to 8-bit ONNX for CPU inference, but Basic Memory itself reports no retrieval-quality numbers. Treated as: no vendor benchmark leaderboard exists. Flagged in gaps.

## vs imprnt

Same floor, different read path. Both keep plain Markdown on local disk that the user owns, both are Obsidian-friendly, both capture deliberately rather than auto-scraping chat, both carry a typed model in frontmatter (Basic Memory: entity/observation/relation. imprnt: type/kind/tags + people/orgs/holdings with aliases). The differences:

| Dimension | Basic Memory | imprnt |
|-----------|--------------|--------|
| Source of truth | Markdown on disk | Markdown on disk |
| Derived index | SQLite (full-text + `sqlite-vec` vector store) | none persistent, BM25 computed over files |
| Default retrieval | hybrid full-text + vector (`default_search_type: "hybrid"`, `semantic_search_enabled: True`) | BM25 ranking + grep, no embeddings, no vectors |
| Embeddings | local FastEmbed `bge-small-en-v1.5`, default on | none, by design |
| AI access | resident MCP server with tools (`search_notes`, `read_note`, `build_context`, `write_note`) | the agent already in the chat shapes keywords, runs deterministic `recall`, reads top-N files directly, no MCP server over the vault |
| Server / daemon | MCP server runs to broker reads/writes | no daemon, two on-demand commands (`check`, `ingest`/`harvest`) |
| Capture | AI calls `write_note` against the server | agent runs `ingest`, LLM on the write path only |
| Backend options | SQLite default, Postgres/Neon optional | files only |
| Hosting | free self-host + $15/seat/mo cloud | local-only, owner-only `chmod 700` |
| License | AGPL-3.0 | (imprnt's own license) |

The single cleanest contrast: Basic Memory derives a vector index and runs an MCP server in the read loop. imprnt's read path is pure local arithmetic (BM25 term frequencies + idf) plus grep with the LLM at the two ends only, never resident, never re-ranking per query, never embedding. imprnt's contract calls embeddings/vectors/MCP-over-the-vault explicitly out of scope. Basic Memory adopts all three as defaults.

Both honor the "files outlive the tool" property: delete the app, the Markdown remains editable.

- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/config or README](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20
- [raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py) - accessed 2026-06-20

## When it wins over imprnt

- You want multi-device, mobile, and web access to the same notes, or team collaboration with audit logs and shared workspaces. The cloud tier ships that. imprnt is single-owner local-only.
- You want semantic recall on meaning out of the box (paraphrase matching, "find by idea not keyword") without shaping keywords yourself. Hybrid vector is the Basic Memory default. imprnt is BM25 keyword ranking by design.
- You want a standard MCP server so many off-the-shelf clients (Claude, ChatGPT, Gemini, Cursor, VS Code) attach to the same memory with zero custom glue.
- You want Postgres/Neon as the backend for larger or hosted deployments.
- You want graph traversal via stable `memory://` URLs and typed relations as a first-class read primitive (`build_context`).
- You want a maintained, fast-moving project with a company behind it and a paid support path.

## Sources

- [github.com/basicmachines-co/basic-memory (repo)](https://github.com/basicmachines-co/basic-memory) - accessed 2026-06-20
- [README.md (raw, main)](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md) - accessed 2026-06-20
- [CHANGELOG.md (raw, main)](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/CHANGELOG.md) - accessed 2026-06-20
- [src/basic_memory/config.py (raw, main)](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/src/basic_memory/config.py) - accessed 2026-06-20
- [GitHub releases page](https://github.com/basicmachines-co/basic-memory/releases) - accessed 2026-06-20
- [GitHub API: repo metadata](https://api.github.com/repos/basicmachines-co/basic-memory) - accessed 2026-06-20
- [GitHub API: latest release (v0.22.1)](https://api.github.com/repos/basicmachines-co/basic-memory/releases/latest) - accessed 2026-06-20
- [GitHub API: release v0.19.0](https://api.github.com/repos/basicmachines-co/basic-memory/releases/tags/v0.19.0) - accessed 2026-06-20
- [basicmemory.com (homepage)](https://basicmemory.com) - accessed 2026-06-20
- [basicmemory.com/pricing](https://basicmemory.com/pricing) - accessed 2026-06-20
- [docs.basicmemory.com (docs home)](https://docs.basicmemory.com) - accessed 2026-06-20
- [docs.basicmemory.com/start-here/what-is-basic-memory](https://docs.basicmemory.com/start-here/what-is-basic-memory) - accessed 2026-06-20
- [docs.basicmemory.com/guides/mcp-tools](https://docs.basicmemory.com/guides/mcp-tools) - accessed 2026-06-20

## Confidence and gaps

- **High confidence:** status (active), latest release v0.22.1 / 2026-06-13, stars 3,265, license AGPL-3.0, Markdown-on-disk + SQLite-index architecture, default storage `~/basic-memory`, Obsidian compatibility, MCP server with `write_note`/`read_note`/`search_notes`/`build_context`, semantic search default (`semantic_search_enabled: True`, `default_search_type: "hybrid"`, FastEmbed `bge-small-en-v1.5`) confirmed in live `config.py` and v0.19.0 release body, cloud price $15/seat/month. All carry primary-source quotes above.
- **v0.22.1 body:** the GitHub API release body is a "What's Changed" commit-message list, not narrative release notes. The `(type, id)` vector-hydration fix is verbatim ("fix(core): use (type, id) keys in vector search hydration to prevent id collisions"). The fresh-install/workspace-routing/sync-selection/startup-latency description is a paraphrase of several commit lines, not a single verbatim quote, and is presented as paraphrase above.
- **Funding / company backing:** unverified. No primary-source funding announcement located for Basic Machines / basicmachines-co. The product is clearly commercial (paid cloud, "Agent Infrastructure" enterprise tier) but the raise, if any, is not sourced. Do not assert a funding figure.
- **Cloud retrieval mode:** the pricing page's Cloud feature list names "Full-text search across notes and projects" specifically, while the local `config.py` defaults to hybrid (vector) search. Whether the hosted tier runs vector search by default, or full-text only, is not explicitly stated in a fetched primary source. Flagged as uncertain.
- **Benchmarks:** none. No vendor-published retrieval-quality or latency numbers were found, only the qualitative "keeps search fast." Treat any quality comparison as unmeasured.
- **MCP tool full inventory:** `write_note`, `edit_note`, `append_note`, `read_note`, `search_notes`, `build_context`, and `search` are confirmed by name from primary sources. The complete tool list (e.g. `recent_activity`, `view_note`, `delete_note`) appears in docs nav but the dedicated `mcp-tools-reference` page returned 404 on fetch, so the full enumerated set with per-tool descriptions is partially unverified.
- **Date-parsing note:** an early WebFetch of the releases HTML page misrendered years as 2024. The authoritative GitHub API `published_at` timestamps (2026) were used instead and cross-checked. The 2026 dates are correct.
