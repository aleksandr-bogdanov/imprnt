# CowAgent

**One-line:** The renamed chatgpt-on-wechat, one of China's earliest and biggest ChatGPT bot projects (repo dates to August 2022), rebuilt in February 2026 into a "super AI assistant" agent harness whose memory is agent-written Markdown under `~/cow`, indexed into a SQLite hybrid store that weights API embeddings 0.7 over FTS5 BM25's 0.3, and distilled nightly by an LLM "Deep Dream" pass.

**Status (checked 2026-08-26):** active, hyperactive cadence. Last push 2026-08-26 (the day of this check, per the GitHub API `pushed_at: 2026-08-26T09:10:15Z`), latest release 2.1.7 published Aug 21, 2026, with roughly weekly-to-biweekly releases since the 2.0 pivot. The repo description reads: "Open-source super AI assistant & Agent Harness. Plans tasks, runs tools and skills, self-evolves with memory and knowledge. Multi-model, multi-channel. Lightweight, extensible, one-line install. (formerly chatgpt-on-wechat)". Source: https://api.github.com/repos/zhayujie/CowAgent

**Latest release:** 2.1.7, Aug 21, 2026 | **Stars:** 46,692 | **License:** MIT | **Hosting:** self-host (one-line installer, Docker), with LinkAI as the maintainer-affiliated managed-hosting platform

## What it is

A personal-agent runtime in the OpenClaw shape, built in China and years older than the 2026 wave. The README self-describes:

> "CowAgent is an open-source super AI assistant that proactively plans tasks, controls your computer and external services, creates and runs Skills, builds a personal knowledge base and long-term memory, and grows alongside you through self-evolution - a reference implementation of Agent Harness engineering."

> "CowAgent is a complete **Agent Harness**: messages flow in through **Channels**; the **Agent Core** plans and reasons over memory, knowledge, and the available tools and skills; **Models** generate the response, which is sent back through the originating channel."

- https://raw.githubusercontent.com/zhayujie/CowAgent/master/README.md (accessed 2026-08-26)

The rename is explicit at the foot of the README: "This project was previously named `chatgpt-on-wechat` and is now officially **CowAgent**. The old GitHub URL redirects automatically." The channel set is China-first: the README's channel table lists Web Console (the default), Telegram, Slack, Discord, WeChat, Feishu / Lark, DingTalk, WeCom Bot, QQ, WeCom App, WeChat Customer Service, and WeChat Official Account. No WhatsApp, no iMessage, no Signal - the Western-messenger set that OpenClaw leads with is absent, and the WeChat family that OpenClaw lacks is covered four ways. Built-in tools per the README: "file I/O (`read` / `write` / `edit` / `ls`), terminal (`bash`), file sending (`send`), memory retrieval (`memory`), environment variables (`env_config`), web fetching (`web_fetch`), scheduling (`scheduler`), web search (`web_search`), vision (`vision`), and browser automation (`browser`)", plus native MCP and a Skill Hub (skills.cowagent.ai).

## Status, timeline, recency

