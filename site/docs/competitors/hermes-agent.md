# Hermes Agent (Nous Research)

**One-line:** An open-source, self-hosted personal AI agent by Nous Research with a "built-in learning loop": agent-curated memory in two capped Markdown files, FTS5 full-text search over its own SQLite session history, agent-authored skills, and a messaging gateway spanning 20+ chat platforms.

**Status (checked 2026-08-26):** active, and among the fastest-moving projects in the field. The repo's `pushed_at` is 2026-08-26 (the check date itself), the latest release is Aug 19, 2026, and the release notes for a single one-day window (v0.20.4 to v0.20.5) report "~746 commits across ~1,250 files (+111,500 / -20,701) -- ~323 merged PRs". Source: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19

**Latest release:** v0.20.5 (tag v2026.8.19), "Release Date: August 19, 2026", published 2026-08-21 | **Stars:** 236,848 | **Forks:** 47,889 | **License:** MIT | **Language:** Python | **Hosting:** self-hosted, free (optional Nous Portal subscription for model access)

> Star count, forks, license, and dates are from the GitHub API (`stargazers_count: 236848`, `forks_count: 47889`, `license.spdx_id: MIT`, `created_at: 2025-07-22`, `pushed_at: 2026-08-26`), accessed 2026-08-26. The count is real API data, and it puts Hermes above every tool in this folder, ECC included.

## What it is

The README opens:

> "The self-improving AI agent built by Nous Research. It's the only agent with a built-in learning loop -- it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions. Run it on a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle."

- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md (accessed 2026-08-26)

The GitHub description is "The agent that grows with you" (GitHub API, accessed 2026-08-26). It is a personal agent product, the same shape as OpenClaw, and it explicitly courts OpenClaw's users with automated migration (see Capture below). Memory is one feature of the agent, alongside a terminal UI, a messaging gateway, cron automation, MCP, subagents, and voice mode. It is model-agnostic: "Use any model you want -- Nous Portal, OpenRouter, OpenAI, your own endpoint, and many others" (README, accessed 2026-08-26).

The feature table's memory row, in full:

> "A closed learning loop: Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. Skills self-improve during use. FTS5 session search with LLM summarization for cross-session recall. Honcho dialectic user modeling. Compatible with the agentskills.io open standard."

- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md (accessed 2026-08-26)

## Status, timeline, recency

- 2025 (Jul 22): GitHub repository created (`created_at: 2025-07-22T22:22:28Z`, GitHub API, accessed 2026-08-26). Development predates the public launch by months.
- 2026 (Feb 25, claimed): public launch announcement. Only third-party coverage attests this date (see Confidence and gaps). No primary Nous Research source for it was found.
- 2026 (Mar 12): first release on GitHub, "Hermes Agent v0.2.0 (2026.3.12)", published 2026-03-12. Weekly cadence follows: v0.3.0 Mar 17, v0.4.0 Mar 24, v0.5.0 Mar 28, v0.6.0 Mar 30. Source: https://api.github.com/repos/NousResearch/hermes-agent/releases (accessed 2026-08-26)
- 2026 (Aug 19/21): latest release, "Hermes Agent v0.20.5 (v2026.8.19)", release date stated as August 19, 2026, published to GitHub 2026-08-21. 29 releases total between March and August 2026. Source: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19 (accessed 2026-08-26)

Recency verdict: hyperactive. 236.8k stars in roughly six months of public life, a release cadence measured in days, and a last push on the check date. Open issues stand at 36,183 (GitHub API), which is what a project at this scale and velocity looks like, and the release notes promise "Full curated release notes for this window will ship with v0.21.0". Not dormant by any measure.

## Where memory lives

Durable curated memory is two capped Markdown files. From the memory docs:

> "MEMORY.md | Agent's personal notes -- environment facts, conventions, things learned | 2,200 chars (~800 tokens)"

> "USER.md | User profile -- your preferences, communication style, expectations | 1,375 chars (~500 tokens)"

> "Both are stored in `~/.hermes/memories/` and are injected into the system prompt as a frozen snapshot at session start."

- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory (accessed 2026-08-26)

That is 3,575 characters of durable declarative memory total, about 1,300 tokens. The cap is hard, and the design refuses silent loss:

> "Memory does not auto-compact: when a write would exceed the limit, the `memory` tool returns an error instead of silently dropping entries."

Session history is a database, and it is the larger store: "All CLI and messaging sessions are stored in SQLite (`~/.hermes/state.db`) with FTS5 full-text search" (memory docs, accessed 2026-08-26).

