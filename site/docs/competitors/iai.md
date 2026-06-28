# iai

**One-line:** A local, MIT-licensed MCP memory server (full name "iai-pme", Independent Autistic Intelligence Personal Memory Engine) that automatically captures every conversation turn verbatim, consolidates it into an encrypted episodic/semantic/procedural store, and auto-injects a relevant memory slice at the start of each new AI coding session.

**Status (checked 2026-06-20):** active - the repo's most recent commit is dated `2026-06-20T04:00:36Z` ("docs: mark Linux supported, Windows coming soon"), the GitHub API reports `"pushed_at": "2026-06-20T04:00:44Z"` and `"archived": false`, and the newest release v1.1.2 shipped 2026-06-18, two days before this check. This is an actively developed project.

**Latest release:** v1.1.2, 2026-06-18 | **Stars:** 265 | **License:** MIT | **Hosting:** self-host (fully local, no cloud)

## What it is

iai is a local memory layer for AI coding assistants. It runs as a background daemon plus an MCP server on the user's own machine, records every turn of every session, and feeds back a small context slice automatically at session start so the assistant "remembers" across conversations without the user ever issuing a remember command.

> "A local server that speaks the MCP protocol and gives Claude, and any other MCP-compatible assistant, a long-term memory. It captures every turn of every session verbatim, organizes those captures over time into a personal map of who you are, and serves a small slice of relevant memory back at the start of each new conversation."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

The repo's own tagline positions it on benchmark performance:

> "The best-benchmarked open-source memory system for AI coding assistants"

Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine (the `description` field, accessed 2026-06-20)

The "IAI" acronym expands to "Independent Autistic Intelligence" and the privacy stance is explicit:

> "And unlike cloud memory services, there's no API key, no account, and no telemetry: the engine, the store, and the embeddings all run locally."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

## Status, timeline, recency

