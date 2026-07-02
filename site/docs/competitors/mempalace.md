# mempalace

**One-line:** A local-first, MIT-licensed AI memory system that stores conversation history verbatim in a "memory palace" of wings/rooms/drawers, retrieves it with ChromaDB vectors plus a keyword-and-temporal hybrid ranker, and exposes it to coding agents over an MCP server with 35 tools.

**Status (checked 2026-07-02):** active - shipping fast. Latest release v3.5.0 dated 23 Jun 2026 and the repo tagline reads "The best-benchmarked open-source AI memory system. And it's free." Reputation caveat: a public audit alleges tens of thousands of purchased GitHub stars (see Confidence and gaps). Source: [github.com/MemPalace/mempalace](https://github.com/MemPalace/mempalace), [releases](https://github.com/MemPalace/mempalace/releases).

**Latest release:** v3.5.0, 23 Jun 2026 | **Stars:** ~56,900 (reported on the repo page, inflation alleged) | **License:** MIT | **Hosting:** self-host (local-first). A hosted "MemPalace Cloud" domain exists but is not part of the open-source repo and is unverified

## What it is

mempalace is a Python CLI plus MCP server that gives AI agents long-term memory by storing every message verbatim and searching it locally. It organizes content the way the classical mnemonic does: people and projects become wings, topics become rooms, and the original text lives in drawers. It runs entirely on your machine with ChromaDB as the default vector store.

> "Local-first AI memory. Verbatim storage, pluggable backend, 96.6% R@5 raw on LongMemEval — zero API calls."

> "people and projects become _wings_, topics become _rooms_, and original content lives in _drawers_"

> "Nothing leaves your machine unless you opt in."

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20

## Status, timeline, recency

- **2026-04-06** - project created and released. Per the third-party audit, "v3.1.0 for a project created 7 days ago. No v1 or v2 release exists" (it launched mid-version-number). Source: [gist audit](https://gist.github.com/roman-rr/0569fc487cc620f54a70c90ab50d32e3), [Cybernews](https://cybernews.com/ai-news/milla-jovovich-mempalace-memory-tool/).
- **2026-04-09** - earliest tagged release on the GitHub releases page: "v3.1.0 - 09 Apr 18:06". Source: [releases](https://github.com/MemPalace/mempalace/releases).
- **2026-04-11** - issue #618 "POSSIBLE SCAM REPO" opened by georgescharlesbrain, later "Closed as not planned". Source: [issue #618](https://github.com/MemPalace/mempalace/issues/618).
- **2026-04 onward** - steady release cadence: v3.3.0 (14 Apr), v3.3.1 (18 Apr), v3.3.2 (21 Apr), v3.3.3 (24 Apr), v3.3.4 (01 May), v3.3.5 (10 May), v3.3.6 (06 Jun), v3.4.0 (06 Jun). Source: [releases](https://github.com/MemPalace/mempalace/releases).
- **2026-06-15** - release "v3.4.1 — Cursor and Antigravity IDE support", timestamped "15 Jun 09:38". Source: [releases](https://github.com/MemPalace/mempalace/releases).
- **2026-06-23** - latest release v3.5.0: an opt-in local write daemon (`mempalace daemon`, serializes background palace writes through a single process), an opt-in HTTP transport for the MCP server, two new MCP tools (`mempalace_checkpoint`, `mempalace_delete_by_source`) plus a `source_file` filter, new transcript parsers for Continue.dev, Gemini CLI, and Pi agent, and SQLite performance work for large palaces. The release body: "This cycle adds two new ways to run MemPalace's write path and a set of tools for keeping a palace clean." Source: [releases](https://github.com/MemPalace/mempalace/releases) - accessed 2026-07-02.
- **Stars:** the repo page reports roughly 56,900 stars (up from ~19,500 and ~23,000 figures cited in earlier coverage). Star count is contested - see Confidence and gaps. Source: [github.com/MemPalace/mempalace](https://github.com/MemPalace/mempalace) - accessed 2026-07-02.

Recency verdict: active and actively shipping. Latest release is nine days before the access date, not dormant.

## Where memory lives (storage and architecture)

Default storage is local ChromaDB vectors plus local SQLite for the temporal knowledge graph, with three opt-in alternative backends. Memory is laid out as a memory palace.

> "ChromaDB is the default. For the pluggable-backend preview, MemPalace also ships `sqlite_exact` for local exact-vector correctness checks, and two opt-in external service backends — `qdrant` (REST) and `pgvector` (Postgres)."

> "MemPalace includes a temporal entity-relationship graph with validity windows — add, query, invalidate, timeline"

The knowledge graph is "backed by local SQLite." The palace structure (wings = people/projects, rooms = topics, drawers = original verbatim content) is the human-browsable layer over the vector index.

Requirements per the README: "Python 3.9+", "A vector-store backend (ChromaDB by default)", "~300 MB disk for the embedding model".

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20

## Retrieval

Three tiers, from pure-local semantic search up to optional LLM reranking. The base tier needs no API key and no LLM.

> "Raw (semantic search, no heuristics, no LLM): **96.6%**"

> "Hybrid v4, held-out 450q (tuned on 50 dev, not seen during training): **98.4%**"

> "Hybrid v4 + LLM rerank (full 500): ≥99%"

The hybrid layer's mechanics:

> "The hybrid pipeline adds keyword boosting, temporal-proximity boosting, and preference-pattern extraction"

So the default read path is embeddings-based semantic search over ChromaDB. Hybrid v4 layers deterministic boosts on top (keyword match, temporal proximity, preference patterns). The top tier sends the candidate set to a capable LLM for reranking, which is opt-in. The raw tier "requires no API key, no cloud, and no LLM at any stage."

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20

## Capture

Both manual CLI capture and automatic agent hooks. Capture is verbatim by design.

> "Auto-save hooks for Claude Code, Codex CLI, and Cursor IDE save periodically and before context compression"

> "run `mempalace sweep <transcript-dir>` periodically — it stores one verbatim drawer per user/assistant message"

File and conversation mining from the CLI:

```bash
mempalace mine ~/projects/myapp                    # project files
mempalace mine ~/.claude/projects/ --mode convos   # Claude Code sessions
```

So capture sources are: project file mining (`mine`), Claude Code session transcripts (`--mode convos`), per-message verbatim storage (`sweep`), and always-on auto-save hooks for Claude Code, Codex CLI, and Cursor IDE that fire periodically and right before the agent compacts its context. v3.4.1 added native hooks for Cursor IDE and Google Antigravity. v3.5.0 added transcript parsers for Continue.dev, Gemini CLI, and Pi agent, plus miner language support for C#, PHP, Swift, Kotlin, and Java. Storage is verbatim ("one verbatim drawer per user/assistant message"), not summarized.

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20
- [releases (v3.4.1, v3.5.0)](https://github.com/MemPalace/mempalace/releases) - accessed 2026-07-02

## How the AI reads it

Through an MCP server that exposes 35 tools, plus direct CLI commands for humans.

> "35 MCP tools cover palace reads/writes, knowledge-graph operations, cross-wing navigation, drawer management, and agent diaries."

Note on the tool count: the README stated 33 MCP tools at the 2026-06-20 check and states 35 as of 2026-07-02 (v3.5.0 added `mempalace_checkpoint` and `mempalace_delete_by_source`). A web-search snippet referencing Claude Code auto-discovery cited "19 MCP tools" - that appears to be the subset Claude Code surfaces by default, not the full server. The 35 figure is the primary-source (README) number and is what to cite. Since v3.5.0 the MCP server can also run over an opt-in HTTP transport (with security guards), and an opt-in local daemon can queue palace writes. Stdio remains the default.

Human-facing read commands from the quick start:

```bash
mempalace search "why did we switch to GraphQL"
mempalace wake-up
```

The MCP toolset covers palace reads/writes, knowledge-graph queries, cross-wing navigation, drawer management, and per-agent diaries. The architecture is a vector-search backend the LLM queries through MCP tool calls, not a flat-file store the LLM greps.

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-07-02
- [releases (v3.5.0)](https://github.com/MemPalace/mempalace/releases) - accessed 2026-07-02

## Pricing and license

Free and open source under MIT. No paid tier in the open-source repo.

> "MIT — see [LICENSE](LICENSE)."

Repo tagline: "The best-benchmarked open-source AI memory system. And it's free."

Install is free via PyPI (`pip install mempalace`) or `uv tool install mempalace`. A "MemPalace Cloud" domain (mempalace.cloud) surfaced in search and a `.net` download page advertising "v3.1.0", but the README explicitly warns that non-official domains are impostors, so no hosted/paid pricing tier is verifiable from primary sources. The README names the only official channels: GitHub repo, PyPI package `mempalace`, and docs at mempalaceofficial.com.

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20

## Benchmarks (vendor self-reported)

All numbers below are from the project's own README, self-reported, on retrieval recall.

> "Raw (semantic search, no heuristics, no LLM): **96.6%**" (LongMemEval R@5, 500 questions)

> "Hybrid v4, held-out 450q (tuned on 50 dev, not seen during training): **98.4%**"

> "Hybrid v4 + LLM rerank (full 500): ≥99%"

Additional self-reported figures pulled from the README:

- LoCoMo R@10 (raw): 60.3%
- LoCoMo hybrid v5 R@10: 88.9%
- ConvoMem average recall: 92.9%
- MemBench (R@5): 80.3%

Disclaimer the authors themselves include:

> "deliberately do not include a side-by-side comparison against Mem0, Mastra, Hindsight, Supermemory, or Zep"

Caveat: the gist audit states "The 96.6% LongMemEval score is ChromaDB's score. You could replicate it with ~50 lines of Python." Separately, the headline LongMemEval number was revised down from an earlier 100% claim to 96.6% after scrutiny (reported across third-party coverage). Treat all benchmark figures as vendor self-reported, not independently reproduced here.

- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-06-20
- [gist audit](https://gist.github.com/roman-rr/0569fc487cc620f54a70c90ab50d32e3) - accessed 2026-06-20

## vs imprnt

Both are local-first, free, and keep your data on your machine. The architecture is the opposite end of the spectrum from imprnt.

- **Storage substrate.** mempalace stores verbatim text indexed in ChromaDB vectors plus a SQLite knowledge graph. imprnt stores plain Markdown files with typed frontmatter, no vector DB. With imprnt the files are the product and they outlive the tool. mempalace's memory is locked inside a Chroma index and SQLite, readable only through its CLI/MCP.
- **Retrieval.** mempalace defaults to embeddings (semantic search) with an opt-in LLM rerank tier. imprnt is BM25 plus grep, zero embeddings, no LLM in the read loop. imprnt's read path is deterministic local arithmetic. mempalace pays for an embedding model (~300 MB) on disk and, at the top tier, LLM calls per query.
- **Capture philosophy.** mempalace auto-saves everything verbatim through always-on hooks (every user/assistant message becomes a drawer). imprnt is conscious, on-demand capture: the human says "ingest this" and the LLM does a one-time write-side enrichment (type, summary, tags, links). mempalace optimizes for total recall of raw transcripts. imprnt optimizes for a curated typed knowledge graph of entities.
- **Schema.** imprnt has a typed entity contract (people/orgs/holdings with aliases, wikilinks, contradiction handling). mempalace has a temporal entity-relationship graph but the user-facing organization is wings/rooms/drawers, derived from transcripts, not a hand-curated entity contract.
- **How the AI reads.** imprnt: the AI greps plain files directly, no server. mempalace: the AI calls an MCP server (35 tools) over a vector backend, since v3.5.0 optionally fronted by a local write daemon and an HTTP transport.
- **Survivability.** imprnt's core promise is the files outlive the tool being deleted. mempalace's memory does not survive deleting mempalace, because it lives in Chroma/SQLite and is reconstructed through its own tooling.

## When it wins over imprnt

- You want zero-effort, fully automatic capture of every coding-agent message without ever consciously filing anything. mempalace's always-on hooks for Claude Code, Codex, Cursor, and Antigravity do this out of the box.
- You need fuzzy semantic recall over large raw transcript volumes ("find the conversation where we discussed X" by meaning, not keywords). Embeddings beat BM25 when the query and the stored text share no literal terms.
- You want a turnkey MCP server with 35 tools your agent can call immediately, rather than wiring grep yourself.
- You want the temporal-graph queries (validity windows, invalidate, timeline) as a built-in feature.
- You are fine with memory living in a vector DB and do not need the data to be human-portable plain Markdown that survives the tool.

## Sources

- [github.com/MemPalace/mempalace](https://github.com/MemPalace/mempalace) - accessed 2026-07-02
- [github.com/MemPalace/mempalace/blob/main/README.md](https://github.com/MemPalace/mempalace/blob/main/README.md) - accessed 2026-07-02
- [github.com/MemPalace/mempalace - releases](https://github.com/MemPalace/mempalace/releases) - accessed 2026-07-02
- [github.com/MemPalace/mempalace - issue #618 "POSSIBLE SCAM REPO"](https://github.com/MemPalace/mempalace/issues/618) - accessed 2026-06-20
- [gist.github.com/roman-rr - "MemPalace Exposed" audit](https://gist.github.com/roman-rr/0569fc487cc620f54a70c90ab50d32e3) - accessed 2026-06-20
- [cybernews.com - Milla Jovovich creates MemPalace AI memory tool](https://cybernews.com/ai-news/milla-jovovich-mempalace-memory-tool/) - accessed 2026-06-20

## Confidence and gaps

- **Star count is contested and the most uncertain fact.** The repo page reports ~56,000 stars, but a public audit gist ("MemPalace Exposed") alleges "42,497 GitHub stars" were acquired in "7 days" via a "textbook bot-farm pattern" (e.g. "Page 100 (April 7)" showing "10 stars in 63 seconds" with "Two stars in the same second"). I could not independently verify the stargazer-timestamp analysis from a primary source, so the star figure should be treated as unreliable as a popularity signal. The audit is one developer's analysis, not an official source.
- **Authorship.** Coverage attributes the project to actress Milla Jovovich (GitHub account `milla-jovovich`) with crypto developer Ben Sigman (`bensig`). The audit notes the `milla-jovovich` account has "0 public repositories" and was listed as "COLLABORATOR" not owner, and that there is no verification the account belongs to the real actress. The README I fetched did not name either person, so authorship is unverified from the primary repo source.
- **"AAAK 30x compression" and "170-token startup".** These appear in third-party blogs and a search summary, not in the README I fetched. Unverified - the README emphasizes verbatim storage and fidelity, which sits in tension with a "30x compression" claim. Flagged as unverified.
- **MCP tool count discrepancy.** Verified as 35 per the README as of 2026-07-02 (33 before v3.5.0). A "19 MCP tools" figure from a search snippet appears to be Claude Code's auto-discovered subset, not the full server. Confirmed: 35 is the README number.
- **Benchmarks are vendor self-reported and disputed.** The headline number was revised down from an earlier 100% claim to 96.6% after scrutiny (third-party coverage), and the audit gist states the 96.6% "is ChromaDB's score" replicable in "~50 lines of Python," i.e. effectively unmodified ChromaDB. Not independently reproduced. The authors themselves decline head-to-head comparisons vs Mem0/Zep.
- **Hosted/paid tier.** A "MemPalace Cloud" domain and a `.net` download page exist, but the README warns all non-official domains are impostors. No verifiable paid pricing. The only confirmed distribution is free MIT via PyPI/uv.
- **Last commit date.** I confirmed the latest release (v3.4.1, 15 Jun 2026) but did not separately read the raw commit log timestamp. The release date is recent enough to call the project active.
