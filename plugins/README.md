# imprnt — opt-in plugins

The core is tiny and dumb on purpose: your notes (markdown) plus three commands —
`ingest` (add a note), `recall` (search), `check` (tidy up). **Everything else is a
plugin you drop in or delete.** Install what you need, `rm -rf` what you don't. Nothing
here runs unless you wire it in.

This file is the **plugin contract** — the standing rules every plugin follows. The
contract exists for one reason: to stop the core from slowly growing to know about every
plugin. That growth is what bloats this kind of system over time, the core ends up carrying
every feature as always-on overhead you pay for in tokens and misfires. PAI, the system imprnt
grew out of, hit exactly this. The contract is what keeps imprnt composable instead.

---

## The one rule everything hangs off

**The core never knows any plugin exists.** Plugins know about the core; the core knows
nothing about them.

The practical test — the litmus for the whole contract:

> **You can add or delete any plugin without editing a single line of core code (`packages/imprnt/`).**

If adding a plugin forces you to touch the core, the plugin is wrong — not the core.

## The shape, drawn

```
                ┌─────────────────────────────────────────────────────────────┐
                │ YOU                                                         │
                │  · wire @plugins/<name>/agent.md into CLAUDE.local.md       │
                │  · schedule commands (launchd/cron) or run them by hand     │
                │  · approve everything that leaves the machine               │
                └────────┬───────────────────────────────┬────────────────────┘
                         │ runs / schedules              │ talks
                         ▼                               ▼
    REMOTE       ┌───────────────────┐         ┌───────────────────────┐
    SERVICE ◄───►│  plugin commands  │         │  AGENT (Claude)       │
    (the only    │  sync / check /   │         │  knows the plugin     │
     wire, and   │  <verb>.js / .mjs │         │  via agent.md ONLY    │
     only sync   └────────┬──────────┘         └──────────┬────────────┘
     touches it)          │ writes own folder only        │ reads at answer time,
                          ▼                               │ never the wire
                ┌─────────────────────────────────────────▼───┐
                │  plugins/<name>/      (the rm -rf-able unit) │
                │    mirror/     local cache, rendered at read │
                │    proposed/   staged notes, nothing applied │
                └────────┬─────────────────────────────────────┘
                         │ imprnt ingest --apply   (you approve)
                         ▼
                ┌──────────────┐    imprnt check --all globs plugins/*/check.js (or .mjs),
                │    vault/    │◄── reads EXIT CODES only - core never imports,
                └──────────────┘    never names, never parses a plugin
```

The property the picture enforces: the agent and the wire never touch. Code talks to the outside
world, the agent reads the local mirror, and the two meet only at your approval. Behavior and
harness plugins are degenerate cases of the same shape — no remote service, no mirror, just the
`agent.md` fragment (or hook/settings files) inside the same rm-able folder.

## Using plugins

Each plugin is its own npm package, `imprnt-plugin-<name>`. Installing one fetches the package and
copies its files into your project's `plugins/<name>/`, then wires it:

```sh
imprnt plugin list                  # installed plugins (on/off) + official ones available to add
imprnt plugin add anti-slop         # fetch imprnt-plugin-anti-slop, copy in, wire @plugins/anti-slop/agent.md
imprnt plugin add kopeika --from packages/plugin-kopeika   # install from a local dir (pre-publish/dev)
imprnt plugin rm anti-slop          # unwire; add --purge to also delete plugins/anti-slop/
```

Why copy into the project rather than load from `node_modules`: Claude Code's `@import` resolves files
only inside the project root, so a plugin's `agent.md` has to live at `plugins/<name>/agent.md`. `add`
runs `npm pack` on the package (a registry name, or a local dir with `--from`), extracts the tarball of
exactly its shipped `files[]`, copies that into `plugins/<name>/`, and appends the `@import` line to
`CLAUDE.local.md` (creating the file if missing). `rm` strips the line back out, and `--purge` also
deletes the copied dir. Everything is idempotent. The project `plugins/` dir is the self-contained,
offline, `rm`-able record. npm is just the transport. You can still hand-edit `CLAUDE.local.md`
directly. It stays the single source of truth for what's enabled.

