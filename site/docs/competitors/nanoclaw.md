# NanoClaw

**One-line:** Gavriel Cohen's deliberately small, container-isolated personal-agent runtime, written as the security-minded answer to OpenClaw: one process on the Claude Agent SDK, thirteen chat channels, and per-agent memory as plain Markdown files with no database and no embedding store.

**Status (checked 2026-08-26):** active, venture-backed, hyperactive cadence. Latest release v2.3.0 published 2026-08-24T11:45:32Z, last push 2026-08-26T20:52:02Z (the access date itself), both from the GitHub API. The creator's company NanoCo raised a $12M seed in May 2026 (TechCrunch: "NanoClaw creator turns down $20M buyout offer, raises $12M seed instead").

**Latest release:** v2.3.0, Aug 24, 2026 | **Stars:** 30,627 | **Forks:** 12,840 | **License:** MIT | **Hosting:** self-host only (your machine, agents in local containers)

## What it is

The repo description (GitHub API, accessed 2026-08-26): "A lightweight alternative to OpenClaw that runs in containers for security. Connects to WhatsApp, Telegram, Slack, Discord, Gmail and other messaging apps, has memory, scheduled jobs, and runs directly on Anthropic's Agents SDK."

The README opens: "An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs." The positioning against OpenClaw is explicit: "OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies," while "NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files." Security is by OS boundary: "Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks."

- https://raw.githubusercontent.com/nanocoai/nanoclaw/main/README.md (accessed 2026-08-26)

Design principles, verbatim from the README: "Small enough to understand. One process, a few source files and no microservices." / "Secure by isolation. Agents run in Linux containers and they can only see what's explicitly mounted." / "Built for the individual user. NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs."

Channels, verbatim: "WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend." Channels install on demand via `/add-<channel>` skills.

Model support: "NanoClaw natively uses Claude Code via Anthropic's official Claude Agent SDK, so you get the latest Claude models and Claude Code's full toolset." It is deliberately swappable: "Other providers are drop-in options: `/add-codex` for OpenAI's Codex, `/add-opencode` for OpenRouter, Google, DeepSeek and more via OpenCode, and `/add-ollama-provider` for local open-weight models." So it is Claude-first, model-agnostic by skill.

Honest caveat on "a handful of files": the main-branch git tree lists 1,025 paths today (GitHub API, accessed 2026-08-26), including a TypeScript host, a container agent-runner with a SQLite mailbox, ~30 installable skills, and tests. TechCrunch reports the original was "500 lines of code." The minimalism is a real posture and a real architecture (one process, no microservices), and the codebase has still grown well past a weekend project.

## Who maintains it

NanoCo, founded early 2026 by brothers Gavriel Cohen (CEO, ex-Wix engineer, built NanoClaw solo) and Lazer Cohen. Fortune: "Meet the brothers who turned a homegrown AI agent into a $12 million bet on the future of work — in six weeks." The GitHub org is `nanocoai` ("Building AI-native Infrastructure", nanoco.ai, created 2026-01-15, 18 public repos). Contributor stats confirm a dominant lead author: `gavrielc` with 1,348 commits, the next human contributor at 176.

- https://fortune.com/2026/05/20/exclusive-first-claw-company-to-raise-funding-nanoco-nanoclaw-cohen-brothers/ (accessed 2026-08-26)
- https://api.github.com/repos/nanocoai/nanoclaw/contributors (accessed 2026-08-26)

## Status, timeline, recency

- 2026-01-31: repo created (`created_at: 2026-01-31T15:47:22Z`, GitHub API). TechCrunch: Cohen built it "in a weekend coding binge" after discovering OpenClaw "had downloaded all of his WhatsApp messages and stored them in plain, unencrypted text on his computer. Not just the work-related messages it was given explicit access to, but all of them, his personal messages too." Source: https://techcrunch.com/2026/03/13/the-wild-six-weeks-for-nanoclaws-creator-that-led-to-a-deal-with-docker/
- 2026-02 (approx): "an X post praising NanoClaw from famed AI researcher Andrej Karpathy went viral" (TechCrunch, roughly three weeks before its Mar 13 piece). Stars at that point: 22k.
- 2026-03-13: Docker partnership announced, "integrate Docker Sandboxes into NanoClaw," replacing the original Apple container technology. Source: same TechCrunch article.
- 2026-05-20: NanoCo raises a $12M seed led by Valley Capital Partners, with Docker, Vercel, monday.com, Slow Ventures, Clutch Capital, Factorial Capital, and Clem Delangue participating, after turning down a ~$20M acquisition offer. Sources: https://techcrunch.com/2026/05/20/nanoclaw-creator-turns-down-20m-buyout-offer-raises-12m-seed-instead/ and the Fortune piece above. VentureBeat frames the company direction as "turning the secure, open source AI agent harness into an enterprise 'second brain'": https://venturebeat.com/orchestration/nanoclaws-creators-are-turning-the-secure-open-source-ai-agent-harness-into-an-enterprise-second-brain
- 2026-06-17: v2.1.0 and v2.1.17 published. 2026-08-01: v2.1.54. 2026-08-13: v2.2.0. 2026-08-24: v2.3.0 (latest), whose notes cover a per-agent Slack app migration, a Codex CLI re-pin, and a storage-neutral mailbox registry refactor. Source: https://api.github.com/repos/nanocoai/nanoclaw/releases (accessed 2026-08-26)

