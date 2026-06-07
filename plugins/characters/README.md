# characters/ — your digital people

Each *digital person* the assistant can be — or convene — is defined by one character file here:
its personality, voice, standards, the way it works. The DA is the first (`taylor.md`).

This is a **config-extension plugin**: it produces character text the *agent* reads, not notes in
the vault. The clean parallel — `vault/people/` holds the **real** people you know; `characters/`
holds your **digital** people.

## Why a character at all

Without one, the assistant is generic Claude. The character is what makes it *itself* — the voice,
the standards, the things it never does (the anti-slop core). It's the most load-bearing plugin:
it's how the DA's identity survives moving between systems.

## The cast grows (later)

A character generalizes to one *or many*. Today there's one (Taylor). Later, a **council** or a
**red team** is just a *group of characters* you convene from the cast — each its own file here.
The word was chosen to generalize now so nothing needs renaming when that happens. Not built yet —
no group-convening machinery exists; this folder is just the cast.

## Install

Add the character to **`CLAUDE.local.md`** (gitignored, per-machine — Claude Code auto-loads it after
the committed `CLAUDE.md`). Not the committed `CLAUDE.md` — that keeps personal wiring out of the
shipped contract:

```
@plugins/characters/taylor.md
@plugins/characters/writing.md
```

Those lines are the on-switch. (Or paste the files' contents into whatever system-prompt mechanism
your agent uses.)

## Remove

Delete the import line, and `rm plugins/characters/<name>.md` if you want it gone entirely. No
referee: if you wire in two characters that contradict each other, you reconcile them — that's the
cost of *you* choosing who's on.
