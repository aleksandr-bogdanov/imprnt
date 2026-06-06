# The module-access contract — open architecture question

> Extracted 2026-06-06 from a questions/ideas session, to be solved in its own dedicated chat.
> Status: **RESOLVED 2026-06-06.** The decided contract lives in **`modules/README.md`** (canonical, full plain-English version), with a compact mirror in `CLAUDE.md` (Modules section) and a narrative note in `docs/architecture.md` (Built in pieces). This brief is kept as the record of the question + agenda.
> The collapse: the 7-dimension agenda reduced to **one rule** — the core never knows a module exists; you can add/remove any module with zero edits to `scripts/`; a module depends only on `vault/` (+ frontmatter format) and its own folder. The two open forks were resolved: **(Q1) copy the ~12-line header reader, share no core code** (reversible direction); **(Q2) one `check --all` aggregator that reads exit codes only**, never parses module output. The 3 instances (Whenful/documents/behavior) fall out as applications.
> Do NOT build from this. It frames the problem and the agenda. The answer is decided in the architecture session, then folded into `CLAUDE.md` + `docs/architecture.md` + `modules/README.md`.

## Read-order for a cold start

1. This brief.
2. `CLAUDE.md` (the vault contract — the schema and doctrine).
3. `modules/README.md` (the thin module contract that already exists + the `guard/` example).
4. `scripts/recall.ts` (the read path — proof that core is already permissive).
5. The 5 doctrine memories in `~/.claude/projects/-Users-abogdanov-IdeaProjects-knowful/memory/` (`knowful-conscious-llm`, `knowful-llm-cost-criterion`, `knowful-build-methodology`, `knowful-architecture-v3`, `knowful-v3-build-state`).
6. `docs/architecture-revisit-2026-06-06.md` (the v3 layout decisions).

## State in one breath

knowful v3 is built and fully migrated (114 notes, `check` clean). Core = the markdown vault + the schema + the `ingest -> recall(BM25) -> check` loop. The principle locked this session: **"everything else is a pluggable module"** (Whenful sync, a documents librarian, an agent-behavior ruleset, graph lint, the guard, eventually DA/voice). `modules/` already exists with a thin contract. The unsolved question is the contract itself.

## The question

**What is the contract by which a pluggable module reads, writes, and extends the vault — without becoming a cross-dependency that slowly re-bloats the core (the PAI failure)?**

`documents/` vs `raw/`, Whenful sync direction, and the behavior module are NOT three problems. They are three **instances** of this one question. Solving each ad-hoc produces drift: every module invents its own access pattern, and core grows to know about each one. Solve the contract once and the instances fall out as trivial applications.

## What is already true (the contract is half-implicit today)

The existing `modules/README.md` contract: a module is a self-contained dir, zero cross-deps, you wire in what you want, `rm -rf` what you don't. `guard/` is built (a deterministic PreToolUse blocklist), `graph/` is sketched.

Core is **permissive**, which means a module can already do a lot with **zero core change**:

- `recall` walks `vault/` **only**. A module's data or mirror dir as a **sibling** (`whenful/`, `documents/`) is invisible to search for free. (`raw/` is the existing precedent: sibling, never searched.)
- `recall` reads only `tags` and `aliases` from frontmatter and ignores every other key. So a module adding `tasks: [wf:14519]` is invisible to core.
- `check` validates only core invariants (orphan links, domain-matches-folder). A module ships its **own** check for its own keys and dirs.

So the "first-class module attribute" (`tasks: [wf:id]`) is **already supported** by open frontmatter plus core-ignores-unknown-keys. The architecture session is mostly about **writing the seam down as a stable promise**, not building machinery.

## The agenda — dimensions the session must decide