**Gallery vs `_personal/`.** The packages above are the public gallery - generic, shippable. There is
one more place, `plugins/_personal/`, which is **gitignored** and never published: it holds your own
private DA instance and voice overlay (a copy of a gallery plugin you've edited to make yours). To
personalize, copy a plugin into `_personal/`, edit it, and `imprnt plugin add _personal/<file>.md` - a
`<name>/<file.md>` spec wires a local file directly, no fetch. `imprnt plugin list` skips `_personal/`
so your private cast never shows up in the public listing.

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

Install is therefore one line: add `@plugins/<name>/agent.md` as an import to **`CLAUDE.local.md`**
— your gitignored, per-machine toggle file, which Claude Code auto-loads right after the committed
`CLAUDE.md`. `imprnt plugin add <name>` appends that line for you (or hand-edit `CLAUDE.local.md`
yourself — same edit). Never wire plugins into the committed `CLAUDE.md`: that ships the contract
clean, and a fresh clone (no `CLAUDE.local.md`) loads **zero** plugins by default — opt-in for real.
That single line is the whole on-switch. Remove is `imprnt plugin rm <name>` (deletes the line), plus
`--purge` if you want the copied dir gone too. This is the real off-switch the old system never had —
the assistant learns a plugin by being handed its fragment, and forgets it the moment you delete the
line.

The same enable list travels: outside the project, the `imp` launcher reads `CLAUDE.local.md`, inlines
the enabled fragments into the session it spawns (`--append-system-prompt` on the claude backend, a
generated `GEMINI.md` on gemini), and skips that inside the
project where Claude Code loads them natively. One list, managed in one place, honored everywhere.

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
   header carry the plugin's name as a prefix (`kopeika.synced`, `documents.expires`), and a
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
   **the old system imposed; imprnt composes.**

6. **Everything is a command you run.** Nothing runs in the background by itself. Want hourly
   sync? *You* schedule it (cron/launchd/whatever). No plugin quietly starts a background
   process just by being installed. (This is the exact thing that made the old system bill
   rent.)

7. **Install/remove is one generic command (or by hand).** `imprnt plugin add <name>` fetches
   `imprnt-plugin-<name>`, copies its files into `plugins/<name>/`, and wires the `@import` line in
   `CLAUDE.local.md` - generic, by naming convention, with zero per-plugin logic in core (a plugin with
   extra wire-in steps documents them in its own README). `rm` unwires, and `--purge` deletes the copied
   dir. You can always hand-edit `CLAUDE.local.md` instead. No app store, no registry the core reads
   (the list of official names is a hint string, not a registry), no plugin-aware core. Each plugin's
   README has a `## Install` and `## Remove` section.

8. **One escape hatch for the search problem.** Because search ignores plugin folders, a
   plugin's data is invisible there. So a plugin *may* propose **one** short, low-frequency
   summary note into your real notes (you approve it). The bulk of its data stays in its own
   folder, unsearchable **on purpose.**

9. **Secrets stay at the plugin's edge, as env vars.** A plugin that talks to an outside service
   (a task server, a transcription API) reads its credential from an environment variable named
   in its own README (`DEEPGRAM_API_KEY`), and fails loud with that name when it's missing. The
   key never appears in the vault, in the plugin's folder, or in anything committed. No central
   secret store, and the core never touches credentials - the edge belongs to the plugin, same
   as its sync protocol (see the MCP boundary below).

## Harness plugins: customizing Claude itself

Some plugins have nothing to do with the vault - they customize the **harness** the agent runs in:
a PreToolUse hook that snapshots your work before each change (timemachine), the status line at the bottom of
the screen (statusline), the spinner words, a skill. Same folder, same on/off switch (the @import
line), plus up to two extra files, both discovered by filename convention:

- **`.claude-plugin/plugin.json`** makes the folder a **native Claude Code plugin**. Hooks
  (`hooks/hooks.json`), skills (`skills/`), and the other native components sit next to it, in
  Anthropic's documented format - imprnt defines no manifest of its own. `imp` passes the folder
  to every claude session it launches via `--plugin-dir`, so the components load while the plugin is
  enabled and vanish when it isn't.
- **`imp-settings.json`** carries the settings keys Claude only accepts via config (a `statusLine`
  command, `spinnerVerbs`). `imp` merges every enabled plugin's fragment (wire order, later wins
  on a key conflict) and passes the result as ONE `--settings` to the session. A fragment writes
  `${PLUGIN_DIR}` wherever it needs its own absolute path, so it works from any cwd (the
  native spelling `${CLAUDE_PLUGIN_ROOT}` is accepted as an alias, so the variable you already
  use in hooks.json works here too).

