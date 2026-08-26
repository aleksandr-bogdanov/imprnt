# nanobot (HKUDS)

**One-line:** An ultra-lightweight, self-hosted personal AI agent framework from HKU's Data Intelligence Lab (the LightRAG lab), whose long-term memory is plain Markdown files a scheduled "Dream" pass edits, with an append-only JSONL history underneath, git-versioned, and with no retrieval index of any kind: the memory file rides whole in every prompt and the agent greps the rest.

**Status (checked 2026-08-26):** active. The repo's `pushed_at` is 2026-08-26, the check date itself (GitHub API). Latest release is v0.3.0, published 2026-07-25, announcing "260 PRs merged and 38 new contributors" (https://github.com/HKUDS/nanobot/releases/tag/v0.3.0). Development has continued for a month past that release: the README's "Recent Updates" stop at 2026-07-24 while commits land daily.

**Latest release:** v0.3.0 ("The Agency Release"), 2026-07-25 | **Stars:** 47,425 | **Forks:** 8,369 | **License:** MIT | **Language:** Python | **Hosting:** self-hosted, free, BYOK

> Stars, forks, license, and dates are from the GitHub API (`stargazers_count: 47425`, `forks_count: 8369`, `license.spdx_id: MIT`, `created_at: 2026-02-01`, `pushed_at: 2026-08-26T14:59:45Z`), accessed 2026-08-26. The maintainer org HKUDS is "✨Data Intelligence Lab@HKU✨" (GitHub org API, accessed 2026-08-26), the lab behind LightRAG ("[EMNLP2025] LightRAG: Simple and Fast Retrieval-Augmented Generation", 39,204 stars, github.com/HKUDS/LightRAG). Named maintainers: Xubin Ren and Yongru Chen (README).

## What it is

The README opens:

> "nanobot is an ultra-lightweight, open-source, self-hosted personal AI agent framework written in Python. It runs in a WebUI, terminal, or chat apps and combines tools, long-term memory, MCP integrations, model routing, multi-agent delegation, scheduled automation, and an OpenAI-compatible API in a small, readable core."

- https://raw.githubusercontent.com/HKUDS/nanobot/main/README.md (accessed 2026-08-26)

The capability list, from the same README: it is "a self-hosted personal AI agent runtime" that can "run in a browser WebUI or terminal", "connect to Telegram, Discord, Slack, WeChat, Email, Mattermost, and other chat apps", "use tools such as files, shell, web search, web fetch, MCP, cron, image generation, and subagents", "keep session history and long-term memory through Dream", "run long-horizon goals and scheduled automations", and "expose a Python SDK and OpenAI-compatible API for integrations".

It openly courts OpenClaw's users: the gateway-first workflow "is the familiar entry point if you are coming from OpenClaw or already operate agents as long-lived services" (README, accessed 2026-08-26). The architecture doc states the design stance: "nanobot stays lightweight by centering everything around a small agent loop: messages come in from chat apps, the LLM decides when tools are needed, and memory or skills are pulled in only as context instead of becoming a heavy orchestration layer" (https://github.com/HKUDS/nanobot/blob/main/docs/architecture.md, accessed 2026-08-26).

## Status, timeline, recency

- 2026 (Feb 1): repository created (`created_at: 2026-02-01T07:16:15Z`, GitHub API, accessed 2026-08-26).
- 2026 (Feb 4): earliest GitHub release, v0.1.3.post4, published 2026-02-04. Releases begin three days after repo creation. Source: https://api.github.com/repos/HKUDS/nanobot/releases (accessed 2026-08-26)
- 2026 (Feb-Jul): 19 releases total. v0.2.0 May 16, v0.2.1 Jun 1, v0.2.2 Jun 23, v0.3.0 Jul 25 (all from the releases API, accessed 2026-08-26).
- 2026 (Jul 25): v0.3.0 "The Agency Release": "Consult inline subagents without leaving the current task", "Switch model presets per session directly from the composer", guided WebUI setup, live config reloads. Source: https://github.com/HKUDS/nanobot/releases/tag/v0.3.0 (accessed 2026-08-26)
- 2026 (Aug 26): last push, the check date (GitHub API).

