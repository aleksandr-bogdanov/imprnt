# QwenPaw

**One-line:** Alibaba's open-source personal AI assistant (the April 2026 rebrand of CoPaw, under the AgentScope org), an always-on multi-channel agent runtime that ships its own 2B/4B/9B local models and whose durable memory layer is ReMe, a linked-Markdown knowledge base searched by BM25 with embeddings off by default.

**Status (checked 2026-08-26):** active, hyperactive cadence. The repo's `pushed_at` is 2026-08-26T15:46:46Z, the same day as this check, and the latest beta (v2.1.1-beta.3) landed the day before, 2026-08-25. Eight tagged releases in August 2026 alone. Source: https://api.github.com/repos/agentscope-ai/QwenPaw and https://github.com/agentscope-ai/QwenPaw/releases

**Latest release:** stable v2.1.0, Aug 13, 2026, plus beta v2.1.1-beta.3, Aug 25, 2026 | **Stars:** 34,502 (forks 3,037) | **License:** Apache-2.0 | **Hosting:** self-host (local machine or your own cloud), no hosted service found

> Note on release years: GitHub's releases UI shows "13 Aug 12:43" with no year. GitHub omits the year only for the current year, and the repo was created 2026-02-24, so every visible release resolves to 2026. A first fetch-model pass guessed 2024, which is the known relative-date artifact and is wrong.

## What it is

QwenPaw is a personal assistant runtime from Alibaba's AgentScope team. The repo description:

> "Your Personal AI Assistant; easy to install, deploy on your own machine or on the cloud; supports multiple chat apps with easily extensible capabilities."

- https://github.com/agentscope-ai/QwenPaw (accessed 2026-08-26)

The README tagline is "Works for you, grows with you." One deployment serves many chat apps at once:

> "DingTalk, Lark, WeChat, Discord, Telegram, iMessage, QQ - one instance, all channels."

It is an independent codebase built on AgentScope (releases pin AgentScope versions, e.g. beta.3 "bumped AgentScope to version 2.0.7"), part of the OpenClaw-wave pattern rather than a fork of it. Distinctive move: it ships its own trained local models so the assistant runs with no key at all:

> "QwenPaw-Flash models (2B / 4B / 9B) trained for agent tasks. Built-in QwenPaw Local runtime - no API key, no cloud dependency."

Cloud providers are also supported: "DashScope / Qwen, OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi, OpenRouter, and more." Installation is pip, Docker, a beta desktop app, or one-command installers. Security machinery (kernel-level sandboxing, Tool Guard, File Guard, Skill Scanner) is a first-class README section.

- https://raw.githubusercontent.com/agentscope-ai/QwenPaw/main/README.md (accessed 2026-08-26)

## Status, timeline, recency

- 2026 (Feb 24): repo created (`created_at: 2026-02-24T03:42:56Z`), initially as CoPaw. Source: https://api.github.com/repos/agentscope-ai/QwenPaw
- 2026 (Apr, around the 13th): CoPaw rebrands to QwenPaw with its v1.1.0 release, joining the Qwen open-source ecosystem. An AIbase article dated April 13, 2026 reports "the open-source desktop Agent tool CoPaw has officially released version 1.1.0 and announced a brand repositioning," a name change marking "official inclusion in the Qwen (Tongyi Qianwen) open-source ecosystem." Tongyi Lab's own X post: "Excited to see CoPaw officially rebrand to QwenPaw 🐾 We're proud to continue this open-source journey with all of you." Sources: https://news.aibase.com/news/27047 and https://x.com/Ali_TongyiLab/status/2043301256568205372
- 2026 (Aug 3-13): five v2.1.0 betas, then v2.1.0 stable on Aug 13. Source: https://github.com/agentscope-ai/QwenPaw/releases
- 2026 (Aug 20-25): v2.1.1-beta.1 through beta.3. Source: https://github.com/agentscope-ai/QwenPaw/releases
- 2026 (Aug 26): last push, same day as this check. Source: https://api.github.com/repos/agentscope-ai/QwenPaw

Recency verdict: hyperactive. Six months old, ~34.5k stars, releases roughly weekly, pushed the day of access. The star count is an order of magnitude below OpenClaw (~388k) and Hermes (~236k) but the corporate backing (Alibaba Tongyi Lab / AgentScope) makes dormancy unlikely.