What this preserves, on purpose: **stock `claude` stays stock** - the flags exist only on sessions
you start by typing `imp`, nothing is ever written into your global Claude config or any
settings.json - and **add/rm stays perfectly symmetrical** - the hook and the setting live inside
the `rm`-able folder, so removal undoes everything with no settings entry to forget. Typing `imp`
is the consent, every time. The honest cost: harness plugins exist only in imp-launched claude
sessions. Plain `claude` stays plain even in the lair, and gemini has no host for them - `imp
--gemini` skips harness plugins with one warning line.

Build only on the durable native surfaces - skills, hooks, the plugin manifest (the layout every
major harness converged on). The experimental components (monitors, themes) change shape between
releases. A plugin that needs one documents that risk in its own README.

## The two decisions (resolved 2026-06-06)

**Code sharing: copy, share nothing.** The ~12 lines a plugin needs to read a note's header
(split the `--- ---` block, read a `key: [list]`, grab the `# H1` title) are **copied** into
each plugin. The core shares no code as a contract. The reason isn't purity — it's
reversibility: if you later wish you'd shared, pulling duplicated copies into one file is a
five-minute change that breaks nobody; un-publishing a shared tool that plugins already
import is a breaking change and a magnet for "can it also do X?" creep. Copy is the move you
can undo. The contract guarantees the **format**, so a shared `@imprnt/frontmatter` reader
can always be added later as an optional extra without touching this contract.

**Core ↔ plugin contact: exactly four convention-based contact points.** The core touches plugins
in only four places, and all are dumb, uniform, and carry zero per-plugin logic - they
discover plugins by **filename/dir convention**, never by importing a plugin and never by
naming a specific one:

- **`imprnt check --all`** runs the core check, then globs `plugins/*/check.js` (the plugin's built
  artifact, or `check.mjs`, with `.js` winning when both exist), runs each with `node` as a subprocess, and **reads the exit code only** (0 = sound,
  non-zero = something's off), forwarding the plugin's own stdout verbatim. It never parses or
  interprets what a plugin says. The principled fence (what makes "one helper" safe rather than
  arbitrary): **the core may provide read-only *aggregation* helpers, never write/orchestration
  helpers.** `check` qualifies because it's idempotent and changes nothing.
- **`imprnt ingest --apply`** files a pre-enriched staged note that a plugin has dropped into
  `plugins/*/proposed/` — the propose-then-approve escape hatch (rule 8) made concrete. It
  snapshots the staged note for provenance, files it into the right `vault/` folder, resolves
  its links, and deletes the staged copy. `--apply-all` globs `plugins/*/proposed/*.md` and
  applies each — same uniform handling, no per-plugin branch.
- **`imp`'s launch carriage** turns the enable list (the same @import lines everything else
  reads) into launch flags for the session it spawns: one `--plugin-dir` per enabled folder
  carrying `.claude-plugin/plugin.json`, plus one `--settings` merged from every enabled
  `imp-settings.json` (see Harness plugins above). Read-only, convention-discovered, and it
  qualifies under the same fence: aggregation, never write or orchestration.
- **The module-command dispatcher** - `imprnt <module> <command>` runs
  `plugins/<module>/<module>.js` or `<module>.mjs` by the same filename convention (`imprnt kopeika sync`),
  stdio inherited, exit code passed through. Zero per-module
  knowledge in core, and a built-in subcommand always wins. The core executes the plugin's own
  command verbatim and never parses or interprets what it does.

> **Not Kubernetes-style liveness/readiness.** Those exist to auto-restart live services and
> route traffic — imprnt has no daemons and no orchestrator (rule 6), so "is it alive?" has
> no meaning here. The only real health question is "is this plugin's data *sound*?" — which
> is exactly what `check` already answers. A plugin's `check.js` can *say* what's wrong in
> its stdout ("mirror is 3 days stale — run `<module> sync`"); the core just forwards that
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

## Capability modules: provides / consumes (the one relaxation of "share nothing")

