# Recall — workflow

Let `KF` = the imprnt repo. Vault defaults to `./vault` (pass `--vault DIR` if the user named one).
This is the hybrid: **LLM (shapes the question into keywords) → code (`recall` ranks with BM25) → LLM
(reads top hits)**. The LLM is at the two ends only; it is never in the middle.

## Step 1 — shape the question into search terms (you, conscious, cheap)

From the user's plain-language ask, pick the few keywords + candidate tags that actually carry the
query. You already hold the question — this is the cheap conscious end. BM25 scores each note by how
distinctive your terms are (a rare term counts more than a common one) and weights title/tag hits above
body, so the goal is **the few words that name the thing**, not a sentence:
- **Reduce to 1-3 topical content words.** "what's the STATUS of the Voronezh MOVE" → `voronezh`;
  "what do I BELIEVE about money" → `beliefs finances` (or just `money`).
- **Drop intent/filler words** — `status`, `move`, `about`, `what`, `current`, etc. (the engine also
  strips a lean stopword list, but tighter input is better input).
- Prefer the canonical tag/word form (the `_tags.md` canonical) and the specific term over a broad one.

You don't have to AND-fit the note any more: BM25 is additive, so one matched distinctive term still
scores and ranks — there's no false "no matches" from a single absent word.

## Step 2 — BM25 ranked search (CLI, free)

```sh
imprnt recall "<keywords>" [--vault DIR]
```

`recall` normalizes each word through `vault/_tags.md` (`AMT → taxes`), then BM25-ranks every note over
its title/tags/body (rare terms float up, title/alias hits outweigh body) and returns a TIGHT, well-
separated set — top ~15 by default (`--limit N` to widen; you rarely need to). No MCP, no embeddings, no
whole-vault dump, no per-query LLM re-ranking.

## Step 3 — on a thin or empty result, broaden once (NON-OPTIONAL)

BM25 rarely returns nothing when a real term matches. If it does (or the top scores look uniformly weak),
auto-retry **once** with the single most topical word or a known canonical synonym (a new German term for
the tax office → `taxes`) before telling the user "no match". Do **not** read the whole vault to
compensate — that's the unconscious trap the ranker exists to prevent.

## Step 4 — read only the top hits (you, conscious)

Read the highest-scoring notes (start with title/tag hits). Stop when you have enough — you rarely need
the bodies of low-ranked hits. This is scoped loading: you pulled the tax notes, not the beer ratings.

## Step 5 — present, then act

Give a tight brief of what's known on the topic (decisions, owners, open questions, linked entities),
grounded in the notes — not generic knowledge. If they then ask for work ("draft the plan"), do it from
this retrieved context.

## Correction = the only learning

If the user corrects the match ("no, not that — I meant the tax office"), append the synonym to the
`## Synonyms` section of `vault/_tags.md` (`<their word> -> <canonical>`). That one deterministic edit is
the entire learning loop. Never run a workload to evaluate whether retrieval "worked".
