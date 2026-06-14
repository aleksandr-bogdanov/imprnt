# Architecture lessons, generalized (the knowful read)

> A synthesis of the full knowful/imprnt build history - the two raw session transcripts (~5,600
> lines) plus the curated session notes 3-7, the field survey, and the PAI and knowful explainers -
> read by a subagent fan-out and distilled here into the durable, transferable lessons. The goal is
> not to re-tell the build. It is to state the principles in a form that survives the next schema
> change, and to fold in the module/capability evolution and the session-host auth finding so they
> sit inside one coherent model. This is the reasoning behind the plugin contract in
> `plugins/README.md`.

## 0. The two cornerstones (everything else is downstream)

1. **Don't treat AI as magic, don't treat the user as an idiot.** The user is competent and wants to
   be amplified, not babysat. This is the source of every "no daemon, no auto-inject, explicit
   command" rule in the system. A tool that works without you ever thinking about it is a tool you
   cannot audit, cannot stop, and do not own. The whole product is the negation of that.
2. **Ration the LLM by WHERE it runs, not by how much it runs.** Deterministic-first never meant
   "minimize the model." It meant: spend the model on the once-per-item WRITE path (understanding
   unstructured input is irreducibly semantic), and keep it out of the thousands-of-times READ path
   (ranking is local arithmetic). The axis is deterministic-vs-LLM crossed with frequency, never
   LLM-vs-no-LLM.

Both were learned the hard way, and the failure to state them up front cost the most.

## 1. Invariants must be falsifiable tests, not values

The single most expensive lesson. Roughly half the build's wasted spend traced to *wrong criteria*,
not wrong execution. The mechanism:

