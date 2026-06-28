# Letta / MemGPT

**One-line:** A platform for stateful AI agents with self-improving memory, born from the MemGPT research project at UC Berkeley, now pivoting its flagship from a server-side memory database to "Letta Code," a model-agnostic terminal agent harness whose memory lives in git-backed filesystem "context repositories."

**Status (checked 2026-06-20):** pivoting - the company announced a decisive shift away from server-side memory tools toward client-side filesystem memory. From the official "Letta's next phase" post (MAR 16, 2026): "Legacy server memory tools like core_memory_replace will be removed in favor of straightforward filesystem operations" and "Memory moves from specialized memory tools that edit memory in a database to generalized computer use tools like bash that operate over memory projected into git-backed files." Source: https://www.letta.com/blog/our-next-phase

**Latest release:** v0.16.8, May 14, 2026 | **Stars:** ~23.4k | **License:** Apache-2.0 | **Hosting:** both (self-host + Letta Cloud)

> Note on the release date: GitHub's releases UI showed "14 May" with no year, under a "© 2026 GitHub" footer. GitHub omits the year only for the current year, so "14 May" resolves to 2026. This is corroborated by v0.16.7 being dated March 31, 2026 (see timeline below). The auto-summarizer initially guessed 2025 from the relative date, which is incorrect.

## What it is

Letta is the commercial and open-source successor to MemGPT, a research system that treated the LLM context window like an operating system's memory hierarchy. The repository describes itself plainly:

> "Platform for stateful agents: AI with advanced memory that can learn and self-improve over time."

- https://github.com/letta-ai/letta (accessed 2026-06-20)

The README now leads with two products: Letta Code ("run agents locally in your terminal") and the Letta API ("build agents into your applications"). The README states Letta is "fully model-agnostic, though we recommend Opus 4.5 and GPT-5.2 for best performance" and that it is "an open source project built by over a hundred contributors from around the world."

- https://raw.githubusercontent.com/letta-ai/letta/main/README.md (accessed 2026-06-20)

The original research framing comes from the MemGPT paper, "MemGPT: Towards LLMs as Operating Systems" (Charles Packer, Sarah Wooders, Kevin Lin, Vivian Fang, Shishir G. Patil, Ion Stoica, Joseph E. Gonzalez, UC Berkeley, arXiv:2310.08560, 2023), which proposed "virtual context management, a technique drawing inspiration from hierarchical memory systems in traditional operating systems."

- https://arxiv.org/abs/2310.08560 (accessed 2026-06-20)

## Status, timeline, recency

- 2023 (Oct): MemGPT paper published, arXiv:2310.08560, "MemGPT: Towards LLMs as Operating Systems." Authors are the UC Berkeley team that later founded Letta. Source: https://arxiv.org/abs/2310.08560
- 2024 (Sept 24-26): Letta emerges from stealth with a $10M seed round led by Felicis, with Sunflower Capital and Essence VC. Angels include Jeff Dean, Clem Delangue, Cristobal Valenzuela, Jordan Tigani, Tristan Handy, Robert Nishihara, Barry McCardel. Source: https://www.prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html
- 2025 (Aug 12): Letta publishes its LoCoMo benchmark post, reporting a filesystem memory approach scoring 74.0% and beating its own tool-based memory and mem0's graph variant. Source: https://www.letta.com/blog/benchmarking-ai-agent-memory/
- 2026 (Feb 12): "Introducing Context Repositories: Git-based Memory for Coding Agents" published on the research blog. Describes "a rebuild of how memory works in Letta Code based on programmatic context management and git-based versioning." Source: https://www.letta.com/blog/context-repositories/
- 2026 (Mar 16): "Letta's next phase" published, formalizing the pivot to Letta Code and announcing the removal of legacy server-side memory tools. Source: https://www.letta.com/blog/our-next-phase
- 2026 (Mar 31): v0.16.7 released. Per a search-surfaced changelog summary, it raised the default global context window from 32k to 128k, fixed a context-window reset bug (LET-7991), and overhauled compaction. Release notes also state: "Block limits are no longer enforced -- block limit validation has been deprecated and removed" and "Git-backed memory frontmatter no longer emits `limit`." Source: https://github.com/letta-ai/letta/releases
- 2026 (May 14): v0.16.8 released, the latest. Notes are minimal: "fix: workflows update" and "fix(security): use JSON instead of pickle for sandbox->server tool result transport." Source: https://github.com/letta-ai/letta/releases/tag/0.16.8