- 2022 (Aug 7): repo created, per the GitHub API `created_at: 2022-08-07T08:33:41Z`. Source: https://api.github.com/repos/zhayujie/CowAgent
- 2023 (Feb 11): release 1.0.0, titled "Stable version" - the chatgpt-on-wechat chatbot era. 81 releases exist in total. Source: https://github.com/zhayujie/CowAgent/releases
- 2026 (Feb 3): release 2.0.0, titled "CowAgent 2.0", the pivot. The (Chinese) notes announce a "全面升级" from chatbot to "超级Agent助理" (super agent assistant): complex task planning, long-term memory persisted "至本地文件和数据库中" (to local files and a database) with "关键词及向量检索" (keyword and vector retrieval), 10+ built-in tools, and a Skills engine. Notably the 2.0.0 notes still link docs at `github.com/zhayujie/chatgpt-on-wechat`, so the brand renamed at 2.0 while the repo URL moved later. Source: https://github.com/zhayujie/CowAgent/releases/tag/2.0.0
- 2026 (Jun 1): 2.1.0 adds internationalization and the Western channels (Telegram, Discord, Slack). Source: https://github.com/zhayujie/CowAgent/releases/tag/2.1.0
- 2026 (Jun 9): 2.1.1 ships "Self-Evolution", described in release summaries as "automatic review after idle" to improve through collaboration. Source: https://github.com/zhayujie/CowAgent/releases
- 2026 (Jul 8): 2.1.3 launches the Desktop client (macOS/Windows) and knowledge-base document import. Source: https://github.com/zhayujie/CowAgent/releases
- 2026 (Aug 12): 2.1.6 ships the pluggable vector backend. Verbatim from the release notes: "**Pluggable vector backend**: memory's vector storage and retrieval sit behind a single interface, with SQLite as the default, making it easy to plug in an external vector store later." Source: https://github.com/zhayujie/CowAgent/releases/tag/2.1.6
- 2026 (Aug 21): 2.1.7, the latest release (`published_at: 2026-08-21T02:39:37Z`): multiple workspaces with per-session isolation, permission modes (read-only, workspace-write, full-access), desktop voice input. Source: https://api.github.com/repos/zhayujie/CowAgent/releases

Recency verdict: very active. A release five days before this check, a push on the day of it, and 10,328 forks. The 46.7k stars accumulated over four years under the old name, so raw star count overstates the agent product's own traction relative to OpenClaw (~388k in under a year) and Hermes (~236k in six months).

## Where memory lives (storage and architecture)

Plain Markdown under the agent workspace, default `~/cow` (config key `agent_workspace`). The memory docs (docs.cowagent.ai/memory/index, accessed 2026-08-26) describe a three-tier architecture, and the README compresses it to one line: "conversation context (short-term) → daily memory (mid-term) → MEMORY.md (long-term)". Per the docs:

- Core memory: `~/cow/MEMORY.md`, holding "long-term user preferences, important decisions, key facts, and other information that doesn't fade over time".
- Daily memory: `~/cow/memory/`, files "named by date (e.g., `2026-03-08.md`)" holding "daily conversation summaries and key events".
- Dream diary: `~/cow/memory/dreams/YYYY-MM-DD.md`, holding "discoveries, deduplication operations, and new insights from each consolidation".

Beside the time-ordered memory sits a knowledge base under `~/cow/knowledge/`: "Auto-curates structured knowledge into a Markdown wiki, builds an evolving knowledge graph with visual browsing" (README). The knowledge docs list `knowledge/index.md` as the entry point, `knowledge/log.md` as a change log, and `concepts/`, `entities/`, `sources/` directories, with "The directory structure is flexible - the Agent automatically creates appropriate category directories based on actual content" (docs.cowagent.ai/knowledge/index, accessed 2026-08-26).

The derived index is a SQLite database at `~/cow/memory/long-term/index.db` (source code: `common/state_dir.py`, `memory_index_db()`, which also documents that the same database holds the sessions and runs tables). Embeddings live in a `chunks.embedding` column inside that database (`agent/memory/vector_backend.py`, class `SQLiteVectorBackend`), behind the pluggable `VectorBackend` interface added in 2.1.6. Uninstall verdict: the Markdown (MEMORY.md, dailies, dreams, the knowledge wiki) survives as ordinary files you can open anywhere. The SQLite index is derived state, and the repo carries rebuild paths (`agent/memory/embedding/rebuild.py`, `agent/memory/rebuild_index.py`), so the index is disposable by design.

- https://raw.githubusercontent.com/zhayujie/CowAgent/master/common/state_dir.py (accessed 2026-08-26)
- https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/vector_backend.py (accessed 2026-08-26)

## Retrieval

Hybrid, vector-dominant by default, with a verified keyword-only fallback. The memory docs describe two modes: "Keyword retrieval - FTS5 full-text index matching with BM25 ranking" and "Vector retrieval - Embedding-based semantic similarity search", fused at "default: 0.7 vector weight + 0.3 keyword weight". The code confirms the weights: `agent/memory/config.py` sets `vector_weight: float = 0.7` and `keyword_weight: float = 0.3`, with `embedding_provider: str = "openai"` and `embedding_model: str = "text-embedding-3-small"` (dim 1536) as defaults.