Recency verdict: active and fast-moving. 47.4k stars in under seven months, a release roughly monthly, 741 open issues, and a push on the check date. The star velocity trails only Hermes and OpenClaw among the tools in this folder, on a repo one-third their age.

## Where memory lives

Plain files in the agent workspace (default `~/.nanobot/workspace/`), layered by role. From the memory doc:

> "It separates memory into layers, because different kinds of remembering deserve different tools: `session.messages` holds the living short-term conversation. `memory/history.jsonl` is the running archive of compressed past turns. `SOUL.md`, `USER.md`, and `memory/MEMORY.md` are the durable knowledge files. `GitStore` records how those durable files change over time."

- https://github.com/HKUDS/nanobot/blob/main/docs/memory.md (accessed 2026-08-26)

The roles, verbatim: "`SOUL.md` remembers how nanobot should sound. `USER.md` remembers who the user is and what they prefer. `MEMORY.md` remembers what remains true about the work itself. `history.jsonl` remembers what happened on the way there." The workspace tree in the doc also shows `memory/.cursor` (consolidator write cursor), `memory/.dream_cursor` (Dream consumption cursor), and `memory/.git/` ("Version history for long-term memory files"). Session transcripts live outside the workspace as JSONL under `~/.nanobot/sessions/<workspace-id>/` (architecture.md, accessed 2026-08-26).

The raw/curated split is explicit design: the move from a human-readable `HISTORY.md` to `history.jsonl` bought "a better boundary between raw history and curated knowledge", and "`history.jsonl` is for structure" while "`SOUL.md`, `USER.md`, and `MEMORY.md` are for meaning" (memory doc, accessed 2026-08-26). Memory changes are auditable and reversible: `/dream-log` shows a change, `/dream-restore <sha>` restores "to the state before a specific change", because "users should always retain the right to inspect, understand, and restore it."

## Retrieval

There is none, in the ranking sense. Verified in source (accessed 2026-08-26):

- `MEMORY.md` is injected whole into the system prompt every turn. `ContextBuilder` in `nanobot/agent/context.py`: `memory = self.memory.read_memory()` then `parts.append(f"# Memory\n\n## Long-term Memory\n{memory}")`, alongside the bootstrap files `AGENTS.md`, `SOUL.md`, `USER.md`.
- Recent `history.jsonl` entries since the last Dream cursor are also injected, capped at `_MAX_RECENT_HISTORY = 50` entries and `_MAX_HISTORY_TOKENS = 8_000` (context.py).
- Everything older is reached by the agent grepping its own files. The memory doc says so directly: "You can still search it with familiar tools" followed by literal `grep -i "keyword" memory/history.jsonl`, `jq`, and Python one-liner examples. The agent's own toolset matches: `nanobot/agent/tools/search.py` opens with the docstring "Search tools: file discovery and grep." and ships `FindFilesTool` (name `find_files`) and `GrepTool` (name `grep`, "Search text, PDF, DOCX, XLSX, and PPTX content"), a pure-Python regex scan with no index behind it.
- `MemoryStore` (`nanobot/agent/memory.py`, 1,212 lines) has no search method at all. Its full public surface is read/write for the three files, history append/compact, cursor bookkeeping, and the Dream pass. No BM25, no FTS, no embeddings, no vectors anywhere in the memory path.

So the read path is injection plus agent-driven grep: the durable layer is assumed small enough to carry whole, and anything beyond it costs an LLM tool call to a plain regex scan. Nothing ranks, ever.

## Capture

Automatic, two-stage, agent-authored. From the memory doc (accessed 2026-08-26):

