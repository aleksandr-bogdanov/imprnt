---
title: The model
description: Folders you browse by hand, and note headers that carry the meaning.
---

> **In one line.** Your notes live in plain folders, sorted the way you would sort your own life. Search ignores the folders completely, so where you put a note never affects whether you find it.

Folders are for you to browse, never for search to use. `recall` ignores them, so the layout costs you nothing at search time. That frees the folders to be an honest map of your life instead of a filing system you fight.

## The layout

Three kinds of folder, each with a real reason to exist.

```
vault/
  index.md         a generated map of everything
  hot.md           a short primer and what needs review
  log.md           an append-only timeline
  _tags.md         the tag list and synonyms

  # entities - referenced from everywhere, one home each
  people/          a human
  orgs/            an institution: employer, insurer, bank, vendor
  holdings/        an owned thing whose state changes over time

  # domains - your life-areas, you pick these
  identity/  health/  finances/  work/  life/  projects/

  # forms - set apart by how you use them
  events/          a dated thing worth its own note
  mistakes/        a lesson: believed, found false, true now
```

- **Entities** get one canonical home because the rest of your notes point at them. A person, an org, or a holding (a policy, a medication and its dose, an account and its balance) lives once and links out.
- **Domains** hold most of your content, and you define them. Alex uses `identity health finances work life`. A consultant would use `clients`. A researcher, `topics`.
- **Forms** are split out by how you use them, not by topic.

## How the model decides where a note goes

One call, in order:

1. Is it a person, org, or holding (an owned thing whose state you track)? File it in the entity folder, whatever the topic.
2. Is it a dated event, a lesson learned, or a project with a status? Those have their own folders.
3. Otherwise it is topical. File it by life-area.

## What carries the meaning

Three labels do the real work, and keeping them separate is what stops the folders from sprawling.

| Label | Where it lives | What it says |
|------|-------|------------------|
| `type` | the header | what the object is: person, org, holding, project, principle, note, mistake, event |
| `kind` | the header | what form it takes: a belief, a model, a policy, a how-to, a rating |
| `tags` | the header | what it is about, a list that grows on its own, one idea per tag |
| folder | the path | where you browse for it, the one axis search never reads |

## The meaning travels with the note

A note never hides its meaning in its file path. A note in a life-area folder also says `domain:` in its header, and `check` complains if the folder and the field disagree. Move the note or export it, and its meaning comes along.

Every note also carries `tags` and a one-line `summary`. That summary is the line the read side leans on: `check` builds the whole index from it, with no model involved.

## Tags grow on their own

`_tags.md` holds your tags and a synonym map. The list grows with no approval step. When the model files a note it picks the best tag that fits, and coins a new one if none does. Then `check` syncs every tag your notes use into the list, and flags near-duplicate spellings (`finance` next to `finances`) so you can merge them by hand. Picking the winning name is a judgment call, so that one step stays yours.

## The data is the knowledge

The one rule you cannot break: filing adds, it never removes.

`recall` searches `vault/` only, so anything left behind in `raw/` is invisible to it. The note has to carry the source's real payload in full: tables, lists, IDs, numbers, dates, prices, doses, exact wording. The summary goes on top of that, never in place of it.

> **The test before a note is done.** Could you answer a specific question from the vault note alone, without opening the original? If the answer is only in `raw/`, you dropped the knowledge. Put it back.
