---
title: How it works
description: Spend the AI once, when you file. Read with cheap local code, every time after.
---

> **In one line.** The AI is expensive, so imprnt only uses it once per thing you save. Finding stuff later is plain math on your own machine, free and instant.

A model costs money every time it thinks. So imprnt asks one question about every step: how often does this run?

- **Filing runs once** per source. Turning a messy transcript into clean notes takes real understanding, so the model does it.
- **Reading runs all day.** Ranking notes for a search is simple arithmetic, so plain code does it, with no model anywhere near.

That is the whole trick. Pay the model for the rare hard job. Keep it out of the job you do a hundred times a day.

## When you file: the model works

Hand over a transcript or a document, and the model does the thinking, one time:

- Reads the prose and finds the structure in it.
- Picks what each note is and which folder it lives in.
- Writes a one-line summary.
- Pulls out the decisions and the action items.
- Tags it, and links the people, orgs, and projects it names.

"Not sure where this goes? Hand it to the model" is fine here. This is the place for it. The thing to avoid is throwing everything at the model on every search and hoping for magic.

## When you read: plain code works

`recall` ranks your notes with BM25, a formula from the 1990s that is pure arithmetic. It counts how often your search words appear, and weighs a rare word heavier than a common one. A word in the title counts more than the same word in the body.

No model. No embeddings. No vectors. No server. The model only turns your question into search words at the start, and reads the few best notes at the end. It is never the thing doing the ranking.

Because a rare matched word floats to the top on its own, you get a short, sharp list of hits, not a dump of the whole vault.

> **Does plain search actually hold up?** We put a number on it. Across the two example vaults, 39 everyday questions, imprnt ranks the right note first about 9 times in 10, and lands it in the top five (the handful the assistant reads) about 97% of the time. It is a small test and the number will move, but you can run it yourself with `bun run eval`. The harness lives in [`eval/`](https://github.com/aleksandr-bogdanov/imprnt/tree/main/eval).

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

Every tool call the model makes costs tokens, whatever the wires look like. The two levers are how big the payload is and whether you cached it. So imprnt does the heavy scan in code, hands the model a tight result, and caches locally to skip the re-fetch.

A live server answering search queries breaks both levers: a round-trip on every read, with nothing cached. That is why there is no query layer over the vault. A plugin's `sync` is different and fine, because it is one batched call that caches locally, and everything after it reads the cache.
