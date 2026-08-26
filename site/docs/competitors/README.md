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
| `logseq.md` | Logseq | Plain files you own | pivoted: DB version is the main product (2.0.1 beta 2026-07-13), file version split off as maintenance-mode "Logseq OG" (re-checked 2026-08-27) |
| `reor.md` | Reor | Vector engines | archived Mar 7 2026, no successor (re-confirmed 2026-08-27) |
| `khoj.md` | Khoj (+ Pipali, Open Paper) | Vector engines | pivoting, hosted service sunset Apr 15 2026, self-host only |
| `mem0.md` | mem0 (+ OpenMemory) | Vector engines | active (OpenMemory being sunset) |
| `mempalace.md` | mempalace | Vector engines | active (star-count inflation alleged) |
| `iai.md` | iai | Vector engines | active |
| `supermemory.md` | Supermemory | Vector engines | active |
| `zep-graphiti.md` | Zep / Graphiti | Graph memory | active (Zep Community Edition deprecated) |
| `cognee.md` | cognee | Graph memory | active |
| `letta-memgpt.md` | Letta / MemGPT | Agent-state runtime + Personal-agent runtime | pivot landed (MemFS), now ships the assistant (re-checked 2026-08-26) |
| `ecc.md` | ECC (everything-claude-code) | Adjacent: harness config pack | active (one maintainer, added by request 2026-07-02) |
| `hermes-agent.md` | Hermes Agent (Nous Research) | Personal-agent runtime | active, hyperactive cadence (checked 2026-08-26) |
| `openclaw.md` | OpenClaw | Personal-agent runtime | active, foundation-stewarded (checked 2026-08-26) |
| `nanobot.md` | nanobot (HKUDS) | Personal-agent runtime | active (checked 2026-08-26) |
| `cowagent.md` | CowAgent (ex-chatgpt-on-wechat) | Personal-agent runtime | active, hyperactive cadence (checked 2026-08-26) |
| `qwenpaw.md` | QwenPaw (Alibaba AgentScope, ex-CoPaw) | Personal-agent runtime | active, hyperactive cadence (checked 2026-08-26) |
| `zeroclaw.md` | ZeroClaw | Personal-agent runtime | active, hyperactive cadence (checked 2026-08-26) |
| `nanoclaw.md` | NanoClaw (NanoCo) | Personal-agent runtime | active, venture-backed (checked 2026-08-26) |
| `ironclaw.md` | IronClaw (NEAR AI) | Personal-agent runtime | active, corporate-stewarded (checked 2026-08-26) |

Watched but not dossiered (from the 2026-08-26 camp sweep): Poke (poke.com,
commercial, closed source, memory architecture undocumented), AIRI (48k stars,
companion/character product, memory is not the pitch), MimiClaw (ESP32 hardware
novelty). Khoj re-checked in the sweep: no personal-agent runtime shipped, its
existing row stands.

Last full refresh: 2026-06-20. ECC added and four dossiers re-checked 2026-07-02.
The Personal-agent runtimes camp added 2026-08-26 (Hermes Agent + OpenClaw, then a
six-project sweep the same day on Alex's go), all applied to the comparison page.
Freshness is now MECHANIZED: `watched.tsv` holds each dossier's claimed numbers and
`freshness.mjs` diffs them against the GitHub API (flags star drift over 25%, releases
newer than the check date, 90-day silence, archived/renamed repos, and big new
entrants), wired into CI as `.github/workflows/freshness.yml` (monthly + on PRs
touching this folder). Report-only, exit 1 on flags, never edits a dossier. Its first
live run flagged 13 real staleness items across the June/July dossiers, so a refresh
session is due. From that list, cognee and iai were re-checked 2026-08-27 (dated
update sections in both dossiers, both camps hold: cognee stays Graph memory at
30.3k stars, iai stays Vector engine at v3.0.8). Prior single-file research: `site/research/competitors-2026-06.md`
(2026-06-18), now superseded by this folder.
