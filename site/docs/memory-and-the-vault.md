---
title: Memory and the vault
description: Where a fact lives, whether the assistant loads it on its own, and who put it there. One knowledge store, a small always-on behavior layer, and a rule that keeps them apart.
---

Every personal-AI system has to answer one question for each thing it knows: where does this live, and will the assistant see it. Most answer it with several stores that overlap, so you can never quite say where a fact went or whether it is in context right now. imprnt keeps one knowledge store and one strict rule about what loads on its own.

## Two jobs people keep conflating

A store does one of two jobs. The trouble starts when one store does both, or when several do the same one.

- **Knowledge** is what you know about your world: people, policies, decisions, numbers. You want to find it when it is relevant, and you do not want it sitting in context the rest of the time. Knowledge should be searchable and fetched on demand.
- **Behavior** is how the assistant should act: a house style, an anti-slop ruleset, a standing instruction. You want it applied every time without asking. Behavior should be small and auto-loaded.

These pull in opposite directions. Knowledge wants to be large and quiet. Behavior wants to be tiny and always on. Putting them in one bucket is what makes a context system feel like a junk drawer.

## imprnt's answer: one knowledge store, demand-paged

The vault is the only place knowledge lives, and nothing about it injects itself into a session. You reach it through three doors, each one on demand:

- **`recall`** searches the corpus with BM25 and hands back the top hits. This is the everyday door. See [how it works](/how-it-works/).
- **`imprnt hot`** prints the roughly 500-token primer in `hot.md` plus anything that needs review. The "where was I" glance.
- **`imprnt context`** prints the full filing contract. An agent runs it right before it writes a note, so the heavy rules are paid only by the sessions that write.

What an `imp` session loads on its own is deliberately small: your enabled behavior plugins, plus a one-line pointer saying the vault exists and how to search it. A read-heavy day costs that pointer, never the corpus.

| Surface | What it carries | Auto-loaded | Reached by | Who writes it |
|---------|-----------------|-------------|------------|---------------|
| `vault/` notes | your knowledge | no | `recall` | you, through the model at ingest |
| `hot.md` | the primer plus needs-review | no | `imprnt hot` | the model, refreshed as you work |
| the vault contract | the filing rules | no | `imprnt context` | imprnt ships it |
| the session pointer | "the vault exists, search it with recall" | yes | injected by `imp` | imprnt |
| `raw/` | immutable source snapshots | no | never searched | code, at ingest |

## Behavior rides in the harness, not the vault

The vault holds no behavior and force-feeds nothing. A house style or an anti-slop ruleset is a behavior plugin: a fixed fragment you wire into your assistant with one import line in `CLAUDE.local.md`, your per-machine toggle file. It auto-loads because you added the line, and it leaves when you delete the line. See [plugins](/plugins/).

That keeps the axis clean. Knowledge sits in the vault, searchable and quiet. Behavior sits in the harness config, small and always on. Neither leaks into the other.

## Your harness has its own memory, so keep it thin

imprnt usually runs under Claude Code, and Claude Code ships a memory of its own, separate from the vault. The assistant writes a `MEMORY.md` about a project as it works, the first stretch of it auto-loads every session, it stays on your machine, and it lives outside `vault/`, so `recall` never sees it. That is genuinely useful for what the assistant learns about a repo. It is also a second always-on store you cannot search.

One rule keeps it from turning into a parallel version of the mess above:

- World and project knowledge goes in the vault, where `recall` finds it.
- A standing behavior or preference goes in the harness `CLAUDE.md`, or its auto-memory.
- The same fact never lives in both. Two copies drift, and one of them is invisible to search.

The failure to watch for is parking searchable knowledge in the store that cannot be searched. It is an easy one to commit. While building imprnt, project facts about the website and a plugin got written into the harness memory and had to be moved into the vault to be findable. Keep harness memory down to a handful of behavior facts and let the vault carry everything you will look up later.

## Where each thing goes

| You want to keep | Put it in | Auto-loaded | Found by recall |
|------------------|-----------|-------------|-----------------|
| A fact about a person, policy, or decision | a vault note | no | yes |
| A number, table, or record | a vault note, in full | no | yes |
| A primer of where things stand | `hot.md`, via `imprnt hot` | no | no, it is a control file |
| The filing rules | the vault contract, via `imprnt context` | no | no |
| A writing style or anti-slop ruleset | a behavior plugin in `CLAUDE.local.md` | yes | no |
| A standing instruction to the assistant | the harness `CLAUDE.md` or its memory | yes | no |
| Source transcripts and documents | a `raw/` snapshot | no | no |

## The pattern imprnt set out to avoid

imprnt grew out of [PAI](https://github.com/danielmiessler/PAI), which pointed the way and also showed where several memory stores start to blur together. PAI carried at least three, and all of them read like "memory":

- **USER/** held identity and life goals, auto-loaded every session through `@`-imports.
- **MEMORY/KNOWLEDGE/** was a curated, typed entity graph, fetched on demand.
- **MEMORY/LEARNING/** captured failures and successes as raw timestamped records, to be mined later.

Each loaded differently: always on, on demand, and capture-then-review. The responsibilities overlapped too. USER and KNOWLEDGE both answered "who am I and what am I working on." Two stores under MEMORY/ served opposite ends, one curated and permanent, one raw and temporal. The practical cost was the question this page opened with: you could rarely say where a fact lived or whether the assistant would see it.

imprnt collapses that into one knowledge store with three on-demand doors, plus the harness's small always-on behavior layer. A single question routes anything you want to keep: is it knowledge or is it behavior. Knowledge goes to the vault and is found by search. Behavior goes to the config and loads every time. PAI imposed a fixed set of stores you took whole. imprnt gives you one store and one rule, then lets you compose the rest. The longer record of these calls is in [design decisions](/design-decisions/).