Recency verdict: active and actively developed. Latest release is ~5 weeks before the access date (May 14, 2026), with a steady monthly-ish release cadence (0.16.4 Jan, 0.16.5 Feb, 0.16.6 Mar, 0.16.7 Mar 31, 0.16.8 May 14). Not dormant. Star count ~23.4k. The notable movement is strategic, not stagnation: the project is mid-pivot.

## Where memory lives (storage and architecture)

Two architectures coexist during the pivot. The legacy/server architecture and the new Letta Code filesystem architecture.

Legacy server architecture (the classic MemGPT three-tier model, still present in the API/server):
- Core memory: always in-context, editable blocks compiled into the system prompt. Acts like RAM, always visible without a retrieval call.
- Recall memory: searchable conversation history.
- Archival memory: an external vector store queried explicitly via tool calls.

Storage backend for the legacy model is Postgres with the pgvector extension. Per AWS's own writeup of Letta's stack, embeddings for archival and source data are stored in Postgres tables (for example `archival_passages` and `source_passages`) using pgvector for semantic search.

- https://aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql/ (accessed 2026-06-20)
- https://docs.letta.com/guides/ade/core-memory/ (accessed 2026-06-20)

New Letta Code architecture (MemFS / context repositories). The docs describe memory as a git-backed directory of markdown files on the local filesystem:

> "MemFS is available in Letta Code version 0.15 and later" and "All new agents have MemFS enabled by default."

> "Files in the `system/` directory are always loaded in full into the agent's system prompt. Files outside `system/` are visible to the agent via the memory tree (filenames and descriptions), but their contents are not automatically loaded."

Storage locations per the docs:
- Letta API agents: `~/.letta/agents/<your-agent-id>/memory`
- Local-mode agents: `~/.letta/lc-local-backend/memfs/<agent-id>/memory`

- https://docs.letta.com/letta-code/memory (accessed 2026-06-20)

The context-repositories post frames the change as the move away from a database:

> "Context Repositories are git-backed, so every change to memory is automatically versioned with informative commit messages."

> "Letta Code agents clone their memory repository to the local filesystem, giving the agent a local copy of its memory that stays in sync."

> Prior memory systems "limited agents to MemGPT-style memory tools or virtual filesystem operations," whereas the new approach enables full terminal and coding capabilities for context management.

- https://www.letta.com/blog/context-repositories/ (accessed 2026-06-20)

## Retrieval

Legacy model: retrieval is LLM-driven semantic/vector search. Core memory blocks are always compiled into the prompt (no retrieval call needed). Recall memory (conversation history) and archival memory are searched on demand via explicit tool calls (`conversation_search`, `archival_memory_search`) backed by pgvector embeddings. The model is in the read loop: it decides when to search, generates the query, and reads the results.

- https://docs.letta.com/guides/ade/core-memory/ (accessed 2026-06-20)
- https://aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql/ (accessed 2026-06-20)

New model (Letta Code): retrieval is the agent using bash and filesystem tools (grep, cat, scripts) over its markdown memory tree, plus the always-loaded `system/` files. The benchmark post argues this beats specialized vector tools because agents are better at filesystem operations they have seen in training. Either way the LLM is in the read loop, but the new path drops the per-query vector DB in favor of plain file operations.

- https://www.letta.com/blog/benchmarking-ai-agent-memory/ (accessed 2026-06-20)
- https://docs.letta.com/letta-code/memory (accessed 2026-06-20)

## Capture

The agent self-edits its own memory mid-loop. In the new model it does this with bash tools and commits the result:

> The agent "edits these files directly using its bash tools, then commits to save changes." For cloud deployments, "Letta API agents also push commits to sync back to Letta Cloud, giving you a full version history."

- https://docs.letta.com/letta-code/memory (accessed 2026-06-20)

There is also background consolidation, "sleep-time" (dream) compute. From the context-repositories post:

> The "Memory reflection" skill includes "a background 'sleep-time' process that periodically reviews recent conversation history and persists important information."

The docs describe "periodic sleep-time (dream) subagents" triggered by step count or context-window compaction, working in a git worktree to avoid conflicts.

- https://www.letta.com/blog/context-repositories/ (accessed 2026-06-20)
- https://docs.letta.com/letta-code/memory (accessed 2026-06-20)

Capture is automatic and continuous (agent self-writes plus background sleep-time), which is the opposite of imprnt's conscious, on-demand capture.

## How the AI reads it