## Where memory lives

The README states the memory model in one paragraph:

> "Three-layer memory - live working context, full verbatim history, and a self-evolving personal knowledge base powered by ReMe. Conversations and resources continuously become readable, editable, searchable, and linked Markdown memory."

- https://raw.githubusercontent.com/agentscope-ai/QwenPaw/main/README.md (accessed 2026-08-26)

The durable layer is ReMe, Alibaba's own memory kit (same GitHub org, ~3.4k stars, Apache-2.0), whose README calls it "A local-first, self-evolving personal knowledge base for AI agents" and states:

> "ReMe stores durable memory as ordinary Markdown with frontmatter and wikilinks."

The workspace is a directory of layered folders (`session/`, `mem_session/`, `resource/`, `daily/`, `digest/`, with rebuildable `metadata/`), defaulting to `.reme/` in the working directory. ReMe is deliberately multi-agent: "Agents such as QwenPaw, OpenClaw, Hermes, and Claude Code can share the same workspace to retrieve, maintain, and evolve knowledge, while users retain control of the durable files."

- https://raw.githubusercontent.com/agentscope-ai/ReMe/main/README.md (accessed 2026-08-26)

In Docker deployments, "Config, memory, and skills are stored in the qwenpaw-data volume," and the README's local pitch is "Deploy locally - data stays on your machine."

## Retrieval

This is the load-bearing finding. ReMe's search is lexical-first with embeddings as an explicit opt-in:

> "BM25, optional embeddings, and wikilink expansion retrieve relevant line-level passages and their relationships without loading the entire knowledge base into the agent context."

> "Search returns matching chunks with line ranges and bounded wikilink neighbors. Optional vector results are fused with BM25 through reciprocal rank fusion (RRF)."

> "Embeddings are disabled by default, so the default setup does not start an embedding model or require an embedding API key."

- https://raw.githubusercontent.com/agentscope-ai/ReMe/main/README.md (accessed 2026-08-26)

So the stock read path is BM25 plus deterministic wikilink expansion, no embedding model running. No default embedding model is named in the README's config examples (enabling one is a config edit). The drift direction is visible in QwenPaw's own release notes, though: v2.1.0 says "ReMe Light memory search can optionally rerank candidates through an OpenAI-compatible endpoint and falls back gracefully when reranking is unavailable" and "ReMe Light adds validated, hot-updatable embedding settings, Daily Paper and service-level schedules, per-Agent runtime status, manual reindex controls, and independent search and notification options." The optional model-on-the-read-path machinery is being actively built out.

- https://github.com/agentscope-ai/QwenPaw/releases/tag/v2.1.0 (accessed 2026-08-26)

The verbatim-history layer got its own search in v2.1.0 too: "History search returns paired requests and responses and understands date-based queries."

## Capture

Automatic and continuous, on the personal-agent-runtime pattern. The QwenPaw README's word is "continuously" (quote above), and ReMe's is:

> "ReMe progressively turns conversations and resources into daily notes and long-term knowledge, preserving sources while refining facts, preferences, procedures, and relationships over time."

Consolidation runs as a background job with the same "dream" vocabulary OpenClaw uses: an `auto_dream` capability runs via `dream_cron` or manually via `reme auto_dream`, and "By default, extracts up to five reusable units from changed files in the latest two-day window, then creates, corroborates, refines, or corrects digest nodes."

- https://raw.githubusercontent.com/agentscope-ai/ReMe/main/README.md and https://github.com/agentscope-ai/ReMe (accessed 2026-08-26)

The user-facing posture is that the files stay editable ("readable, editable, searchable" and "users retain control of the durable files"), so a human can curate after the fact. The default author is the machine.

## How the AI reads it

