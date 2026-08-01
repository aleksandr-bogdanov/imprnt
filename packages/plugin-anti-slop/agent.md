# Anti-slop rules

> Universal anti-AI-slop rules; applies to any prose the agent produces.
> These are the standards the agent applies whenever it produces prose - vault notes, docs, messages,
> deliverables. The bans below are what keep the output from reading like AI.

## Language scope: ENGLISH PROSE ONLY

These rules govern ENGLISH prose. They do NOT apply to Russian or any other non-English text.

- The punctuation bans are English-specific. In Russian the em-dash (тире, «—») is standard and frequently REQUIRED («Любовник — лирический герой»). Do not strip it. Use normal native Russian punctuation.
- The [B] word list and [C] phrase list target English slop. They are irrelevant to Russian.
- For Russian (or any non-English) prose, judge slop by THAT language's native tells (in Russian: канцелярит, штампы, кальки с английского), and above all do not translate from an English frame. Write in the target language directly. If you cannot, hand the prose to a native-language generation pass instead of applying these English rules to it.

## Scope of the anti-slop bans

**Mandatory** for any document the agent produces - output-facing prose (posts, articles, docs,
external messages, deliverables) **and vault notes** (clean knowledge, no AI tells). Hard bans there.

**Guidance, not a hard ban,** for the conversational back-and-forth seen in-session - lean
clean, but don't contort a normal reply to dodge a hyphen. The cost of slop scales with who reads it.

Framework scaffolding (template skeletons, field labels) is exempt everywhere - only *prose* is judged.

**Data is exempt too.** These bans govern narrative writing. Tables, rated lists, records, IDs, numbers, doses, prices, verbatim legal/clause text are DATA - keep them structured, in full. Never drop or collapse a table to obey an anti-slop rule. Losing the data to tidy the prose is the worst slop of all.

## [A] Forbidden punctuation / typography

- Em-dash and en-dash (`—`, `–`). Never. Use a plain hyphen-minus `-` or split into two sentences. Forget these characters exist.
- Semicolon. Never. Use a period and start a new sentence.
- Curly / smart quotes. Always plain ASCII `"` and `'`.
- Ellipsis character `…`. Use three plain dots `...` if really needed.
- Non-breaking space and exotic spaces. Plain space only.
- Asterisk-bold (`**word**`) inside otherwise plain prose. Skip the emphasis or rewrite so the word lands without bold.
- Emoji-as-bullet at the start of every line (no leading 📌 ✨ 🚀 etc).
- **Hard-wrapped prose.** Never break a paragraph at a fixed column (72, 80, 100) by inserting newlines mid-sentence. A paragraph is ONE line in the file and the reader's editor or browser wraps it. Hard wrapping makes every later edit reflow the whole block, ruins diffs (a one-word change rewrites six lines), and reads as machine-formatted rather than written. This applies to markdown, docs, vault notes, commit message BODIES, and any prose file. It does NOT apply to code, code comments, tables, or YAML, where a column limit is a real convention.

## [B] Forbidden words (any form: -ing, -ed, -s, -ly)

delve, leverage (verb), harness (verb), navigate (metaphor), unleash, unlock, robust, seamless, myriad, plethora, tapestry, realm, landscape, ecosystem (metaphor), journey (personal-narrative noun), elevate (transitive), empower, underscore (verb), showcase (verb), foster (loose use), pivotal, crucial, vital (filler intensifiers), comprehensive, holistic, meticulous, captivating, intriguing, fascinating, remarkable, embarrassingly, signal (any form when used as filler), indeed (especially as one-word opener), cutting-edge, state-of-the-art, next-generation, ever-evolving.

## [C] Forbidden phrases

"It's worth noting that...", "It's important to note that...", "That said," (as a pivot), "In essence,", "At its core,", "Ultimately," (as closer), "In conclusion,", "To put it simply,", "In a nutshell,", "Let's dive into" / "Let's unpack" / "Let's explore", "When it comes to...", "In today's fast-paced world", "In the realm of...", "Game-changer" / "paradigm shift" / "sea change", "A double-edged sword", "The intersection of X and Y", "Stand the test of time", "Push the boundaries", "More than just X", "X is more than [just] a Y", "Whether you're a beginner or a seasoned ...", "Buckle up" / "Strap in", "Without further ado", "I hope this helps", "Here's the thing:".

## [D] Forbidden rhetorical patterns

- **Negate-then-affirm in any form.** Banned regardless of punctuation between the two halves.
  - Same-sentence: "this is not X, this is Y" / "it's not X, it's Y" / "not just X, but Y" / "this isn't X, it's Y"
  - Across-sentence: "These are not X. They are Y." / "This isn't X. It's Y."
  - Across-paragraph: opening a paragraph with "These are not X" right after a paragraph that hinted at X
  - State what the thing IS. Drop the negated contrast entirely. If readers might think it's X, they will figure out it isn't from the affirmative description; you don't have to disabuse them first.
- **Choppy declarative parallels.** Series of 2-6 word sentences in a row, especially in threes, that announce structure or restate the obvious. "Three pieces. Each is useful on its own. They compose well together." / "Two reasons. Both apply here. Both matter." Either combine into one normal sentence or commit to a single declarative without the parallel cadence. This reads as ChatGPT's signature rhythm and gets called out instantly.
- **Mid-argument rhetorical questions.** "But is it really?" / "What does this mean for you?" Answer the question instead.
- **Three-sentence paragraph closing on a one-line dramatic statement.** "And that changes everything." / "Game over." Just stop when the point is made.
- **Closing line that re-states the title or opening claim.**
- **Forced symmetry.** Pros/cons or upsides/downsides with the same item count when reality is lopsided. Match the count to the truth.
- **Qualifier hedge.** "while it's true that X, it's also worth considering Y." Pick one and commit.

## Quick self-check before sending (documents / output-facing / vault notes)

1. Scan for `—` and `–`. Replace with `-` or a sentence break.
2. Scan for `;`. Replace with `.`.
3. Scan for any [B] word. Rephrase.
4. Scan for any [C] phrase. Rephrase.
5. Check the [D] rhetorical patterns. Rewrite if any is present.
