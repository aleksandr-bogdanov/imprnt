---
title: How it works
description: imprnt rations the model by where it runs. Write once with judgment, read with cheap local code.
---

imprnt rations the model by where it runs, not by how much it runs. The line is drawn by how often a step happens.

- The **write path** runs once per source. Reading a messy source into structured knowledge is irreducibly semantic, so the model earns its keep here.
- The **read path** runs thousands of times. Ranking notes for a query is local arithmetic, so it stays plain code with no model in the loop.

This is the whole discipline. Spend the model on the rare, hard, conscious work. Keep it out of the path you run all day.

## The write path

When you hand over a transcript or a document, the model does the conscious work, one time:

- Reads the prose and finds its structure.
- Picks the note type and the folder it belongs in.
- Writes a one-line summary.
- Pulls out the decisions and actions with judgment.
- Assigns tags and sets the note's kind.
- Wires links to the people, orgs, and projects it mentions.

"Not sure, hand it to the model" is a first-class move here. That is conscious use. The thing to avoid is dumping everything at the model on every read and expecting magic.

## The read path

`recall` ranks your notes with BM25, a term-frequency formula from the 1990s that is pure local arithmetic. Term frequency times inverse document frequency, with field boosts so a term in the title or aliases outweighs the same term in the body.

No model in the loop, no embeddings, no vectors, no server. The model only shapes your question into keywords at the front and reads the top hits at the back. It is never the ranker.

BM25 is the core ranker, not an opt-in. Its inverse-document-frequency already floats a rare matched term above a common one, so it returns a tight, well-separated set rather than the whole vault.

## The line, step by step

| Step | Who | Why |
|------|-----|-----|
| Snapshot the source, hash it, update the manifest | code | mechanical, exact, and free |
| Read unstructured prose to find its structure | model | there is nothing to parse, it takes reading |
| Pick the type, write the summary, pull decisions | model | irreducibly semantic, the conscious work |
| Assign tags, set the kind, wire the links | model | judgment about meaning, paid once |
| File the note into its folder | code | once the type is decided, writing is mechanical |
| Rebuild the index from every summary | code | a deterministic read over frontmatter |
| Rank notes for a query (BM25) | code | fast, free, transparent, over thousands of notes |
| Turn a question into keywords, read the top hits | model | it is the interface, with the query and results in hand |

## The honest cost model

There is no token-free tool call. Anything the model reads costs tokens, whatever the transport. The two real levers are payload size and caching. Do the heavy scan in code and hand the model a tight result, and keep a local cache so you avoid the re-fetch.

This is why a query layer over the vault is out. A per-query round-trip to a running server, with no cache, pays the cost on every read. A plugin's `sync` edge is fine, because it is a batched call that caches locally and everything downstream reads the cache.