1. **READ access.** How does a module read vault notes? Direct fs walk, a core-provided read/query API (so modules do not each reimplement frontmatter parsing), or reuse `recall` as a library? Tradeoff: duplication vs coupling.
2. **WRITE access.** May a module write **into** `vault/` (create notes, mutate existing-note frontmatter), or only into its own sibling dir? If two modules can write the same note's frontmatter, how is collision prevented? Candidate stance: modules **never mutate vault notes directly**; they write their own sibling dir and propose changes that `ingest`/the user applies. Keeps the vault single-writer.
3. **FRONTMATTER ownership + namespacing.** Modules add keys; core ignores them. Do we need a reserved namespace so two modules do not collide on a key name? Does `check` gain a way to fan out to module checks (`knowful check --all` runs core + each installed module's check)?
4. **SIBLING DIRS + recall exclusion.** Formalize as a stable promise: `recall` only ever searches `vault/`. Modules get their own top-level dirs. `raw/` (provenance) is also never searched.
5. **SYSTEM-CONTEXT contribution (the behavior module).** A module wants to be always-loaded into the agent. The mechanism must be: the module ships a fixed-size context fragment, the **user wires it into their agent's system-prompt config**, the **vault never auto-injects**. This is the seam that lets "always-on" exist without becoming the PAI sin. Removable = delete the wire-in line / `rm -rf` the module.
6. **LIFECYCLE.** How is a module installed and removed? Today: wire-in-yourself + `rm -rf`. Is a documented README "install" section the whole story, or is a discovery helper warranted? Bias: keep it manual + documented; resist a registry/manifest unless a real need forces it.
7. **DAEMON discipline.** Modules may want background sync/watch. Rule: core and modules ship **commands**; scheduling them (cron/launchd/watcher) is the user's opt-in, never a forced daemon. The local mirror stays warm because **you** scheduled a token-free code sync, not because knowful runs a daemon.

## Doctrine constraints (do not violate)

- Deterministic-first = ration the LLM **by frequency**. The hot read path stays pure code (BM25); the LLM is spent on the one-off write/import.
- **No auto-injection by the vault.** Always-on behavior is allowed only via the agent's own config, and only removably.
- **No forced daemon.** Core ships commands; scheduling is opt-in.
- Everything `rm -rf`-able; zero cross-deps between modules.
- Markdown storage is core and **not** abstracted (no SQLite / storage-interface — rejected this session as a feature for its own sake).
- No MCP / embeddings / vectors on the vault.
- "It belongs" is not a reason to add anything. A module earns its place by a real, named need.
- Token economy lever (settled this session): there is no token-free MCP or CLI; anything the model **reads** costs tokens. The win is **payload size** (code does the heavy work, surfaces a tight result) + **caching** (a local mirror avoids re-fetching). MCP's specific tax is verbose JSON and no local cache.

## The three instances to spec AFTER the contract (each can be its own chat)

**A. Whenful sync.** Direction: Whenful server is authoritative, the vault is a client. Mirror lives in `whenful/`, linked `[[whenful/14519]]` (clickable locally) with a direct `whenful.com/task/<id>` URL as the no-mirror fallback. Frontmatter bridge `tasks: [wf:14519]`. A triage process = one knowful **case note** (identity, reference numbers, reasoning) + a `## Status log` where each step line can carry a `[[whenful/id]]`; done steps render done from the mirror, open steps are live tasks. Whenful owns "is step N done"; the note owns "what is this case and why." Sync is pure code, on-demand or user-scheduled, zero tokens, no daemon. Bidirectional is acceptable because client-server with `updated_at` is a solved problem (read the Whenful repo and lift its multi-device sync model). This instance is **blocked on dimensions 1, 2, 3, 4, 7** of the contract.

**B. Documents librarian.** Canonical file homes (the Yandex `_documents` root), deterministic file tracking (hash/manifest), LLM only on a **new** file to classify and file it. Relationship to `raw/`: **separate layers** — the librarian tracks all your files (most never become notes); `raw/` is per-note provenance. Handoff: when you ingest a note from a document, `ingest` copies that document into `raw/` from the librarian's canonical path, so the note gets a rot-proof `[[raw/...]]` link. Article line Alex wants: "the digital assistant helps you track files in a deterministic way without wasting excessive tokens." Blocked on dimensions 1, 2, 7.

**C. Behavior module.** The anti-slop ruleset (and later voice, etc.) shipped as a fixed-size fragment, wired into the agent's system prompt by the user, removable. The whole moat in one sentence: **PAI imposed, knowful composes** — same always-on capability, opposite default, real off-switch. Blocked on dimension 5.

## Open questions for Alex (answer these in the session)

1. Do modules get a core-provided read API, or read the vault directly? (Duplication vs coupling.)
2. Single-writer vault (modules only write sibling dirs + propose note changes), or may modules mutate note frontmatter directly?
3. `knowful check --all` fanning out to module checks, or each module's check run separately?
4. Is the contract purely a written README convention, or does it need any code (a tiny module-discovery helper)? Bias: convention-only.
5. Bound the scope: the contract should be the **minimum that unblocks instances A/B/C**, not a general plugin framework. What is explicitly out of scope for v1 of the contract?