Naming note up front: the canonical repository is `CodeAbra/iai-personal-memory-engine`. The GitHub API returns `"full_name": "CodeAbra/iai-personal-memory-engine"`, and the URL `github.com/CodeAbra/iai-mcp` silently redirects to it (GitHub's rename-redirect behavior). The prior internal notes had the rename direction backwards: `iai-mcp` is the old/alias slug, `iai-personal-memory-engine` is the live name. The CLI binaries installed are `iai` and `iai-mcp`. Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine (accessed 2026-06-20).

- 2026-05-06: repository created. GitHub API `"created_at": "2026-05-06T08:04:52Z"`. Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine (accessed 2026-06-20).
- 2026-05-11: v0.1.0, "Initial public release". Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine/releases (accessed 2026-06-20).
- 2026-05-12: v0.2.0, "Int8 embedding quantization option; contradiction-aware temporal validity". Source: same releases API (accessed 2026-06-20).
- 2026-05-13: v0.3.0, "Per-turn ambient capture; session-start recall injection via hooks", followed same day by v0.3.1 and v0.3.2 (the latter a security fix making the precache file 0600). Source: same releases API (accessed 2026-06-20).
- 2026-05-14: v0.4.0 (memory bank denormalized caches, `bank-recall` CLI) and v0.4.1 (GIL contention fix). Source: same releases API (accessed 2026-06-20).
- 2026-05-15: v0.4.2, "Update-check hook" added. Source: same releases API (accessed 2026-06-20).
- 2026-06-06: v1.0.0, "First stable release with Hippo storage engine and native Rust extension", and v1.0.1 same day ("Daemon RSS crash-loop" fix). Source: same releases API (accessed 2026-06-20).
- 2026-06-08: v1.0.2, packaging fixes (launchd plist and systemd unit ship inside the wheel). Source: same releases API (accessed 2026-06-20).
- 2026-06-11: v1.0.3, MCP `tools/list` no longer stalls when the daemon is down. Full-transcript session capture. Source: same releases API (accessed 2026-06-20).
- 2026-06-15: v1.1.0, "Experimental Linux support" plus source restructured into focused packages, then v1.1.1 same day (Linux runtime fixes). Source: same releases API (accessed 2026-06-20).
- 2026-06-18: v1.1.2 (latest), "macOS Keychain credentials for nightly consolidation" fix. Source: same releases API (accessed 2026-06-20).
- 2026-06-20 (today): latest commit `"docs: mark Linux supported, Windows coming soon"` at `2026-06-20T04:00:36Z`. API `"pushed_at": "2026-06-20T04:00:44Z"`. Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine/commits?per_page=1 and the repo API (accessed 2026-06-20).
- Recency verdict: very fresh. 15 tagged releases in roughly six weeks (2026-05-11 through 2026-06-18), a commit landed the same day as this check. Not dormant, not archived. `"archived": false`, `"disabled": false`. Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine (accessed 2026-06-20).
- Stars 265, forks 37, open issues 4. Source: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine (accessed 2026-06-20).
- Author: "By Areg Aramovich Noya, in collaboration with the team at [lcgc.dev](https://lcgc.dev)." Note: lcgc.dev returned HTTP 403 to a live fetch on 2026-06-20, so the org behind it is unverified beyond the README credit. Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

## Where memory lives (storage and architecture)

Memory lives entirely on the local machine in a custom encrypted SQLite-based engine named "Hippo," which holds the records, the vector index, and the graph together in one store.

> "Hippo — The storage engine — encrypted records, the vector index, and the graph in one local store."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

Encryption at rest is AES-256-GCM with a locally held key:

> "All records are encrypted at rest with AES-256-GCM. The key lives in `~/.iai-mcp/.key` (mode 0600)."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

The data is organized into three memory tiers:

> "Episodic is verbatim, timestamped fragments of what was said. Semantic is summaries induced from clusters of related episodes during idle-time consolidation. Procedural is a small set of stable parameters about you, learned over time."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

On top of the tiers sits a hyperdimensional substrate called "Lilli HD" and a custom clustering algorithm called "MOSAIC":

> "Lilli HD | The hyperdimensional memory substrate — distinct representations for episodic / semantic / procedural memory, with structural recall (retrieve by the *shape* of a memory, not just its embedding)."

> "MOSAIC | My community-detection algorithm. It clusters the memory graph so recall spreads through the right neighbourhood and sleep can replay coherent episodes — tuned for a small, heterogeneously-weighted graph that changes every cycle, with stable community identity across splits and merges."

Source (both): https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

A native Rust extension implements the performance-critical kernels, built during install via `setuptools-rust`. The language breakdown on the repo is Python 94.8% / TypeScript 1.9% / Rust 1.8% / Shell 1.4% / JavaScript 0.1%. Sources: https://github.com/CodeAbra/iai-personal-memory-engine and the README (both accessed 2026-06-20).

The storage format is a binary, encrypted SQLite store, not human-readable plain files. There is no plain-Markdown layer a user can read or edit by hand.

## Retrieval

Retrieval is local-only and combines three weighted signals over the graph and vector index. There is no BM25 anywhere in the README description.

> "Recall combines three signals: semantic similarity, graph-link strength, and recency."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

Embeddings are computed locally with `bge-small-en-v1.5` (384-dimensional, per the benchmarks table, where "iai (product)" is listed against that embedder). The retrieval hot path is described as running locally with no LLM in the loop on a normal recall. Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

Measured retrieval latency from the vendor benchmarks: p95 of 77 ms at 1,000 records and 368 ms at 10,000 records. RSS memory footprint of 589 MB at 10,000 records. Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

The contrast with imprnt: imprnt's core ranker is BM25 (term-frequency times inverse-document-frequency, pure local arithmetic, zero embeddings, zero model). iai's recall is embedding-plus-graph-plus-recency with a 384-dim local neural embedder and a custom hyperdimensional substrate. Both keep the LLM out of the per-query hot path, but iai pays a model and an index on every write, where imprnt pays only term-frequency arithmetic.

## Capture

Capture is fully automatic and ambient. The user never issues a remember command.

> "You never have to say 'remember this' or 'what did we say last time?'"

> "Capture is automatic. Every turn, yours and the assistant's, is recorded verbatim with timestamps and session metadata."

Source (both): https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

Mechanically, capture is wired through shell hooks installed into the Claude Code / Codex hook system via `iai-mcp capture-hooks install`. A `UserPromptSubmit` hook records each turn (described as roughly 5 ms per turn, no embedding on the hot capture path), a `Stop` hook rolls the buffered session to the engine, and a `SessionStart` hook injects the memory prefix into `additionalContext`. Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

A nightly idle-time consolidation ("sleep cycle") clusters episodes into semantic summaries, decays stale links, and reinforces frequently co-retrieved paths. It may make at most one LLM call per night through the user's existing Claude subscription:

> "One step per night can make a single LLM call **through your existing Claude subscription** (`claude -p`) — no separate API key, capped at ≤1% of your daily quota."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

There is no conscious, on-demand filing path described. Capture is the always-on default. The model is "record everything, consolidate later," which is the opposite of imprnt's "you consciously decide what becomes a note."

## How the AI reads it

The AI reads memory through an MCP server speaking MCP-over-stdio. Hosts (Claude Code, Codex CLI, Gemini CLI, Cursor CLI) connect via a config block pointing `node` at the wrapper's built `index.js`. A `SessionStart` hook also auto-injects a memory slice into `additionalContext` before the conversation begins, so reading is partly push (auto-injected) and partly pull (MCP tool calls). Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

There is also a CLI, surfacing the same operations:

> "There's also a CLI — you don't need it for normal use, but when you want to query or add to your memory straight from the terminal, `iai` is there: `recall`, `capture`, `ask` (LLM synthesis grounded in your memory), `status`, and `last`."

Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20)

