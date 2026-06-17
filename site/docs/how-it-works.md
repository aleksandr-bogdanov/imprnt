---
title: How it works
description: Spend the AI once, when you file. Read with cheap local code, every time after.
---

imprnt is plain **markdown** files on your computer. No database, no cloud, no app to log into. You talk to your assistant and it drives imprnt underneath, filing what you tell it and recalling what you ask.

A model costs money every time it thinks, and it forgets everything between sessions. So imprnt keeps it out of the mechanical jobs (parsing, filing, searching) and spends it on the one job that needs **understanding**. Which side a step falls on comes down to one question: **how often does it run?**

- **Filing runs once** per source. Turning a messy transcript into clean notes takes real understanding, so the model does it.
- **Reading runs all day.** Ranking notes for a search is arithmetic, so plain code does it, with no model anywhere near.

That is the whole trick: pay the model for the rare hard job, keep it out of the job you do a hundred times a day.

## The shape

The loop runs left to right and starts and ends at your assistant: you talk, the model understands and files once, plain code searches thousands of times, the model reads the best hits and answers.

<figure style="background:#f5f3ec;border-radius:12px;padding:1.25rem;margin:0;overflow:auto">
  <img src="/architecture.svg" alt="imprnt architecture: the loop from Claude through ingest, the vault, and recall, back to Claude" style="display:block;width:100%;height:auto" />
</figure>

## When you file: the model works

Hand over a transcript or a document, and imprnt runs one pass of four steps. Only one spends the model:

1. **Copy** (code): the source goes into `raw/` untouched, hashed, with the obvious structure pulled out. Free.
2. **Understand** (the model, the only paid step): for each thing in the source, pick its type and [folder](/vault-layout/), write a one-line summary, pull the decisions and actions, and tag it with the words you will search for later, even if the source never used them. A dense source fans out into several small notes here.
3. **File** (code): match names and aliases against the entity folders, merge instead of duplicating, write the note.
4. **Tidy** (code): `check` rebuilds the index and flags any note that links nothing, matches no entity, or has no tags. It never blocks and never silently drops anything.

"Not sure where this goes? Hand it to the model" is fine here. The thing to avoid is throwing everything at the model on every **search** and hoping for magic.

## Fixing a fact costs one edit

Say you filed a colleague as Carl, an Engineer, and a later meeting reveals he is Boris, a Director. That sounds like hunting down every note that mentions him. It is not. Filing looks him up by **alias**, finds the existing note, fixes that one note, and adds "Carl" to the aliases so old references still resolve. Every other note points at him by his permanent file ID, so fixing that one note shows the right name and role across every meeting and project.

A contradiction is the special case. If a new meeting says a date moved, filing updates the note and stamps the old line as **superseded**, so search can tell the live fact from the stale one. Old information is marked, never quietly overwritten.

## The originals are never touched

Your raw sources are kept forever, one folder per source under `raw/`. To change how notes are structured, re-run filing over the originals and get the new layout for free. You are never stuck in an old format, and any claim in a note traces back to its **snapshot**.

## When you read: plain code works

`recall` ranks your notes with **BM25**, a formula from the 1990s that is pure arithmetic. It counts how often your search words appear, and weighs a rare word heavier than a common one. A word in the title counts more than the same word in the body.

No model, no embeddings, no vectors, no server. The model only turns your question into search words at the start and reads the few best notes at the end. It never does the **ranking**.

Because a rare matched word floats to the top on its own, you get a short, sharp list of hits, not a dump of the whole vault.

Does plain search hold up? We put a number on it. Across the two example vaults and 39 everyday questions, imprnt ranks the **right note first** about 9 times in 10, and lands it in the top five (the handful the assistant reads) about **97%** of the time. It is a small test and the number will move, but you can run it yourself with `bun run eval`. The harness lives in [`eval/`](https://github.com/aleksandr-bogdanov/imprnt/tree/main/eval).

## The whole thing on one line

Who does each step, and why:

| Step | Who | Why |
|------|-----|-----|
| Copy the source, hash it, log it | code | mechanical, exact, free |
| Read messy prose to find its shape | model | nothing to parse, it takes reading |
| Pick the type, write the summary, pull decisions | model | needs real understanding, the conscious work |
| Assign tags, set the kind, wire the links | model | judgment about meaning, paid once |
| File the note in its folder | code | once the type is decided, writing is mechanical |
| Rebuild the index from every summary | code | a plain read over the note headers |
| Rank notes for a search | code | fast, free, clear, over thousands of notes |
| Turn a question into search words, read the top hits | model | it is the interface, with the question in hand |

## Why no search server

Every tool call the model makes costs tokens, whatever the wires look like. The two levers are **payload size** and **caching**. So imprnt does the heavy scan in code, hands the model a tight result, and caches locally to skip the re-fetch.

A live server answering search queries breaks both levers: a round-trip on every read, nothing cached. That is why there is no query layer over the vault. A plugin's `sync` is fine, because it is one batched call that caches locally, and everything after it reads the cache.

## Core plus plugins

The only thing always present is the core: the vault plus `ingest`, `recall`, and `check`. Everything else is an optional **plugin** you add or delete with one command, under one rule that keeps the core small: the core never knows a plugin exists. The how is in [How plugins work](/plugins/), the why in [Design decisions](/design-decisions/).
