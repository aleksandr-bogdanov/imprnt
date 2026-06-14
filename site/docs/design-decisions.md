---
title: Design decisions
description: The durable calls behind imprnt, why they were made, and what would flip them.
---

imprnt grew out of [PAI](https://github.com/danielmiessler/PAI), a personal-AI system that pointed the way and also showed, in practice, where a few design choices create friction at scale. Most of the decisions below are imprnt taking a lesson from that and committing to the other path. This page is the record of what was decided and what would have to change for a decision to flip.

## Ration the model by frequency, not by rule

Deterministic-first does not mean "avoid the model." It means spend the model where it pays and keep it out of the hot path. The axis is how often a step runs.

- The **write path** runs once per item, so it earns the model: read the prose, choose the type, write the summary, pull decisions, assign tags, wire links.
- The **read path** runs thousands of times, so it stays cheap, deterministic, and local: grep plus BM25 ranking, no model in the loop.

"The dumbest thing that works" is measured against the model. BM25 is pure local arithmetic, so it is the default ranker, not an opt-in. This flips only if a read-time quality problem appears that no local ranking can fix, and even then the move is a better local index, never a model in the loop.

## Retrieval is BM25, not embeddings or a query layer

`recall` ranks with standard BM25 (term frequency times inverse document frequency) with title and tag boosts. No per-query model re-ranking, no embeddings, no vectors, no protocol over the vault. Inverse document frequency floats a rare matched term above a common one, so it returns a tight, well-separated set. The scaling path stays local at every step: a full scan to about 10k notes, a grep-prefilter then BM25 to about 100k, a persistent inverted index above that. Scaling adds a local index, never a vector store or a model.

A protocol over plain files would cost orders of magnitude more tokens than grep and would go stale on every edit. Vector search sounds smarter but costs more, re-indexes on every change, and hides why it matched. BM25 over plain text is free, transparent, and good enough once notes are tagged well on the way in.

## The data is the knowledge

A note must carry the source's structured payload in full: tables as tables, IDs, numbers, dates, prices, verbatim legal text. The summary is in addition to the data, never instead of it.

The reason is mechanical. `recall` searches `vault/` only, so anything left in `raw/` is invisible to retrieval. Summarizing a catalog to prose and pointing at the snapshot silently deletes that knowledge, because the rows were the note. This rule earned its teeth from a real failure: a vault rebuild kept the prose summaries and left the tables and records behind in `raw/`. The fix is a stated invariant (enrich adds, never removes) and a falsifiable check, the lookup test: could you answer a specific question from the vault note alone?

## Layout is domain-first, with cross-cutting entity folders

An earlier type-first layout produced a junk drawer: a single typeless `notes/` bucket grew to nearly half the vault, because most of life's content is reference-about-a-domain with no type-home. The fix is to organize by life-area, the way a person actually browses their own knowledge. Folders are browse-drawers only. Search ignores them, so layout costs retrieval nothing.

The one thing kept from the type-first idea is that entities (people, orgs, holdings) get their own cross-cutting folders, because an entity is referenced from many domains and needs one canonical home. That resolvable-entity graph is the single real improvement over PAI, which kept knowledge as prose files without a typed entity layer.

## The core never knows a plugin exists

Core is the vault plus `ingest`, `recall`, and `check`. Everything else is a plugin. The one rule, with its litmus:

> You can add or remove any plugin with zero edits to the core.

This is the most important call, and it is a direct lesson from PAI. A core bloats when the dependency arrows point from core to module: the core imports, branches on, validates, and loads every subsystem, so every new capability grows it. PAI was built that way, and over time the core carried every feature as always-on overhead you paid for in tokens and misfires whether you used a feature or not. imprnt inverts the arrows. A plugin depends on exactly two things, your notes and its own folder, and the core stays blind to all of them. PAI shipped a fixed set you took whole. imprnt ships a small core plus plugins you compose, with a real off-switch.

## Copy the reader, share no core code

The roughly twelve lines a plugin needs to read a note's frontmatter are copied into each plugin. The core publishes no importable code as a contract. The reason is reversibility, not purity. If duplication later hurts, pulling the copies into one shared file is a five-minute change that breaks nobody. Un-publishing a shared tool that plugins already import is a breaking change and a magnet for "can it also do X?" creep. Copy is the move you can undo.

## Commands only, never a daemon

The core and every plugin ship commands. Scheduling them (cron, launchd, a watcher) is your opt-in. Nothing runs in the background just by being installed. A data plugin keeps its local mirror warm because you scheduled a token-free sync, not because imprnt runs a daemon. Always-on background machinery is the cost pattern imprnt was built to avoid: a tool that works without you ever thinking about it is also one you cannot audit, cannot stop, and do not fully own.

## Invariants are tests, not values

The most expensive lesson, and another from PAI: a principle written as a value ("be private," "ration the model") cannot be checked against reality, so it rots into recitation. PAI carried seventeen such principles. imprnt's answer is that an invariant earns its place only as a falsifiable check pointing at a specific failure it would have caught. "On the real corpus, recall tops the right note" is a test. "Deterministic-first" is a value. The first catches a regression on day one. The second gets quoted in a meeting.

## Privacy by being private

The whole vault is local and owner-only. There is no sensitivity field, no redaction pass, no secret-fencing, because the vault is meant to hold everything, including medical, financial, and personal data. The only rule is that it never goes near a public repo. Publishing a subset is an export-time filter you run consciously, not a tax paid on every note at ingest.

## imp is the front door, imprnt stays the engine

The package ships two commands from one dispatcher, split by audience. `imp` is for humans: typed in any directory it opens a Claude session there with the imprnt context riding along, and `imp lair` opens it inside the vault project. `imprnt` is for machinery: agents and scripts call `imprnt recall`, `imprnt check`, and the rest.

Two earlier models lost. Injecting imprnt into the assistant's global config pays tokens in every session forever, the always-on cost again. A launcher-only model left the vault unreachable from the coding repos where most of the day happens. The resolution is per-keystroke consent: typing `imp` instead of `claude` is the entire opt-in. Stock `claude` stays stock, nothing is written into the global config, and each session carries the context because you asked for it by name.

## Session context is demand-paged

What a session carries up front is decided by the same frequency axis. Always loaded: your enabled behavior plugins plus a small pointer that says the vault exists, when to search it, and the one entry point for writing. The full filing contract is never loaded up front outside the lair. `imprnt context` prints it on demand, so the rules are paid only by the sessions that actually write, at the moment they write. A read-heavy day costs a pointer, not the whole contract.
