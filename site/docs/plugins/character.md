---
title: Character
description: A voice and standards your assistant works in, so it acts like itself, not generic Claude.
---

> **In one line.** A character file gives your assistant a personality, a voice, and a set of standards, so it works like a specific person instead of generic Claude.

## What it's for

Without a character, the assistant is plain Claude. A character file is what makes it itself: how it talks, what it values, the things it never does. It is the most load-bearing plugin, because it is how an assistant's identity survives moving between systems and sessions.

The package ships one default character, Scribe: a direct, opinionated peer that pushes back when it disagrees, owns mistakes lightly, and writes plain prose with no filler. The vault holds your real people in `people/`. This folder holds your digital ones.

## How it works

This is a behavior plugin. It hands the assistant a character file you wire into its prompt. There is no code, no command, no data. The vault never force-feeds the assistant.

A character generalizes to one or many. Today there is one shipped (Scribe), and each is its own file in the folder. There is no referee: if you wire in two characters that contradict each other, you reconcile them. That is the cost of choosing who is on.

## Install

```sh
imprnt plugin add character
```

That copies the package into `plugins/character/` and wires `@plugins/character/agent.md` into `CLAUDE.local.md`, your per-machine on-off file. You can also hand-edit that file and add the line yourself.

Scribe is a generalized default. To make it yours, copy it into the private `_personal/` folder, edit the voice, and wire that copy instead. `_personal/` is gitignored, so your private character never ships and never lands in the public gallery.

```sh
imprnt plugin rm character
```
