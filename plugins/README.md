# imprint — opt-in plugins

The core is tiny and dumb on purpose: your notes (markdown) plus three commands —
`ingest` (add a note), `recall` (search), `check` (tidy up). **Everything else is a
plugin you drop in or delete.** Install what you need, `rm -rf` what you don't. Nothing
here runs unless you wire it in.

This file is the **plugin contract** — the standing rules every plugin follows. The
contract exists for one reason: to stop the core from slowly growing to know about every
plugin. That growth is what killed the system imprint replaces (the core became a "robot
suit" that billed rent). The contract is what keeps imprint composable instead.

---

## The one rule everything hangs off

**The core never knows any plugin exists.** Plugins know about the core; the core knows
nothing about them.

The practical test — the litmus for the whole contract:

> **You can add or delete any plugin without editing a single line of core code (`scripts/`).**

If adding a plugin forces you to touch the core, the plugin is wrong — not the core.

Stated more precisely (the rule the litmus is a cheap proxy for): **a plugin may depend on
exactly two things — your `vault/` notes (and their frontmatter format) and its own folder.
Nothing else.** Not core internals, not core code, not another plugin, not another
plugin's folder, not another plugin's frontmatter labels.

## The entry point: the agent fragment

The thing that actually *knows* a plugin exists is the **agent**, not the core code. Each
plugin ships one file — `plugins/<name>/agent.md` — a fixed-size fragment that tells the
agent everything it needs: what the plugin is, where its data / local mirror / join-table
lives, the commands it exposes, and any always-on rules the agent should follow. The core
code never reads `agent.md`; only the assistant does.

Install is therefore one line: add `@plugins/<name>/agent.md` as an import to the project
`CLAUDE.md` (or paste the fragment in). That single line is the whole on-switch. Remove is
deleting that line and `rm -rf plugins/<name>`. This is the real off-switch the old system
never had — the assistant learns a plugin by being handed its fragment, and forgets it the
moment you delete the line.

## The rules, in plain English

1. **Reading your notes** — a plugin opens the files and reads them like any script would.
   It leans on the *shape* of a note (the `--- ... ---` header with `key: value` lines), not
   on any core code. The core guarantees the **format** stays stable; it does **not** publish
   any importable code as a contract.

2. **Writing** — a plugin **never edits your actual notes.** It writes only inside its own
   folder. To change a note, it hands you (or `ingest`) a *suggested* change and you approve
   it. Exactly one thing ever writes your notes (`ingest`/you). Two plugins can never fight
   over the same note. (Single-writer, per path: each plugin folder has exactly one writer
   and one reader — its own plugin; `vault/` has exactly one writer.)

3. **Each plugin owns its own folder and its own labels.** Any labels it adds to a note's
   header carry the plugin's name as a prefix (`whenful.synced`, `documents.expires`), and a
   plugin only ever reads *its own* labels — never another plugin's, never the core's
   private ones. So two plugins can't trip over each other, and there's no central registry
   needed to keep them apart. The core ignores any label it doesn't recognize.

4. **Search only ever looks at your real notes** (`vault/`). Never inside plugin folders,
   never the raw archive (`raw/`). This is permanent. If a plugin wants something findable,
   the only path is to *propose a real note* you approve (see rule 8) — never to make its own
   folder searchable.

5. **"Always-on behavior" plugins work differently** (e.g. an anti-slop ruleset for the
   assistant). They hand you a fixed chunk of text and **you** paste it into your assistant's
   settings. The vault never force-feeds the assistant on its own. Turn it off = delete the
   line you pasted. Fair warning: install two that contradict each other and you sort it out —
   there's no referee. That's the cost of *you* choosing what's on, and it's the whole moat:
   **the old system imposed; imprint composes.**

6. **Everything is a command you run.** Nothing runs in the background by itself. Want hourly
   sync? *You* schedule it (cron/launchd/whatever). No plugin quietly starts a background
   process just by being installed. (This is the exact thing that made the old system bill
   rent.)

7. **Install/remove is by hand.** Each plugin's README has a `## Install` section (the two or
   three wire-in steps — at minimum the `@plugins/<name>/agent.md` line above) and a
   `## Remove` section ("delete the line + `rm -rf` the folder"). No app store, no registry,
   no install command.

