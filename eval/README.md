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
| digital-assistant | 23 | 91.3% | 91.3% | 0.913 |
| organization | 16 | 81.3% | 100% | 0.887 |
| **overall** | **39** | **87.2%** | **94.9%** | **0.903** |

The corpus is small and the queries are hand-written, so read this as an early signal, not a leaderboard claim. It says BM25 over a tagged vault tops the right note on the first try most of the time, and gets it into the cheap top-5 set the model reads almost always.

## The labeling rule, and why the number is conservative

Gold is the canonical note that is the subject of the query. For "who is my doctor" that is the doctor's own note, not the owner note that happens to link to it. So a query counts as a miss even when a hub note in the results already states the answer. In real use the assistant reads the top hits and would still answer correctly from the hub note, so the true "did the user get their answer" rate sits above the R@1 here.

## What the misses teach

The misses are the useful part. From `--show`:

- **"who is my doctor"** returns the owner note `sam-rivera` (its body says "Primary doctor is Dr. Elena Costa"), not `dr-elena-costa`. The doctor's own note carries "doctor" only in its `summary`, and the `summary` field is not indexed. An outbound wikilink mention outranks the entity itself.
- **"what do I do for work"** returns `identity/mission` (its body has "choose the work") over `sam-rivera`, whose body describes the job without the word "work".

Both point at the same lever: a note's own role words (doctor, job title) need to live in an indexed field (body or tags), not only in the `summary`. Two candidate fixes worth testing against this harness before committing: index the `summary` line, or have ingest put an entity's role word in its tags. The eval is here to tell which one actually moves the number, instead of guessing.
