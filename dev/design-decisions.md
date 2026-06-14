# Design decisions

The durable calls behind imprnt and why they were made. Evergreen rationale only. The session
narrative that produced them lives elsewhere. This is the record of what was decided and what
would have to change for the decision to flip.

---

## Deterministic-first means ration the LLM by frequency

The core discipline is not "avoid the LLM." It is invest the LLM where it pays and keep it out
of the hot path. The axis is how often a step runs.

- The **write path** runs once per item, so it earns the LLM: read unstructured prose, decide
  the type, write the summary, pull decisions and actions, assign tags, wire links. A migration
  is the same write work done once in bulk.
- The **read path** runs thousands of times, so it stays cheap, deterministic, and local: grep
  plus BM25 ranking, no LLM in the loop.

"The dumbest thing that works" is measured against the LLM. BM25 is pure local arithmetic with
zero deps, so it is the default ranker rather than an opt-in. This would flip only if a read-time
quality problem appeared that no local ranking could fix, and even then the move is a better
local index, never a model in the loop.

## Retrieval is BM25, never embeddings or MCP on the vault

`recall` ranks with standard BM25 (term frequency times inverse document frequency) with title
and tag field boosts. No per-query LLM re-ranking, no embeddings, no vectors, no MCP over the
vault. BM25 returns a tight, well-separated set because idf floats a rare matched term above a
common one. The scaling path stays local at every step: full scan up to about 10k notes, a
grep-prefilter then BM25 up to about 100k, a persistent inverted index above that. The invariant
is that scaling adds a local index, never a vector store or an LLM.

## The data is the knowledge (the Fidelity rule)

A note must carry the source's structured payload in full: tables as tables, IDs, numbers,
dates, prices, doses, verbatim legal text. The summary is in addition to the data, never instead
of it.

The reason is mechanical. `recall` searches `vault/` only, so anything left in `raw/` is
invisible to retrieval. Summarizing a catalog to prose and pointing at the snapshot silently
deletes that knowledge, because the rows were the note. Enrich means add (summary, tags, links),
never remove.

This rule has teeth because a vault rebuild violated it: a re-process kept the prose summaries
and left the tables, IDs, and records behind in `raw/`, which `recall` cannot reach. The lesson
became the cardinal ingest rule and the lookup test (could you answer a specific question from
the vault note alone?). It also clarified a related call: when you rebuild, re-derive from the
original `raw/` snapshots, never reshuffle a prior vault, because that migrates yesterday's
mistakes forward. The one exception is a source that is already an atomic enriched note, which
you map onto the contract rather than re-derive from scratch.

## Tags auto-grow, an audit keeps them lean

Tags are an auto-growing vocabulary, not a gated allowlist. At ingest the LLM applies the
best-fitting tag and coins a new one if none fits. There is no human-approval gate, because a
tag is just a string the note already holds. `imprnt check` syncs new tags into `_tags.md`
deterministically.

The discipline that keeps the list lean moved off the write path to a non-blocking audit:
`check` flags near-duplicate tags (shared prefix or one edit apart) for a conscious synonym
merge. Code never auto-merges, because picking the canonical term is judgment. The earlier gated
list was the error: it made a new domain (a wardrobe, a client) hit a wall at ingest, which is
exactly when you do not want friction.

## Layout is domain-first, with cross-cutting entity folders

An earlier type-first layout (organizing by entity type) produced a junk drawer: a single
typeless `notes/` bucket grew to nearly half the vault, because most of life's content is
reference-about-a-domain with no type-home. The fix is to organize by life-area (domain), the
way a human actually browses their own knowledge. Folders are browse-drawers only. Search is
grep plus BM25 and ignores folders, so layout is a pure human-browsing choice.

The one thing kept from the type-first design is that entities (people, orgs, holdings) get their
own cross-cutting folders, because an entity is referenced from many domains and needs one
canonical home. That resolvable-entity graph is the single real improvement over the system
imprnt replaces, which never had it. The domain set itself is user-defined: imprnt ships the
mechanism and sensible defaults, not a fixed list.

## The plugin contract: the core never knows a plugin exists

Core is the vault plus `ingest`, `recall`, `check`. Everything else is a plugin. The one rule,
and its litmus:

> You can add or remove any plugin with zero edits to `packages/imprnt/`.

