---
title: How it compares
description: imprnt against the AI-memory field. The one split that matters, a table per tool, and where another tool is the better pick.
---

> **In one line.** Most AI-memory tools build a store for the machine to read: a vector index you cannot open. imprnt builds plain notes for you to read, that the AI also searches. This page shows where that helps and where it does not.

The "memory for AI" field is crowded, and most of it is well built. The marketing all reads the same ("never forget", "your AI second brain", "local-first"), so the labels will not tell you which to use. What separates these tools is the architecture underneath, and it points in opposite directions from one to the next. Below is what each one bets on, where imprnt sits, and the cases where another tool is the better pick for you.

## The one question that splits the field

Almost every tool here sorts on a single question: **is the memory built for the machine to read, or for you to read?**

- **Memory for the machine.** The store is a vector index, a knowledge graph, or an encrypted blob. Capture is automatic, pulled from your chat turns as you go. You almost never open the raw data, and would learn little if you did. This is most of the funded field (mem0, Letta, Zep, Supermemory, cognee, mempalace).
- **Knowledge you own.** The store is plain Markdown you can read, edit, grep, and graph in Obsidian with none of the tooling running. The AI reads it too, but the file is the thing and you are the first reader. This is the smaller corner, and where imprnt lives.

That one split decides everything downstream: whether you can audit what was stored, whether the memory survives the tool being uninstalled, and whether a wrong fact is a line you fix or an opaque vector you cannot find.

## imprnt's four bets

Each is the minority position. The table sets each against what the rest of the field does.

| imprnt's bet | What the field mostly does | Who comes closest |
|---|---|---|
| **No embeddings.** Search is BM25 plus grep, local arithmetic, no model in the read loop. | Embeddings and a vector index as the core recall driver. Every tool below ships them. | Basic Memory keeps a full-text mode, but now defaults to hybrid vector. Nobody else defaults to no vectors. |
| **Conscious capture.** You decide what gets filed, on demand. | Auto-extraction from every chat turn. | Basic Memory also captures on a deliberate `write_note`. The rest auto-capture. |
| **No server over the vault.** The AI greps the Markdown directly. | An MCP server or a vector DB sits between the AI and the data. | Nobody. Even the Markdown-native tools put a derived index and a protocol in between. |
| **Spend the model only where it runs rarely.** On the write path, never the read path. | Optimize read-side scores, often with a model on every query. | Not a framing anyone else uses. The benchmark leaders push the opposite way. |

imprnt's white space is "plain Markdown the AI reads directly, BM25 and grep, no vector DB, no server," and no tool in the field sits there. That is a real gap and a real bet at once. It pays off when BM25 over a well-tagged vault answers the questions you actually ask. It loses when your queries need vector recall over raw, untagged text. The benchmark section below makes that tradeoff concrete.

## The field, tool by tool

Facts are pulled from each project's own README and docs (checked 2026-06-15). Benchmark numbers are self-reported by the vendor under its own harness, so read them as "the project claims X", never as a settled leaderboard. The numbers are contested even among the vendors: Zep published a rebuttal of mem0's headline LoCoMo claim, mem0 fired back disputing Zep's numbers, which is the clearest public sign these scores are not neutral.

| Tool | Where memory lives | Retrieval | Capture | AI reads via |
|---|---|---|---|---|
| **imprnt** | Plain Markdown files you own | BM25 + grep, no model in loop | Conscious, on demand | Greps the files directly, no server |
| **Basic Memory** | Markdown files + derived SQLite index | Hybrid: SQLite full-text + vectors (default), full-text-only fallback | Conscious `write_note` | MCP server |
| **Reor** *(archived 2026)* | Markdown files + LanceDB vectors | Embeddings, vector similarity | Auto-embed on every write | Built-in desktop app, no MCP |
| **Khoj** | Its own Postgres + pgvector DB | Embeddings + neural re-rank | Sync and index your docs | App, and an MCP client (not a server) |
| **Obsidian / Logseq AI plugins** | Your notes + a sidecar vector store | Embeddings | Auto-embed in the background | Inside the GUI app |
| **mem0** | Vector store (24 backends) | Hybrid: semantic + BM25 + entity matching, fused | Auto-extract from turns | API or OpenMemory MCP |
| **Letta / MemGPT** | Postgres + pgvector memory blocks | Embeddings over archival memory | Agent self-edits its own memory | Letta server / API |
| **Zep / Graphiti** | Temporal knowledge graph (Neo4j default, also FalkorDB / Neptune) | Hybrid: embeddings + BM25 + graph | Auto-extract into the graph | SaaS (Zep) or MCP (Graphiti) |
| **cognee** | Graph + vectors + relational | Hybrid, with a model on the read path | Auto-extract from many formats | Library or MCP |
| **mempalace** | Vector DB (ChromaDB default) | Embeddings + boosting + optional LLM re-rank | Both manual and auto hooks | MCP server (33 tools) |
| **Supermemory** | Cloud store, with a real self-host mode | Embeddings | Auto-capture | API, MCP, or local binary |

