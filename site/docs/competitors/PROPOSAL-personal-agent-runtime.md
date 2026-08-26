# Proposal: the Personal-agent runtime camp (Hermes Agent + OpenClaw)

Status: PROPOSAL, 2026-08-26. Nothing here is published. The dossiers
(`hermes-agent.md`, `openclaw.md`) are the evidence base. This file carries the
camp ruling and the exact rows and entries for `comparison.mdx`,
`CompareTable.astro`, and `FieldVerdicts.astro`, ready to apply after review.
Delete this file once applied or rejected.

## The camp ruling

Add a fifth camp, **Personal-agent runtimes**, holding Hermes Agent and OpenClaw.
Both dossiers reached this independently and the argument survives contact with
the alternatives:

- "Plain files you own" breaks on the read path. OpenClaw's default install
  embeds every memory write through OpenAI's API into a SQLite hybrid index.
  Hermes stores its searched corpus (session history) in SQLite, and its two
  plain-Markdown memory files are never searched at all, they are injected whole.
  In both, capture is agent-authored, not human-curated.
- "Vector engines" breaks on the store. Both keep canonical memory as
  user-ownable Markdown that survives uninstall. Hermes has no vector machinery
  documented anywhere.
- "Agent-state runtime" (Letta) is closest in mechanics but wrong in product
  shape. Letta sells memory as a platform developers build on (API, SDKs,
  managed state). Hermes and OpenClaw sell the assistant itself, reachable from
  WhatsApp or Telegram, with memory as one built-in subsystem and no memory API
  for other applications. The reader choosing between imprnt and Letta picks a
  memory backend. The reader choosing between imprnt and these two picks whether
  memory lives inside one resident agent or in files any agent reads. Different
  question, different camp.

The camp also matches the market: these are the two biggest repos in the entire
field (~388k and ~237k stars), they share a lineage (`hermes claw migrate`
imports OpenClaw memories wholesale), and imprnt's own positioning note has
named this class since June 2026 ("agency-first, against OpenClaw + PAI").

## CompareTable.astro: two rows to append to ROWS

```js
{
  tool: "Hermes Agent",
  note: "personal agent, memory is a built-in feature",
  where: "Two capped Markdown files (~3.5KB total) plus SQLite session history",
  retrieval: "FTS5 full-text over raw session messages, no vectors documented",
  capture: "Agent self-curates on periodic nudges, approval gate off by default",
  reads: "Capped files injected whole at session start, session_search for history",
},
{
  tool: "OpenClaw",
  note: "personal assistant runtime, foundation-stewarded",
  where: "Plain Markdown workspace plus a derived SQLite index",
  retrieval: "Hybrid vector plus keyword in SQLite, OpenAI embeddings by default",
  capture: "Agent-written: dailies, silent pre-compaction flush, dream sweeps",
  reads: "Local gateway agent, memory_search tool, core files always in context",
},
```

## FieldVerdicts.astro: one new camp group

```js
{
  name: "Personal-agent runtimes",
  blurb:
    "The assistant is the product and memory is one subsystem: agent-authored files plus a search index, reached through chat channels. The field's two biggest repos.",
  tools: [
    {
      tool: "Hermes Agent",
      note: "236k stars in six months",
      what: "Nous Research's self-hosted personal agent. Durable memory is two hard-capped files (~3.5KB total) injected whole each session, and cross-session recall is FTS5 full-text search over raw SQLite session history.",
      split:
        "Same lexical-retrieval bet, opposite curation bet. The agent curates its own memory under a hard cap, and a fact that misses the cut survives only as transcript. imprnt keeps an unbounded human-curated vault where the notes themselves are what gets searched.",
      wins: "One always-on assistant across 21 chat channels, with cron, agent-authored skills, and memory that costs you zero effort.",
    },
    {
      tool: "OpenClaw",
      note: "foundation-stewarded since Feb 2026",
      what: "The 2026 wave's flagship personal assistant (~388k stars): a local gateway to ~30 chat channels whose memory is agent-written Markdown indexed into SQLite hybrid search.",
      split:
        "The store is plain files, the read path is not. A default install embeds every memory write through OpenAI's API, and recall is vector plus keyword. Capture is ambient (dailies, pre-compaction flushes, dream sweeps), producing the pile a semantic index exists to cope with.",
      wins: "An assistant that acts - email, browser, shell, cron - and answers on WhatsApp, with a skills marketplace behind it.",
    },
  ],
},
```

## comparison.mdx: prose that needs a touch (proposed, not applied)

1. The page's framing ("Most AI-memory tools store what they learn as a vector
   index... The other camp keeps memory as notes") now has a third shape worth
   one sentence: the personal-agent runtimes keep notes AND derive an index,
   with the agent as author. Suggested placement: after the SplitPanels intro.
2. Hermes deserves a line in the retrieval discussion: after Letta, it is the
   second big-name convergence on lexical search (FTS5, nothing vector-shaped
   documented), from a 236k-star project. The convergence claim gets stronger.
3. TrackRecord candidate: OpenClaw's founder joined OpenAI on Feb 14, 2026 and
   the project moved to a foundation ("OpenClaw will move to a foundation and
   stay open and independent"). A direction change in the ledger's sense, with
   the plain-files test giving its usual answer: the Markdown workspace
   survives, the SQLite index and channel logins are runtime state.
4. WrongTool routing: "you want an assistant that acts and reaches you on
   WhatsApp" should route to OpenClaw or Hermes by name.

## The honest read, confirmed and corrected (vs the task brief)

- CONFIRMED for Hermes: lexical retrieval with no vectors (with one honesty
  note: "explicitly no embeddings" has no quotable sentence, it is inferred
  from FTS5 being the only documented mechanism). Durable curated knowledge is
  ~1,300 tokens of capped files, searched never, injected whole. What IS
  searched is the raw transcript, not curated notes. Memory is agent-authored
  by design. They beat imprnt on every product axis.
- REFUTED for OpenClaw on retrieval: not lexical. Hybrid vector-plus-keyword
  SQLite search with OpenAI embeddings as the documented default. The
  files-you-own half holds, the read path does not.
- Detail corrections: Hermes has seven terminal backends (Vercel Sandbox added,
  docs lag the README), 21 named channels. OpenClaw claims ~30 channels, and
  its first published name was Warelay (Nov 24, 2025) before Clawdbot. Hermes'
  "released Feb 2026" has no primary source: repo created 2025-07-22, first
  GitHub release 2026-03-12.