In the legacy server model, an application or the ADE talks to a running Letta server over REST, with Python and TypeScript SDKs (`pip install letta-client`, `npm install @letta-ai/letta-client`). Core blocks are always compiled into the prompt, and the agent calls search tools to pull from recall/archival.

In the new Letta Code model, the agent runs in your terminal and reads its memory as files via bash, with `system/` files always loaded and the rest exposed as a browsable tree. From the README: Letta Code lets you "launch an agent with memory running on your local computer" and supports "skills" and "subagents."

- https://raw.githubusercontent.com/letta-ai/letta/main/README.md (accessed 2026-06-20)
- https://docs.letta.com/letta-code/memory (accessed 2026-06-20)

## Pricing and license

Code license: Apache-2.0 (per the GitHub repo, accessed 2026-06-20).

Letta Code / Cloud pricing (from the docs pricing page, accessed 2026-06-20, https://docs.letta.com/letta-code/pricing):

- Free: "$0 /month" - limited agents, limited Letta Auto usage, bring your own API keys (BYOK). Free accounts "support up to three agents with managed state."
- Pro: "$20 /month" - "Letta Auto weekly + monthly quota," pay-as-you-go overage, up to 20 stateful agents.
- Enterprise / Team: no public price, "contact us" for managed per-seat pricing.

All tiers support BYOK. The LLM gateway offers "passthrough (non-markup) API pricing" with optional pay-as-you-go credits. The page distinguishes Personal Plans from a separate API Plan (whose detailed pricing was referenced but not shown on this page, so the API-plan numbers are unverified).

Note: https://www.letta.com/pricing 301-redirects to https://docs.letta.com/letta-code/pricing, which is itself evidence of the Letta Code repositioning.

## Benchmarks (vendor self-reported)

From "Benchmarking AI Agent Memory" (Aug 12, 2025, https://www.letta.com/blog/benchmarking-ai-agent-memory/), accessed 2026-06-20:

- Letta's filesystem approach scored "74.0% accuracy on LoCoMo by simply storing conversation histories in files," using GPT-4o mini.
- mem0's reported figure was 68.5% (described as their "top-performing graph variant"). Letta's filesystem result exceeded it by 5.5 points.
- The headline finding for imprnt: a plain filesystem beat their own specialized memory tools. Verbatim: "Agents today are highly effective at using tools, especially those likely to have been in their training data (such as filesystem operations). As a result, specialized memory tools...are less effective than simply allowing the agent to autonomously search through data with iterative querying."

This is a vendor self-report on a single benchmark (LoCoMo), so treat the absolute numbers with the usual caution. The directional finding (files over bespoke memory tools) is what is load-bearing here, and the vendor publishing it against their own prior product makes it more credible, not less.

## vs imprnt

The convergence is the headline. Letta, an embeddings-and-Postgres memory company, publicly concluded that a plain filesystem of files beats its own vector-tool memory, and is rebuilding its flagship around git-backed markdown files an agent reads with bash. That is imprnt's core thesis, validated by a well-funded competitor against its own prior product.

Where they still differ:
- Retrieval: imprnt is deterministic BM25 + grep with no model in the ranking loop, and the LLM only shapes the query and reads top-N. Letta keeps the LLM in the read loop both in the legacy vector model and in the new bash-over-files model (the agent decides when/what to search and reads results). Letta has no deterministic ranker as the core. imprnt's discipline is rationing the LLM out of the hot path.
- Embeddings: imprnt has zero embeddings, zero vectors, by design. Letta's legacy path requires Postgres + pgvector. The new Letta Code path drops the vector DB for files, but Letta the platform still ships the vector stack.
- Capture: imprnt is conscious, on-demand ("harvest this"). Letta is automatic and continuous, the agent self-edits memory mid-loop plus background sleep-time consolidation. Different philosophy: Letta optimizes for an autonomous agent that never forgets. imprnt optimizes for a human-curated knowledge vault.
- Server: imprnt is a no-server, plain-files vault you grep directly. Letta the legacy product needs a running server (REST + SDKs + ADE). Letta Code moves to the terminal, closer to imprnt, but still tied to the Letta runtime, Letta Auto, and (for sync/history) Letta Cloud.
- Durability / lock-in: imprnt files outlive the tool. Letta Code's context repositories are git-backed markdown, so they survive too, but cloud sync, sleep-time, skills, and the Letta Auto gateway are runtime features that vanish if you stop running Letta. The data is portable. The behavior is not.
- Typed contract: imprnt has a typed entity schema (people/orgs/holdings with aliases, frontmatter contract). Letta's memory is freeform markdown files in a tree with an always-loaded `system/` directory, no typed-entity resolution layer.

## When it wins over imprnt

- You want an autonomous coding agent that maintains and improves its own memory with no human curation. Letta Code's whole pitch is self-improving memory plus sleep-time consolidation. imprnt deliberately keeps capture conscious.
- You are building agents into an application and need a hosted, multi-agent, API-driven memory backend with SDKs, an inspector UI (ADE), and managed state. imprnt is a personal vault, not an agent backend.
- You want git-versioned memory with automatic commits and informative messages produced by the agent itself, plus cloud sync and full version history. imprnt leaves versioning to your own git usage.
- You want vector/semantic recall over large conversation histories out of the box (legacy path). imprnt intentionally has no embeddings.
- You want the agent to actively search and reason over memory each turn rather than a cheap deterministic ranker. That is Letta's model by design.

## Sources

- [Letta GitHub repository](https://github.com/letta-ai/letta) - accessed 2026-06-20
- [Letta README (raw, main branch)](https://raw.githubusercontent.com/letta-ai/letta/main/README.md) - accessed 2026-06-20
- [Letta releases page](https://github.com/letta-ai/letta/releases) - accessed 2026-06-20
- [Letta v0.16.8 release tag](https://github.com/letta-ai/letta/releases/tag/0.16.8) - accessed 2026-06-20
- [Letta's next phase (pivot announcement, Mar 16 2026)](https://www.letta.com/blog/our-next-phase) - accessed 2026-06-20
- [Introducing Context Repositories (Feb 12 2026)](https://www.letta.com/blog/context-repositories/) - accessed 2026-06-20
- [Letta Code memory docs](https://docs.letta.com/letta-code/memory) - accessed 2026-06-20
- [Letta Code pricing docs](https://docs.letta.com/letta-code/pricing) - accessed 2026-06-20
- [Benchmarking AI Agent Memory (LoCoMo, Aug 12 2025)](https://www.letta.com/blog/benchmarking-ai-agent-memory/) - accessed 2026-06-20
- [Core memory guide (ADE)](https://docs.letta.com/guides/ade/core-memory/) - accessed 2026-06-20
- [How Letta builds production-ready AI agents with Amazon Aurora PostgreSQL (AWS)](https://aws.amazon.com/blogs/database/how-letta-builds-production-ready-ai-agents-with-amazon-aurora-postgresql/) - accessed 2026-06-20
- [MemGPT: Towards LLMs as Operating Systems (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560) - accessed 2026-06-20
- [Berkeley AI spinout Letta raises $10M seed (PRNewswire)](https://www.prnewswire.com/news-releases/berkeley-ai-research-lab-spinout-letta-raises-10m-seed-financing-led-by-felicis-to-build-ai-with-memory-302257004.html) - accessed 2026-06-20

## Confidence and gaps

- Release date year (May 14, 2026): high confidence but inferred. GitHub showed "14 May" with no year under a "© 2026" footer. GitHub omits the current year, and v0.16.7 is independently dated March 31, 2026, so 2026 is consistent. The auto-summarizer's "2025" reading is a known relative-date artifact and is wrong.
- Star count (~23.4k): from the repo summary, single read, not cross-checked against a second source. Treat as approximate.
- Last commit date: not visible in the fetched content. Unverified. Given a May 14, 2026 release ~5 weeks before access, the project is clearly active regardless.
- Pricing: the Personal Plan tiers (Free $0, Pro $20/mo) are from the docs pricing page. The separate "API Plan" detailed pricing is referenced on that page but not shown, so API-plan numbers are unverified. Enterprise/Team is "contact us," no public price.
- Deprecation timeline specifics ("templates and filesystem deprecated by mid-April 2026"): summarized from the "next phase" post by the fetch model. The broad direction (legacy server memory tools removed in favor of filesystem ops) is directly quoted and solid, but the exact per-feature dates are lower confidence and were not independently re-quoted.
- v0.16.7 changelog details (32k -> 128k default context, LET-7991): came via a search-result summary of the GitHub releases page rather than a direct quote of the release body. The deprecation quotes ("Block limits are no longer enforced", "Git-backed memory frontmatter no longer emits `limit`") are from the fetched release content.
- LoCoMo numbers are vendor self-reported on one benchmark. Directionally credible (published against their own product) but not independently reproduced here.