Posture on cloud varies too. mem0, Zep, and Supermemory are cloud-first with a local mode (Supermemory's self-host is a substantive one-binary setup, not a token gesture). Letta, Khoj, cognee, and mempalace self-host. imprnt has no hosted mode and no account at all, because the files are already on your disk.

## The closest neighbor: Basic Memory

Of everything here, Basic Memory shares imprnt's floor. It treats Markdown as the source of truth, keeps a derived SQLite index in sync, and captures on a deliberate write rather than scraping every turn. If you want imprnt's "own your files" stance with a more conventional MCP-server delivery, it is a real and good choice.

The split is downstream of storage. Basic Memory now defaults to hybrid vector search and puts a derived database and an MCP server between the AI and the Markdown. imprnt removes that whole layer and has the AI grep the files with BM25, the model touching only the two ends of a query. Basic Memory's answer to good recall is "add a server and embeddings." imprnt's answer is "keep it grep and arithmetic, so you never pay a model or a vector index on a read, and recall never goes stale on an edit." Same respect for the file, opposite call on the machinery around it.

## What the benchmark numbers mean for you

One tool in the table, mempalace, leads with a strong LongMemEval recall number (it reports R@5 around 0.96 in a no-LLM run over 500 questions). It is tempting to set that next to a number from imprnt and compare. You should not, and here is why.

That benchmark scores recall over auto-logged conversation dumps. A model captures thousands of raw turns, and the test asks whether the right turn can be found again. It measures a real task. If your use is "remember everything from every chat and surface it later," it is the number to trust, and a tool like mempalace is your pick.

imprnt is built for a different task: retrieval from a small set of notes you curated, typed, and linked on the way in. The corpus is smaller and cleaner because the judgment happened at write time, not in a vector search at read time. A LongMemEval score does not carry over in either direction. A high number there tells you little about how imprnt does on your vault, and imprnt's own number tells you nothing about the LongMemEval task.

imprnt does now measure itself, on its own task. A small in-repo eval runs plain-language questions against the curated example vaults and checks where the answer note ranks. Over 39 questions across two vaults it tops the right note on the first hit about 90% of the time, and lands it in the top five (the cheap set the model reads) about 97% of the time. The corpus is small and the questions are hand-written, so read this as an early signal that BM25 over a tagged vault answers the questions asked, not a leaderboard entry. The harness and queries live in [`eval/`](https://github.com/aleksandr-bogdanov/imprnt/tree/main/eval) so you can read the labels and run it yourself.

> **What this does not say.** That 97% is not mempalace's 0.96 plus a point. Different task, different corpus, a tenth the questions. The number is honest about imprnt's task and silent about LongMemEval's. If a big-corpus leaderboard score is what you need before committing, pick a tool that publishes one.

## When imprnt is the wrong tool

The cases where another tool is the better pick:

- **You want zero-effort ambient memory.** If you want your assistant to silently remember every chat with no filing step from you, imprnt's conscious capture just gets in your way. Tools like mem0, Zep, and mempalace are built for that, capturing turns automatically and surfacing recall when you ask.
- **You are building a product, not a personal vault.** A multi-user app that needs a memory API, a hosted service, and per-user isolation wants mem0, Zep, or Supermemory. imprnt is single-owner, local, and has no API surface.
- **You want the agent to manage its own state at scale.** Letta is the purest version of an agent that pages and self-edits its own memory across long autonomous runs. imprnt has no agent runtime owning the store. You own it.
- **You need semantic recall across messy unlabeled text.** If your corpus is large, unstructured, and you will not tag it on the way in, embeddings will out-recall BM25. imprnt's bet pays off because the write path does the labeling. Skip that work and the bet weakens.

imprnt is for one person who wants their knowledge to be plain files they own, read, and keep after any tool is gone. If that is the thing you want, the rest of the field is solving a different problem well. If it is not, one of these is a better fit, and the table above should help you find it.
