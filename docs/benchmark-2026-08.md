# What happened when we benchmarked imprnt

Written 2026-08-01. Internal. Not linked from the website and not announced until v1.1.

This is the long version of a day's work. It is here so that the decisions are recoverable later, so the numbers can be re-run by anyone who doubts them, and so a future article has something honest to be built from. Everything below is reproducible with commands in this repo.

---

## The short version

We set out to see whether imprnt could beat Letta, a funded memory company, on the benchmark they publish a number for. Three things came back.

**We lost the fair fight.** Running the same model Letta ran, on their benchmark, with their grader and their judge, imprnt scores 58.6% against their published 74.0%. The confidence intervals do not overlap. This is not a sampling problem and it is not a measurement artefact.

**The scoreboard everyone in this category quotes is softer than any of the numbers on it.** Grading one fixed set of imprnt's answers with a different judge model, changing nothing else, moved the result by nine points. Every published figure in this space sits inside a 68-75% band that is narrower than that.

**Five read-path improvements made retrieval 26% better and answer quality 0.13 points better.** That gap between "the retrieval got better" and "the answers did not" turned out to be the most useful thing we learned, and it is what killed the plan we started the day with.

---

## Why we did it at all

The comparison page carried a claim borrowed from Letta's blog: that a plain-files approach scored 74.0% on a benchmark, ahead of Letta's own specialised memory tools and ahead of mem0. It was the strongest evidence on the page precisely because it came from a competitor arguing against their own prior product.

Borrowing someone's number is fine. Standing next to it is not, unless you have run the same test. So we ran it.

---

## What LoCoMo actually is

LoCoMo comes from the paper *Evaluating Very Long-Term Conversational Memory of LLM Agents* (Maharana et al., arXiv 2402.17753). It is ten very long conversations between two people, each spread across many sessions over months, with 1,986 questions about them.

The questions are deliberately awkward. They fall into five categories:

| category | what it asks | count in our run |
|---|---|---|
| single-hop | a fact stated in one place | 638 |
| multi-hop | a fact you must assemble from several sessions | 282 |
| temporal | when something happened, or in what order | 321 |
| open-domain | an inference the conversation supports but never states | 299 |
| adversarial | questions with no answer, to catch confident invention | 446 |

The benchmark exists because a memory system that only handles single-hop lookups is not doing the hard part.

**A vendor running LoCoMo almost never runs all of it.** Letta drops the adversarial category outright, leaving 1,540 questions. So does mem0. So does Zep. We matched that, because the goal was comparability, and we say so every time we print the number.

---

## How the measurement works

The pipeline has four stages, and only one of them is imprnt.

**Ingest.** Each conversation is fed to imprnt, which reads it and files it into a vault of markdown notes: people, events, projects, decisions. This is the write path, and it uses a model. One conversation becomes about 62 notes.

**Retrieve.** For each question, `imprnt recall` runs BM25 over the vault and returns the top fifteen notes. No model. This is the part the whole product argument rests on.

**Answer.** A model is given only those fifteen notes and the question, and must answer in a short phrase. It never sees the original conversation.

**Grade.** A judge model compares the answer to the gold answer and returns correct, incorrect, or not-attempted. We use Letta's own grader template, unmodified, pinned at their commit `47352a2`, and the judge model their code specifies, `gpt-4.1`.

The last two stages are where almost all the cost and all the noise live, which matters later.

---

## The results

Three arms. Same vault, same questions, same grader, same judge. One variable changes at a time.

| arm | answering model | retrieval | score | 95% CI |
|---|---|---|---|---|
| A | gpt-4o-mini | shipped | **58.64%** | 56.2 - 61.1% |
| B | Claude Sonnet | shipped | **76.30%** | 74.2 - 78.4% |
| C | gpt-4o-mini | upgraded | **58.77%** | 56.3 - 61.2% |
| - | Letta, as published | gpt-4o-mini | 74.00% | not stated |

n = 1,540 per arm. Zero unjudged questions in all three.

### Arm A: the honest comparison, and we lose

Letta's run used gpt-4o-mini. Ours does too. Everything else that could differ is held fixed. imprnt scores **58.6% against their 74.0%**, roughly fifteen points behind, with no interval overlap.

