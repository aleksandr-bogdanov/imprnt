---
title: Memory and the vault
description: One store for what you know, a tiny always-on layer for how the assistant should act, and a rule that keeps them apart.
---

> **In one line.** Two kinds of "memory" usually get jumbled together: stuff you know, and rules for how the AI behaves. imprnt keeps the first in one searchable place and the second tiny and separate, so you always know where a fact is.

Every AI memory system has to answer one question for each thing it knows: where does this live, and will the assistant see it? Most answer with several overlapping stores, so you can never quite say where a fact went or whether it is in context right now. imprnt keeps one store for knowledge and one strict rule about what loads on its own.

## Two jobs people keep mixing up

A store does one of two jobs. The trouble starts when one store tries to do both, or several do the same one.

- **Knowledge** is what you know about your world: people, policies, decisions, numbers. You want to find it when it matters, and you want it out of the way the rest of the time. So it should be searchable and fetched on demand.
- **Behavior** is how the assistant should act: a house style, an anti-slop ruleset, a standing instruction. You want it applied every time without asking. So it should be small and always on.

These pull in opposite directions. Knowledge wants to be big and quiet. Behavior wants to be tiny and loud. Put them in one bucket and the whole thing turns into a junk drawer.

## imprnt's answer: one store, fetched on demand

The vault is the only place knowledge lives, and nothing about it pushes itself into a session. You reach it through three doors, each one on demand:

- **`recall`** searches the vault with BM25 and hands back the best hits. The everyday door. See [how it works](/how-it-works/).
- **`imprnt hot`** prints the short primer in `hot.md` plus anything that needs review. The "where was I" glance.
- **`imprnt context`** prints the full filing rules. The assistant runs it right before it writes a note, so the heavy rules are paid only by the sessions that actually write.

An `imp` session loads almost nothing on its own: your behavior plugins, plus a one-line note saying the vault exists and how to search it. A day of reading costs that one line, never the whole vault.

| Surface | What it holds | Auto-loaded | Reached by | Who writes it |
|---------|-----------------|-------------|------------|---------------|
| `vault/` notes | your knowledge | no | `recall` | you, through the model at filing |
| `hot.md` | the primer plus needs-review | no | `imprnt hot` | the model, as you work |
| the vault contract | the filing rules | no | `imprnt context` | imprnt ships it |
| the session pointer | "the vault exists, search it" | yes | injected by `imp` | imprnt |
| `raw/` | untouched source copies | no | never searched | code, at filing |

## Behavior rides in the assistant, not the vault

The vault holds zero behavior and force-feeds nothing. A house style or an anti-slop ruleset is a behavior plugin: a fixed chunk of text you wire into your assistant with one import line in `CLAUDE.local.md`, your per-machine on-off file. It loads because you added the line. It leaves when you delete the line. See [plugins](/plugins/).

That keeps the line clean. Knowledge sits in the vault, searchable and quiet. Behavior sits in the config, small and always on. Neither bleeds into the other.

## Your assistant has its own memory, so keep it thin

imprnt usually runs under Claude Code, which ships a memory of its own, separate from the vault. The assistant writes a `MEMORY.md` about a project as it works. The first stretch of it auto-loads every session, it stays on your machine, and it lives outside `vault/`, so `recall` never sees it. Useful for what the assistant learns about a repo. It is also a second always-on store you cannot search.

One rule keeps it from becoming a parallel mess:

- World and project knowledge goes in the vault, where `recall` finds it.
- A standing behavior or preference goes in the assistant's `CLAUDE.md` or its auto-memory.
- The same fact never lives in both. Two copies drift, and one of them is invisible to search.

> **The easy mistake.** Parking searchable knowledge in the store that cannot be searched. While building imprnt, project facts about the website and a plugin got written into the assistant's memory and had to be moved into the vault to be findable. Keep the assistant's memory down to a few behavior facts, and let the vault carry everything you will look up later.

## Where each thing goes

| You want to keep | Put it in | Auto-loaded | Found by recall |
|------------------|-----------|-------------|-----------------|
| A fact about a person, policy, or decision | a vault note | no | yes |
| A number, table, or record | a vault note, in full | no | yes |
| A primer of where things stand | `hot.md`, via `imprnt hot` | no | no, it is a control file |
| The filing rules | the vault contract, via `imprnt context` | no | no |
| A writing style or anti-slop ruleset | a behavior plugin in `CLAUDE.local.md` | yes | no |
| A standing instruction | the assistant's `CLAUDE.md` or its memory | yes | no |
| Source transcripts and documents | a `raw/` copy | no | no |

## The mess imprnt set out to avoid

imprnt grew out of [PAI](https://github.com/danielmiessler/PAI), which pointed the way and also showed where several memory stores blur together. PAI carried at least three, and all of them read like "memory":

- **USER/** held identity and life goals, auto-loaded every session.
- **MEMORY/KNOWLEDGE/** was a curated, typed entity graph, fetched on demand.
- **MEMORY/LEARNING/** captured wins and failures as raw timestamped records, to be mined later.

Each loaded differently, and the jobs overlapped. USER and KNOWLEDGE both answered "who am I and what am I working on." The two MEMORY stores served opposite ends, one curated and permanent, one raw and temporal. The result was simple: you could rarely say where a fact lived or whether the assistant would see it.

imprnt collapses that into one knowledge store with three on-demand doors, plus the assistant's small always-on behavior layer. One question routes anything you want to keep: is it knowledge or is it behavior? Knowledge goes to the vault and is found by search. Behavior goes to the config and loads every time. The longer record of these calls is in [design decisions](/design-decisions/).