Recency verdict: about as alive as a repo gets. Release two days before access, push on the access date, three releases in August alone, 1,001 open issues, 30.6k stars in under seven months.

## Where memory lives

File-based, per agent group, and documented with unusual clarity. From `docs/memory.md` (accessed 2026-08-26):

> "Every agent group has persistent, file-based memory: plain Markdown files that survive container restarts, session ends, compaction, and provider switches. There is no database and no embedding store. The agent reads and edits the files with ordinary file tools, and you can too."

Location: "On the host the files live in `groups/<folder>/memory/`. Inside the container the same directory is mounted at `/workspace/agent/memory/`." The scaffold is `index.md` (top-level index plus a Core Memory section, always loaded) and `system/definition.md` (how the memory behaves, always loaded), with agent-created folders beyond that, each carrying its own `index.md`.

The format is a named convention, "Open Knowledge Format (OKF) v0.1": "one Markdown concept per file, with YAML frontmatter declaring a `type` (for example `person`, `project`, `decision`...)". Optional fields: `title`, `description`, `tags`, `resource` (path to the raw source it was distilled from). "Types are the agent's vocabulary, not a fixed list." The stated payoff: "any OKF-aware agent or tool can read the bundle, and switching a group to a different provider carries memory over untouched."

- https://github.com/nanocoai/nanoclaw/blob/main/docs/memory.md (accessed 2026-08-26)

The scout's "the Claude-agent pattern of CLAUDE.md as memory" is now partly historical: `CLAUDE.md`-resident memory notes and Claude's auto-memory directory are listed under "Migrating older memory" as legacy storage that `/migrate-memory` moves into the shared memory tree. The current design is the OKF tree above, provider-neutral by intent.

## Retrieval

No search index of any kind, machine or vector. Two mechanisms:

1. Always-loaded index: "a session-start hook injects `index.md` and `system/definition.md` into the agent's context" whenever a fresh context window is created (startup, clear, compaction). "Only those two files are injected, and each is capped at 16k characters."
2. Agent-driven lookup for everything else: "the agent follows links from the index and reads the files directly." The shipped `system/definition.md` template instructs verbatim: "Search with ordinary filesystem tools such as `rg` and `find`, then follow Markdown links."

So retrieval is lexical and local, with zero embeddings, and the model is in the read loop on every query: the agent decides what to grep, runs it, and reads results. There is no ranker. The index files are the agent's own hand-maintained map, kept accurate by instruction ("Whenever you add, move, or remove memory, update the nearest index"), never regenerated by code.

- https://github.com/nanocoai/nanoclaw/blob/main/docs/memory.md (accessed 2026-08-26)
- https://github.com/nanocoai/nanoclaw/blob/main/container/agent-runner/src/memory/templates/system/definition.md (accessed 2026-08-26)

## Capture

Automatic and agent-authored, steered by a prompt file the agent may rewrite. The template: "you need to store all relevant information the user shares with you and recall it when relevant... Information is lost when the conversation history is compacted, so anything you would want to survive compaction should be stored in memory." The write discipline is notable: "Remember the approach, not the instance" (a disliked post usually means a style preference, ask when unsure) and "Think in entities. People, projects, teams, places, decisions: things that recur deserve their own concept, with relationships recorded." Corrections are prune-in-place: "When a fact is corrected, update the memory and keep only useful history."

The definition file itself is agent-owned: "This file defines how your persistent memory works, and it is yours to improve." The operator can also edit any memory file directly on the host, picked up at the next context window.

- https://github.com/nanocoai/nanoclaw/blob/main/container/agent-runner/src/memory/templates/system/definition.md (accessed 2026-08-26)

## How the AI reads it

The agent runs inside its group's container via the Claude Agent SDK (or a drop-in provider). At every fresh context window the runner's session-start hook injects the two always-loaded files, and mid-session the agent reads memory with its normal file tools over the mounted `/workspace/agent/memory/`. There is no memory server, no MCP layer over the store, no API between the model and the files. Standing behavior lives separately in `/workspace/agent/instructions.prepend.md`, transcripts in `conversations/`.

- https://github.com/nanocoai/nanoclaw/blob/main/docs/memory.md (accessed 2026-08-26)