That is the number that means something, and it goes first everywhere we publish.

### Arm B: what a better model buys

Swapping the answering model to Claude Sonnet moves imprnt to **76.3%**, a gain of **+17.7 points** from the model alone.

That number is not a rebuttal to Arm A and we do not present it as one. Comparing our Sonnet result to their gpt-4o-mini result would be comparing two different things, which is the exact move that makes everyone else's numbers untrustworthy.

What it does tell you is something real about imprnt's design: **it leans on the answering model much harder than Letta's does.** imprnt hands over fifteen whole notes and expects the model to find the answer inside them. A weak model does that badly. Letta's agent narrows further before the model ever sees anything, and can search again when it misses. That difference is worth about seventeen points, and it is a genuine architectural trade, not a bug.

### Arm C: the improvements that did nothing

We built five read-path improvements and measured the best combination end to end.

| | |
|---|---|
| retrieval, right note in first position | 19.7% → **24.9%** (+26% relative) |
| answer quality, end to end | 58.64% → **58.77%** (+0.13 points) |
| paired McNemar | 81 fixed, 79 broken, **p = 0.937** |

**Retrieval got 26% better and the answers did not change at all.**

The explanation is uncomfortable and obvious in hindsight. The answering model receives all fifteen notes regardless of their order. Putting the right one first only helps to the extent the model reads earlier text more carefully, and apparently it does not care much.

This is the most valuable result of the day, because it kills the plan we started with. We had been about to spend the next release on ranking quality.

---

## The finding that undermines the whole scoreboard

Take one fixed set of imprnt's answers. Do not change a single character. Grade it twice with different judge models.