Stage 1, Consolidator: "When a conversation grows large enough to pressure the context window", the `Consolidator` "summarizes the oldest safe slice of the conversation and appends that summary to `memory/history.jsonl`", a file that is "append-only", "cursor-based", and "optimized for machine consumption first, human inspection second". The doc is candid about its rank: "It is not the final memory. It is the material from which final memory is shaped."

Stage 2, Dream: "the slower, more thoughtful layer. It runs on a cron schedule by default and can also be triggered manually." Dream reads the new history entries plus the three current files, "Then it edits the long-term files surgically in a single pass -- not by rewriting everything, but by making the smallest honest change that keeps memory coherent." Dream "decides what to keep, update, or forget", and its behavior is steerable per workspace via an editable `prompts/dream.md` (`/dream-prompt init`). The default schedule is every two hours: `nanobot/config/schema.py` has `enabled: bool = True` and `interval_h: int = Field(default=2)` with the comment "Every 2 hours by default" (accessed 2026-08-26).

An opt-out exists per conversation: the WebUI offers "temporary chats when a conversation should not be saved to history or memory" (README, accessed 2026-08-26). But the default is continuous ambient capture with a scheduled consolidation pass, the opposite of imprnt's conscious harvest.

## How the AI reads it

The agent is the reader and the runtime is the product. `ContextBuilder` "combines project instructions with agent-owned profile and memory" into the system prompt (architecture.md), and the agent reaches everything else through its own tools (read_file, grep, find_files, shell). The gateway (`nanobot gateway --background`) keeps channels, cron jobs, "and system jobs such as Dream" running unattended. Humans reach the same agent through the WebUI (bundled in the wheel, `nanobot webui`), the terminal TUI (`nanobot agent`), or the chat channels. Integrations reach it through the OpenAI-compatible API and a Python SDK, and MCP servers plug in as tools. Memory stays continuous across projects: "This keeps one agent's profile and memory continuous while it works across projects", with a separate workspace recommended "when identity or memory must be isolated" (memory doc, accessed 2026-08-26).

## Pricing and license

MIT license (GitHub API and the README's license badge, accessed 2026-08-26). Free, self-hosted, no hosted service and no paid tier of its own. You bring a model: hosted providers via OpenAI-compatible APIs with specialized paths for "Anthropic, Azure OpenAI, AWS Bedrock, OpenAI Codex, and GitHub Copilot" (architecture.md), or local models via Ollama and vLLM (README). A one-click Render deploy exists, where "Persistent disks require a paid Render service" (README). The README carries an "Open Source Partners" section with Kimi and MiniMax referral links, which is sponsorship, and there is no product revenue surface beyond it.

## Benchmarks

None found. No memory or agent benchmark scores appear in the README, the memory doc, or the architecture doc (accessed 2026-08-26). The lab publishes research benchmarks elsewhere (LightRAG is an EMNLP 2025 paper), but nanobot itself ships no LoCoMo or equivalent number.

## vs imprnt

This is the closest architecture to imprnt in the whole field, closer than Letta's pivot target. The floor is identical: durable knowledge as plain Markdown files on disk, an append-only raw layer beneath a curated layer ("a better boundary between raw history and curated knowledge" is imprnt's raw/-vault/ split in different words), git as the version history, zero embeddings, zero vector store, zero database, and grep as the documented search verb. Even the philosophy rhymes: "Good memory is not a pile of notes. It is a quiet system of attention" (memory doc).

The splits that remain are sharp:

