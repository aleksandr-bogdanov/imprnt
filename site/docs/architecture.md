---
title: Architecture
description: How imprnt fits together, end to end, in one picture and a few moving parts.
---

imprnt is a folder of plain markdown files on your disk. No database, no cloud, no app to log into. You talk to your assistant and it drives imprnt for you: it files what you tell it and recalls what you ask for. The command-line engine is what the assistant runs under the hood.

This page is the bird's-eye view. [How it works](/how-it-works/) goes deep on the read and write paths, [The model](/the-model/) on the folders and frontmatter, and [Plugins](/plugins/) on the extension model.

## The core idea

The AI builds the tools, the tools do the work. A model costs money and forgets everything between sessions, so you keep it out of the mechanical jobs (parsing, filing, searching) and let small free programs do those. You spend the model on the one job that needs understanding, and which side a step falls on is decided by how often it runs.

## The shape

The loop runs left to right and starts and ends at the assistant: you talk, the model understands and files once, plain code searches thousands of times, the model reads the top hits and answers.

<figure style="background:#f5f3ec;border-radius:12px;padding:1.25rem;margin:0;overflow:auto">
  <img src="/architecture.svg" alt="imprnt architecture: the loop from Claude through ingest, the vault, and recall, back to Claude" style="display:block;width:100%;height:auto" />
</figure>

## The one moving part: ingest

When you ask your assistant to file a source, it runs one pass with four steps, and only one spends the model:

1. **Snapshot** (plain code): copy the source into `raw/` untouched, hash it, pull obvious structure. Free.
2. **Understand** (the model, the only paid step): for each thing in the source, pick its type and folder, write a one-line summary, pull decisions and actions, and tag it with the words you will later search for even if the source never used them. A dense source fans out into several small notes here.
3. **File** (plain code): match names and aliases against the entity folders, merge instead of duplicating, write the note.
4. **Tidy** (plain code): `imprnt check` rebuilds the index and flags any note that links nothing, matches no entity, or has no tags. It never blocks and never silently drops anything.

## Corrections cost one edit

Say you filed a colleague as Carl, an Engineer, and a later meeting reveals he is Boris, a Director. That sounds like hunting down every note that mentions him. It is not. Ingest looks him up by alias, finds the existing note, fixes that one note, and adds "Carl" to the aliases so old references still resolve. Every other note points at him by his permanent file-ID, so the instant the one person-note is fixed, every meeting and project that mentions him shows the right name and role.

A contradiction is the special case. If a new meeting says a date moved, ingest updates the note and stamps the old line as superseded, so search can tell the current fact from the stale one. Old information is marked, never quietly overwritten.

## The safety net: the originals are never touched

Your raw sources are kept forever, one folder per source under `raw/`. So if you ever want to change how notes are structured, you re-run ingest over the originals and get the new layout for free. You are never stuck in an old format, and any claim in a note traces back to its snapshot.

## Core plus plugins

The only thing always present is the core: the vault plus `ingest`, `recall`, and `check`. Everything else is an optional plugin you install or delete with one command, under one rule that keeps the core from bloating: the core never knows a plugin exists. The reasoning is in [Design decisions](/design-decisions/). The full contract is in [Plugins](/plugins/).