Skills are the third store, procedural memory as files: "All skills live in `~/.hermes/skills/`" with project-local variants in `<project-root>/.hermes/skills/` or `<project-root>/.agents/skills/`. Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills (accessed 2026-08-26)

Everything is local. From the FAQ: "Your conversations, memory, and skills are stored locally in `~/.hermes/`" and "Hermes Agent does not collect telemetry, usage data, or analytics." Source: https://hermes-agent.nousresearch.com/docs/reference/faq (accessed 2026-08-26)

## Retrieval

Lexical full-text search, no vector store in the read path. Past sessions are searched with the `session_search` tool over SQLite FTS5, and the memory docs are specific about what comes back:

> "Search queries return actual messages from the DB -- no LLM summarization, no truncation"

- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory (accessed 2026-08-26)

The README's phrasing is "FTS5 session search with LLM summarization for cross-session recall" (accessed 2026-08-26). The two statements read as tension but compose: the tool returns raw messages, and the LLM layer summarizes across sessions on top of raw returns. The corpus being searched is the raw conversation transcript, not curated notes. The two curated files are never searched at all: they ride into every session's system prompt whole, as "a frozen snapshot at session start."

No explicit "no embeddings" statement was found in the README, memory docs, or FAQ. The absence of vectors is inferred from the architecture (FTS5 named as the search mechanism, nothing vector-shaped documented anywhere), not quoted (see Confidence and gaps).

There is also an inspectable memory timeline: "`hermes journey` (aliases: `hermes learning`, `hermes memory-graph`)" opens the learning timeline, and "`hermes journey edit <node>` | Open the node's content (a skill's `SKILL.md` or the memory chunk) in `$EDITOR`" makes every memory chunk and skill human-editable. Source: memory docs, accessed 2026-08-26.

## Capture

Agent-authored by design, on all three stores.

Declarative memory: "The agent manages its own memory via the `memory` tool -- it can add, replace, or remove entries." The human gate exists but ships open: "`write_approval: false` (default) | Write freely -- the gate is off" versus "`write_approval: true` | Require approval before anything is saved." The README adds the trigger mechanism: the agent "nudges itself to persist knowledge" ("Agent-curated memory with periodic nudges"). Sources: memory docs + README, accessed 2026-08-26.

Skills: "The agent can create, update, and delete its own skills via the `skill_manage` tool. This is the agent's procedural memory." Creation triggers are experience-shaped: "When it worked out a multi-step workflow worth repeating" or "When it hit errors or dead ends and found the working path." A write-approval gate can stage skill writes for review: "every `skill_manage` write (create / edit / patch / delete / write_file / remove_file) is staged instead of committed." Skills follow "a progressive disclosure pattern to minimize token usage and are compatible with the agentskills.io open standard," and a community Skills Hub aggregates registries (official optional skills, skills.sh, well-known endpoints, GitHub repos) with "security scanning" on install. Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills (accessed 2026-08-26)

Session history: captured automatically, every message, into `state.db`.

Migration is a capture path too. From the README's "Migrating from OpenClaw" section: "If you're coming from OpenClaw, Hermes can automatically import your settings, memories, skills, and API keys." The wizard "automatically detects `~/.openclaw` and offers to migrate," and `hermes claw migrate` supports `--dry-run`, `--preset user-data` ("Migrate without secrets"), and `--overwrite`. Imported items include "Memories -- MEMORY.md and USER.md entries" and "Skills -- user-created skills -> `~/.hermes/skills/openclaw-imports/`". Source: README, accessed 2026-08-26.

## How the AI reads it

The two files are compiled into the system prompt at session start (the "frozen snapshot"). Session history is pulled on demand via the `session_search` tool. Skills load by progressive disclosure. Optionally, "Honcho dialectic user modeling" (an external memory provider, linked to github.com/plastic-labs/honcho in the README) deepens the user model. The agent itself is reachable from a terminal TUI or the messaging gateway: "Telegram, Discord, Slack, WhatsApp, Signal, and CLI -- all from a single gateway process" (README), with the messaging docs listing the full set: "Chat with Hermes from Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, ntfy, or your browser." That is 21 named channels. Source: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ (accessed 2026-08-26)

Execution spans "Seven terminal backends -- local, Docker, SSH, Singularity, Modal, Daytona, and Vercel Sandbox," where "Daytona and Modal offer serverless persistence -- your agent's environment hibernates when idle and wakes on demand." Cron is built in: "Built-in cron scheduler with delivery to any platform. Daily reports, nightly backups, weekly audits -- all in natural language, running unattended." MCP: "Connect any MCP server for extended capabilities." Source: README, accessed 2026-08-26.

