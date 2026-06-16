---
title: Anti-slop
description: A ruleset the assistant reads so its prose stops reading like AI.
---

A fixed set of **rules** you hand the assistant so its prose stops sounding like a machine wrote it. Out of the box an assistant writes in the tells everyone recognizes: em-dashes, filler words like "robust" and "seamless", "it's worth noting that", the negate-then-affirm rhythm ("this isn't X, it's Y"). Anti-slop **bans** those patterns. It applies to every bit of prose the assistant produces, whether a vault note, a doc, a message, or a deliverable.

## How it works

A **behavior** plugin. It hands the assistant a fixed chunk of text you wire into its prompt. No code, no command, no data. It produces no notes and touches nothing in the vault. The rules cover four areas: forbidden punctuation and typography, forbidden words, forbidden phrases, forbidden rhetorical patterns.

To turn it off, delete the import line. The assistant goes back to its default voice.

## Install

```sh
imprnt plugin add anti-slop
```

That wires `@plugins/anti-slop/agent.md` into `CLAUDE.local.md`, your per-machine on-off file. You can also hand-edit that file and add the line yourself.

Want the rules in every session, even a plain `claude` in an unrelated repo? Wire them at **user scope**:

```sh
imprnt global add anti-slop
imprnt global rm anti-slop
```

To make the rules your own (your register, your banned words on top), copy the fragment into the private `_personal/` folder, extend it, and wire that copy instead. `_personal/` is gitignored, so your overlay never ships.

```sh
imprnt plugin rm anti-slop
```
