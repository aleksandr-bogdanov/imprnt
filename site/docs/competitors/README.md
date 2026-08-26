# Competitor dossiers (source of truth)

The definitive, sourced record of every tool the comparison page measures imprnt
against. One file per competitor. This folder lives inside `docs/` for proximity
but is excluded from the published site (see the glob in
`src/content.config.ts`), so it is internal reference, never a public route.

The comparison page (`docs/comparison.mdx`) and its components
(`CompareTable.astro`, `FieldVerdicts.astro`) are downstream of this folder.
When a fact here changes, update the page to match.

## The rule for this folder

Every material claim carries a verbatim quote and a link to the primary source,
with the date it was checked. No claim from memory. No claim without a source.
A status line at the top of each file states whether the tool is active,
archived, sunset, or pivoting, with proof. This exists because a competitor was
sunset and we heard it from a friend, not from our own notes. That does not
happen again.

## Method

- Primary sources only: the project's own repo (README, releases, last commit),
  official docs, pricing page, and official blog or changelog.
- Recency is a fact: each file records the latest release and date, plus stars,
  so a stale or dormant project is visible at a glance.
- Benchmarks are vendor self-reported under each vendor's own harness. They are
  recorded as "the project claims X", never as a settled leaderboard.

## The field

| File | Tool | Camp | Status (last checked) |
|------|------|------|------------------------|
| `karpathy-llm-wiki.md` | Karpathy's LLM Wiki | Plain files you own | active (as a pattern, virally adopted) |
| `basic-memory.md` | Basic Memory | Plain files you own | active |
| `obsidian.md` | Obsidian | Plain files you own | active |
| `logseq.md` | Logseq | Plain files you own | pivoting (and partly stalled) toward SQLite DB version |
| `reor.md` | Reor | Vector engines | archived Mar 7 2026, no successor |
| `khoj.md` | Khoj (+ Pipali, Open Paper) | Vector engines | pivoting, hosted service sunset Apr 15 2026, self-host only |
| `mem0.md` | mem0 (+ OpenMemory) | Vector engines | active (OpenMemory being sunset) |
| `mempalace.md` | mempalace | Vector engines | active (star-count inflation alleged) |
| `iai.md` | iai | Vector engines | active |
| `supermemory.md` | Supermemory | Vector engines | active |
| `zep-graphiti.md` | Zep / Graphiti | Graph memory | active (Zep Community Edition deprecated) |
| `cognee.md` | cognee | Graph memory | active |
| `letta-memgpt.md` | Letta / MemGPT | Agent-state runtime | pivoting (to git-backed filesystem memory) |
| `ecc.md` | ECC (everything-claude-code) | Adjacent: harness config pack | active (one maintainer, added by request 2026-07-02) |
| `hermes-agent.md` | Hermes Agent (Nous Research) | Personal-agent runtime (proposed, see PROPOSAL file) | active, hyperactive cadence (checked 2026-08-26) |
| `openclaw.md` | OpenClaw | Personal-agent runtime (proposed, see PROPOSAL file) | active, foundation-stewarded (checked 2026-08-26) |

Last full refresh: 2026-06-20. ECC added and four dossiers (zep-graphiti, mempalace,
iai, cognee) re-checked 2026-07-02. Hermes Agent and OpenClaw added 2026-08-26 with a
proposed new camp, pending review: `PROPOSAL-personal-agent-runtime.md`. Prior
single-file research: `site/research/competitors-2026-06.md` (2026-06-18), now
superseded by this folder.
