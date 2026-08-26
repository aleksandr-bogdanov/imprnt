# ZeroClaw

**One-line:** ZeroClaw Labs' Rust single-binary personal-agent runtime (~32.7k stars in six months), an autonomy-focused assistant that answers across 30+ channels and runs down to a Raspberry Pi, whose pluggable memory defaults to a local SQLite store searched by FTS5 BM25 keyword ranking with embeddings switched off out of the box.

**Status (checked 2026-08-26):** active, hyperactive cadence. The GitHub API reports `pushed_at: 2026-08-26T12:12:31Z`, the day of this check. The latest release, v0.8.4 (Aug 2, 2026), describes itself as "a maintenance and hardening release spanning **262 commits** from **49 contributors**". The repo was created 2026-02-13, so the whole project is about six and a half months old. Sources: https://api.github.com/repos/zeroclaw-labs/zeroclaw, https://github.com/zeroclaw-labs/zeroclaw/releases/tag/v0.8.4

**Latest release:** v0.8.4, Aug 2, 2026 | **Stars:** 32,661 | **License:** dual MIT OR Apache-2.0 (GitHub's detector reports Apache-2.0) | **Hosting:** self-host only, your machine and your keys

## What it is

A personal-agent runtime, the same shelf as OpenClaw and Hermes Agent. The repo description: "Fast, small, and fully autonomous AI personal assistant infrastructure, any OS, any platform - deploy anywhere, swap anything 🦀". The README's own definition:

> "ZeroClaw is an agent runtime - a single Rust binary you configure and run. It talks to LLM providers (Anthropic, OpenAI, Ollama, and ~20 others), reaches the world through 30+ channels (Discord, Telegram, Matrix, email, voice, webhooks, your own CLI), and acts through tools (shell, browser, HTTP, hardware, custom MCP servers). Everything runs on your machine, with your keys, in your workspace."

- https://github.com/zeroclaw-labs/zeroclaw (accessed 2026-08-26)

The ownership pitch is the headline: "You own the agent. You own the data. You own the machine it runs on." The website leads with "The Lightweight Personal AI Agent You Own". Multi-channel is the delivery model: "one agent answering you across every channel you configure. Inbound messages from Discord, Telegram, Matrix, email, webhooks, CLI - all delivered to the same agent loop." Autonomy is gated: "default autonomy is `supervised`: medium-risk ops require approval, high-risk blocked," with OS-level sandboxes (Landlock / Bubblewrap / Seatbelt / Docker) and "cryptographic tool receipts on every action." It is also hardware-capable: "GPIO / I2C / SPI / USB on Raspberry Pi, STM32, Arduino, and ESP32 via the `Peripheral` trait."

- https://github.com/zeroclaw-labs/zeroclaw (README, accessed 2026-08-26)
- https://www.zeroclawlabs.ai/ (accessed 2026-08-26)

The repo carries an `openclaw` topic tag. No lineage statement linking it to OpenClaw was found in the README or docs, so the tag is recorded here as an observation, nothing more.

## Status, timeline, recency

- 2026 (Feb 13): repo created (`created_at: 2026-02-13T08:56:04Z`). Source: https://api.github.com/repos/zeroclaw-labs/zeroclaw
- 2026 (Jun 19 - Jun 26): v0.8.1 and v0.8.2 released, a one-week gap. Source: https://github.com/zeroclaw-labs/zeroclaw/releases
- 2026 (Jul 16): v0.8.3 released. Source: same releases page.
- 2026 (Aug 2): v0.8.4, the latest, "262 commits from 49 contributors". Its memory bullet, verbatim: "**Memory controls** add opt-in retrieval caching, reranking, typed-fact extraction, migration-aware configuration checks, content scanning, and auditable recall paths." Source: https://github.com/zeroclaw-labs/zeroclaw/releases/tag/v0.8.4
- 2026 (Aug 26): `pushed_at` is the day of this check. 4,914 forks, 815 open issues.

Recency verdict: very active. Roughly monthly releases, dozens of contributors per release, commits landing the day of the check. The star curve (32.7k in ~6.5 months) puts it well behind OpenClaw (~388k) and Hermes (~236k) but growing on the same wave.

## Where memory lives (storage and architecture)

A pluggable backend behind one trait, with SQLite as the default. ADR-005 ("Memory storage is backend-neutral with SQLite as the default", dated 2026-07-14, status accepted) is the governing record:

> "The current repository recognizes SQLite, Lucid, PostgreSQL, Qdrant, and Markdown storage, plus `none` to disable persistent memory. SQLite is the default."

> "SQLite remains the default because it provides durable local storage, hybrid retrieval, and no external service requirement."

- https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/architecture/decisions/ADR-005-pluggable-memory-backends.md (accessed 2026-08-26)

Code confirms it: `default_memory_backend()` returns `"sqlite"` (`crates/zeroclaw-config/src/schema.rs`), and the SQLite store lives at `workspace_dir/memory/brain.db` in WAL mode (`crates/zeroclaw-memory/src/sqlite.rs`). The backend picker labels the options: "SQLite with Vector Search (recommended) - fast, hybrid search, embeddings", "Markdown Files - simple, human-readable, no dependencies", "Lucid Memory bridge", "PostgreSQL", "None - disable persistent memory" (`crates/zeroclaw-memory/src/backend.rs`). The Markdown backend is a flat per-agent file store (MEMORY.md plus dated files) and ADR-005 notes "Markdown memory is append-only and does not delete entries." There is also a Markdown escape hatch on the SQLite path: an optional "periodic export of core memories to MEMORY_SNAPSHOT.md" (the config comment calls it "soul backup to Markdown") with `auto_hydrate` on by default, rebuilding memory "from MEMORY_SNAPSHOT.md when brain.db is missing."

A separate "relationship memory" knowledge graph exists behind the `knowledge` tool, and its docs are explicit that "Capture is explicit. Enabling the graph does not automatically ingest conversations, files, or channel data."

- https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/architecture/memory-payload-lifecycle.md (accessed 2026-08-26)

## Retrieval

The load-bearing fact of this dossier: **the shipped default is keyword-only BM25, with embeddings off.** The `[memory]` config's `embedding_provider` doc comment, verbatim from `crates/zeroclaw-config/src/schema.rs` (accessed 2026-08-26):

> "Source of embedding vectors for semantic search. `none` = keyword-only retrieval (no API calls, no vector cost); `openai` = OpenAI's embedding API; `custom:URL` = any OpenAI-compatible embedding endpoint (LiteLLM, local gateway, etc.)."

And `default_embedding_provider()` returns `"none"`. The embedding factory (`crates/zeroclaw-memory/src/embeddings.rs`) routes `openai`, `openrouter`, and `custom:` URLs to an OpenAI-compatible client and everything else to a `NoopEmbedding` the code comments call the "keyword-only fallback." The SQLite schema builds a `memories_fts` FTS5 virtual table under the comment "FTS5 full-text search (BM25 scoring)", and `fts5_search` is documented in-source as "FTS5 BM25 keyword search."

When embeddings are configured, `search_mode` defaults to `hybrid`: "blended keyword + vector score" with `vector_weight` 0.7, `keyword_weight` 0.3, and a `min_relevance_score` floor of 0.4. The `search_mode` options, verbatim: "`bm25` = keyword-only (no embeddings, cheapest); `embedding` = vector similarity only (needs an embedding model_provider); `hybrid` = blended keyword + vector score using the weights above (most robust)." v0.8.4 added an opt-in rerank stage that blends "retrieval score with importance and recency" and collapses near-duplicates.

## Capture

Ambient by default, with explicit tools on top. The `auto_save` config comment, verbatim:

> "Auto-save what *you* tell ZeroClaw into memory as conversation history - the agent's own replies are not saved. Turn off if you want memory to only hold things you explicitly record via the memory tool."

`auto_save` defaults to `true`. The memory-payload-lifecycle doc names exactly two write paths: "the agent calls a memory tool such as `memory_store`" and "runtime code explicitly stores a memory entry, such as the configured conversation autosave path." The tool set is `memory_store`, `memory_recall`, `memory_forget`, `memory_purge`, `memory_export` (`crates/zeroclaw-tools/src/`). A periodic hygiene pass (on by default) "archives stale daily/session files and enforces retention windows." LLM fact extraction exists but is off: `consolidation_extract_facts` is "Default off; the flip is sequenced in a later phase."

- https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/architecture/memory-payload-lifecycle.md (accessed 2026-08-26)
- crates/zeroclaw-config/src/schema.rs (accessed 2026-08-26)

## How the AI reads it

Two paths. At turn start "the runtime can recall relevant memories and inject a bounded `[Memory context]` block into the user-visible prompt context," with filters for "generated autosave noise, stale `<tool_result>` blocks," and low-relevance entries (the 0.4 floor exists "to prevent irrelevant context from bleeding into conversations"). Mid-turn the agent calls `memory_recall`, whose tool description reads: "Search long-term memory for relevant facts, preferences, or context. Returns scored results ranked by relevance. Supports keyword search, recent recall with omitted query or bare '*', time-only query (since/until), or both." A web dashboard adds human-facing "memory browsing."

## Pricing and license

No pricing. No hosted offering was found on the website, README, or docs: the model is self-host with your own provider keys. License, verbatim from the README: "Dual-licensed: [MIT](LICENSE-MIT) OR [Apache 2.0](LICENSE-APACHE). You may choose either. Contributors automatically grant rights under both - see [CLA](docs/book/src/contributing/cla.md). The **ZeroClaw** name and logo are trademarks of ZeroClaw Labs." The GitHub API's license detector reports Apache-2.0 only, which undercounts the dual grant.

## Benchmarks

None found for memory. A `zeroclaw-eval` crate exists in the workspace, but no published memory-recall benchmark numbers appeared in the README, docs, or release notes. Recorded as absent, not as a claim.

## vs imprnt

The retrieval default is the story. A 32.7k-star agent runtime shipped BM25 keyword ranking as its out-of-the-box read path, with embeddings behind an opt-in flag whose own docs sell the default as "no API calls, no vector cost." That is imprnt's core bet (deterministic lexical ranking, no model and no vector service in the read loop) showing up as the factory setting of a project on the personal-agent shelf. Of the three runtimes in this camp, ZeroClaw sits closest to imprnt on ranking: OpenClaw defaults to OpenAI-embedded hybrid search, Hermes to FTS5 over raw session rows, ZeroClaw to FTS5 BM25 over a curated-ish memory table.

Where they diverge:

- The store: brain.db rows, not notes. ZeroClaw's memory is a database of auto-saved user messages plus tool-written entries, keyed and categorized internally. imprnt's store is the readable artifact itself: typed Markdown notes with frontmatter, links, and a human-browsable folder layout. ZeroClaw's Markdown backend is the exception, and it is a flat append-only file store with no schema, offered as the simple option rather than the recommended one.
- Capture: ambient vs conscious. `auto_save` on by default means memory accumulates conversation exhaust, then needs hygiene passes, retention windows, relevance floors, dedup, and (in v0.8.4) rerank machinery to keep recall clean. imprnt captures on demand ("harvest this") through an LLM classify-and-file pass, so the corpus is curated at write time and the read side stays a dumb ranker.
- Who reads: the agent, via tool call and runtime injection. ZeroClaw's model decides when to call `memory_recall` and receives an injected context block each turn. imprnt's LLM shapes keywords at the front and reads top-N at the back, with `recall` a plain CLI over files.
- No entity graph on the main path. ZeroClaw's knowledge graph is a separate opt-in tool. imprnt's people/orgs/holdings entities, aliases, and wikilinks are the core contract.
- Scope: ZeroClaw is an acting assistant (shell, browser, hardware, SOPs, channels) whose memory is one subsystem. imprnt is the memory, full stop.

## When it wins over imprnt

- You want one assistant that acts (email, browser, shell, cron, even GPIO pins) and answers on Discord, Telegram, Matrix, and ~27 more channels. imprnt does none of that.
- You want zero-effort memory: auto-saved conversations, retention hygiene, and scored recall without ever filing a note.
- You run constrained hardware. A single Rust binary on a Pi (or an ESP32 peripheral) is a genuinely different deployment class from a Node/CLI-based vault workflow.
- You need supervised autonomy with sandboxes, approval gates, and cryptographic tool receipts around an agent that executes real-world actions.
- You want multi-agent setups with scoped, allowlisted cross-agent memory sharing over one backend.

## Sources

- [ZeroClaw GitHub repository](https://github.com/zeroclaw-labs/zeroclaw) - accessed 2026-08-26
- [GitHub API: repo metadata](https://api.github.com/repos/zeroclaw-labs/zeroclaw) - accessed 2026-08-26 (stars, forks, license detection, created_at, pushed_at, topics)
- [Releases page](https://github.com/zeroclaw-labs/zeroclaw/releases) - accessed 2026-08-26
- [v0.8.4 release notes](https://github.com/zeroclaw-labs/zeroclaw/releases/tag/v0.8.4) - accessed 2026-08-26
- [Docs: introduction](https://docs.zeroclawlabs.ai/master/en/introduction.html) - accessed 2026-08-26
- [Docs: architecture overview](https://docs.zeroclawlabs.ai/master/en/architecture/overview.html) - accessed 2026-08-26
- [Docs: crates deep dive](https://docs.zeroclawlabs.ai/master/en/architecture/crates.html) - accessed 2026-08-26
- [ADR-005: pluggable memory backends](https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/architecture/decisions/ADR-005-pluggable-memory-backends.md) - accessed 2026-08-26
- [Memory and payload lifecycle](https://github.com/zeroclaw-labs/zeroclaw/blob/master/docs/book/src/architecture/memory-payload-lifecycle.md) - accessed 2026-08-26
- Source files, master branch, accessed 2026-08-26: `crates/zeroclaw-config/src/schema.rs` (MemoryConfig, SearchMode, defaults), `crates/zeroclaw-memory/src/{sqlite,embeddings,backend,lib,markdown,retrieval}.rs`, `crates/zeroclaw-tools/src/memory_recall.rs`
- [ZeroClaw Labs website](https://www.zeroclawlabs.ai/) - accessed 2026-08-26

## Confidence and gaps

- The keyword-only default: high confidence, triple-sourced from code (`default_embedding_provider()` returns `"none"`, the `NoopEmbedding` fallback, the config doc comment). It is a code-level fact as of master on 2026-08-26, and a default can flip in any release. Worth re-checking at the next refresh.
- User-facing memory documentation is thin, as the scouting pass suspected. The docs site's navigation has chapters for Channels, Providers, Tools, Hardware, and SOP but no top-level Memory chapter. What exists lives in architecture ADRs (ADR-005, ADR-010), the memory-payload-lifecycle reviewer guide, and code comments. Those internal sources turned out to be rich and candid (ADR-005 even documents its own config-selector overlap as "not an ideal end state"), so the thinness is a docs-surface gap, and this dossier leans on code and ADRs instead.
- Docs-site vs code discrepancy: the crates page describes embedding backends as "OpenAI, Ollama, local," but the factory in `embeddings.rs` recognizes `openai`, `openrouter`, and `custom:URL` (Ollama would ride the custom OpenAI-compatible path). The code is treated as authoritative here.
- Release dates for v0.8.3 and earlier came from the releases-page fetch summary. v0.8.4's date and body were verified directly via the GitHub API (`published_at: 2026-08-02T21:00:00Z`). Earlier dates are one-source.
- The `openclaw` topic tag: verified present via the API. Any lineage claim beyond the tag's existence is unsupported and deliberately not made.
- The scout's framing of the memory as "a database with vector search" was half right: the vector machinery exists, but the shipped default runs no vectors at all. The scout's star count (32,661), license family, v0.8.4 date, Rust/Pi claims, and channel quotes all verified.
- The Lucid backend ("sync with local lucid-memory CLI, keep SQLite fallback") was not investigated beyond its selector label. What lucid-memory is remains a gap.

## Proposed page entries

CompareTable row (CompareTable.astro shape):

```
{
  tool: "ZeroClaw",
  note: "Rust personal-agent runtime, 32.7k stars in six months",
  where: "SQLite brain.db in the agent workspace (flat Markdown backend optional)",
  retrieval: "FTS5 BM25 keyword-only by default, embeddings and hybrid opt-in",
  capture: "Ambient: auto-saves what you tell it, plus explicit memory_store",
  reads: "Runtime injects a [Memory context] block, memory_recall tool mid-turn",
}
```

FieldVerdicts card (FieldVerdicts.astro shape):

```
{
  tool: "ZeroClaw",
  note: "keyword-only retrieval is the shipped default",
  what: "A Rust single-binary personal-agent runtime (~32.7k stars): 30+ chat channels, hardware GPIO, supervised autonomy, and a pluggable memory that defaults to SQLite FTS5 with BM25 scoring and no embedding provider configured.",
  split: "Closest of the runtimes to imprnt's read path: the default install ranks memory by BM25 with zero API calls and zero vectors. The store is the divergence: auto-saved conversation rows in a database the agent queries by tool call, kept clean by hygiene passes, where imprnt keeps human-curated typed Markdown notes that are themselves the searched artifact.",
  wins: "An assistant that acts - shell, browser, email, cron, even GPIO pins - across Discord, Telegram, Matrix and ~27 more channels, on hardware as small as a Pi, with memory that costs zero effort.",
}
```