## Pricing and license

License: MIT (GitHub API, accessed 2026-08-26). From the FAQ: "Hermes Agent itself is free and open-source (MIT license). You pay only for the LLM API usage from your chosen provider. Local models are completely free to run."

The paid path is Nous Portal: "Nous Research's unified subscription gateway and the recommended way to run Hermes Agent," offering 300+ models behind one OAuth login, with Hermes 4 models "available through the Portal at heavily discounted rates." No dollar figures are published on the docs page checked. Portal is optional: the docs cover adding it "alongside other providers" and switching "with `/model` mid-session." Source: https://hermes-agent.nousresearch.com/docs/integrations/nous-portal (accessed 2026-08-26)

## Benchmarks

None found. No memory or agent benchmark scores appear in the README, the FAQ, or the docs pages checked (accessed 2026-08-26). Unlike Letta, mem0, and Zep, Hermes publishes no LoCoMo or equivalent number. The release notes mention internal "Composio eval findings" driving execution-discipline fixes, but no scores are published.

## vs imprnt

The retrieval-layer agreement is real, and it is the second big-name convergence on lexical search after Letta's files-over-vectors pivot: a 236k-star agent from a research lab does cross-session recall with SQLite FTS5 full-text search, and nothing vector-shaped appears anywhere in its documented memory architecture. No embeddings, no vector DB, no re-ranker in the read path. That is imprnt's retrieval thesis shipping at mass scale.

Everything above the ranker diverges:

- What is searched: Hermes searches the raw conversation transcript ("actual messages from the DB"). imprnt searches curated typed notes and never searches raw transcripts (`recall` greps `vault/` only, `raw/` is invisible to search by design). Hermes' equivalent of imprnt's vault, the curated durable layer, is not searched at all: it is two files small enough to inject whole.
- Size of the curated layer: MEMORY.md (2,200 chars) plus USER.md (1,375 chars) is about 3.5KB, roughly 1,300 tokens, hard-capped, with the agent forced to consolidate or evict when full. imprnt's vault is unbounded, entity-typed (people/orgs/holdings), linked, and grows to thousands of notes because BM25 ranking makes a large corpus cheap to read from. Hermes' capped files need no ranking precisely because they are tiny. The architectures agree on lexical search and disagree on what deserves to durably exist. (Skills soften this: procedural knowledge accumulates without cap in `~/.hermes/skills/`. But declarative knowledge, the what-do-I-know layer, is the two files plus whatever a transcript search can rediscover.)
- Who writes memory: Hermes is agent-authored by design ("The agent manages its own memory via the `memory` tool," write approval off by default, periodic self-nudges). imprnt is conscious capture: a human says "harvest this," the LLM does the one-time write-path work, and `imprnt check` audits the result. Hermes bets the agent curates well under a hard cap. imprnt bets curation is the valuable one-off work worth doing deliberately and keeping unbounded.
- Fidelity: a fact that misses the 3.5KB cut survives in Hermes only as transcript, findable if a later FTS5 query happens to hit its wording. imprnt's cardinal rule is the opposite: structured payload (tables, numbers, IDs) is copied into searchable notes because "anything left in raw/ is invisible."
- Scope: Hermes is an agent that has memory. imprnt is memory that any agent can use, plain files with no runtime. Delete Hermes and the two Markdown files survive, but `state.db` needs SQLite and the recall behavior, nudges, journey timeline, and skills loop all die with the runtime. Delete imprnt and every note still opens.

## When it wins over imprnt

- You want one persistent assistant reachable from anywhere: 21 messaging channels, voice, a TUI, and cross-platform conversation continuity from a single gateway process. imprnt has no channels at all, it rides inside whatever agent you already run.
- You want the assistant always on and working unattended: cron in natural language, serverless backends that hibernate ("costing nearly nothing between sessions"), subagents, MCP. imprnt is on-demand by principle and ships no scheduler.
- You want zero-effort memory. Hermes captures everything automatically and curates itself. imprnt asks you to consciously harvest, which is a cost Hermes users never pay.
- You want perfect recall of what was literally said weeks ago: FTS5 over every stored message beats a vault that only holds what was deliberately filed.
- You want a skills marketplace: agent-authored procedures, an open standard (agentskills.io), a community hub with security scanning, and one-command migration from OpenClaw. imprnt's plugins are personal, not shared.
- Onboarding: one-line installers for Linux/macOS/WSL2/Termux and native Windows PowerShell, with the installer bundling uv, Python, Node.js, ripgrep, ffmpeg, and a portable Git Bash.