| judge | score |
|---|---|
| Claude | 68.42% |
| gpt-4.1 (Letta's own) | **77.63%** |

**Nine points, from the grader alone.** Agreement between the two judges is 89.5%, Cohen's kappa 0.736, and the disagreements run almost entirely one way: gpt-4.1 marked an answer correct where Claude did not **fifteen** times, and the reverse happened **once**. Claude is systematically the stricter grader.

Now compare that to the spread between every published number in this category: mem0 at 68.44%, Letta at 74.0%, Zep at 75.14%. **The entire distance between all of them is smaller than the effect of changing who marks the paper.**

This is not an accusation against any vendor. It is a statement about what a LoCoMo percentage can support. Any figure published without naming its judge model is close to meaningless, and that includes ours until we name ours, which is why we always do.

---

## What we found in other people's published numbers

We audited the competitive claims before putting any of them on a page, then had a second pass try to refute the first. Several of the more dramatic findings did not survive that, and the retractions matter as much as the findings.

**Letta's 74.0% cannot be reproduced from what they published.** Their benchmark code exists and their blog deep-links a specific line of it, and that link still resolves. But the post states no question count, no category set, no repeat count, and no chunking, and no run configuration or result file is recoverable from the repository. So the number cannot be checked, which is a narrower and fairer statement than the first pass produced.

*Retracted from the first audit:* that the number "traces to nothing", that no runner exists, and that the benchmark had been deleted. All three are false. The runner exists and is invocable, the blog's link is accurate, and nothing was deleted.

**mem0's README numbers do not match mem0's own committed data.** Recomputed from their per-question result files: 91.56% against a published 92.5%, and 82.66% against a published 91.8%. The commit that set those README values changed one file, `README.md`, sixteen lines, and the previous values had matched the data exactly. mem0 does document a methodology change in the commit message, and that has to be quoted alongside the discrepancy for the claim to be fair.

**Zep's 75.14% recomputes correctly** from their committed per-question grades, to 75.13%. Two of their four published category scores are transposed against their own data.

**A claim we tested and dropped.** An audit reported that the LoCoMo judge accepts 62.81% of deliberately-wrong answers, which would have been damning. Checked properly, those "wrong" answers are mostly correct-but-coarser paraphrases: "Single" answered as "Not currently in a relationship". On the temporal subset, 82.8% of accepted answers name the same year as the gold and only 2.0% actually contradict it. The figure that measures acceptance of genuinely wrong answers is **10.61%**, which cuts the opposite way. A separate "43.67% judge-human agreement" figure could not be established at all: it appears only in a README, in an anonymous single-repo account, with no annotations or scoring script committed.

We nearly published all three of those. They are in this document as retractions instead.

---

## The read-path work

Five changes, all pure local arithmetic, all shipping as optional flags that are **off by default** in v1. Nothing below changes how imprnt behaves unless you ask for it.

| flag | what it does | why |
|---|---|---|
| `--stem` | folds inflections, so "swimming" matches "swim" | nothing in the pipeline did this, so a query and a note could describe the same thing and never match |
| `--coverage` | rewards matching more *distinct* query terms | BM25 sums per term, so one term repeated could outrank a note matching three different ones |
| `--proximity` | rewards query terms sitting near each other | BM25 discards word positions entirely: "double charge" adjacent and 200 words apart score identically |
| `--gap` | cuts the result list where scores fall off a cliff | a fixed top-15 ships noise. In the shipped example the top hit scores 3.73 and the fifth scores 0.09 |
| `--passages` | returns the best paragraphs of a note, not the whole file | one question handed the model 31,000 characters |

### How we measured them without spending anything

Running each candidate through the full answer-and-judge pipeline would have cost hours per configuration and drowned every result in the nine-point judge noise described above.

So we measured retrieval directly instead. Replay the queries already recorded from a finished run, against the real `recall` binary, and record two things: whether the gold answer survives into the returned context, and at what rank. No model, no judge, no API calls. About a minute per configuration across all ten conversations.

**We validated the proxy before trusting it.** Questions whose gold answer reached the context were graded correct 83.7% of the time. Questions where it did not, 37.5%. A 46-point separation is enough to rank configurations honestly.

### The sweep

1,540 questions, all ten conversations, every configuration:

| configuration | hit@1 | @3 | @5 | @15 | MRR | median tokens |
|---|---|---|---|---|---|---|
| baseline | 19.7% | 32.2% | 37.3% | 41.5% | 0.268 | 5050 |
| `--stem` | 20.9% | 32.8% | 37.7% | 41.9% | 0.277 | 5100 |
| `--coverage` | 20.4% | 33.1% | 38.1% | 41.5% | 0.276 | 5062 |
| `--proximity` | 22.0% | 33.8% | 38.2% | 41.5% | 0.287 | 5060 |
| stem + coverage | 21.9% | 33.8% | 38.4% | 41.9% | 0.287 | 5126 |
| stem + proximity | 23.3% | 34.7% | 38.9% | 41.9% | 0.298 | 5134 |
| **stem + coverage + proximity** | **24.9%** | **36.2%** | **39.6%** | 41.9% | **0.311** | 5148 |
| the above + `--gap` | 24.9% | 36.2% | 39.5% | 41.8% | 0.311 | 5075 |
| the above + `--passages 3` | 22.1% | 31.4% | 34.2% | 37.0% | 0.273 | **1688** |

All three stack. `--gap` is free: identical accuracy, fewer tokens. `--passages` is a different trade entirely, cutting context by 67% at the cost of recall, which is why it is not part of the recommended bundle.

### The result that should temper all of it

**Look at the @15 column.** It moves from 41.5% to 41.9%. Essentially nothing.

Every gain in that table is *reordering notes BM25 had already found*. **In 58% of questions the right note is never retrieved at all**, and none of the five changes touches that. That is the real ceiling, and it is why Arm C moved 0.13 points: better ordering of a candidate set that is wrong more than half the time does not produce better answers.

Closing the fifteen-point gap to Letta is a retrieval-recall problem, not a ranking problem. We now know that, and we know it cost about a day to learn instead of a release.

### They are safe to switch on

Checked before recommending them as defaults in v1.1:

- **imprnt's own eval improves too**, not just LoCoMo: R@1 89.7% → 92.3%, MRR 0.929 → 0.942. Nothing regressed at any k.
- **No runtime cost.** On a real 308-note vault: 157ms baseline, 134ms with all three. Within noise.
- **Non-English text is untouched.** The stemmer skips any token not ending in an ASCII letter, so Cyrillic and CJK pass through unchanged. Verified on `страховка`, `полиса`, `встреча`. English edge cases behave: `bus`, `wing`, `bring`, `business`, `serious`, `analysis` all left alone, while `swimming` → `swim`, `policies` → `policy`, `running` → `run` fold correctly.

---

## Five ways a benchmark lies to you

Four of these were in our own harness. Every one produced a plausible number rather than an error, which is exactly why they are dangerous.

**A failed judge call scored as a wrong answer.** A bare `catch` turned an API failure into "not attempted", which counts as zero. A rate-limited run produced 32.24% and looked like a catastrophic result. Ninety of 152 grading calls had simply died. Fixed: an unjudged question is now excluded from the denominator and shouts about it.

**A failed answering call scored as a wrong answer.** The same bug in the other half of the pipeline. One conversation scored 36.08% against 70-81% everywhere else, because 82 of its 204 answering calls had hit a subscription limit and every one was graded as a miss. After repair it scored 80.38%.

**A join that silently matched nothing.** Analysis code parsed a conversation id by slicing a filename at a fixed offset, producing `-50` where the join expected `50`. It matched zero rows and reported "0 excluded", which looked like a clean result. This is the same class of error we found in a competitor's published category table.

**A metric blind to the thing it was built to detect.** The first version of the retrieval harness measured only recall@15. Coverage and proximity are *ranking* changes, so they scored identically to baseline and read as null results. Adding rank tracking revealed a +26% effect that had been invisible.

**A run that succeeded in nine seconds with no API key.** Launched through a shell that did not load the environment, so every model call failed instantly. It reported completion with a $0 bill. Only the loud-failure fix from the first item exposed it. The original code would have produced a believable low score.

The lesson is not that we are careless. It is that in a benchmark pipeline, **a broken run and a bad result look identical unless you build the difference in deliberately.**

---

## Reproducing this

Everything is in the repository. Nothing below needs our cooperation.

```bash
# the retrieval sweep: no model, no API key, about a minute per configuration
cd imprnt-locomo
bash sweep.sh                       # all configurations, all ten conversations
cat sweep.log

# imprnt's own retrieval eval, 39 hand-written questions
cd imprnt
bun eval/run.ts                                                    # shipped behaviour
bun eval/run.ts --recall-extra "--stem --coverage --proximity"     # with the upgrades

# a single recall, to see the read path directly
bun packages/imprnt/scripts/recall.ts "double charge billing" \
  --vault examples/organization/vault --limit 5
```

Re-running the full LoCoMo arms needs the dataset and two API keys (one for the answering model, one for the `gpt-4.1` judge). The harness, every prediction, every judge verdict and the scoring scripts are committed, so any number in this document can be recomputed from the artefacts without re-running anything.

**Cost and time, measured:** one arm is about 1,986 answering calls and 1,540 judging calls. On gpt-4o-mini for answering and gpt-4.1 for judging, that is a few dollars and roughly two hours, most of it waiting on the judge's rate limit.

---

## What we still do not know

**Why Letta does better on a weak model.** The hypothesis is that they narrow harder before the model sees anything, and can search again after a miss. That would mean their advantage comes from putting a model *inside* the retrieval loop, which is the thing imprnt's design explicitly refuses. We started reading their source to confirm it and did not finish. One early finding: the current release has no file-search tool at all, which sits oddly with the "filesystem approach" their blog credits for the 74.0%.

**Whether they hold up on a modern model.** Their published number is on gpt-4o-mini, a 2025 model. Nobody has run Letta on Sonnet. Until someone does, "we score 76.3% with Sonnet" and "they score 74.0% with gpt-4o-mini" are two facts that cannot be put in the same sentence.

**Whether any of this survives a real vault.** Our test vault is about 62 notes, so returning fifteen hands back a quarter of everything. That is the easy case for a retriever. A vault of several thousand notes is the case that actually matters, and none of these numbers speak to it.

**Whether LoCoMo is still the right benchmark.** It is from 2024. Newer ones exist, and at least one ships its own local judge, which would remove the single largest source of noise documented above.
