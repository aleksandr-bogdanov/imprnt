# ECC (everything-claude-code)

**One-line:** A cross-harness configuration and prompt pack - 268 skills, 66 agent definitions, 122 rules files, 92 command shims, and per-harness config trees for eleven coding-agent harnesses - plus a thin Node installer CLI (`ecc-universal`) and lifecycle hook scripts, one of which implements a modest recency-based session-memory layer.

**Status (checked 2026-07-02):** active - repo `affaan-m/ECC` pushed 2026-07-01, 14 releases from v1.0.0 (2026-01-22) to v2.0.0 (2026-06-10), and the last 100 commits all land between Jun 15 and Jun 30, 2026. Effectively a one-maintainer project (Affaan Mustafa) with a very large surface area, funded by a $19/seat hosted tier and sponsors. GitHub API: `archived: false`, pushed 2026-07-01. [api.github.com/repos/affaan-m/ECC](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02.

**Latest release:** v2.0.0, 2026-06-10 | **Stars:** 225,052 | **License:** MIT | **Hosting:** local (the OSS core), plus an optional hosted GitHub App (ECC Pro, $19/seat/month at ecc.tools)

**Category note - why this file exists:** ECC is a config pack for coding-agent harnesses, and memory is one bolt-on subsystem among many. It earns a dossier anyway: it was asked for, it is the most-starred agent-adjacent repo of 2026 so readers will hold it next to imprnt regardless, and it advertises "memory persistence" as a headline feature. This dossier measures that subsystem on the same axes as the real memory tools and keeps the category mismatch visible throughout.

## What it is

ECC is the renamed `everything-claude-code` repo. The old API URL 301-redirects to repository id 1136590548, which is ECC, so the viral star count and the current repo are one and the same. The GitHub description reads:

> "agent harness performance optimization system"

- [api.github.com/repos/affaan-m/ECC](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02
- [api.github.com/repos/affaan-m/everything-claude-code (301 redirect)](https://api.github.com/repos/affaan-m/everything-claude-code) - accessed 2026-07-02

The v2.0.0 "Agent Harness Operating System" branding oversells the mechanics. The shipped code is a large curated content-and-config pack that gets copied or symlinked into existing harnesses, which stay in charge of actually running agents: 268 SKILL.md skills, 66 agent definitions, 122 rules files, 92 command shims, and per-harness config trees for Claude Code (`.claude`, plus a `.claude-plugin` marketplace entry, slug `ecc@ecc`), Codex, Cursor (17 JS hooks), OpenCode, Gemini, Kiro, Zed, Qwen, Trae, CodeBuddy, and GitHub Copilot.

- [api.github.com/repos/affaan-m/ECC/git/trees/main?recursive=1 (full 4,501-entry tree)](https://api.github.com/repos/affaan-m/ECC/git/trees/main?recursive=1) - accessed 2026-07-02

On top sits real but thin runtime machinery in JavaScript: the npm package `ecc-universal` (bins `ecc`, `ecc-control-pane`, `ecc-install`, deps only `@iarna/toml`, `ajv`, `sql.js`) doing manifest-driven selective install, the lifecycle hook scripts that implement the memory layer, a sql.js state store, and git-worktree/tmux orchestration helpers. Peripheral surfaces: a second npm package `ecc-agentshield` (a security scanner), the hosted ECC Tools GitHub App (the monetization layer), a Tkinter dashboard (`ecc_dashboard.py`), and `ecc2/`, a Rust control-plane prototype the release notes themselves call alpha, "not yet a general release".

- [raw.githubusercontent.com/affaan-m/ECC/main/package.json](https://raw.githubusercontent.com/affaan-m/ECC/main/package.json) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/README.md](https://raw.githubusercontent.com/affaan-m/ECC/main/README.md) - accessed 2026-07-02

So it ships four ways: copyable config trees, an npm CLI/installer, a Claude Code plugin, and a hosted paid GitHub App.

## Status, timeline, recency

- **2026-01-18** - repo created as `everything-claude-code`, riding the author's viral "Shorthand Guide" X thread. Stargazer API timestamps confirm 10k stars within 3 days of creation and 40k within 3 weeks. [api.github.com/repos/affaan-m/ECC](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02.
- **2026-01-22** - v1.0.0. [api.github.com/repos/affaan-m/ECC/releases](https://api.github.com/repos/affaan-m/ECC/releases) - accessed 2026-07-02.
- **2026-03** - v1.8.0 retrofits the "agent harness performance system" framing onto what launched as a "complete Claude Code configuration collection". Release notes - accessed 2026-07-02.
- **2026-06-10** - v2.0.0, the "Agent Harness Operating System" release. 14 releases total, roughly biweekly. [api.github.com/repos/affaan-m/ECC/releases](https://api.github.com/repos/affaan-m/ECC/releases) - accessed 2026-07-02.
- **2026-07-01** - last push. The last 100 commits span Jun 15-30, 2026 (the author 37, dependabot 11, the rest small community PRs). [api.github.com/repos/affaan-m/ECC/commits?per_page=100](https://api.github.com/repos/affaan-m/ECC/commits?per_page=100) - accessed 2026-07-02.
- **Stars:** 225,052 | **Forks:** 34,447 | **Watchers (subscribers):** 1,146 | **Open issues:** 87. [api.github.com/repos/affaan-m/ECC](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02.
- **Engagement runs far behind the stars.** 1,146 watchers on a 225k-star repo is a ~196:1 star-to-watcher ratio (React and freeCodeCamp sit around 35-50:1), 637 issues ever, and npm installs of `ecc-universal` total ~42k since launch (~4.3k/week now). Consistent with drive-by starring from viral X reach. No direct evidence of botted stars was found.
- **HN flopped repeatedly:** every direct submission got 1-2 points with zero comments (Jan, May, Jun 2026 via Algolia). The one substantive HN comment on the trend is respectful but skeptical: "stars are not telling us which of these are surviving on actual reuse", the skills catalog "can be diffed and ported in an afternoon", though it calls AgentShield "a real product even if the skills it scans aren't". [hn.algolia.com search: everything-claude-code / ECC](https://hn.algolia.com/?q=everything-claude-code) - accessed 2026-07-02.
- **Malware ride-alongs:** a DEV.to security audit found a malware clone (`arabicapp/everything-claude-code`) and flagged the original's own attack surface (28 auto-executing hooks, 49 of 64 agents with Bash access, unsigned git-pull auto-update). Bitdefender, BleepingComputer, and TrendMicro covered fake Claude Code repos riding the same wave. The README now opens with an official-sources-only warning and CI carries a supply-chain IOC scan plus SLSA provenance.
- **Maintainer:** Affaan Mustafa (GitHub `affaan-m`), an extremely fast-shipping solo builder whose background is crypto/web3 agents (elizaOS core dev, autonomous Solana trading bots), currently co-founder of Ito, a prediction-market startup. v2.0.0-rc.1 ships an "Ito prediction-market skill pack", so the repo doubles as distribution for that startup. Monetization (ECC Pro at $19/seat/month, GitHub Sponsors, business sponsors) funds one maintainer, which is both the momentum and the bus-factor risk.

Recency verdict: very active, pushed the day before this check. Also churning fast. A 5-month-old codebase already carries "legacy command shims" and a legacy sessions dir, and counts drift between the repo's own surfaces (README badge "211.9K+" stars vs 225K live, "261 skills" vs "268 skills" in adjacent paragraphs).

## Where memory lives (storage and architecture)

The memory layer is implemented entirely as harness lifecycle hooks: `hooks/memory-persistence/hooks.json` wires SessionStart, PreCompact, PreToolUse/PostToolUse, and SessionEnd to scripts in `scripts/hooks/`. Three stores, all plain files or SQLite under the user's home dir:

1. **Session summaries.** `scripts/hooks/session-end.js` parses the Claude Code JSONL transcript (stdin `transcript_path`), extracts the last 10 user messages, tools used, and files modified, and writes a per-project markdown summary under `~/.claude/session-data/` (legacy `~/.claude/sessions/`), matched as `*-session.tmp` with `ECC:SUMMARY:START/END` markers. Optionally `scripts/lib/llm-summary.js` shells out to `claude -p` with Haiku for a richer summary, reusing Claude Code auth with no API key, a 90s timeout, and a recursion guard.
2. **Instincts** (the continuous-learning-v2 skill). PreToolUse/PostToolUse hooks append `observations.jsonl`, and a background Haiku "observer" agent distills observations into atomic YAML instinct files (id, trigger, confidence 0.3-0.9, domain, scope), stored project-scoped under `${XDG_DATA_HOME:-~/.local/share}/ecc-homunculus/projects/<hash>/` or globally under `~/.claude/homunculus/`. `/evolve` and `/promote` commands cluster instincts into learned skills (markdown under `~/.claude/skills/learned/`).
3. **A sql.js SQLite state store** (`scripts/lib/state-store/`, ajv-validated against `schemas/state-store.schema.json`) tracking sessions, skill runs, decisions, install state, governance events, and work items. Operational state. The knowledge, such as it is, lives in the files above.

- [raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md](https://raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-end.js](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-end.js) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/skills/continuous-learning-v2/SKILL.md](https://raw.githubusercontent.com/affaan-m/ECC/main/skills/continuous-learning-v2/SKILL.md) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/state-store/schema.js](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/state-store/schema.js) - accessed 2026-07-02

The persistence contract is local-by-default and says so:

> "Keep persistence local by default. Avoid sending transcripts or tool traces to hosted services unless a user explicitly enables an integration."

- [raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md](https://raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md) - accessed 2026-07-02

## Retrieval

Recency-based context injection with no search. `scripts/hooks/session-start.js` finds `*-session.tmp` files (7-day window, 30-day retention default), dedupes, and prints the most recent summary to stdout so the harness injects it, bounded by `ECC_SESSION_START_MAX_CHARS` (default 8,000 chars, opt-out via `ECC_SESSION_START_CONTEXT=off`). It also injects up to 6 instincts with confidence >= 0.7 and up to 6 learned-skill summaries (220 chars each).

There is no ranking, no BM25, no embeddings, no vector store, and no query-time search over memory. The model gets whatever is newest and above the confidence threshold. Older sessions are reachable only by explicit commands (`/sessions`, `/resume-session`, `sessions-cli.js`).

- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/utils.js (storage roots)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/utils.js) - accessed 2026-07-02

## Capture

Automatic and ambient, per session. SessionEnd writes the summary from the transcript, PreCompact preserves state before compaction, PostToolUse appends observations, and a background Haiku agent distills instincts on its own schedule. The writers are hook scripts (code) plus that background LLM agent. Nothing asks the user what is worth keeping. The one conscious surface is the `/evolve` / `/promote` pair that turns accumulated instincts into skills.

- [raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md (hooks.json wiring)](https://raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/llm-summary.js](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/llm-summary.js) - accessed 2026-07-02

## How the AI reads it

Through the harness's own context injection, at session start only. The SessionStart hook prints the newest summary plus the instinct/skill slice, the harness puts that in context, and the session proceeds. No MCP server, no memory tools, no API over the store. Mid-session, memory is out of reach unless the user runs `/sessions` or `/resume-session` or the `sessions-cli.js` helper.

- [raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js) - accessed 2026-07-02

## Pricing and license

License: MIT (LICENSE file, confirmed by the GitHub API license field, spdx MIT). The OSS core - config packs, installer, hooks, the memory layer - is free.

The commercial layer is the ECC Tools GitHub App at ecc.tools: hosted PR audits with a Pro tier at $19/seat/month. Hosted infrastructure, separate from the local system. Some skills wrap external APIs (exa-search, fal-ai, x-api) with keys via `.env`.

- [api.github.com/repos/affaan-m/ECC (license field)](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/README.md (ECC Pro)](https://raw.githubusercontent.com/affaan-m/ECC/main/README.md) - accessed 2026-07-02

## Benchmarks (vendor self-reported)

Nothing backs the "performance optimization system" tagline: no comparative benchmark anywhere in the repo shows agents performing better with ECC than without it, or against any other config pack or harness. What the repo does carry:

- **The mgrep numbers are borrowed.** The longform guide claims "~50% token reduction on average" and a 50-task benchmark where "mgrep + Claude Code used ~2x fewer tokens than grep-based workflows at similar or better judged quality". Despite the "our" wording, the guide itself credits "Source: mgrep by @mixedbread-ai". It is the mgrep vendor's own benchmark, copied wording and chart included, with no independent replication and no methodology in the ECC repo.
- **Config-tip percentages ship without data.** Switching opus to sonnet is billed at "~60% cost reduction" handling "80%+ of coding tasks", and lowering the thinking cap at "~70% reduction" in hidden thinking cost. Directionally sound, dressed as measurements, no methodology.
- **AgentShield's counts are self-reported and drift** across the author's own surfaces: "1282 tests, 98% coverage" in the README, "1,609 tests" on the author's site.

The repo's own software test suite is real (183 files under `tests/`, a c8 coverage gate at ~80%, CI with SLSA provenance), but that is QA for the installer and scripts. No retrieval-quality or memory benchmark exists at all.

- [raw.githubusercontent.com/affaan-m/ECC/main/README.md](https://raw.githubusercontent.com/affaan-m/ECC/main/README.md) - accessed 2026-07-02
- [raw.githubusercontent.com/affaan-m/ECC/main/package.json (test suite, coverage gate)](https://raw.githubusercontent.com/affaan-m/ECC/main/package.json) - accessed 2026-07-02

## Note: site style similarity (checked 2026-07-02)

A side-by-side review of ecc.tools against imprnt's site found the overlaps stop at generic 2024-2026 dev-tool landing defaults: near-black background (#0a0a12 vs imprnt's #0a0b0d), JetBrains Mono, the stock feTurbulence grain snippet at ~0.03-0.04 opacity, a $-prefixed install command with a copy button, an "Open source · MIT" credibility chip, and no-lock-in copy. Everything distinctive diverges (palette, sans fonts, section structure, arguments), none of imprnt's specific copy, fingerprints, or design tokens appear in ECC, and ECC's landing prose carries the exact LLM tells imprnt's anti-slop spec bans. Verdict: same-model house style. Both sites are visibly LLM-built from the same genre defaults, with no evidence of derivation in either direction.

## vs imprnt

The honest comparison starts with the category: ECC is a catalog of prompts and configs for coding agents with a session-continuity feature, and imprnt is a personal knowledge vault. The memory subsystems still compare cleanly:

| Dimension | ECC (memory subsystem) | imprnt |
|-----------|------------------------|--------|
| What is remembered | Last sessions' summaries, distilled behavior "instincts", operational state | Knowledge: typed entity notes (people/orgs/holdings), events, decisions, reference |
| Storage | Markdown + YAML + JSONL scattered under `~/.claude/` and `~/.local/share/ecc-homunculus/`, plus sql.js SQLite | One plain-Markdown vault the user owns |
| Retrieval | Newest-first injection at session start. No search, no ranking | BM25 + grep over the whole vault, on any question, any time |
| Capture | Automatic hooks on every session, background Haiku distillation | Conscious, on demand ("ingest this", harvest) |
| Retention | 7-day injection window, 30-day retention default | Permanent. Contradictions marked superseded, never expired |
| Reader | The harness injects at session start. Mid-session needs commands | The agent greps and reads files mid-conversation, whenever asked |
| Scope | Per-project coding-session continuity | A whole life: health, finances, work, people |

The deeper mismatch: ECC's memory answers "what was I doing last session" and imprnt's vault answers "what do I know". ECC has no query path at all. A fact captured 40 days ago has aged out of injection and is findable only if you know which session to resume. Credit where due by imprnt's own lights: ECC keeps plain local files, uses zero embeddings, puts no vector store or MCP over memory, and states a local-by-default persistence contract. The designs part on the read path (recency injection vs ranked search) and on capture (ambient hooks plus a background LLM vs the LLM spent once, consciously, on the write path).

## When it wins over imprnt

- You want a huge ready-made catalog of skills, agents, rules, and commands for ten-plus harnesses, installed in minutes, with translations and a community around it.
- You want zero-effort session continuity in Claude Code (pick up tomorrow where you left off today) without ever deciding what to file.
- You want passive habit-learning: the instinct pipeline notices repeated behavior and distills it into reusable rules and skills with no manual authoring.
- You want the adjacent tooling: AgentShield security scanning, hosted PR audits (paid), git-worktree/tmux orchestration helpers.
- You work across many harnesses (Codex, Cursor, Gemini, Zed, and more) and want one config layer that targets all of them.

## Sources

- [github.com/affaan-m/ECC (repo)](https://github.com/affaan-m/ECC) - accessed 2026-07-02
- [api.github.com/repos/affaan-m/ECC (metadata: stars, forks, watchers, issues, license, dates)](https://api.github.com/repos/affaan-m/ECC) - accessed 2026-07-02
- [api.github.com/repos/affaan-m/everything-claude-code (301 redirect proving the rename)](https://api.github.com/repos/affaan-m/everything-claude-code) - accessed 2026-07-02
- [README.md (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/README.md) - accessed 2026-07-02
- [Git tree API (full 4,501-entry tree)](https://api.github.com/repos/affaan-m/ECC/git/trees/main?recursive=1) - accessed 2026-07-02
- [hooks/memory-persistence/README.md + hooks.json (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/hooks/memory-persistence/README.md) - accessed 2026-07-02
- [scripts/hooks/session-end.js (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-end.js) - accessed 2026-07-02
- [scripts/hooks/session-start.js (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/hooks/session-start.js) - accessed 2026-07-02
- [scripts/lib/llm-summary.js (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/llm-summary.js) - accessed 2026-07-02
- [scripts/lib/utils.js (raw, main - storage roots)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/utils.js) - accessed 2026-07-02
- [skills/continuous-learning-v2/SKILL.md (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/skills/continuous-learning-v2/SKILL.md) - accessed 2026-07-02
- [scripts/lib/state-store/schema.js (raw, main)](https://raw.githubusercontent.com/affaan-m/ECC/main/scripts/lib/state-store/schema.js) - accessed 2026-07-02
- [package.json (raw, main - ecc-universal v2.0.0)](https://raw.githubusercontent.com/affaan-m/ECC/main/package.json) - accessed 2026-07-02
- [GitHub API: releases (14 releases, v1.0.0 through v2.0.0)](https://api.github.com/repos/affaan-m/ECC/releases) - accessed 2026-07-02
- [GitHub API: last 100 commits](https://api.github.com/repos/affaan-m/ECC/commits?per_page=100) - accessed 2026-07-02
- [ecc.tools (landing page, raw HTML head for the style note)](https://ecc.tools) - accessed 2026-07-02
- Secondary (traction, origin, security): [hn.algolia.com search](https://hn.algolia.com/?q=everything-claude-code), medium.com/@tentenco and medium.com/@joe.njenga writeups, claudehub.fr, zenith.chat (hackathon-winner branding), affaanmustafa.com, the DEV.to security audit of the repo and its malware clone - accessed 2026-07-02

## Confidence and gaps

- **High confidence:** repo identity and rename (the 301 redirect), stars/forks/watchers/issues, MIT license, release list and dates, commit cadence, catalog counts (spot-checked via the contents API: skills/ 277 entries, agents/ 67, commands/ 92), and the memory subsystem's mechanics. The hook wiring, file paths, env vars, windows, and thresholds were all read from the shipped scripts, and the local-by-default quote is verbatim from the hook README.
- **Star quality:** the stars are real GitHub stars and the viral curve is verified by stargazer timestamps, but the star-to-watcher (~196:1) and star-to-install (~42k npm installs ever) ratios say most stargazers never became users. No direct evidence of purchased or botted stars was found. Recorded as lopsided traction, no stronger.
- **Performance claims:** unsubstantiated. The tagline has no benchmark behind it, the mgrep numbers are the mgrep vendor's own, and the config-tip percentages carry no data. All recorded as "the project claims X".
- **Count drift:** the repo's own surfaces disagree (README badge 211.9K+ vs 225K live stars, 261 vs 268 skills, AgentShield 1,282 vs 1,609 tests on the author's site). This dossier uses the live API numbers from 2026-07-02 and flags the drift rather than reconciling it.
- **Author-sourced history:** "10+ months of intensive daily use", the 8-hour hackathon build, and the X view counts (900k views, "3M+ directly tracked") are self-reported and unauditable. The Sept 2025 Anthropic x Forum Ventures hackathon win itself is corroborated by zenith.chat's branding and multiple independent writeups.
- **Style-note caveat:** ecc.tools was read via a summarizing fetch plus the raw HTML head. Long-tail body sections beyond the first ~6KB of inline CSS were not inspected byte-for-byte. The verdict (same-model house style, no derivation) rests on the global design tokens and the full copy of both landing pages.
- **Secondary-source URLs:** several traction claims (Reddit reception, npm install totals, the DEV.to audit) come from named secondary coverage without a single stable primary URL. They are attributed to their outlets above and kept out of any load-bearing architectural claim.
