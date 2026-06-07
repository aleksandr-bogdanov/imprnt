# Implementation plan — make imprint shippable (the gallery + pluggability)

> Build spec for the shipping model decided 2026-06-07. One repo/package = core CLI + a bundled
> plugins gallery. Plugins are installable via `imprint plugin add` which AUTO-WIRES CLAUDE.local.md
> ("plug it in, it's carried on"). Distribute via npm/bunx. Personal content (Alex's own DA instance,
> his voice overlay, his vault) is separable, never in the public gallery.

## Decided model (do not relitigate)

- **One repo/package**, NOT a monorepo-of-hidden-bundles and NOT a separate gallery repo. Core + an
  explicit `plugins/` gallery of generic, installable plugins in the same repo.
- **Pluggability is the premise:** `imprint plugin add/rm/list` does the wiring. A deliberate,
  contract-clean evolution of the old "manual wire-in only" rule. The command MUST stay **generic** —
  it operates on `plugins/<name>/` by convention and appends/removes one `@import` line in
  `CLAUDE.local.md`, with ZERO per-plugin logic in core. Litmus still holds: adding a gallery plugin =
  drop a dir, no `scripts/` edit; `CLAUDE.local.md` stays the source of truth for what's enabled.
- **Distribute via npm/bunx** (`bunx imprint` / `npm i -g imprint`). Packaging is the last, easy step.
- **Generic ships; personal stays private.** The shipped character is a *generalized* default DA
  (Alex's "Taylor" with the Alex-specific bits removed), named **Scribe**. The shipped anti-slop is the
  *universal* anti-AI-slop core. Alex's personal DA + his personal voice calibration are his own
  private plugins, not in the public gallery.

## Target gallery structure (FIXED — build to this exactly so pieces don't need to coordinate)

```
plugins/
  README.md                  # the contract + `imprint plugin` usage (UPDATE)
  guard/                     # generic safety plugin (EXISTS, keep)
    guard.ts
  character/                 # the DA-character plugin (NEW dir; was characters/)
    scribe.md                # generalized default DA (NEW — from taylor.md, Alex-specifics stripped)
    README.md                # what a character is, how to make your own, install line
  anti-slop/                 # generic anti-AI-slop (NEW dir)
    agent.md                 # the universal [A]/[B]/[C]/[D] rules (from writing.md, personal voice stripped)
    README.md
  whenful/                   # example data-plugin shell (EXISTS, keep as example)
  _personal/                 # GITIGNORED — Alex's private instance (his real Taylor + voice overlay)
    taylor.md                # MOVED from characters/taylor.md (his personal DA, verbatim)
    voice.md                 # MOVED from characters/writing.md (his personal register/rhetoric/banned-words)
```

- `.gitignore`: add `plugins/_personal/` (Alex's private plugins never ship).
- `CLAUDE.local.md` (Alex's, gitignored already): rewire to his personal ones —
  `@plugins/_personal/taylor.md` + `@plugins/_personal/voice.md` (keep HIS setup working). A fresh
  user instead does `imprint plugin add character` + `imprint plugin add anti-slop` → gets Scribe + the
  generic slop rules.

## Piece A — the `imprint plugin` command (scope: `scripts/` ONLY)

Add to `scripts/cli.ts` (+ a `scripts/lib/plugins.ts` helper). Generic, no per-plugin logic.

- `imprint plugin list` — print available plugins (each top-level dir under `plugins/` except `_personal/`
  and `README.md`) and which are ENABLED (have an `@import` line in `CLAUDE.local.md`). Mark enabled/disabled.
- `imprint plugin add <name>` — enable: ensure `CLAUDE.local.md` exists (create with a header if not),
  then append `@plugins/<name>/<entry>` if not already present. Entry resolution: if `plugins/<name>/agent.md`
  exists use it; else if a single `.md` (e.g. character/scribe.md) the caller passes `<name>/<file>`. Keep
  it simple: support `imprint plugin add <name>` (wires `@plugins/<name>/agent.md`) AND
  `imprint plugin add <name>/<file.md>` (wires that exact file, for character/scribe.md). Idempotent
  (no duplicate lines). Print what got wired.
- `imprint plugin rm <name>` — remove the matching `@import` line(s) from `CLAUDE.local.md`. Idempotent.
- CLAUDE.local.md path: resolve relative to the repo root (where CLAUDE.md is) — same dir as the committed
  CLAUDE.md. Use the script location to find repo root, or cwd; match how `@import` resolves (project root).
- Update the cli.ts help text + the default-case usage block with the new `plugin` subcommand.
- Do NOT touch plugins/ content or docs (other pieces own those). Reuse existing style (thin dispatch).
- Verify: `imprint plugin list` shows guard/character/anti-slop/whenful; `add anti-slop` appends the line;
  running it twice doesn't duplicate; `rm` removes it; capture the CLAUDE.local.md before/after.

## Piece B — gallery content + generalization (scope: `plugins/`, `.gitignore`, `CLAUDE.local.md`)

1. `git mv plugins/characters plugins/character` (singular, matches the gallery naming) — OR create
   `plugins/character/` and move files. Keep README.
2. **Generalize the character → `plugins/character/scribe.md`:** start from the current `taylor.md`,
   REMOVE the Alex-specific lines (the name "Taylor", "Alex", his specific preferences, anhedonia/career
   references, anything personal), KEEP the universal DA stance verbatim where possible (peer-not-assistant,
   first person, direct, fire-mode, no gushing, opinions-volunteered, push-back-and-hold, never-ghost-write-
   the-user's-prose, casual self-deprecation). Title `# Scribe — default character`. This is editorial
   REMOVAL of personal bits, not rewriting the voice rules. Add a one-line header: "a generalized default
   DA; copy + personalize + rename to make it yours."
3. **Generic anti-slop → `plugins/anti-slop/agent.md`:** from `writing.md`, KEEP VERBATIM the universal
   sections — [A] forbidden punctuation, [B] forbidden words, [C] forbidden phrases, [D] forbidden
   rhetorical patterns, the quick self-check. DROP the Alex-personal sections — "THE RULE (Alex writes his
   own prose)", his "Register (published content)" with lowercase-edgy, his "How Alex makes a case"
   rhetoric, his calibration refs. Those are personal. Header: "universal anti-AI-slop rules; applies to
   any prose the agent produces."
4. **Move Alex's personal originals to `plugins/_personal/`** (gitignored): `taylor.md` (his real DA,
   verbatim) and `voice.md` (= the current `writing.md`, his full personal voice spec verbatim incl. THE
   RULE + register + rhetoric). These stay private.
5. `.gitignore`: add `plugins/_personal/`.
6. Rewrite Alex's `CLAUDE.local.md` (gitignored) to wire his personal ones:
   `@plugins/_personal/taylor.md` and `@plugins/_personal/voice.md` (so HIS setup keeps working). Leave a
   commented example showing the gallery alternative (`# @plugins/character/scribe.md`).
7. `plugins/character/README.md` + `plugins/anti-slop/README.md`: short — what it is, `imprint plugin add`
   to enable, how to personalize (copy to `_personal/`, edit, wire that instead).
8. Verify: gallery dirs exist with generic content; `_personal/` holds the verbatim originals and is
   gitignored; no "Alex"/"Taylor"/"anhedonia" leaks in the shipped (`character/scribe.md`, `anti-slop/`).

## Piece C — docs + packaging (scope: root `README.md`, `package.json`, `plugins/README.md`, `docs/`)

1. **`plugins/README.md`** (the contract): add a "Using plugins" section documenting `imprint plugin
   add/rm/list` as the install mechanism (auto-wires CLAUDE.local.md). Update the install/entry-point text
   from "hand-edit CLAUDE.local.md" to "`imprint plugin add <name>` (or hand-edit CLAUDE.local.md)". Note
   the gallery vs `_personal/` split. Keep the litmus + contract intact.
2. **Root `README.md`:** a real Setup + Usage section: install (`bunx imprint` / `npm i -g imprint` —
   note: aspirational until published, also document `git clone` + `bun scripts/cli.ts`), `imprint init`,
   set `IMPRINT_VAULT`, `imprint plugin add character/scribe.md anti-slop`, then ingest/recall. Short,
   anti-slop prose (no em-dash, no slop words).
3. **`package.json`:** ensure `bin` maps `imprint` → `scripts/cli.ts`; set `files` to include `scripts`,
   `templates`, `plugins` (the gallery — but NOT `_personal/`, which is gitignored so npm won't pack it),
   `CLAUDE.md`, `README.md`. Keep zero runtime deps. (Do NOT run `npm publish` — that's Alex's call.)
4. `docs/`: if helpful, a short `docs/shipping.md` evergreen note on the distribution model (one
   package, gallery, `plugin add` auto-wire, personal-vs-generic). Keep docs/ evergreen.

## Out of scope (do NOT do)

- `npm publish` (Alex's account/decision).
- The npm-global "copy from package into workspace on add" behavior (later layer — for now `add` wires
  the in-repo gallery plugin; that's the keystone).
- Rewriting Alex's voice rules (only REMOVE personal bits to generalize; keep universal substance verbatim).
- Renaming the vault dir (separate task).

## Verification (each piece reports evidence)

- `bun scripts/cli.ts plugin list` works and shows enabled/disabled correctly.
- `add`/`rm` are idempotent and edit only CLAUDE.local.md.
- `rg -i 'alex|taylor|anhedonia' plugins/character/scribe.md plugins/anti-slop/` → nothing (clean generalization).
- `plugins/_personal/` is gitignored (`git check-ignore plugins/_personal/taylor.md`).
- Anti-slop holds on all new shipped docs (no `—`, no [B] words).
- `git status` clean of personal content in tracked files.
