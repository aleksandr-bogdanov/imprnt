# OpenClaw

**One-line:** Peter Steinberger's open-source personal AI assistant, the fastest-growing repo of the 2026 wave (~388k stars), a local gateway that connects Claude or GPT models to ~30 messaging channels with a skills ecosystem (ClawHub) and a persistent memory made of plain Markdown files indexed by a built-in SQLite engine with hybrid keyword-plus-vector search.

**Status (checked 2026-08-26):** active, foundation-stewarded. Steinberger announced on Feb 14, 2026 that he is joining OpenAI: "I'm joining OpenAI to work on bringing agents to everyone" and "OpenClaw will move to a foundation and stay open and independent." The repo license line now reads "MIT © OpenClaw Foundation" and releases are shipping (latest beta Aug 24, 2026, two days before this check). Source: https://steipete.me/posts/2026/openclaw

**Latest release:** 2026.8.1-beta.3, Aug 24, 2026 | **Stars:** ~388k | **License:** MIT (OpenClaw Foundation) | **Hosting:** self-host only, your own machine and API keys

## What it is

A personal assistant runtime, not a memory tool. The repo describes itself as "Your own personal AI assistant. Any OS. Any Platform. The lobster way." and the README as "a personal AI assistant that runs on your devices and meets you in the channels you already use." The architecture connects "models, tools, messaging channels, and optional companion apps through one Gateway."

- https://github.com/openclaw/openclaw (accessed 2026-08-26)

The site leads with agency, not recall: "The AI that _really_ does things." It "Organizes your inbox, sends emails, manages your calendar, checks you in for flights. All from WhatsApp, Telegram, or any chat app you already use." Channels named on the site: "WhatsApp, Telegram, Discord, Slack, iMessage, Signal, and 24 additional channels" (so ~30 total, above the "20+" often quoted). The README's list adds Google Chat. Skills and plugins are shared through ClawHub. Install is a one-liner (`curl -fsSL https://openclaw.ai/install.sh | bash`) or npm, requiring "Node 22.22.3+, 24.15+, or 25.9+".

- https://openclaw.ai (accessed 2026-08-26)

## Status, timeline, recency

- 2025 (Nov 24): first published under the name Warelay, soon known as Clawdbot. Creator: Peter Steinberger, Austrian developer, previously founder of PSPDFKit. Source: https://en.wikipedia.org/wiki/OpenClaw (dates per Wikipedia, see gaps)
- 2026 (Jan 27): renamed Clawdbot -> Moltbot after Anthropic trademark pressure (Clawd is close to Claude). During the handle swap, snipers took the freed @clawdbot accounts within seconds and scammers launched a fake $CLAWD token on Solana that hit a ~$16M market cap before collapsing. Sources: https://en.wikipedia.org/wiki/OpenClaw, https://www.forbes.com/sites/ronschmelzer/2026/01/30/moltbot-molts-again-and-becomes-openclaw-pushback-and-concerns-grow/
- 2026 (Jan 30): renamed Moltbot -> OpenClaw. Steinberger's stated reason for dropping Moltbot: it "never quite rolled off the tongue." Source: https://en.wikipedia.org/wiki/OpenClaw
- 2026 (Feb 14): "OpenClaw, OpenAI and the future" published on steipete.me. He joins OpenAI, the project moves to the OpenClaw Foundation, OpenAI commits to sponsoring it, and he frames the goal as keeping it "a place for thinkers, hackers and people that want a way to own their data." Source: https://steipete.me/posts/2026/openclaw
- 2026 (Mar 2): ~247,000 stars, 47,700 forks per Wikipedia's snapshot. By this check (2026-08-26) the repo shows ~388k stars, so growth continued after the founder's departure to OpenAI.
- 2026 (Aug): release cadence is dense: 2026.7.1-1 and 2026.7.1-2 on Aug 4, 2026.6.34 on Aug 8, 2026.8.1-beta.2 on Aug 15, 2026.8.1-beta.3 on Aug 24. The latest beta notes name "GPT-5.6 Sol, Terra, Luna, and Ultra reasoning support across OpenClaw and the Codex runtime" and "Compact, verified SQLite backup and fresh-target restore commands." Source: https://github.com/openclaw/openclaw/releases

Recency verdict: very active. ~83,000 commits on main, a release two days before this check, and the largest star count of any tool in this folder by an order of magnitude. The risk to watch is governance, not dormancy: the founder now works at OpenAI and the foundation is young.

## Where memory lives (storage and architecture)