The session-start auto-injection is sized to a token budget: measured 1,629 (min) to 2,993 (std) tokens, under a stated 3,000-token budget. Source: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20).

## Pricing and license

Free and open-source under MIT. There is no paid tier, no cloud service, no account, no telemetry, no API key required for normal use (the optional nightly consolidation rides the user's existing Claude subscription via `claude -p`). License field from the GitHub API: `"license_spdx_id": "MIT"`. Sources: https://api.github.com/repos/CodeAbra/iai-personal-memory-engine and the README (both accessed 2026-06-20).

Distribution is from source, not a package registry. Install is `git clone` then `pip install .` (which builds the Rust extension via `setuptools-rust`), then `npm install && npm run build` in `mcp-wrapper`, then `iai-mcp daemon install` and `iai-mcp capture-hooks install`. There is no PyPI package: a live fetch of `https://pypi.org/pypi/iai-pme/json` returned HTTP 404 on 2026-06-20, consistent with the README's "there is no PyPI package name." Requirements: "macOS (Apple Silicon) or Linux · Python 3.11 or 3.12 · Node.js 18+ · A Rust toolchain." Sources: https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md and https://pypi.org/pypi/iai-pme/json (both accessed 2026-06-20).

## Benchmarks (vendor self-reported)

All figures below are the vendor's own reported numbers from the README. They are not independently reproduced here.

LongMemEval-S:

| System | Embedder | R@5 | R@10 |
|---|---|---|---|
| iai (product) | bge-small-en-v1.5 | 0.962 | 0.978 |
| iai (matched embedder) | all-MiniLM-L6-v2 | 0.966 | 0.978 |
| mempalace v3.3.6 | all-MiniLM-L6-v2 | 0.966 | 0.978 |

Longitudinal:

| Benchmark | Result | What it measures (vendor wording) |
|---|---|---|
| Rescue@10 (post-contradiction) | 1.000 | After a fact is updated/contradicted, the current fact still ranks top-10 |
| Personal-fact drift (recall@10) | 0.9933 | Retention across 50 facts / 50 sessions / 30 intervening sessions |
| Sleep-consolidation (recall@10) | 1.000 to 1.000 | Recall survives a full consolidation cycle |
| Session-start tokens | 1,629 min / 2,993 std | Under the 3,000-token budget |

Cost and footprint:

| Metric | Measured |
|---|---|
| Recall p95 latency @1k records | 77 ms |
| Recall p95 latency @10k records | 368 ms |
| Memory (RSS) @10k records | 589 MB |

Source (all tables): https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md (accessed 2026-06-20). The README states full harnesses live in a `bench/` directory with reproduction commands, which were not independently run for this dossier.

## vs imprnt

- Storage format: iai stores everything in an encrypted binary SQLite engine (Hippo) with AES-256-GCM at rest. The data is not human-readable and not editable by hand. imprnt stores plain Markdown files you can open, grep, edit, and version yourself. The vault outlives the tool. If imprnt the binary vanishes, the files are still readable. If iai vanishes, you have an encrypted SQLite blob and a key.
- Retrieval: iai uses a 384-dim local neural embedder (bge-small-en-v1.5) plus graph-link strength plus recency, with a custom hyperdimensional substrate (Lilli HD) and clustering (MOSAIC). imprnt uses BM25 (term-frequency arithmetic) plus grep, no embeddings, no vectors, no model. iai's recall is richer and benchmark-tuned. imprnt's is dependency-free, transparent, and inspectable.
- Capture: iai is ambient and automatic, recording every turn verbatim with no conscious filing step. imprnt is conscious and on-demand. You decide what becomes a note, and the LLM does the one-off enrichment at ingest. iai's model is "capture everything, consolidate at night". imprnt's is "capture deliberately, ration the LLM by where it runs."
- Entity model: imprnt has a typed entity contract (people / orgs / holdings with aliases, frontmatter type/kind/tags, wikilinks, entity resolution with merge-on-alias-hit). iai has an emergent graph of episodes/semantic-summaries/procedural-params clustered by MOSAIC, not a typed, hand-curatable entity schema. iai discovers structure. imprnt declares it.
- Background processing: iai runs a daemon plus nightly sleep cycles (one `claude -p` LLM call per night). imprnt has no daemon and no background loop. Its only "robot" steps are two commands you run by hand (`check` and harvest).
- Reading: both keep the LLM out of the per-query hot path. iai pushes an auto-injected memory slice at session start. imprnt never auto-injects context, it answers on request.
- Surface: both are local-first, MIT, self-host, no cloud, no telemetry. The genuine overlap is "local private memory for AI." The split is determinism and ownership of format (imprnt) versus automatic ambient capture and benchmark-tuned neural recall (iai).

## When it wins over imprnt

- You want zero-effort, fully automatic capture of every coding session with no manual filing, and you accept an opaque encrypted store as the cost. iai records everything ambiently. imprnt asks you to consciously decide what to keep.
- You are optimizing for benchmark recall accuracy on long-conversation memory (LongMemEval-style) and want neural-embedding plus graph recall out of the box. iai is explicitly tuned and self-reports strong R@5/R@10. imprnt's BM25 is deliberately "the dumbest thing that works."
- Your use case is an AI coding assistant that should silently remember prior sessions across Claude Code / Codex / Gemini / Cursor, with a SessionStart auto-injection doing the work invisibly. imprnt deliberately never auto-injects.
- You want nightly automatic consolidation (summaries, link decay, reinforcement) handled by a daemon, and you are fine with a background service plus one `claude -p` call per night. imprnt has no daemon and no background loop by design.
- You care more about retrieval signals (embeddings + graph + recency) than about owning a plain-text, hand-editable, tool-independent file format.

## Sources

- [iai-personal-memory-engine README (raw, main branch)](https://raw.githubusercontent.com/CodeAbra/iai-personal-memory-engine/main/README.md) - accessed 2026-06-20
- [GitHub repo: CodeAbra/iai-personal-memory-engine](https://github.com/CodeAbra/iai-personal-memory-engine) - accessed 2026-06-20
- [GitHub API: repo metadata (stars, forks, dates, license, archived flag)](https://api.github.com/repos/CodeAbra/iai-personal-memory-engine) - accessed 2026-06-20
- [GitHub API: releases (full dated list)](https://api.github.com/repos/CodeAbra/iai-personal-memory-engine/releases) - accessed 2026-06-20
- [GitHub API: tags](https://api.github.com/repos/CodeAbra/iai-personal-memory-engine/tags) - accessed 2026-06-20
- [GitHub API: latest commit](https://api.github.com/repos/CodeAbra/iai-personal-memory-engine/commits?per_page=1) - accessed 2026-06-20
- [Redirect-source URL github.com/CodeAbra/iai-mcp (redirects to iai-personal-memory-engine)](https://github.com/CodeAbra/iai-mcp) - accessed 2026-06-20
- [PyPI iai-pme JSON (returned HTTP 404, confirms no PyPI package)](https://pypi.org/pypi/iai-pme/json) - accessed 2026-06-20
- [Author org lcgc.dev (returned HTTP 403, org unverified beyond README credit)](https://lcgc.dev) - accessed 2026-06-20

## Confidence and gaps

- High confidence on status, recency, version, stars, license, and the dated timeline: all pulled from the live GitHub API and the raw README on 2026-06-20.
- Repo name correction is high confidence: the canonical name is `iai-personal-memory-engine` (GitHub API `full_name`), and `iai-mcp` is the redirect alias. The prior internal notes stated the rename direction backwards.
- All benchmark numbers are vendor self-reported. They were read verbatim from the README's tables. They were not independently reproduced (the README cites a `bench/` directory. That harness was not run here). Treat R@5 0.962, R@10 0.978, Rescue@10 1.000, drift 0.9933, p95 77 ms / 368 ms, RSS 589 MB as the vendor's claims, unverified by a third party.
- The author credit (Areg Aramovich Noya, lcgc.dev) is taken from the README. lcgc.dev returned HTTP 403 on a live fetch, so the organization behind it is unverified beyond that one README line.
- No PyPI/npm distribution exists. Install is from source. Confirmed by the README's installation section and a 404 on the expected PyPI path.
- "Independent Autistic Intelligence" as the IAI expansion comes from the README and a secondary search summary, both consistent. Confidence high but the phrasing is the project's own.
- Star count (265) is a point-in-time snapshot at 2026-06-20 and will drift.