"Share nothing" was the original rule: no plugin reads another plugin's folder, imports its code,
or depends on it. One real need bends it — a **capability** one module *provides* and another
*consumes*. The shape that motivated it: a warm browser holding your logged-in sessions,
brokering a fresh auth token over a localhost socket so a watcher (a marketplace inbox, later
mail) can reach a site without each one reverse-engineering that site's login. The pair that
proved it lived in this gallery until 2026-09-03 and is private now (git history is the archive).
The contract it proved stays.

The relaxation is bounded so it can't become the old core-bloat:

1. **A capability is a declared edge, not an import.** The consumer copies a tiny client
   (`sessionToken(site) -> string | null`) that speaks to a localhost broker. It never imports the
   provider's code and never reads its folder. This keeps the reversibility argument intact:
   removing the provider can't break the consumer's build.

2. **Removing a provider degrades a consumer gracefully — never breaks it.** This is the invariant
   that carries the weight the old "no cross-plugin reads" rule used to. A consumer treats a missing
   provider as *fall back*, never a hard failure: `null` from the broker means "host down, do it the
   slow way" (the watcher reads the token from a direct browser session instead). A capability you
   can remove without breaking its consumers is the proof that it's a real module boundary and not a
   hidden dependency.

3. **It's a third contact surface, fenced like the others.** The two surfaces a plugin already
   touches are the **vault** (single-writer; plugins propose, never write) and the **agent context**
   (you wire the fragment). A capability adds a third: a **localhost broker between modules**. It
   obeys the same fences as the sync edge — deterministic only (no LLM drives it), answer-on-request
   (it never acts on its own, never auto-injects), auditable (it logs a token *fingerprint*, never
   the token), and never resident (you start it, you can kill it).

4. **The litmus still holds, extended to providers.** You can add or remove a capability *provider*
   with zero core edits, because discovery is the broker plus a copied client — never a core-managed
   capability registry. A registry in core would be the exact magnet that re-bloats it, so there
   isn't one (it stays on the out-of-scope list below).

**The auth finding behind the design.** A cold, fully-automated login trips bot protection (Akamai
and similar fingerprint the automation). The fix is not better evasion — it's to stop pretending: a
clean, non-automation-flagged browser you log into **by hand once**, then a read-only attach to that
warm, already-authenticated session. Never copy a profile (that both looks like theft to the
fingerprinter and is its own credential-handling risk). The human does the one irreducible step (the
password); the machine only reads the token the site is already refreshing. That's why the
such a module is user-started, localhost-bound, and never resident — "explicit beats automatic"
applied to credentials. Any future credential-holding module follows the same shape.

## The plugins this contract unblocks

- **Documents (file librarian).** Watches your files; on a new one, proposes a note about it
  for you to approve. Tracks files deterministically (hash/manifest) in its own folder; on
  ingest, hands the file off into `raw/` so the note gets a rot-proof provenance link. Clean
  fit for propose-then-approve.
