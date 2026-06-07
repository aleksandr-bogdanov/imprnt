# anti-slop/ - universal anti-AI-slop rules

A ruleset the assistant reads so the prose it produces does not read like AI. It bans the punctuation,
words, phrases, and rhetorical patterns that mark machine-written text - em-dashes, filler intensifiers,
negate-then-affirm, choppy declarative parallels, and the rest. Applies to any prose the agent writes:
vault notes, docs, messages, deliverables.

This is an **always-on behavior plugin** (rule 5 in the plugin contract): it hands the agent a fixed
chunk of text and you wire it in. It produces no notes and touches nothing in the vault. Turn it off
by removing the import line.

## Install

```sh
imprint plugin add anti-slop
```

That wires `@plugins/anti-slop/agent.md` into `CLAUDE.local.md` (gitignored, per-machine - Claude Code
auto-loads it right after the committed `CLAUDE.md`). Or hand-edit `CLAUDE.local.md` and add the line
yourself.

## Personalize it

`agent.md` is the universal core. To add your own register, banned words, or rhetoric on top, copy it
into the private `_personal/` folder, extend it, and wire that one instead.

```sh
cp plugins/anti-slop/agent.md plugins/_personal/voice.md
# edit plugins/_personal/voice.md, then:
imprint plugin add _personal/voice.md
```

`plugins/_personal/` is gitignored, so your personal voice overlay never ships.

## Remove

```sh
imprint plugin rm anti-slop
```

Or delete the import line by hand.