A plugin depends on exactly two things: your `vault/` notes (and their frontmatter format) and
its own sibling folder. Nothing else. It reads notes directly, writes only its own folder, and
proposes vault-note changes rather than mutating notes (single-writer vault). Frontmatter labels
are slug-namespaced (`whenful.synced`) and read-your-own-only. `recall` searches `vault/` only,
forever, so a plugin surfaces into search only by proposing one low-frequency summary note.

The reason for the rule is the failure it prevents. The system imprnt replaces let its core
grow to know about every feature until the core became a "robot suit" that billed rent (a token
tax plus misfires). The contract is what keeps imprnt composable instead. The slogan: the old
system imposed, imprnt composes, with a real off-switch.

## Core touches plugins in exactly two convention-based aggregators

Both are dumb, uniform, and carry zero per-plugin logic. They discover plugins by filename or
directory convention, never by importing one and never by naming one.

- `imprnt check --all` globs `plugins/*/check.js` (the plugin's built artifact), runs each with
  `node`, reads the exit code only, and forwards stdout verbatim. It never parses plugin output.
- `imprnt ingest --apply` files staged notes a plugin drops in `plugins/*/proposed/`.

The fence that makes "one helper" safe rather than arbitrary: the core may provide read-only
aggregation helpers, never write or orchestration helpers.

## Copy the reader, share no core code

The roughly 12 lines a plugin needs to read a note's frontmatter are copied into each plugin.
The core publishes no importable code as a contract. The reason is reversibility, not purity. If
duplication later hurts, pulling the copies into one shared file is a five-minute change that
breaks nobody. Un-publishing a shared tool that plugins already import is a breaking change and a
magnet for "can it also do X?" creep. Copy is the move you can undo. The contract guarantees the
note format, so a shared reader can always be added later as an optional extra.

## Render at read off a local mirror, sync only at the edge

A data plugin (Whenful is the worked instance) keeps a local mirror it owns and renders it at
read time. The everyday path touches no network and no server. A network client is allowed in
exactly one place: the plugin's `sync` command at its remote edge, batched, run only when you
run it. The framing: MCP is a way to query, a plugin is a way to not have to query. The win is
payload size (code does the heavy work and surfaces a tight result) plus caching (a local mirror
avoids re-fetching). There is no token-free protocol, so anything the model reads costs tokens,
which is why the mirror exists.

## No protocol between the agent and the vault

The vault is plain files and the agent greps them. There is no MCP, no query layer, no
embeddings on the vault itself. A protocol over the same files would cost orders of magnitude
more tokens than grep and would go stale on every edit. This is the storage-side counterpart to
the plugin MCP boundary above.

## Commands only, never a forced daemon

Core and plugins ship commands. Scheduling them (cron, launchd, a watcher) is the user's opt-in.
Nothing runs in the background just by being installed. The local mirror stays warm because you
scheduled a token-free code sync, not because imprnt runs a daemon. Background auto-magic is
exactly what made the prior system bill rent.

## Run off-PAI by splitting HOME

imprnt was extracted from the personal-AI system it replaces (PAI), which auto-loads a global
config from the home directory. To develop and run imprnt as a standalone system, point Claude
Code at a clean HOME so it loads imprnt's own project context rather than PAI's global
machinery. This keeps the two decoupled, proves imprnt stands on its own with no hidden
dependency on the parent system, and stops PAI's auto-injection from leaking into an imprnt
session. The decision is the decoupling. The HOME split is the mechanism that enforces it.

## Privacy by being private, no sensitivity machinery

The whole vault is local and owner-only. There is no sensitivity field, no redaction pass, no
secret-fencing, because the vault is meant to hold everything including medical, financial, and
personal data. The only rule is that it never goes near a public repo, which `.gitignore` guards
if the directory is ever git-init'd. Publishing a subset is an export-time filter you run
consciously, not a tax paid on every note at ingest.

## imp is the front door, imprnt stays the engine (decided 2026-06-09)

The package ships two bin names running one dispatcher, split by audience. `imp` is for humans:
typed bare in any directory, it opens a Claude session there with the imprnt context riding
along. `imp lair` is the same machine with one parameter changed, the working directory becomes
the registered vault project. `imprnt` is for machinery: typed bare it prints help, and agents
and scripts call its subcommands (`imprnt recall`, `imprnt check`) exactly as before. Engine
subcommands work under both names, so `imp plugin add` reads like the package manager it is.

The session model this replaces was a fork between a dedicated launcher and global injection
into the assistant's config. Both lost. Global injection pays tokens in every session forever
(the rent-billing the project exists to reject), and a launcher-only model left the vault
unreachable from the coding repos where most of the day happens. The resolution is per-keystroke
consent: typing `imp` instead of `claude` IS the wire-in. Stock `claude` stays stock, nothing is
written into the assistant's global config, and each session carries the context because the
user asked for it by name. Bare `imp` launches only when both stdin and stdout are TTYs, so a
script calling it bare (or piping its output) gets help text, never a surprise interactive session.

There are no modes. Everything that looks like one falls out of the assistant's own directory
mechanics: in the lair, the contract and the plugin wiring load natively from cwd (so imp skips
injection there), and personal history and permission grants accumulate in one resumable place.

## Session context is demand-paged by frequency

What an imp session carries up front is decided by the same axis as everything else: how often
it is needed. Always loaded: the user's enabled behavior plugins (the cast), plus a ~150-token
pointer with three jobs. It says what exists (a persistent vault of the user's people, projects,
decisions, history), when to reach for it (when the user references their own world, search with
`imprnt recall` before claiming ignorance), and the one entry point for writing (run
`imprnt context` and follow it before filing or editing any note).

The full vault contract is never loaded up front outside the lair. `imprnt context` prints it on
demand, so the ~9k tokens of filing rules are paid only by the sessions that actually write,
at the moment they write. Read-heavy days cost a pointer. The failure mode of an agent writing
without the rules is already netted: `check` flags the malformed note into needs-review, nothing
is silently lost. This would flip only if just-in-time loading demonstrably produced broken notes
faster than needs-review catches them.

## The vault project is registered at init, never discovered by magic

`imprnt init` records the project path in `~/.config/imprnt/` (the first init becomes the
default), which is what lets `imp` and `imp lair` work from any directory with zero manual
shell-profile steps. `IMPRNT_ROOT` still overrides for scripting. The registry is a map of named
vaults that v1 only ever fills with one entry: the shape exists so a second vault (a team vault
in a work repo) is a config entry later, never an architecture change. Multi-vault switching
itself is not built until a real need names it.

## Harness plugins ride imp's launch flags, never global config (decided 2026-06-10)

A third plugin class customizes the harness itself rather than the vault: guard's PreToolUse
hook, the status line, spinner words, a skill. Two conventional files inside the same plugin
folder carry it. `.claude-plugin/plugin.json` makes the folder a native Claude Code plugin
(hooks and skills in Anthropic's documented format, imprnt defines no manifest of its own), and
`imp-settings.json` holds the settings keys Claude only accepts via config, with `${PLUGIN_DIR}`
standing in for the plugin's absolute path. At launch, imp turns the enable list into flags: one
`--plugin-dir` per native plugin, one `--settings` merged from the fragments in wire order.

Two alternatives lost. Writing into settings.json on install made `plugin rm` asymmetrical: the
files left but the wiring stayed, which was guard's documented wart. Installing native plugins
user-scope (`~/.claude/plugins/`) leaked imprnt into stock `claude`. The flags model keeps both
promises at once: per-keystroke consent (typing imp IS the opt-in, nothing global is ever
written) and add/rm symmetry (the hook and the setting live inside the rm-able folder). The
honest cost: harness plugins exist only in imp-launched sessions, and plain `claude` stays plain
even in the lair.

The bet on the native plugin format is deliberate. Claude Code's plugin directory layout
(`skills/`, `hooks/hooks.json`, the manifest) is the surface its competitors cloned and the
SKILL.md spec was published as an open standard, while bespoke settings keys have churned. Build
harness plugins on skills, hooks, and the manifest. The experimental components (monitors,
themes) are churn a plugin owns the risk for.

## A plugin's secrets are env vars at its own edge

A plugin that calls an external service (a transcription API, a task server) reads its
credential from an environment variable named in its README and fails loud with that name when
the variable is missing. Keys never appear in the vault, the plugin folder, or anything
committed, and the core never touches credentials. There is no central secret store, because
that is registry creep and the remote edge already belongs to the plugin.

## Out of scope, on purpose

No task management. No auto-injected context. No background loop. No self-grading or evals. No
MCP, vectors, or embeddings on the vault. No sensitivity machinery. No `out/` zone for
deliverables (a produced artifact lives in your artifacts directory with a vault note pointing at
it). "It belongs" is never a reason to add something. A capability earns its place by a real,
named need or it ships as a plugin you can `rm -rf`.