- No ranker versus BM25. nanobot has no retrieval step at all: `MEMORY.md` rides whole in every prompt and older history is a regex grep away, unranked. That works exactly as long as durable memory stays prompt-sized, which is why Dream must "keep, update, or forget", with forgetting as a load-bearing feature. imprnt's BM25 exists so the corpus never has to fit in context: thousands of typed notes stay cheap to search, and nothing is evicted to make room.
- The one-file pattern. nanobot's durable store is the always-injected `MEMORY.md`, the exact pattern imprnt's contract bans for itself ("Do not use the host's auto-memory," a second always-on store that search cannot reach into selectively). imprnt files knowledge as atomic notes found on demand. nanobot compiles knowledge into one file carried always.
- No schema, and no identity machinery. `MEMORY.md` holds "Project facts, decisions, and durable context" as freeform prose. No typed entities, no people/orgs/holdings, no tags, no per-note files. Concretely, that costs three mechanisms imprnt's contract runs in code: entity resolution (a new mention is grepped against names plus `aliases[]` and MERGED into the existing note, so the same doctor never splits into two records - in freeform prose she does, under two spellings), the link graph (`[[wikilinks]]` as real edges, so a fix to one entity note propagates to everything referencing it), and `imprnt check` as a deterministic integrity pass (orphan links, untagged notes, notes resolving no entity, all flagged by code). nanobot's only integrity mechanism is Dream, an LLM pass, which is judgment where imprnt deliberately uses arithmetic.
- Who writes, and when. nanobot's capture is automatic (Consolidator on context pressure, Dream on a two-hour cron) and its curation is the agent's judgment in a background pass. imprnt's capture is conscious ("harvest this") and its write path is a one-time LLM investment audited by a deterministic `imprnt check`.
- Fidelity. nanobot's history layer holds summaries of turns ("compressed past turns"), so the source data itself is lossy from stage one. imprnt's raw/ keeps immutable full snapshots, and the cardinal rule copies structured payload into the searchable notes.
- Scope. nanobot is an agent runtime with memory as one subsystem. Delete nanobot and the Markdown files still open, a genuinely shared property, but Dream, consolidation, the restore commands, and the gateway die with it. imprnt is only the memory, designed to ride inside whatever agent you already run.

And where the honest answer is "nothing": on vendor-survivable plain files, on zero embeddings, and on git as the history, nanobot concedes nothing to imprnt - the floors are the same, verified in source. On the write side both even spend the LLM once per item rather than per query (Dream's consolidation is exactly imprnt's one-off write-path investment, differently triggered). The whole difference lives in three places: who decides what is written (a cron pass or a human saying "file this"), whether the store has a contract code can check, and whether recall needs a ranker at all - nanobot's answer is to keep durable memory small enough to carry, imprnt's is to keep it unbounded and rank it.

## When it wins over imprnt

- You want the whole assistant product: one pip install gives a WebUI, a TUI, Telegram/Discord/Slack/WeChat/Email/Mattermost channels, cron automations, subagents, MCP, image generation, and an OpenAI-compatible API.
- You want zero-effort memory that maintains itself on a schedule, with no filing decisions ever, and you accept the agent deciding what to forget.
- You want auditable automatic memory: every Dream edit is a git commit you can inspect (`/dream-log`) and roll back (`/dream-restore <sha>`). imprnt leaves versioning to your own git usage.
- You are leaving OpenClaw and want the same product shape in "a small, readable core" of Python you can actually read and extend.
- Your durable memory genuinely fits in a prompt. For a single project's working context, injection beats retrieval on latency and simplicity.

## Sources