The assistant runtime is the reader. ReMe exposes search to agents via SKILL.md plus CLI, HTTP, MCP, and an embedded Python API, and returns "matching chunks with line ranges and bounded wikilink neighbors" rather than whole files, so the agent pulls passages plus their linked context on demand. QwenPaw embeds this as its knowledge-base layer (the release notes' "ReMe Light"), alongside always-live working context and searchable verbatim history. v2.1.0 also added "Snapshot and restore conversations, memory, and selected workspace files without changing project Git history."

- https://raw.githubusercontent.com/agentscope-ai/ReMe/main/README.md and https://github.com/agentscope-ai/QwenPaw/releases/tag/v2.1.0 (accessed 2026-08-26)

## Pricing and license

Apache-2.0 on both QwenPaw and ReMe (GitHub license fields, accessed 2026-08-26). No hosted tier or pricing page was found: the model is self-host, bring your own API key for cloud providers, or run the free QwenPaw-Flash local models with "no API key, no cloud dependency." Costs are your hardware or your token bill.

## Benchmarks

None found. The QwenPaw README carries no benchmark numbers or quantified performance claims (checked 2026-08-26). ReMe has an associated research lineage ("Remember Me, Refine Me," arXiv:2512.10696, a procedural-memory framework from Tongyi Lab and Shanghai Jiao Tong researchers), but no memory-benchmark table is published in either README.

## vs imprnt

The closest any camp member comes to imprnt's floor, and by some distance. The durable store is ordinary Markdown with frontmatter and wikilinks that the user can open and edit, the default ranker is BM25, embeddings are off by default and cost no API key, and link traversal at search time is bounded and deterministic. An Alibaba lab independently landed on lexical-first search over linked plain files as the default for personal agent memory. That is direct convergence on imprnt's read-path thesis.

Where they still differ:

- Capture: QwenPaw/ReMe is continuous and agent-authored - conversations digest into daily notes and digest nodes on a dream cron, five units per two-day window. imprnt's capture is conscious and on demand ("harvest this"), with a human deciding what deserves to be knowledge. The runtime optimizes for zero-effort memory, imprnt for a curated vault.
- The store's author: ReMe's layers (`session/`, `daily/`, `digest/`) are machine-derived views of conversation exhaust that a model "creates, corroborates, refines, or corrects." imprnt notes are the knowledge itself, written once at ingest under a typed contract. ReMe has no typed entity schema, no people/orgs/holdings, no alias-based MERGE resolution, no filing decision.
- The escape hatch points the other way: ReMe's optional path adds embeddings, RRF fusion, and an OpenAI-compatible reranker, and QwenPaw's releases are actively building that out (hot-updatable embedding settings, reindex controls). imprnt's position is that the model never enters the ranking loop, ever, so the read path cannot drift.
- Scope: memory is one subsystem of an always-on assistant runtime (channels, sandbox, skills, scheduled tasks, an "OS Shell," video generation). imprnt is the vault, full stop, with the agent you already run as the interface. Delete QwenPaw and the Markdown survives, but the digest cron, the search service, and the assistant behavior go with it.
- Wikilinks do different work: ReMe's links are a retrieval-expansion mechanism (pull bounded neighbors into results). imprnt's links are the knowledge graph itself - typed ownership and participation edges (`owner:`, `participants:`) between entity notes, checked for orphans by `imprnt check`.

## When it wins over imprnt

- You want one always-on assistant reachable from DingTalk, WeChat, QQ, Lark, Telegram, Discord, and iMessage. imprnt has no channel surface at all, and QwenPaw's Chinese-app coverage is unmatched in the field.
- You want zero API spend: its own 2B/4B/9B agent-trained models run the whole assistant locally with no key. imprnt assumes a frontier agent you already pay for.
- You want memory that costs zero effort, with conversations continuously distilled into notes by a background process while you keep the right to edit the files.
- You want one shared memory workspace that several different agents (QwenPaw, Claude Code, others) read and maintain together. imprnt is agent-swappable but single-vault, human-curated.
- You want the surrounding runtime: sandboxed tool execution, skills, scheduled tasks, file workspace, multi-channel presence, backed by an Alibaba lab shipping weekly.

## Sources

- [QwenPaw GitHub repository](https://github.com/agentscope-ai/QwenPaw) - accessed 2026-08-26
- [QwenPaw repo metadata (GitHub API)](https://api.github.com/repos/agentscope-ai/QwenPaw) - accessed 2026-08-26
- [QwenPaw README (raw, main branch)](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/main/README.md) - accessed 2026-08-26
- [QwenPaw releases page](https://github.com/agentscope-ai/QwenPaw/releases) - accessed 2026-08-26
- [QwenPaw v2.1.0 release tag](https://github.com/agentscope-ai/QwenPaw/releases/tag/v2.1.0) - accessed 2026-08-26
- [ReMe GitHub repository](https://github.com/agentscope-ai/ReMe) - accessed 2026-08-26
- [ReMe README (raw, main branch)](https://raw.githubusercontent.com/agentscope-ai/ReMe/main/README.md) - accessed 2026-08-26
- [Tongyi Lab rebrand announcement on X](https://x.com/Ali_TongyiLab/status/2043301256568205372) - surfaced via search 2026-08-26, post itself paywalled to fetch
- [AIbase: CoPaw officially renamed QwenPaw (Apr 13, 2026)](https://news.aibase.com/news/27047) - accessed 2026-08-26
- [Remember Me, Refine Me (arXiv:2512.10696)](https://arxiv.org/abs/2512.10696) - surfaced via search 2026-08-26, not independently read

## Confidence and gaps

- Release years (v2.1.0 Aug 13, v2.1.1-beta.3 Aug 25): high confidence but inferred. GitHub shows "13 Aug 12:43" with no year, GitHub omits only the current year, and the repo was created 2026-02-24, so 2026 is the only consistent reading. One fetch-model pass guessed 2024, the known relative-date artifact.
- Rebrand date: the AIbase article is dated April 13, 2026 and ties the rename to v1.1.0. The Tongyi Lab X post confirms the rebrand happened but its own date was unverifiable (the fetch returned HTTP 402), so "April 2026" rests on AIbase plus the search-result snippet of the post. Medium-high confidence.
- "ReMe Light" is named only in QwenPaw's release notes. That it is the embedded variant of the ReMe kit inside QwenPaw is an inference from naming and behavior (memory search, embedding settings, reindex), consistent but not stated verbatim anywhere fetched.
- Default embedding model when embeddings are enabled: none named in the ReMe README or visible config examples. Unknown, recorded as a gap rather than guessed.
- ReMe workspace path inside a QwenPaw install: ReMe's own default is `.reme/` in the working directory and Docker stores memory in the `qwenpaw-data` volume, but the exact on-disk path a non-Docker QwenPaw install uses was not verified.
- Star counts (34,502 QwenPaw, ~3.4k ReMe): the QwenPaw figure is from the GitHub API and exact as of the check. The ReMe figure is the repo page's rounded display, single read.
- The arXiv paper (2512.10696) and its ACL 2026 acceptance were surfaced by search summaries, not read directly. It describes procedural memory for agent evolution and its exact relationship to the shipped ReMe kit is unverified. Nothing in this dossier depends on it.
- The dream-cron digest details ("five reusable units," "two-day window") came from the ReMe repo page via a fetch-model summary quoting docs text. Direction and vocabulary are solid, the exact defaults are single-sourced.

## Proposed page entries

CompareTable.astro row (Personal-agent runtimes group, after OpenClaw):

```js
{
  tool: "QwenPaw",
  note: "Alibaba's personal agent, CoPaw rebranded Apr 2026",
  where: "Agent-written Markdown with frontmatter and wikilinks (ReMe workspace) plus verbatim session history",
  retrieval: "BM25 plus bounded wikilink expansion by default, embeddings off by default, optional RRF fusion and rerank",
  capture: "Automatic: conversations continuously digested, dream-cron consolidation",
  reads: "Assistant runtime via ReMe search (CLI/MCP/HTTP), chunks with line ranges plus linked neighbors",
},
```

FieldVerdicts.astro card (camp "Personal-agent runtimes"):

```js
{
  tool: "QwenPaw",
  note: "Alibaba-backed, ex-CoPaw, ~34.5k stars",
  what: "Alibaba's AgentScope personal assistant: seven chat channels from one instance, its own 2B/4B/9B local models needing no API key, and a durable memory layer (ReMe) of user-editable Markdown with frontmatter and wikilinks, searched by BM25 with embeddings off by default.",
  split: "The closest any runtime comes to imprnt's floor: linked plain files, lexical-first search, no embedding key needed. The memory is still agent-authored, continuously digested by a dream cron with no typed entity contract, and the opt-in path to embeddings and a reranker is one config away and growing release by release.",
  wins: "An always-on assistant on DingTalk, WeChat, or Telegram that runs fully local with zero API spend and maintains its own memory at zero effort.",
},
```
