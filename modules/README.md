# knowful — opt-in modules

The core (`scripts/`) is the ingest → recall → hot loop. Everything here is **optional**:
install what you need, `rm -rf` what you don't. Nothing here runs unless you wire it in.
That's the composability rule — a module is a self-contained dir with zero cross-deps.

## guard/ — destructive-command guard ✅ built

A deterministic blocklist. `bun modules/guard/guard.ts "<command>"` exits `2` on obviously
dangerous commands (`rm -rf` on home/system paths, `sudo`, fork bombs, force-push to
main…) and `0` otherwise. Wire it as a PreToolUse hook on Bash if you let the agent run
shell. No LLM.

## bm25/ — ranked recall ✅ CORE (not a module)

BM25 is **not** here — it's the core ranker, built into `scripts/recall.ts`. It's pure local
arithmetic (term frequency × idf, with title/tag/body field boosts), zero LLM, zero deps, so it's
the *cheap* default the READ path runs thousands of times — exactly the kind of thing that belongs
in core, not behind an opt-in. The earlier "start with plain grep, defer BM25" plan was the error:
plain tiered grep floods or misses on a real ~150-note vault. There is no `bm25/` module to adapt.

## graph/ — orphan + duplicate lint ⏳ deferred (adapt from PAI)

Lift `~/.claude/PAI/TOOLS/KnowledgeGraph.ts` (BFS over frontmatter tags + wikilinks +
`related:`; `stats` / `hubs` / `related` / `find`). Repoint to knowful's folders. Use isolated-
node detection to push orphans into `_needs-review.md`. Deterministic, no LLM.
