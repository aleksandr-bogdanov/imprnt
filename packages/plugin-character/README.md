# character - your digital people

Each *digital person* the assistant can be (or convene) is defined by one character file: its
personality, voice, standards, the way it works. This package ships a cast of three:

- **Wingman** (`agent.md`, the default) - the ironic peer. A competent friend in your channel who
  argues back. Sarcasm on, light profanity licensed.
- **Doc** (`doc.md`) - the calm senior colleague. Warm, plain, swearing-free, explains as it goes.
- **Caveman** (`caveman.md`) - few word, all signal. Telegraphic answers, full data, zero padding.
  Inspired by the caveman prompt trend; grown into a full character.

All three share one standards spine - verify-never-assert, lead with what matters, no gushing,
opinions volunteered, pushes back and holds ground. You pick a register, never a lower bar. The
default is opinionated on purpose: if Wingman's spice isn't your taste, switching is one command.

This is a **config-extension plugin**: it produces character text the *agent* reads, not notes in
the vault. The clean parallel - `vault/people/` holds the **real** people you know; `character/`
holds your **digital** people.

## Why a character at all

Without one, the assistant is generic Claude. The character is what makes it *itself* - the voice,
the standards, the things it never does. It's the most load-bearing plugin: it's how a DA's identity
survives moving between systems.

## Install

```sh
imprnt plugin add character
```

That fetches `imprnt-plugin-character`, copies it into `plugins/character/`, and wires
`@plugins/character/agent.md` (Wingman) into `CLAUDE.local.md` (gitignored, per-machine - Claude
Code auto-loads it right after the committed `CLAUDE.md`). Or hand-edit `CLAUDE.local.md` and add the
line yourself. Never wire it into the committed `CLAUDE.md` - that keeps personal wiring out of the
shipped contract.

## Pick your character

```sh
imprnt character            # list the cast, see who's wired
imprnt character doc        # switch to Doc
imprnt character caveman    # switch to Caveman
imprnt character wingman    # back to the default
```

The selector rewires the one `@plugins/character/...` line in `CLAUDE.local.md` and touches nothing
else. Exactly one character is wired at a time; a line you commented out by hand stays yours.

## Personalize it

The cast is a starting point. To make one yours: copy it into the private `_personal/` folder,
edit the voice, and wire that one instead.

```sh
cp plugins/character/agent.md plugins/_personal/mychar.md
# edit plugins/_personal/mychar.md, then swap the wiring:
imprnt plugin rm character
imprnt plugin add _personal/mychar.md
```

`plugins/_personal/` is gitignored, so your private character never ships and never lands in the
public gallery.

## The cast grows (later)

A character generalizes to one *or many*. Later, a **council** or a **red team** is just a *group of
characters* you convene from the cast - each its own file here. The word was chosen to generalize
now so nothing needs renaming when that happens. Not built yet - no group-convening machinery
exists; this folder is just the cast.

## Remove

```sh
imprnt plugin rm character
```

Or delete the import line by hand. To drop the files entirely, add `--purge`. No referee: if you
wire in two characters that contradict each other, you reconcile them - that's the cost of *you*
choosing who's on.