Plain Markdown files in the agent workspace, default `~/.openclaw/workspace`, overridable via `OPENCLAW_WORKSPACE_DIR` or `~/.openclaw/openclaw.json`. The docs state it plainly: "OpenClaw remembers things by writing plain Markdown files in your agent's workspace" and "The model only remembers what gets saved to disk; there is no hidden state."

The workspace file set (per the agent-workspace and memory docs, accessed 2026-08-26):

- `AGENTS.md` - "Operating instructions for the agent and how it should use memory"
- `SOUL.md` - "Persona, tone, and boundaries"
- `IDENTITY.md` - "The agent's name, vibe, and emoji"
- `USER.md` (optional) - "stable preferences, communication style, relationships, and active-project context written as directives"
- `MEMORY.md` (optional) - "curated long-term memory: durable non-profile facts, decisions, and short summaries"
- `memory/YYYY-MM-DD.md` - "Daily memory log (one file per day)": running context and observations
- `DREAMS.md` (optional) - "Dream Diary and dreaming sweep summaries for human review"
- `BOOTSTRAP.md` / `BOOT.md` - one-time first-run ritual and an optional startup checklist
- `skills/` - workspace-local skills

The docs advise: "Treat the workspace as private memory. Put it in a **private** git repo so it is backed up and recoverable." Alongside the files sits a derived SQLite index (the search engine below), plus session state and credentials under `~/.openclaw/`. The Markdown survives uninstall as ordinary files. The index, sessions, and channel logins are runtime state.

- https://docs.openclaw.ai/concepts/agent-workspace (accessed 2026-08-26)
- https://docs.openclaw.ai/concepts/memory (accessed 2026-08-26)

## Retrieval

Hybrid search over the Markdown, embeddings included by default. The agent-facing tool is `memory_search`, which "finds relevant notes using semantic search, even when the wording differs from the original." The engine: "SQLite-based. Works out of the box with keyword search, vector similarity, and hybrid search. No extra dependencies." When an embedding provider is configured, "`memory_search` uses hybrid search: vector similarity (semantic meaning) combined with keyword matching (exact terms like IDs and code symbols)." And the default provider is not local: "OpenClaw uses OpenAI embeddings by default. Set `memory.search.provider` explicitly to use Gemini, Voyage, Mistral, Bedrock, DeepInfra, local GGUF, Ollama, LM Studio, GitHub Copilot, or a generic OpenAI-compatible endpoint."

So the working hypothesis that OpenClaw searches its memory lexically is refuted: the store is plain files, but the default read path embeds them into a SQLite vector index and fuses vector similarity with keyword matching. Local-only embedding is possible (GGUF, Ollama) but is an explicit configuration choice, not the default. Whether a no-provider install degrades to keyword-only search is not stated on the page fetched (see gaps).

Beyond `memory_search`, always-loaded context does part of the retrieval job: `USER.md` and `MEMORY.md` load at session start, and "Today's and yesterday's dated notes load automatically on a bare `/new` or `/reset`."

- https://docs.openclaw.ai/concepts/memory (accessed 2026-08-26)

## Capture

Agent-written, on a spectrum from user-prompted to automatic:

- User-prompted: you tell the agent "Remember that I prefer TypeScript" and it writes the file. The human triggers, the agent authors.
- Automatic pre-compaction flush: before context compaction, "OpenClaw runs a silent turn that reminds the agent to save important context to memory files." This is "on by default" and can be disabled in config.
- Ambient accumulation: the daily `memory/YYYY-MM-DD.md` files collect running context and observations as the agent works, and `DREAMS.md` holds "dreaming sweep summaries for human review", a background consolidation pass in the Letta sleep-time family.

- https://docs.openclaw.ai/concepts/memory (accessed 2026-08-26)

The net position: memory content is chosen and phrased by the agent, with the human able to edit the files afterward (they are plain Markdown). There is no typed schema, no entity resolution, no link graph. The structure is a handful of well-known filenames plus free-form dailies.

## How the AI reads it