- [nanobot GitHub repository](https://github.com/HKUDS/nanobot) - accessed 2026-08-26
- [GitHub API: repo metadata](https://api.github.com/repos/HKUDS/nanobot) - accessed 2026-08-26 (stars, forks, license, created_at, pushed_at)
- [GitHub API: releases](https://api.github.com/repos/HKUDS/nanobot/releases) - accessed 2026-08-26
- [v0.3.0 release](https://github.com/HKUDS/nanobot/releases/tag/v0.3.0) - accessed 2026-08-26
- [nanobot README (raw, main branch)](https://raw.githubusercontent.com/HKUDS/nanobot/main/README.md) - accessed 2026-08-26
- [Memory doc: AI Agent Memory in nanobot](https://github.com/HKUDS/nanobot/blob/main/docs/memory.md) - accessed 2026-08-26
- [Architecture doc](https://github.com/HKUDS/nanobot/blob/main/docs/architecture.md) - accessed 2026-08-26
- [Source: nanobot/agent/context.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/context.py) - accessed 2026-08-26 (prompt injection, history caps)
- [Source: nanobot/agent/memory.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/memory.py) - accessed 2026-08-26 (MemoryStore, no search methods)
- [Source: nanobot/agent/tools/search.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/tools/search.py) - accessed 2026-08-26 (find_files + grep tools)
- [Source: nanobot/config/schema.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/config/schema.py) - accessed 2026-08-26 (DreamConfig defaults)
- [GitHub org API: HKUDS](https://api.github.com/orgs/HKUDS) - accessed 2026-08-26 ("Data Intelligence Lab@HKU")
- [HKUDS/LightRAG repo](https://github.com/HKUDS/LightRAG) - accessed 2026-08-26 (lab provenance)

## Confidence and gaps

- Retrieval-is-nothing: high confidence, verified in the source code itself. `MemoryStore`'s full method listing was read and contains no search function, `search.py` is a pure regex scan, and no FTS/BM25/embedding code appears anywhere in the memory path. This is stronger evidence than most dossiers in this folder carry, because the codebase is small enough to actually check.
- Scout finding "long-term memory in `<workspace>/memory/MEMORY.md`" and "Consolidation source history in memory/history.jsonl": confirmed verbatim in architecture.md's Memory and Sessions table.
- Scout attribution "HKU Data Science Lab": corrected. The org's self-description is "Data Intelligence Lab@HKU" (GitHub org API). "The LightRAG people" holds: LightRAG lives under the same org.
- Scout star count "~47,425": exact on the check date (47,425). Point-in-time, will drift.
- Repo age: created 2026-02-01, so every star and release happened in under seven months. Third-party posts claim it reimplements "over 90% of OpenClaw's core capabilities in just ~4,000 lines", but that is a blog's number, no primary source, and the current codebase is visibly larger. Not load-bearing here.
- Dream default cadence: `interval_h` default 2 with `enabled: True` is from the config schema source. The memory doc's example JSON shows the same value.
- `SOUL.md`/`USER.md` versus `MEMORY.md` prompt handling: context.py treats `AGENTS.md` and `USER.md` as skippable defaults (`_SKIPPABLE_DEFAULTS`) when they still match templates. The exact skip semantics were read from constants, not traced through every call path.
- Em-dashes inside verbatim quotes are rendered as "--" per this folder's typography, otherwise quotes are unaltered.
- The releases API lists 19 releases with the earliest at v0.1.3.post4 (2026-02-04). Whether earlier tags existed and were deleted is unknown, and PyPI history was not checked.

## Proposed page entries

CompareTable row (CompareTable.astro shape):

```
{
  tool: "nanobot",
  note: "HKUDS personal agent, 47k stars in seven months",
  where: "Plain Markdown workspace (MEMORY.md, USER.md, SOUL.md) plus append-only history.jsonl, git-versioned",
  retrieval: "None: MEMORY.md injected whole every turn, agent greps history on demand, no index or vectors",
  capture: "Automatic: consolidator summarizes turns, a Dream pass edits the files every 2h by default",
  reads: "System-prompt injection plus its own grep and file tools",
}
```

FieldVerdicts card (FieldVerdicts.astro shape, Personal-agent runtimes camp):

```
{
  tool: "nanobot",
  note: "47k stars, by the lab behind LightRAG",
  what: "HKUDS's ultra-lightweight self-hosted personal agent in readable Python. Durable memory is plain Markdown files a scheduled Dream pass edits surgically, over an append-only JSONL history, all git-versioned with rollback commands.",
  split: "The closest floor in the field: plain files, no vectors, no index, grep as the documented search. But nothing ranks. MEMORY.md rides whole in every prompt, so knowledge must stay prompt-sized and Dream decides what to forget. imprnt's BM25 exists so the vault never has to fit in context.",
  wins: "A self-hosted assistant on Telegram or a WebUI with cron, subagents, and memory that maintains itself, in a codebase small enough to read end to end.",
}
```