## Pricing and license

MIT (GitHub API, accessed 2026-08-26). The open-source runtime is free: you bring your own Anthropic credentials (or another provider's), registered at install via OneCLI, and the install script sets up Node, pnpm, and Docker. There is no hosted tier for NanoClaw itself as of the access date. The commercial motion is NanoCo's separate enterprise product line ("enterprise AI assistants after 250,000 NanoClaw downloads," ynetnews headline), which does not change the OSS runtime's terms.

- https://www.ynetnews.com/business/article/byqweojymx (accessed 2026-08-26)

## Benchmarks

None published. No memory-recall benchmark, no LoCoMo run, no self-reported numbers found in the README, docs, or release notes as of 2026-08-26. The project's public claims are about size, isolation, and channel breadth, all structural rather than measured.

## vs imprnt

The philosophical overlap is the headline, and it runs deeper than any other runtime in the field. "Small enough to understand: one process and a handful of files" is imprnt's own boring-on-purpose stance applied to the assistant category, and the memory layer converges even harder: plain Markdown, one concept per file, YAML frontmatter with a `type` drawn from the user's world (`person`, `project`, `decision`), tags, links between entities, a distill-from-raw-source pattern, files that survive tool removal and provider switches, zero embeddings. NanoClaw even named the convention (OKF) and pitched portability as the payoff, which is imprnt's files-outlive-the-tool argument made by a 30k-star neighbor. Where they still split:

- Retrieval: NanoClaw has no ranker. Recall is the agent running `rg` and `find` and following links, plus a 16k-capped index injected at context start, so the model is in the read loop on every lookup and pays tokens to walk the tree. imprnt's core is deterministic BM25 over title/tags/body, with the LLM only shaping the query and reading top-N. On a small memory the difference is invisible. On thousands of notes, grep-and-walk is exactly the hot-path cost imprnt rations out.
- Curation: NanoClaw's memory is agent-authored and agent-organized, including the definition file that governs it ("yours to improve"). imprnt's capture is conscious and human-curated ("harvest this"), with a typed contract the human owns. Different bet on who the librarian is.
- Integrity: nothing in NanoClaw checks the memory. Index accuracy, link validity, and frontmatter health are maintained by instruction to the model ("repairs metadata when it next touches the file"). imprnt makes them checked invariants: `imprnt check` rebuilds the index deterministically, flags orphan links, untagged notes, and folder/field disagreement, with code as the referee.
- The index: NanoClaw's `index.md` files are hand-maintained by the agent and load-bearing for recall (the map IS the retrieval entry point, capped at 16k). imprnt's `index.md` is generated from frontmatter and disposable, because search never depends on it.
- Scope: NanoClaw is an assistant runtime where memory is one subsystem beside channels, scheduling, containers, and provider plumbing. imprnt is the knowledge vault alone, usable under any harness. You could, in principle, point an OKF-aware agent at either store, which is a sentence that can be written about no other pair in this folder.
- Entity resolution: OKF has types and links but no alias machinery. imprnt greps names plus `aliases[]` and merges on hit, so a renamed person stays one note.

## When it wins over imprnt

- You want an always-on assistant that acts, across WhatsApp, Telegram, Discord, Slack, Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email, with scheduled jobs. imprnt is a vault, and does none of that on purpose.
- You want hard OS-level isolation: each agent group in its own Linux container seeing only explicit mounts, credentials injected at a proxy and never entering the container. imprnt's security model is a chmod-700 local folder.
- You want memory that costs zero effort, written and reorganized by the agent as life happens, with big-event reshaping built into the prompt. imprnt deliberately keeps capture a conscious act.
- You want to swap the model under the same memory (`/add-codex`, `/add-opencode`, `/add-ollama-provider`) with the runtime carrying the session-start hook across providers.
- You want a codebase you can audit end to end before letting an agent read your messages. That was the founding act of the project.

## Sources

- [NanoClaw GitHub repository](https://github.com/nanocoai/nanoclaw) - accessed 2026-08-26
- [NanoClaw README (raw, main branch)](https://raw.githubusercontent.com/nanocoai/nanoclaw/main/README.md) - accessed 2026-08-26
- [GitHub API: repo metadata (created, pushed, stars, license)](https://api.github.com/repos/nanocoai/nanoclaw) - accessed 2026-08-26
- [GitHub API: releases (v2.3.0 and cadence)](https://api.github.com/repos/nanocoai/nanoclaw/releases) - accessed 2026-08-26
- [GitHub API: contributors](https://api.github.com/repos/nanocoai/nanoclaw/contributors) - accessed 2026-08-26
- [docs/memory.md (memory architecture, OKF)](https://github.com/nanocoai/nanoclaw/blob/main/docs/memory.md) - accessed 2026-08-26
- [Memory definition template (retrieval and capture instructions)](https://github.com/nanocoai/nanoclaw/blob/main/container/agent-runner/src/memory/templates/system/definition.md) - accessed 2026-08-26
- [TechCrunch: The wild six weeks for NanoClaw's creator that led to a deal with Docker (Mar 13, 2026)](https://techcrunch.com/2026/03/13/the-wild-six-weeks-for-nanoclaws-creator-that-led-to-a-deal-with-docker/) - accessed 2026-08-26
- [TechCrunch: NanoClaw creator turns down $20M buyout offer, raises $12M seed instead (May 20, 2026)](https://techcrunch.com/2026/05/20/nanoclaw-creator-turns-down-20m-buyout-offer-raises-12m-seed-instead/) - accessed 2026-08-26
- [Fortune: Meet the brothers who turned a homegrown AI agent into a $12 million bet (May 20, 2026)](https://fortune.com/2026/05/20/exclusive-first-claw-company-to-raise-funding-nanoco-nanoclaw-cohen-brothers/) - accessed 2026-08-26
- [VentureBeat: NanoClaw's creators are turning the harness into an enterprise 'second brain'](https://venturebeat.com/orchestration/nanoclaws-creators-are-turning-the-secure-open-source-ai-agent-harness-into-an-enterprise-second-brain) - accessed 2026-08-26
- [ynetnews: NanoCo launches enterprise AI assistants after 250,000 NanoClaw downloads](https://www.ynetnews.com/business/article/byqweojymx) - accessed 2026-08-26

## Confidence and gaps

- Repo metadata (created 2026-01-31, pushed 2026-08-26, 30,627 stars, 12,840 forks, MIT, v2.3.0 on 2026-08-24): high confidence, read directly from the GitHub API on the access date. The scout's figures all verified exactly.
- Memory architecture and retrieval: high confidence, quoted from `docs/memory.md` and the shipped definition template in the repo itself. The scout's "no separate index documented" needed refinement: there IS an index (`index.md`, agent-maintained, injected at context start), and there is no machine search index. Search is explicitly `rg`/`find` by instruction.
- The scout's "CLAUDE.md as memory" framing is legacy: current docs route durable memory to the OKF tree and list CLAUDE.md-resident notes under migration. The README's per-agent-workspace sentence (own `CLAUDE.md`, own memory) is still accurate, with `CLAUDE.md` now carrying config/instructions rather than the memory store.
- OpenClaw size figures conflict across sources: the README says "nearly half a million lines," TechCrunch says "approximately 800,000." Both are recorded, neither independently measured here.
- Funding details ($12M, Valley Capital Partners lead, investor list, ~$20M rejected offer): from TechCrunch/Fortune/VentureBeat coverage dated May 20, 2026, consistent across three outlets, quoted from headlines and article text via search summaries rather than full-article verbatim pulls. Medium-high confidence.
- Karpathy endorsement: reported by TechCrunch ("an X post praising NanoClaw... went viral") with no direct quote recovered. The post itself was not fetched. Directionally solid, verbatim text unavailable.
- 250,000 downloads: from a ynetnews headline, single source, not independently verifiable for an OSS git repo (likely installer or image pulls). Low confidence on the metric's meaning, cited as the vendor-adjacent claim it is.
- Credential proxy ("OneCLI's Agent Vault... injects authentication at the proxy level"): from a summarized README fetch, not re-quoted verbatim from the raw file. Medium confidence on exact wording, the mechanism is consistent with the repo's OneCLI install flow.

## Proposed page entries

CompareTable.astro row (insert after the OpenClaw row):

```js
{
  tool: "NanoClaw",
  note: "personal agent runtime, the security-first OpenClaw answer",
  where: "Plain Markdown (OKF) per agent group, no DB, no embeddings",
  retrieval: "Agent-driven rg/find plus hand-kept index links, model in the loop",
  capture: "Agent self-writes mid-session, steered by an editable definition file",
  reads: "index.md injected at context start (16k cap), files read in-container",
},
```

FieldVerdicts.astro card (Personal-agent runtimes camp, after OpenClaw):

```js
{
  tool: "NanoClaw",
  note: "30.6k stars in seven months",
  what: "The security-minded minimal answer to OpenClaw: one process on the Claude Agent SDK, agents in isolated containers across 13 chat channels, memory as plain Markdown concept files (OKF: typed frontmatter, tags, links), no database and no embedding store.",
  split: "The field's closest convergence on imprnt's memory design, down to type: person frontmatter, but recall is the agent grepping and walking its own hand-kept indexes, and nothing checks the store. imprnt ranks with deterministic BM25 and audits the vault with code.",
  wins: "An always-on assistant that acts across your chat apps in a codebase small enough to audit, with container isolation and memory that costs zero effort.",
},
```
