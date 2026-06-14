---
title: The model
description: Entities, domains, and forms. Folders you browse, plus frontmatter that means something.
---

Notes live in plain folders chosen for how a human browses, never for how search works. `recall` ignores folders entirely, so the layout costs retrieval nothing. That frees the folders to be an honest map of your life.

## The layout

Three folder groups, each with a genuinely different reason to exist.

```
vault/
  index.md         generated map of content
  hot.md           a short primer and what needs review
  log.md           append-only chronological stream
  _tags.md         the tag vocabulary and synonym map

  # entities - cross-cutting, one home each, linked from everywhere
  people/          a human
  orgs/            an institution: employer, insurer, bank, vendor
  holdings/        an owned thing with tracked changing state

  # domains - your life-areas (you define these)
  identity/  health/  finances/  work/  life/  projects/

  # forms - distinct by how you use them
  events/          a dated occurrence worth its own note
  mistakes/        a lesson: believed, found false, true now
```

- **Entities** get a canonical home because they are referenced from everywhere. A person, an org, or a holding (a policy, a medication and dose, an account and balance) lives once and links out.
- **Domains** carry most of the content. They are user-defined. Alex uses `identity health finances work life`. A consultant would use `clients`, a researcher `topics`.
- **Forms** are set apart by how you use them, not by topic.

## The filing decision

For each note the model makes one conscious call:

1. Is it a person, org, or holding (a tracked-state owned thing)? File it in the entity folder, whatever the topic.
2. Is it a dated occurrence (`events/`), a lesson learned (`mistakes/`), or a bounded effort with a status (`projects/`)?
3. Otherwise it is topical content. File it by life-area domain.

## Three axes, plus the folder

Each axis does real work, and keeping them separate is what stops the folders from sprawling.

| Axis | Where | What it captures |
|------|-------|------------------|
| `type` | frontmatter | what the object is: person, org, holding, project, principle, note, mistake, event |
| `kind` | frontmatter | what form it takes: a belief, a model, a policy, a medication, a how-to, a rating |
| `tags` | frontmatter | what it is about, an auto-growing vocabulary, one concept per tag |
| folder | the path | where it browses, a human-only axis that search never reads |

## Self-describing notes

A semantic property lives in the note, never only in its path. A note in a domain folder carries `domain:` in its frontmatter, and `check` fails if the folder and the field disagree. Move or export the note and its meaning travels with it.

`type` is singular and records what the object is, independent of which folder it browses in. Every note also carries `tags` and a one-line `summary`. The summary is the field the read side leans on: `check` builds the index from each note's summary, with no model involved.

## Tags grow on their own

`_tags.md` holds the tag values and a synonym map. The vocabulary grows automatically, with no approval gate. At ingest the model applies the best-fitting tag, and coins a new one if none fits. `check` then syncs every tag the notes carry into `_tags.md` and flags near-duplicate spellings so you can merge them into a synonym by hand. Picking the canonical name is judgment, so that one step stays yours.

## The data is the knowledge

The cardinal rule: enrich adds, it never removes. `recall` searches `vault/` only, so anything left in `raw/` is invisible to it. The note must carry the source's structured payload (tables, lists, IDs, numbers, dates, prices, doses, verbatim clauses) in full. The summary is added on top.

The test before a note is done: could you answer a specific question from the vault note alone? If the answer is only in `raw/`, the knowledge was dropped.
