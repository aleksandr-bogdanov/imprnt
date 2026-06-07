# character - your digital people

Each *digital person* the assistant can be (or convene) is defined by one character file: its
personality, voice, standards, the way it works. This package ships **Scribe** as its `agent.md`, the
generalized default.

This is a **config-extension plugin**: it produces character text the *agent* reads, not notes in
the vault. The clean parallel - `vault/people/` holds the **real** people you know; `character/`
holds your **digital** people.

## Why a character at all

Without one, the assistant is generic Claude. The character is what makes it *itself* - the voice,
the standards, the things it never does. It's the most load-bearing plugin: it's how a DA's identity
survives moving between systems.

## The cast grows (later)

A character generalizes to one *or many*. Today there's one shipped (Scribe). Later, a **council** or
a **red team** is just a *group of characters* you convene from the cast - each its own file here.
The word was chosen to generalize now so nothing needs renaming when that happens. Not built yet -
no group-convening machinery exists; this folder is just the cast.

## Install

Enable Scribe with the plugin command:

```sh
imprint plugin add character
```

That fetches `imprint-plugin-character`, copies it into `plugins/character/`, and wires
`@plugins/character/agent.md` into `CLAUDE.local.md` (gitignored, per-machine - Claude
Code auto-loads it right after the committed `CLAUDE.md`). Or hand-edit `CLAUDE.local.md` and add the
line yourself. Never wire it into the committed `CLAUDE.md` - that keeps personal wiring out of the
shipped contract.

## Personalize it

Scribe is a generalized default. To make it yours: copy it into the private `_personal/` folder,
edit the voice, and wire that one instead.

```sh
cp plugins/character/agent.md plugins/_personal/mychar.md
# edit plugins/_personal/mychar.md, then:
imprint plugin add _personal/mychar.md
```

`plugins/_personal/` is gitignored, so your private character never ships and never lands in the
public gallery.

## Remove

```sh
imprint plugin rm character
```

Or delete the import line by hand. To drop the file entirely, `rm plugins/character/<name>.md`. No
referee: if you wire in two characters that contradict each other, you reconcile them - that's the
cost of *you* choosing who's on.