The assistant IS the reader. OpenClaw runs as a local gateway process on your machine. Sessions start with `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, and the last two daily notes in context, and the agent calls `memory_search` mid-conversation when it needs older material. There is no separate consumer app or API for the memory: you reach it through whatever channel the gateway bridges (WhatsApp, Telegram, the Control UI, and so on), or by opening the Markdown yourself.

- https://docs.openclaw.ai/concepts/memory (accessed 2026-08-26)

## Pricing and license

Free and open source, MIT, "© OpenClaw Foundation" (repo, accessed 2026-08-26). No hosted tier and no paid product: the site states it runs entirely on your infrastructure, "no subscription required", bring your own Claude or OpenAI credentials. Your real costs are model API usage, including the default OpenAI embedding calls for memory indexing. OpenAI sponsors the project per the Feb 14, 2026 post.

- https://openclaw.ai (accessed 2026-08-26)
- https://steipete.me/posts/2026/openclaw (accessed 2026-08-26)

## Benchmarks

None found. The project publishes no memory benchmark (no LoCoMo or LongMemEval run surfaced in the repo, docs, or blog as of 2026-08-26). Its public numbers are adoption numbers (stars, forks), which measure popularity, not recall quality.

## Security posture (brief, because it is notable)

The project's own docs are unusually direct about the trust model: "This guidance assumes one trusted operator boundary per gateway (single-user, personal-assistant model). OpenClaw is not a hostile multi-tenant security boundary for multiple adversarial users sharing one agent or gateway." DM access defaults to pairing codes, the gateway binds loopback-only with token auth, and a `openclaw security audit` command exists. The docs also treat "prompt-injection chains without policy/auth/sandbox bypass" as no-action findings, which is an honest admission that injection resistance rests on the model, not the harness (they cite 2026 arena numbers: "0.5% success rates for Claude Opus 4.5" vs "8.5% for Gemini 2.5 Pro").

Third-party coverage was rougher: per Wikipedia's sourced summary, Cisco researchers found third-party ClawHub skills performing "data exfiltration and prompt injection without user awareness," a maintainer warned "if you can't understand how to run a command line, this is far too dangerous" for casual users, and China restricted state bodies from running it in March 2026.

- https://docs.openclaw.ai/gateway/security (accessed 2026-08-26)
- https://en.wikipedia.org/wiki/OpenClaw (accessed 2026-08-26)

## vs imprnt

This is the tool imprnt explicitly positions against: the vault's June 2026 positioning note calls imprnt's stance "agency-first (against OpenClaw + PAI)". So precision matters more than dismissal. OpenClaw is not a bad memory tool. It is a different product with a memory subsystem, and on its own product axes it is far ahead.

Where the architectures actually differ:

- Files: both keep memory as plain Markdown on the user's disk, both survive uninstall. Genuine convergence, and worth saying plainly: the biggest agent project of 2026 chose files over a database, same as Letta's pivot. OpenClaw's "no hidden state" line could sit in imprnt's own docs.
- Retrieval: the fork in the road. imprnt is BM25 + grep, pure local arithmetic, zero embeddings, no model in the ranking loop. OpenClaw ships a SQLite hybrid index whose default embedding provider is OpenAI's API, so on a default install every memory write is embedded through a third-party API and semantic recall depends on that provider. Local embedding exists but is opt-in config.
- Capture: imprnt is conscious and human-curated: you say "file this", the LLM writes one typed, tagged, linked note. OpenClaw is agent-authored: dailies accumulate ambiently, a silent pre-compaction turn flushes context automatically, dreaming sweeps consolidate in the background. The pile grows without a curator, which is exactly why it needs semantic search to find anything in it.
- Structure: imprnt has a typed contract (type/kind/tags/summary, entity folders, aliases, wikilinks, `check` invariants). OpenClaw has ~8 known filenames plus free-form daily logs. No entities, no links, no integrity pass. A fact about a person lives wherever the agent happened to write it that day.
- Scope: imprnt is only a vault. OpenClaw is a gateway with shell access, browser control, cron, ~30 channels, and a third-party skills marketplace, which is also why its security surface (and Cisco's findings) has no imprnt equivalent. A grep has no injection surface.
- A small irony worth recording: OpenClaw's memory layout (`MEMORY.md` + `memory/*.md`, always loaded at session start) is structurally the pattern imprnt's own contract bans as "a second always-on store `recall` cannot search." OpenClaw resolves that tension differently: it makes that store THE store and adds a semantic index over it. imprnt makes the searchable vault the only store and keeps the index deterministic.

## When it wins over imprnt

- You want an assistant that acts (email, calendar, browser, shell, cron) and reaches you on WhatsApp or Telegram. imprnt has no channels, no actions, no gateway. This is most people's actual want, which is what ~388k stars are measuring.
- You want zero-curation memory: the agent remembers on its own and you never file anything. imprnt's conscious capture is a deliberate tax OpenClaw does not charge.
- You want semantic recall ("what did we discuss about the flat?" phrased differently every time) out of the box. imprnt's BM25 needs the right keywords and does so by design.
- You want a community and an ecosystem: ClawHub skills, a huge Discord, weekly releases, corporate sponsorship. imprnt is one person's contract.
- You want one assistant identity (SOUL.md, IDENTITY.md) that persists across every channel and device you use.

## Sources

- [OpenClaw GitHub repository](https://github.com/openclaw/openclaw) - accessed 2026-08-26
- [OpenClaw releases page](https://github.com/openclaw/openclaw/releases) - accessed 2026-08-26
- [openclaw.ai](https://openclaw.ai) - accessed 2026-08-26
- [OpenClaw memory docs](https://docs.openclaw.ai/concepts/memory) - accessed 2026-08-26
- [OpenClaw agent workspace docs](https://docs.openclaw.ai/concepts/agent-workspace) - accessed 2026-08-26
- [OpenClaw security docs](https://docs.openclaw.ai/gateway/security) - accessed 2026-08-26
- [OpenClaw, OpenAI and the future (steipete.me, Feb 14 2026)](https://steipete.me/posts/2026/openclaw) - accessed 2026-08-26
- [Wikipedia: OpenClaw](https://en.wikipedia.org/wiki/OpenClaw) - accessed 2026-08-26
- [Forbes: Moltbot Molts Again and Becomes OpenClaw (Jan 30 2026)](https://www.forbes.com/sites/ronschmelzer/2026/01/30/moltbot-molts-again-and-becomes-openclaw-pushback-and-concerns-grow/) - surfaced via search 2026-08-26
- [CNBC: From Clawdbot to Moltbot to OpenClaw (Feb 2 2026)](https://www.cnbc.com/2026/02/02/openclaw-open-source-ai-agent-rise-controversy-clawdbot-moltbot-moltbook.html) - surfaced via search 2026-08-26

## Confidence and gaps

- Rename dates (Warelay Nov 24 2025, -> Moltbot Jan 27 2026, -> OpenClaw Jan 30 2026) and the trademark reason come from Wikipedia and press coverage, not from a primary steipete.me post. His Feb 14 post does not mention the renames, and the original announcement posts were not fetched directly. Dates are consistent across four independent secondary sources (Wikipedia, Forbes, CNBC, dev.to), so confidence is high, but no verbatim primary quote for them is in hand. The brief's "Clawdbot -> Moltbot -> OpenClaw" framing also omits that the very first published name was Warelay per Wikipedia.
- Star count (~388k) is a single read of the repo page on 2026-08-26. The Mar 2 2026 figure (247k) is Wikipedia's. Treat both as approximate.
- Last-commit date was not directly visible. "83,077 commits" plus an Aug 24 release makes activity certain regardless.
- The release list mixes stable and beta lines oddly (2026.6.34 dated Aug 8, after 2026.7.1). Read as parallel maintenance branches, unverified.
- Behavior with NO embedding provider configured: the memory page says the built-in SQLite engine does keyword, vector, and hybrid "out of the box" and that OpenAI embeddings are the default provider, but the fetched content did not explicitly state what a keyless install falls back to. Keyword-only fallback is likely but unverified.
- Whether the SQLite engine is FTS5 + sqlite-vec specifically is not stated in the fetched docs. Recorded only as "SQLite-based."
- The Cisco findings, the maintainer's "far too dangerous" quote, and the China restriction are via Wikipedia's citations, not the primary Cisco report. Directionally solid, phrasing second-hand.
- The MoltMatch incident and the $16M $CLAWD scam figure are from secondary press, recorded for color, not verified primary.
- No memory benchmark exists to compare against imprnt's LoCoMo runs. Absence of evidence, noted as such.

## Camp (proposal input)

Recommendation: a new camp, **Personal-agent runtime**, shared with Hermes Agent. OpenClaw does not fit the existing four without distortion. It fails "Plain files you own" on the read path (default retrieval embeds through OpenAI's API into a SQLite vector index, and capture is agent-authored, not human-curated). It fails "Vector engines" on the store (the canonical data is user-ownable Markdown, the index is derived and disposable). "Agent-state runtime" (Letta) is closest in mechanics (agent self-edits its memory, background consolidation), but Letta is a developer platform for building agents into applications, while OpenClaw is a consumer-shaped personal assistant whose memory is one subsystem among channels, skills, and actions. That product shape, assistant-first with memory as a subsystem, is exactly what imprnt's "agency-first" positioning note is naming, and it deserves its own column entry so the comparison page can say "different product" instead of forcing a memory-tool frame onto it.

Proposed comparison-table row:

- tool: `OpenClaw`
- note: `Personal assistant runtime. Memory is one subsystem of a channel gateway`
- where: `Plain Markdown workspace plus a derived SQLite index`
- retrieval: `Hybrid: vector plus keyword in SQLite, OpenAI embeddings by default`
- capture: `Agent-written: dailies, silent pre-compaction flush, dream sweeps`
- reads: `Local gateway agent, memory_search tool, core files always in context`