- **Character (your digital people).** Each *digital person* — the DA, and later a council
  member, a red-team skeptic — is defined by one character file (one of the character plugin's cast files -
  Wingman by default - or a personalized copy in `plugins/_personal/`): its personality, voice,
  standards, the way it works. You wire a character into the assistant's prompt, and delete the line
  to turn it off. It produces *character text*, not notes — a config-extension plugin (rule 5), a
  different class from the one above, with no referee for conflicts (install two contradictory
  characters and that's on you). The clean parallel: `vault/people/` holds the **real** people you
  know, and your character plugins hold your **digital** people. Wingman is the shipped default.

## Explicitly out of scope for v1 (the C5 stop condition)

Not built until a real, named need forces it: a central registry/manifest the core reads (including
a capability registry — capabilities are discovered by their localhost broker + a copied client, not
by core) · a core "plugin API" beyond the stable note format · search indexing plugin folders · a
storage abstraction (markdown stays concrete, not behind an interface) · any auto-injection into the
assistant · any forced daemon · plugin↔plugin *imports* or cross-folder reads (a declared,
gracefully-degrading capability edge is the one sanctioned exception — see "Capability modules") · a
plugin SDK/scaffold generator · core↔plugin version negotiation. "It belongs" is not a reason to add
anything.

---

## Built plugins

### timemachine — local snapshot safety net ✅ built (harness plugin)

An opt-in safety net for skip-permissions sessions. A native Claude Code plugin: its
`hooks/hooks.json` wires `timemachine.js --hook` as a PreToolUse hook on the mutating tools (Edit,
Write, Bash...), and before each one it snapshots the git working tree to a side ref under
`refs/timemachine/`. So anything the agent deletes or overwrites that git could not otherwise
recover - an untracked file, an uncommitted change - can be restored. It never blocks, respects
`.gitignore` so secrets are never captured, and never leaves the machine. Recover with
`node plugins/timemachine/timemachine.js list|restore|show|wipe`. (Replaced the old `guard`
blocklist, which a creative agent could route around without trying.)

### statusline — the session's bottom line ✅ built (harness plugin)

A customizable status line for imp sessions: model, directory, git branch, context used, session
cost, rate-limit windows with the five-hour reset time, wall clock - colored by how worried you
should be, refreshed every 30s. The line is whatever `statusline.js` prints from the session JSON
Claude pipes it - edit the segments to make it yours (or copy into `_personal/` first). Its
`imp-settings.json` carries the `statusLine` setting and rides imp's merged `--settings`. Nothing
is written to your config.

### telegram — the vault in your pocket ✅ built (channel bridge)

Mobile access: a long-lived imp session in the lair with Claude Code's Telegram channel enabled
(`sh plugins/telegram/link.sh`, a command you run when leaving the desk - never a daemon). You
text your bot, the session runs `recall` against the vault on your machine and texts back. The
plugin ships the phone-side behavior rules (recall-first, phone-sized replies, never paste a
whole note) and wraps the official `telegram@claude-plugins-official` channel plugin (research
preview - during it, only Anthropic-allowlisted channels can register). Bot token via
`/telegram:configure` or `TELEGRAM_BOT_TOKEN` (rule 9). Honest caveats in its README: the machine
must be awake, and bot chats are not end-to-end encrypted - the vault stays home, the
conversation transits Telegram.


### character — your digital people ✅ shipped cast (Wingman, Doc, Caveman)

The DA's character, as a wired-in fragment — the thing that makes the assistant *itself* and not raw
Claude. The `imprnt-plugin-character` package ships a cast of three: **Wingman** (`agent.md`, the
ironic-peer default), **Doc** (`doc.md`, the calm colleague), **Caveman** (`caveman.md`, telegraphic,
few word all signal). Same standards spine in all three; only the register differs. Install =
`imprnt plugin add character`; pick = `imprnt character <name>` (the plugin's own selector, rewiring
only its `@plugins/character/` line); remove = `imprnt plugin rm character`. Your own digital person is a personalized copy in `plugins/_personal/`, wired with `imprnt
plugin add _personal/<name>.md`. The cast grows over time — a council or a red team is just a *group of
characters* you convene (not built yet; the word generalizes now so nothing needs renaming when it
does). Real people live in `vault/people/`; digital people live here.

### anti-slop — universal anti-AI-slop rules ✅ built

The ruleset that keeps the agent's prose from reading like AI — banned punctuation, words, phrases,
and rhetorical patterns. An always-on behavior plugin (rule 5): it hands the agent a fixed chunk of
text, writes no notes, touches nothing in the vault. Install = `imprnt plugin add anti-slop`; remove
= `imprnt plugin rm anti-slop`. Copy it into `_personal/` and extend it to add your own register.

### bm25 — ranked recall ✅ CORE (not a plugin)

BM25 is **not** here — it's the core ranker, built into `packages/imprnt/scripts/recall.ts`. It's pure local
arithmetic (term frequency × idf, with title/tag/body field boosts), zero LLM, zero deps, so it's
the *cheap* default the READ path runs thousands of times — exactly the kind of thing that belongs
in core, not behind an opt-in. The earlier "start with plain grep, defer BM25" plan was the error:
plain tiered grep floods or misses on a real ~150-note vault. There is no `bm25/` plugin to adapt.

### graph/ — orphan + duplicate lint ⏳ deferred (adapt from PAI)

Lift `~/.claude/PAI/TOOLS/KnowledgeGraph.ts` (BFS over frontmatter tags + wikilinks +
`related:`; `stats` / `hubs` / `related` / `find`). Repoint to imprnt's folders. Use isolated-
node detection to push orphans into `_needs-review.md`. Deterministic, no LLM.
