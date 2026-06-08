---
type: tags
---

# Tags + synonym map

Your vault's tag vocabulary. `imprnt check` keeps this in sync with the tags your notes actually use,
so you rarely edit it by hand. The synonym map normalizes both a note's tag and a search query, so
related terms resolve to one tag at write time and at read time.

Keep it lean. One concept, one tag. A tag applied to most notes cannot tell notes apart, which weakens
BM25 ranking, so avoid over-broad catch-all tags.

This file ships with a small generic seed so search has a tag tier from the first ingest. Replace these
with your own life-areas and grow the list as you go.

## Tags
identity, health, finances, work, life, projects, people, books, family, sleep

## Synonyms
pipeline, ingestion, data-pipeline -> etl
on-call, pager -> oncall
money, salary, savings, budget -> finances