- A principle written as a value ("deterministic-first", "private", "ration the LLM") gets misread,
  because a value cannot be checked against reality. An invariant written as a test ("on the real
  corpus, recall tops the right note") would have caught the BM25 failure on day one.
- PAI shipped 17 aspirational principles. They rotted into recitation because nothing was load-bearing
  on them. The rule that replaces that: **an invariant earns its place only by pointing at a specific
  time it would have saved you.** Scar tissue, not aspiration. No speculative "it belongs."
- There are two classes of invariant, and conflating them is itself a trap: (a) principles you *can*
  state up front if you do the work to extract the user's real intent ("use the LLM only for work a
  traditional algorithm or ML genuinely cannot do"), and (b) scar tissue you can only earn by failing.
  The first class is recoverable up front; skipping it is what made the second class so expensive.

A concrete corollary that bit twice: a wrong invariant doesn't just degrade output, it can make an
automated red-team / self-check loop **never converge** - it burns tokens forever chasing a target the
constraint made impossible (the fail-closed regex PII detector that no regex could ever satisfy). When
a loop won't converge, suspect the constraint before the system.

## 2. The deterministic-first line, stated precisely

"The dumbest thing that works" is measured **against the LLM**. The error that cost a multi-session
detour was treating grep as the dumb baseline. The real baseline is *any deterministic local
computation*, and BM25 (term-frequency x inverse-document-frequency, field-boosted) is exactly that -
1990s arithmetic, zero model, zero deps. It had been wrongly *deferred behind* grep as if it were the
heavy option. Against the LLM, it is the cheap option.

- **WRITE path (once per item):** the model earns its keep - read prose, choose the type, write the
  one-line summary, extract decisions with judgment, assign tags + kind, propose aliases, wire links.
  "Not sure -> hand it to the LLM" is a first-class allowed move *here*. That is conscious use.
  Unconscious use is dumping everything at the model and expecting magic; that is the thing to kill.
- **READ path (thousands of runs):** grep + BM25, no model in the middle. The model only shapes the
  query into keywords at the front and reads the top ~15 hits at the back. It is never the ranker.
- **The honest cost model:** there is no token-free tool call - anything the model *reads* costs
  tokens regardless of transport. The only real levers are payload size (do the heavy scan in code,
  hand the model a tight result) and caching (a local mirror avoids the re-fetch). This is why MCP is
  banned *in the middle* (per-query round-trips, a running server, no cache) but fine at the *sync
  edge* (a batched client-server call that caches locally).

Anti-pattern recorded: hierarchical tag taxonomies are *manual idf*. People build tag trees when they
lack a ranker; once you have real idf, the taxonomy is redundant write-tax and read-drift. A tag earns
its place only for a concept that is not reliably a literal word in the notes.

## 3. The module/plugin contract - and why it is the product

PAI's core bloated because the dependency arrows pointed **core -> module**: core imported, branched
on, validated, and loaded each subsystem, so every new capability grew the core. Kill that direction
and core cannot bloat. That is the whole contract, compressed:

- **The core never knows a plugin exists.** Litmus: add or remove any plugin with zero edits to
  `packages/imprnt/`. A plugin depends on exactly two things - the `vault/` note *format* and its own
  sibling folder.
- **The entry point is the agent, not the code.** Something must know a plugin is installed - but it
  is the *agent* (the integrator: "you talk, the assistant runs the tools"), never the core code. So
  each plugin ships `plugins/<name>/agent.md`, a context fragment the user wires into the agent's
  prompt. Core stays 100% blind.
- **Two surfaces, guarded differently.** The *vault* is single-writer (plugins never mutate a note;
  they propose into `plugins/<name>/proposed/` for `ingest --apply`). The *agent context* is where
  always-on fragments wire in - and *you* guard that one by choosing what to wire, the litmus does not.
- **Runtime dependence, not just imports.** The sharpening that mattered: the litmus must catch
  coupling with no import edge. Three vectors, each with its rule: frontmatter-key collision ->
  slug-namespace every key (`whenful.synced`) and read only your own; sibling-dir reads ->
  single-writer-per-path, no cross-plugin reads; ingest-as-merge-point -> a typed idempotent patch so
  ingest stays plugin-agnostic.
- **Copy, don't share - decided on reversibility, not purity.** Copying a 12-line reader and later
  wishing you'd shared is a 5-minute refactor that breaks nobody. Sharing and later wishing you
  hadn't is a breaking change, and the shared lib becomes the magnet where "can it also do X?" lands
  and core grows. The contract guarantees the note *format*, never importable code.
- **The only core<->plugin contact is two convention-based aggregators**, both read-only: `check --all`
  globs `plugins/*/check.js`, runs each, reads exit code only, forwards stdout verbatim; `ingest
  --apply` files staged notes from `plugins/*/proposed/`. Neither imports a plugin or names one. The
  principled fence: **core may provide read-only aggregation, never write/orchestration.**

The deeper framing: opt-in composability *beats* subtractive bundling. The field survey's gap was that
even the best file-native memory tools ship as unsubtractable bundles (23 skills installed by default,
auto-symlinked into ~10 agents). imprnt's answer is that every plugin is a dir you `rm -rf`. **PAI
imposes; imprnt composes.**

## 4. The capability evolution (tonight) - relaxing "share nothing" without re-bloating

"Share nothing" was load-bearing, and a capability is, on its face, exactly the cross-plugin coupling
it banned. The reconciliation:

- A **capability** is something one module *provides* and another *consumes*. The session-host (a warm
  browser holding the user's logged-in sessions, brokering a fresh auth token over a localhost socket)
  is the first provider; the kleinanzeigen watcher is the first consumer.
- The rule that carries the weight the old "no cross-plugin reads" rule did: **removing a provider
  degrades a consumer gracefully, never breaks it.** Made concrete: a consumer copies a tiny client
  (`sessionToken(site) -> string | null`) and treats `null` as "host down, fall back," never a hard
  failure. The provider is a declared *edge*, not a hard import - so it stays inside the reversibility
  argument (removing it cannot break a consumer's build).
- This is a **third contact surface**, distinct from the vault and the agent context: a localhost
  broker between modules. It is sync-edge-shaped (the same place MCP-style calls were ruled
  acceptable: a real client-server boundary, batched, cached, with fallback), and it obeys the same
  fences - deterministic only (no LLM drives it), read-only/answer-on-request (it never acts on its
  own, never auto-injects), auditable (token fingerprints in a log, never the token).
- The litmus survives **if and only if** adding or removing a capability provider still needs zero
  core edits. It does: discovery is by the localhost broker + a copied client, never a core-managed
  registry. A capability *registry in core* would be the exact magnet that re-bloats core - so there
  isn't one.

### The auth finding that shaped the session-host design

A cold, fully-automated login trips bot protection (Akamai and similar fingerprint the automation).
The fix is not a better evasion - it is to stop pretending: a clean, non-automation-flagged browser
the user logs into **by hand once**, then a read-only attach to that warm, already-authenticated
session. Never copy a profile (that is what looks like theft to the fingerprinter and is its own
credential-handling risk). The human does the one irreducible step (the password); the machine only
reads the token the site is already refreshing. This is the same "explicit beats automatic" cornerstone
applied to auth, and it is why the session-host is user-started, localhost-bound, and never resident.

## 5. Fidelity - the data IS the knowledge

The most instructive bug. The migration kept every note's prose and identity (the entire TELOS spine
survived) and silently dropped the *data* - a 40-row beer-tasting table, dose protocols, account and
cadastral numbers, verbatim insurance clauses. A note's own summary even confessed "the live table
lives in the source snapshot." Because `recall` searches `vault/` only, anything left in `raw/` is
invisible - for a knowledge base, the same as deleted. A Sozialversicherungsnummer existed nowhere in
the vault.

- **Root cause:** three reasonable instructions combined into one wrong inference - "write atomic,
  clean, summarized notes" + "anti-slop: prefer paragraphs over bullet-floods" + "raw/ is the
  immutable source you can always go back to" -> "summarize the table, point at raw." Each is
  defensible; together they delete data, because the contract never said the one thing that mattered.
- **The fix is a stated invariant, not a code patch:** enrich = ADD, never REMOVE. Anti-slop governs
  PROSE, not DATA (tables, IDs, doses, prices, verbatim clauses stay structured and in full). And a
  falsifiable acceptance test - the **lookup test**: can you answer a specific question ("what tier is
  Hasseröder", "what's my Sozialversicherungsnummer") from the vault note *alone*? If the answer is
  only in `raw/`, you dropped the knowledge.
- **Process lessons:** fix the contract first, then re-process (so the re-derive validates the
  guardrail instead of papering over output). And: `check` finds *uncovered sources*, not *lossy
  notes* - a second bug class needs a second instrument, which here was a blind five-agent audit
  (the same fan-out shape as the system itself). Only dogfooding finds "the derive drops data" - you
  notice because *your own* beer ratings are gone, not because a test failed.

## 6. Layout and modeling decisions worth carrying forward

- **Entities . domains . forms.** Type only earns a folder for *entities* (people/orgs/holdings -
  things with identity, a graph role, a shared schema). The non-entity bulk files by life-area domain,
  so the typeless `notes/` junk drawer (which had swollen to ~45% of the vault) cannot re-form. Folders
  are a human browse axis only; recall ignores them, so layout costs retrieval nothing.
- **Self-describing notes.** A semantic property must live in the note, never only in its path. The
  tell that caught it: `type:` was in both frontmatter and folder, but `domain:` was path-only - move
  or export the note and the domain is gone. Fix: `domain:` in frontmatter + a `check` that fails on
  folder/field disagreement (the redundancy made a checked invariant so it cannot rot).
- **type (object) x kind (form) x tags (topic), folder = browse.** Four orthogonal axes; keeping them
  orthogonal is what let folder-proliferation die without losing query-by-shape.
- **tags vs aliases is topic vs identity.** tags = many notes -> one shared concept (never unique to a
  note). aliases = many names -> one note (entity resolution). If a value could sit in either field,
  the note is mis-modeled. (Minted bug: a generic tax term as an alias would false-merge a future
  source - aliases must *uniquely* identify the note.)
- **raw/ keyed by source, copies everything, never searched, immutable.** Consistency beat
  cleverness: freeze the transcripts, so freeze the tax CSVs too; pointers rot, copies don't; and
  since recall never touches raw/, a binary there costs disk and zero retrieval pollution.
- **Provenance marks exceptions only.** `{inferred}` / `{ambiguous}` and nothing else; unmarked =
  from source. Marking every from-source line is anti-signal. (And never `^[...]` - `^[` is the ESC
  control char and corrupts on copy/paste; plain braces.)
- **Generalize the data model, never the machinery.** Right-sizing the schema to the actual user
  ("meetings" makes no sense in a home vault) is correction, not scope creep. A too-eager
  "this is scope creep" guard is itself a foot-gun that blocks legitimate fixes.

## 7. Process lessons (how to build this kind of thing)

- **Front-load the divergence check.** The failure mode is the machine not converting a rambling
  intent into concrete criteria, so you ship something that "satisfies my criteria but isn't what I
  wanted" - one misheard word costing a 2-million-token loop. Move the user-impersonating red-team
  attack to minute five. A process can't replace the human holding the intent (Goodhart), but it can
  make the divergence visible early and cheap.
- **The Anna test.** Could the system generate the exact questions it would need to ask a real
  third-party user (Alex's wife Anna) to fully understand what she wants from the tool? If it can't
  generate those questions, it doesn't understand the story and has no business building. Ask until
  you have literally zero questions.
- **Migrate, don't create; re-derive from the ORIGINAL source.** Rebuild from `raw/` snapshots, never
  from a prior vault (that migrates yesterday's mistakes forward) - but preserve genuine prior
  enrichment (an already-atomic, typed, linked source gets its fields *mapped*, not re-derived, which
  would pay the model to downgrade good work). Re-derivation from scratch is for unstructured blobs.
- **Don't parallelize the one-off write you chose to pay for.** The per-domain `check` gate is the
  dedup/orphan guard; sequential domain-by-domain migration is what lets it do its job.

## 8. What this feeds into the contract polish

Concretely, the contract docs (`plugins/README.md`, the CLAUDE.md Plugins section) should now state:

1. The module/capability distinction explicitly: a plugin depends on the vault format + its own
   folder; a **capability module** additionally *provides* or *consumes* a declared edge.
2. The graceful-degradation rule as a first-class invariant: **a consumer treats a missing provider as
   fall-back, never a hard failure** - with the `string | null` client as the worked example.
3. The third contact surface named: vault (single-writer) . agent context (you wire it) . **capability
   broker** (localhost, deterministic, answer-on-request, auditable, never resident).
4. The litmus restated to cover capabilities: zero core edits to add or remove a *provider* too; no
   capability registry in core.
5. The auth finding as the design rationale for any future credential-holding module: human login
   once, read-only attach, never copy a profile, never automate the password.
