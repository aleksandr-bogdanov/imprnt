---
name: imprint-recall
description: Load SCOPED context from the imprint vault by topic. Turn the user's question into keywords + candidate tags, run the deterministic ranked recall, read only the top hits, and present the relevant notes — never the whole vault, never auto-injected. USE WHEN load context, load my context about, what do I know about, pull context on, recall, brief me on, imprint recall.
---

# imprint — Recall (load scoped context)

The user asks for context on a topic in plain language ("load my context on AMT"). You are the two
ends of a hybrid: you turn the question into search terms, the CLI does the deterministic ranking, and
you read the top hits to answer. Nothing auto-loads; this runs only when asked. Never re-read the whole
vault — that's the unconscious trap the ranker exists to prevent.

Execute `Workflows/Recall.md`.

**Principle:** the synonym map (`vault/_tags.md`) normalizes a word to a canonical tag, so "AMT" /
"Steueramt" / "Finanzamt" all hit `taxes`. `recall` BM25-ranks over title/tags/body (rare terms and
title/tag hits weighted up) and returns a TIGHT set, so you get the relevant notes, not the vault. If
the map misses a synonym you recognize, recall again on the canonical term — and if the user confirms
the match, append the synonym to `_tags.md` (correction-only learning; never score whether it "worked").