The embedding side is an API call, not local. `agent/memory/embedding/factory.py` documents the resolution order verbatim: "A. Default (no `embedding_provider` in config.json): Auto-init OpenAI -> LinkAI fallback. B. Explicit (`embedding_provider` is set): Initialize the requested vendor". Both auto-init paths use `text-embedding-3-small`, OpenAI's via api.openai.com and LinkAI's via api.link-ai.tech (LinkAI is the maintainer's commercial platform). With no key at all, the factory returns "None for keyword-only mode", and its docstring notes the whole point of centralizing this is that every caller "selects the same provider instead of silently degrading to keyword-only search". So a keyless install runs on FTS5 BM25 alone - the fallback OpenClaw's docs leave unstated is explicit in CowAgent's code.

The agent-facing tools are `memory_search` (semantic search) and `memory_get` (direct read), per the knowledge docs and the repo paths `agent/tools/memory/memory_search.py` and `memory_get.py`. The knowledge base adds "Index lookup: Quickly locate relevant pages via `knowledge/index.md`". The LLM is in the read loop throughout: it decides when to call the tools and reads what comes back.

- https://docs.cowagent.ai/memory/index (accessed 2026-08-26)
- https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/embedding/factory.py (accessed 2026-08-26)
- https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/config.py (accessed 2026-08-26)

## Capture

Agent-authored end to end, with a nightly consolidation pass. The README: "A nightly **Deep Dream** pass distills scattered memories into refined long-term entries and a narrative journal." The Deep Dream docs (docs.cowagent.ai/memory/deep-dream, accessed 2026-08-26) put numbers and paths on it: "Automatically triggered at 23:55", it performs "LLM distillation - Deduplicate, merge, prune, extract new information", writes daily summaries to `memory/YYYY-MM-DD.md`, "Overwrites `MEMORY.md` after distillation", and saves dream diaries to `memory/dreams/`. Additional triggers: context trimming (trimmed content is summarized when turn or token limits are exceeded) and API overflow (emergency save of the current conversation summary). Manual trigger: `/memory dream [N]`. Disable via `deep_dream_enabled: false` in config.json, which stops the nightly run while keeping the manual command.

The knowledge base captures the same way: "The Agent automatically curates valuable information from conversations, maintains cross-references and indexes" (README). Self-Evolution (since 2.1.1) extends it further: it "reviews conversations automatically to improve skills, follow up on unfinished tasks, and consolidate memory and knowledge" (README feature table). Nothing in the documented flow asks the human to file, approve, or phrase a note.

## How the AI reads it

The assistant is the reader, as with OpenClaw. CowAgent runs as a local harness process (Web console on 127.0.0.1 by default since 2.0.9, or the Desktop client) bridging chat channels. Short-term context rides in the conversation window (`agent_max_context_tokens` default 50000, `agent_max_context_turns` default 20 per the memory docs), and the agent calls `memory_search` / `memory_get` for older material. The docs describe MEMORY.md's role as "maintain long-term knowledge" via agent read/write operations. Whether MEMORY.md is injected whole at session start, OpenClaw-style, is not stated in the pages fetched (see gaps). Humans reach the memory through the Web console's Memory and Knowledge pages (with a knowledge-graph view) or by opening the Markdown directly.

- https://docs.cowagent.ai/memory/index (accessed 2026-08-26)

## Pricing and license

Free and open source, MIT. The README's disclaimer: "This project is licensed under the [MIT License](/LICENSE) and is intended for technical research and learning. You are responsible for complying with applicable laws and regulations in your jurisdiction; the maintainers assume no liability for any consequences arising from use of this project." No paid tier in the repo. The commercial arm is LinkAI, "an all-in-one AI Agent platform for enterprises and developers, offering managed hosting and enterprise-grade support for CowAgent" (README), which is also the fallback embedding provider baked into the factory code. Real costs on a default install: model API usage plus OpenAI (or LinkAI) embedding calls for memory indexing. A keyless or keyword-only setup avoids the embedding spend.

## Benchmarks

None found. No LoCoMo, LongMemEval, or any memory benchmark surfaced in the repo, README, release notes, or docs as of 2026-08-26. Like OpenClaw, its public numbers are adoption numbers.

## vs imprnt

The sharpest fact first: CowAgent's knowledge base is a close structural mirror of imprnt's vault. A Markdown wiki with an `index.md` entry point, a `log.md` change log, and `entities/` alongside topical directories - three of imprnt's own control-file names and its entity axis, independently arrived at (or convergently borrowed) by a Chinese agent harness. The difference is who runs it: in CowAgent the agent "automatically curates" the wiki and its cross-references, in imprnt the human triggers every ingest and a deterministic `check` enforces the invariants.

- Files: real convergence. Memory and knowledge are plain Markdown in `~/cow`, the SQLite index is derived and rebuildable, and the files outlive the tool. Same floor as imprnt, OpenClaw, and Letta's pivot destination.
- Retrieval: the fork. imprnt is BM25 + grep, pure local arithmetic, no embeddings, no model ranking. CowAgent has BM25 in the building (the FTS5 keyword leg) but weights it at 0.3 under a 0.7 vector leg whose embeddings go through OpenAI's API by default, with the maintainer's own LinkAI platform as the silent fallback. Local embedding is a config choice. Keyword-only is the degraded mode, not the design.
- Capture: opposite bets. imprnt is conscious and on demand. CowAgent's dailies accumulate automatically, and every night at 23:55 an LLM pass rewrites the long-term store: "Overwrites `MEMORY.md` after distillation." imprnt's contract says a contradiction stamps the stale line and is "Marked, never silently overwritten." CowAgent's core memory file is, by design, silently rewritten by a model every day, with the dream diary as the audit trail.
- Structure: CowAgent's entity pages are free-form directories the agent invents ("The directory structure is flexible"). imprnt's are a typed contract (type/kind/tags/summary, aliases, wikilinks) with merge-on-hit entity resolution and a `check` that fails on drift.
- Scope: CowAgent is an assistant that acts - bash, browser, scheduler, vision, MCP, skills, twelve channels. imprnt is only a vault. The comparison is one subsystem of theirs against the whole of imprnt, the same asymmetry as OpenClaw.
- Camp placement: Personal-agent runtime, OpenClaw-flavored. Its hybrid vector-plus-keyword SQLite index and ambient agent-authored capture put it next to OpenClaw, against Hermes's lexical-only FTS5 bet. It is close to an OpenClaw for the WeChat/Feishu/DingTalk world, four years of history behind it.

## When it wins over imprnt

- Your messaging life runs on Chinese platforms. WeChat (four integration flavors), Feishu, DingTalk, WeCom, and QQ are channels imprnt will never have and OpenClaw mostly lacks.
- You want an assistant that acts (terminal, browser, scheduler, skills, MCP) and remembers as a side effect, with zero curation effort.
- You want semantic recall over what the agent saw, phrased any way, out of the box - accepting the API embedding dependency that buys it.
- You want a Web console and desktop app with visual memory and knowledge-graph browsing, rather than a CLI and a folder.
- You want nightly consolidation that dedupes and prunes memory on its own. imprnt's `check` deliberately never mutates a note.

## Sources

- [CowAgent GitHub repository](https://github.com/zhayujie/CowAgent) - accessed 2026-08-26
- [CowAgent repo metadata (GitHub API)](https://api.github.com/repos/zhayujie/CowAgent) - accessed 2026-08-26
- [CowAgent README (raw, master)](https://raw.githubusercontent.com/zhayujie/CowAgent/master/README.md) - accessed 2026-08-26
- [CowAgent releases](https://github.com/zhayujie/CowAgent/releases) - accessed 2026-08-26
- [Release 2.0.0 "CowAgent 2.0" (Feb 3 2026)](https://github.com/zhayujie/CowAgent/releases/tag/2.0.0) - accessed 2026-08-26
- [Release 2.1.6 (pluggable vector backend, Aug 12 2026)](https://github.com/zhayujie/CowAgent/releases/tag/2.1.6) - accessed 2026-08-26
- [Long-term memory docs](https://docs.cowagent.ai/memory/index) - accessed 2026-08-26
- [Deep Dream docs](https://docs.cowagent.ai/memory/deep-dream) - accessed 2026-08-26
- [Knowledge base docs](https://docs.cowagent.ai/knowledge/index) - accessed 2026-08-26
- [Embedding factory source](https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/embedding/factory.py) - accessed 2026-08-26
- [Memory config source](https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/config.py) - accessed 2026-08-26
- [Vector backend source](https://raw.githubusercontent.com/zhayujie/CowAgent/master/agent/memory/vector_backend.py) - accessed 2026-08-26
- [State dir source (paths)](https://raw.githubusercontent.com/zhayujie/CowAgent/master/common/state_dir.py) - accessed 2026-08-26

## Confidence and gaps

- The retrieval and storage claims are code-verified (factory, config, vector backend, state_dir fetched raw from master), which is stronger evidence than the docs summaries. Highest confidence in this file.
- Docs quotes (memory, deep-dream, knowledge pages) came through the fetch summarizer marking them as verbatim. Paths and numbers cross-check against the code, so confidence is high, but the exact English phrasing of docs lines was not eyeballed on the rendered page. The docs also carry Japanese and Chinese variants; the English page is the one quoted.
- The exact date of the repo URL rename (chatgpt-on-wechat -> CowAgent) is unpinned. The 2.0.0 release (Feb 3, 2026) uses the CowAgent brand while still linking `zhayujie/chatgpt-on-wechat` docs paths, so the URL moved somewhere between Feb and Aug 2026. No primary announcement post was found.
- Star provenance: the 46,692 stars span the 2022 chatbot era and the 2026 agent era on one redirected repo. How many are post-pivot is unknowable from the API.
- Whether MEMORY.md is injected whole at session start is not stated in the fetched docs. The three-tier description implies core memory is in-context, but no verbatim injection claim is in hand.
- Release summaries for 2.1.1 through 2.1.5 came from a summarized fetch of the releases page, not per-tag reads. Tag dates for 2.0.x and the latest three are API-verified.
- The 2.0.0 pivot quotes are Chinese, translated inline here by this dossier's author. The translation is faithful but is a translation.
- WeChat personal-account integrations historically carry account-ban risk under Tencent's ToS. Not investigated here, flagged as a known-unknown for anyone weighing the WeChat channels.

## Proposed page entries

CompareTable row (insert after the OpenClaw row):

```js
{
  tool: "CowAgent",
  note: "formerly chatgpt-on-wechat, China-first agent harness",
  where: "Plain Markdown workspace (~/cow) plus a derived SQLite index",
  retrieval: "Hybrid: 0.7 vector plus 0.3 FTS5 BM25, OpenAI embeddings by default, keyword-only without a key",
  capture: "Agent-written dailies plus a nightly Deep Dream pass that rewrites MEMORY.md",
  reads: "Local harness agent over 12 channels, memory_search / memory_get tools",
},
```

FieldVerdicts card (camp "Personal-agent runtimes", after OpenClaw):

```js
{
  tool: "CowAgent",
  note: "46.7k stars, four years old, agent since Feb 2026",
  what: "The renamed chatgpt-on-wechat: a China-first agent harness (WeChat, Feishu, DingTalk, QQ, plus Telegram, Slack, Discord) whose memory is agent-written Markdown in ~/cow, indexed into SQLite hybrid search and distilled nightly by an LLM Deep Dream pass.",
  split:
    "Its knowledge base mirrors imprnt's vault shape - a Markdown wiki with index.md, log.md, and entity pages - but the agent curates it, a nightly model pass overwrites MEMORY.md, and default recall weights API embeddings 0.7 over BM25's 0.3. imprnt keeps capture human-triggered, contradictions marked instead of rewritten, and the ranker pure arithmetic.",
  wins: "An assistant on WeChat, Feishu, or DingTalk that acts (terminal, browser, scheduler, skills) and remembers on its own, with a visual memory console.",
},
```
