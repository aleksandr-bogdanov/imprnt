# Retrieval eval

Turns imprnt's design argument into a number. The pitch is "BM25 over a well-tagged vault answers the questions you actually ask." This harness measures whether that holds, on imprnt's own task.

## What it measures

For each natural-language query it runs the real `recall` command, reads the ranked note paths, and checks where the gold answer note lands. It reports:

- **Recall@k** the fraction of queries whose gold note appears in the top k hits (k = 1, 5, 10).
- **MRR** mean reciprocal rank, `1/rank` of the first gold note, averaged. Rewards ranking the right note high, not just somewhere.

## This is not LongMemEval or LoCoMo

Those leaderboards score recall over auto-logged conversation dumps: a model captures thousands of raw turns, and the test asks whether the right turn can be found again. imprnt's task is different. The corpus is a small set of notes a person curated, typed, and tagged on the way in, and the query is a plain sentence whose answer is a known note. A number here does not compare to a number there. Different corpus, different task.

## Run it

```sh
bun eval/run.ts            # all corpora, summary numbers
bun eval/run.ts --show     # per-query hits and misses
bun eval/run.ts --k 20     # raise the top-k ceiling
```

Each `queries/<name>.tsv` pairs with `examples/<name>/vault`. A row is `query<TAB>gold[,gold2...]`, where a gold is a note path as `recall` prints it. A query is a hit if any of its gold notes lands in the top k. Add a corpus by dropping a new `<name>.tsv` next to a matching example vault.

## Current result

Two example vaults, 10 notes each, 39 queries total (as of 2026-06-15):

| Corpus | Queries | R@1 | R@5 | MRR |
|--------|---------|-----|-----|-----|
| digital-assistant | 23 | 91.3% | 95.7% | 0.935 |
| organization | 16 | 87.5% | 100% | 0.922 |
| **overall** | **39** | **89.7%** | **97.4%** | **0.929** |

The corpus is small and the queries are hand-written, so read this as an early signal, not a leaderboard claim. It says BM25 over a tagged vault tops the right note on the first try about nine times in ten, and gets it into the cheap top-5 set the model reads almost always.

The first run scored R@1 87.2% / R@5 94.9%. The lift came from one change this eval pointed at, below.

## The labeling rule, and why the number is conservative

Gold is the canonical note that is the subject of the query. For "who is my doctor" that is the doctor's own note, not the owner note that happens to link to it. So a query counts as a miss even when a hub note in the results already states the answer. In real use the assistant reads the top hits and would still answer correctly from the hub note, so the true "did the user get their answer" rate sits above the R@1 here.

## What the eval fixed, and what is left

The first run missed "who is my doctor" (it returned the owner note `sam-rivera`, whose body says "Primary doctor is Dr. Elena Costa", over `dr-elena-costa`). The doctor's own note carried "doctor" only in its `summary`, and `recall` did not index the `summary` field. An outbound wikilink mention outranked the entity itself.

The fix held to every principle: `recall` now indexes the `summary` at body weight, parsed with the same reader (`fmScalar`) `check` uses to build `index.md`. No model on the read path, no new field a person fills, just searching a curated line the note already carries. It flipped the doctor query to the right note and lifted the overall numbers (R@1 87.2 to 89.7, R@5 94.9 to 97.4). Weighting the summary at body level, not tag level, is deliberate: a sentence carries glue words, so a rare body term ("ferritin") should still outrank a generic summary word ("result").

What is left is a real ceiling, not a bug:

- **"what do I do for work"** returns `identity/mission` (its body has "choose the work") over `sam-rivera`, whose note describes the job as "product designer, freelance" and never uses the word "work". BM25 cannot bridge that without a synonym, and a `work -> job` synonym is vault-specific. This is the honest edge of keyword retrieval: when the note shares no surface word with the question, lexical search will not find it. Adding it to `_tags.md` synonyms is the local lever if a given vault needs it.
- **"what was my ferritin result"** now lands `health/sleep-stack` at the top (its summary ends "the result") with the ferritin note at rank 2. Still in the top-5 the model reads, and a defensible match on the word "result". The cost of indexing the summary is a few generic-word matches like this. Net the change is clearly positive, which is the call the eval exists to let you make on evidence instead of taste.