## Camp (proposal input)

Recommendation: a new camp, **Personal-agent runtime**, with Hermes as its first member (and OpenClaw, its explicit ancestor via `hermes claw migrate`, as the natural second).

Why not "Agent-state runtime" next to Letta: Letta sells memory as the product, a platform developers build agents on top of (API, SDKs, managed state, an inspector UI). Hermes sells the agent as the product, "The self-improving AI agent," a consumer-shaped assistant you talk to from Telegram, and its memory is a built-in feature with no API for other applications to consume. The reader deciding between imprnt and Letta is picking a memory backend. The reader deciding between imprnt and Hermes is picking whether their memory should live inside one resident agent or in files any agent reads. Those are different questions, so they are different camps. Why not "Adjacent": ECC is adjacent because its memory neither searches nor persists knowledge. Hermes has a real, documented, searched memory architecture that agrees with imprnt on lexical retrieval, which makes it a direct comparison, not a footnote.

Proposed comparison-table row (CompareTable.astro shape):

```
{
  tool: "Hermes Agent",
  note: "personal agent, 236k stars, memory is a built-in feature",
  where: "Two capped files (~3.5KB total) plus SQLite session history",
  retrieval: "FTS5 full-text over raw session messages, no vectors",
  capture: "Agent self-curates on periodic nudges, approval gate off by default",
  reads: "Files injected whole at session start, session_search tool for history",
}
```

## Sources

- [Hermes Agent GitHub repository](https://github.com/NousResearch/hermes-agent) - accessed 2026-08-26
- [GitHub API: repo metadata](https://api.github.com/repos/NousResearch/hermes-agent) - accessed 2026-08-26 (stars, forks, license, created_at, pushed_at)
- [GitHub API: releases](https://api.github.com/repos/NousResearch/hermes-agent/releases) - accessed 2026-08-26
- [v2026.8.19 release (v0.20.5)](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.19) - accessed 2026-08-26
- [Hermes README (raw, main branch)](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md) - accessed 2026-08-26
- [Docs home](https://hermes-agent.nousresearch.com/docs/) - accessed 2026-08-26
- [Memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) - accessed 2026-08-26
- [Skills docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) - accessed 2026-08-26
- [Messaging platforms docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/) - accessed 2026-08-26
- [Platform support docs](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support) - accessed 2026-08-26
- [Nous Portal integration docs](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal) - accessed 2026-08-26
- [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq) - accessed 2026-08-26

## Confidence and gaps

- "No embeddings": inferred, not quoted. The task hypothesis said "explicitly no embeddings," but no explicit statement was found in the README, memory docs, or FAQ. The evidence is architectural: FTS5 is the only documented search mechanism, and nothing vector-shaped appears anywhere. High confidence in the fact, no verbatim source for it.
- February 2026 launch date: unverified from primary sources. Third-party coverage places the public announcement at February 25, 2026, but no nousresearch.com post was located to confirm it. What the primary record shows: repo created 2025-07-22, first GitHub release v0.2.0 published 2026-03-12.
- "Six terminal backends" (task brief): refuted. The README says "Seven terminal backends," adding Vercel Sandbox to the brief's six. The docs landing page still says "6 terminal backends," so the docs lag the README.
- "20+ messaging platforms": confirmed with a count of 21 named channels on the messaging docs page. The README's own feature table names only the headline six (Telegram, Discord, Slack, WhatsApp, Signal, CLI).
- LLM summarization in session search: the README says "FTS5 session search with LLM summarization for cross-session recall" while the memory page says search "return[s] actual messages from the DB -- no LLM summarization." Both quotes are real. Read as raw tool returns plus an optional summarization layer, but the exact composition is not verified.
- Em-dashes inside verbatim quotes are rendered as "--" per this folder's typography, otherwise quotes are unaltered.
- Nous Portal pricing: no dollar figures published on the docs page checked. "Heavily discounted rates" is the only pricing language found.
- Honcho dialectic user modeling: named in the README with a link to plastic-labs/honcho and mentioned in the memory docs as an external memory provider option, but how it composes with the two-file model is not documented on the pages checked.
- Nudge mechanics: "periodic nudges" is quoted from the README, but the trigger cadence and mechanism were not found in the docs pages checked.
- Doc-page quotes came through a summarizing fetch tool rather than raw HTML, so surrounding context is trimmed. The README quotes were verified against the raw file directly and are exact.
- Star count 236,848 and open issues 36,183 are point-in-time API reads on 2026-08-26. At this project's velocity they will drift fast.