8. **One escape hatch for the search problem.** Because search ignores plugin folders, a
   plugin's data is invisible there. So a plugin *may* propose **one** short, low-frequency
   summary note into your real notes (you approve it). The bulk of its data stays in its own
   folder, unsearchable **on purpose.**

## The two decisions (resolved 2026-06-06)

**Code sharing: copy, share nothing.** The ~12 lines a plugin needs to read a note's header
(split the `--- ---` block, read a `key: [list]`, grab the `# H1` title) are **copied** into
each plugin. The core shares no code as a contract. The reason isn't purity — it's
reversibility: if you later wish you'd shared, pulling duplicated copies into one file is a
five-minute change that breaks nobody; un-publishing a shared tool that plugins already
import is a breaking change and a magnet for "can it also do X?" creep. Copy is the move you
can undo. The contract guarantees the **format**, so a shared `@imprint/frontmatter` reader
can always be added later as an optional extra without touching this contract.

**Core ↔ plugin contact: exactly two convention-based aggregators.** The core touches plugins
in only two places, and both are dumb, uniform, and carry zero per-plugin logic — they
discover plugins by **filename/dir convention**, never by importing a plugin and never by
naming a specific one:

- **`imprint check --all`** runs the core check, then globs `plugins/*/check.ts`, runs each as
  a subprocess, and **reads the exit code only** (0 = sound, non-zero = something's off),
  forwarding the plugin's own stdout verbatim. It never parses or interprets what a plugin
  says. The principled fence (what makes "one helper" safe rather than arbitrary): **the core
  may provide read-only *aggregation* helpers, never write/orchestration helpers.** `check`
  qualifies because it's idempotent and changes nothing.
- **`imprint ingest --apply`** files a pre-enriched staged note that a plugin has dropped into
  `plugins/*/proposed/` — the propose-then-approve escape hatch (rule 8) made concrete. It
  snapshots the staged note for provenance, files it into the right `vault/` folder, resolves
  its links, and deletes the staged copy. `--apply-all` globs `plugins/*/proposed/*.md` and
  applies each — same uniform handling, no per-plugin branch.

> **Not Kubernetes-style liveness/readiness.** Those exist to auto-restart live services and
> route traffic — imprint has no daemons and no orchestrator (rule 6), so "is it alive?" has
> no meaning here. The only real health question is "is this plugin's data *sound*?" — which
> is exactly what `check` already answers. A plugin's `check.ts` can *say* what's wrong in
> its stdout ("mirror is 3 days stale — run `whenful sync`"); the core just forwards that
> text. Rich message from the plugin, dumb pass/fail read by the core.

## The MCP boundary

There is **no protocol between the agent and the vault.** The vault is plain files; the agent
greps them. A plugin doesn't bolt a query layer onto your notes — that's the whole point of a
plugin: *MCP is a way to query; a plugin is a way to not have to query.* A plugin works off a
**local mirror** it owns, rendered at read time, so the everyday path touches no network and
no server.

A network client is allowed in exactly one place: a plugin's **remote-sync edge** — the
`sync` command that refreshes the local mirror from a remote service. That call is batched and
runs only when *you* run it (rule 6). It may speak REST, or MCP if the service happens to
offer it — the protocol is the plugin's private business at its own edge, never something the
core or the vault sees. Results land in the plugin's local cache; everything downstream of
that reads the cache, never the wire.

## The three plugins this contract unblocks

- **Whenful (tasks).** Keeps a live mirror of your tasks in `whenful/` (its own folder, never
  searched), syncs when you run `whenful sync` (a command, never a daemon), and occasionally
  graduates a *summary* into a real note via proposal. It reads `whenful.*` labels off your
  notes; it never scribbles into them. High-frequency task state stays in the mirror — it
  does **not** propose one note per task.
- **Documents (file librarian).** Watches your files; on a new one, proposes a note about it
  for you to approve. Tracks files deterministically (hash/manifest) in its own folder; on
  ingest, hands the file off into `raw/` so the note gets a rot-proof provenance link. Clean
  fit for propose-then-approve.
- **Characters (your digital people).** Each *digital person* — the DA, and later a council
  member, a red-team skeptic — is defined by one character file (`plugins/characters/<name>.md`):
  its personality, voice, standards, the way it works. You wire a character into the assistant's
  prompt; delete the line to turn it off. It produces *character text*, not notes — a
  config-extension plugin (rule 5), a different class from the two above, with no referee for
  conflicts (install two contradictory characters and that's on you). The clean parallel:
  `vault/people/` holds the **real** people you know; `plugins/characters/` holds your **digital**
  people. Taylor is the first.

## Explicitly out of scope for v1 (the C5 stop condition)

Not built until a real, named need forces it: a central registry/manifest the core reads · a
core "plugin API" beyond the stable note format · search indexing plugin folders · a storage
abstraction (markdown stays concrete, not behind an interface) · any auto-injection into the
assistant · any forced daemon · plugin↔plugin dependencies or cross-folder reads · a plugin
SDK/scaffold generator · core↔plugin version negotiation. "It belongs" is not a reason to add
anything.

---

## Built plugins

### guard/ — destructive-command guard ✅ built

A deterministic blocklist. `bun plugins/guard/guard.ts "<command>"` exits `2` on obviously
dangerous commands (`rm -rf` on home/system paths, `sudo`, fork bombs, force-push to
main…) and `0` otherwise. Wire it as a PreToolUse hook on Bash if you let the agent run
shell. No LLM.

### whenful/ — task mirror ✅ shell built (live sync deferred)

The first plugin to exercise the whole contract end-to-end: an `agent.md` fragment, a
`links.tsv` join table, a local `mirror/` cache rendered at read, a `proposed/` staging
folder, and its own `check.ts` the `check --all` aggregator finds. The `sync` command is a
documented **stub** today — it states the Whenful API contract it will call and makes **no**
live network request — wiring the real API is the next session.

### characters/ — your digital people ✅ first one built (Taylor)

The DA's character, as a wired-in fragment — the thing that makes the assistant *itself* and
not raw Claude. One file per digital person (`plugins/characters/<name>.md`); `taylor.md` is the
first. Install = add `@plugins/characters/taylor.md` to your agent's prompt; remove = delete the
line. The cast grows over time — a council or a red team is just a *group of characters* you
convene (not built yet; the word generalizes now so nothing needs renaming when it does). Real
people live in `vault/people/`; digital people live here.

### bm25/ — ranked recall ✅ CORE (not a plugin)

BM25 is **not** here — it's the core ranker, built into `scripts/recall.ts`. It's pure local
arithmetic (term frequency × idf, with title/tag/body field boosts), zero LLM, zero deps, so it's
the *cheap* default the READ path runs thousands of times — exactly the kind of thing that belongs
in core, not behind an opt-in. The earlier "start with plain grep, defer BM25" plan was the error:
plain tiered grep floods or misses on a real ~150-note vault. There is no `bm25/` plugin to adapt.

### graph/ — orphan + duplicate lint ⏳ deferred (adapt from PAI)

Lift `~/.claude/PAI/TOOLS/KnowledgeGraph.ts` (BFS over frontmatter tags + wikilinks +
`related:`; `stats` / `hubs` / `related` / `find`). Repoint to imprint's folders. Use isolated-
node detection to push orphans into `_needs-review.md`. Deterministic, no LLM.
