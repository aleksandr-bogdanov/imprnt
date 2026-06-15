---
title: How it compares
description: imprnt against the AI-memory field. The one axis that splits it, an honest table per tool, and where imprnt is the wrong choice.
---

There is a crowded field of "memory for AI" tools now, and most of them are genuinely well built. Before reaching for one it is worth knowing what each actually bets on, because the marketing all reads the same ("never forget", "your AI second brain", "local-first") while the architectures point in opposite directions. This page is the homework: what the field does, where imprnt sits, and the cases where one of these other tools is the better pick.

## The one axis that splits the field

Almost every tool here can be sorted by a single question: **is the memory built for the agent to read, or for you to read?**

- **Memory for the agent.** The store is machine-shaped: a vector index, a knowledge graph, an encrypted blob. Capture is automatic, pulled from your conversation turns as you go. A human almost never opens the raw data, and would learn little if they did. This is most of the funded field (mem0, Letta, Zep, Supermemory, cognee, mempalace, iai-pme).
- **Knowledge you own.** The store is plain Markdown you can read, edit, grep, and graph in Obsidian without any of the tooling running. The agent reads it too, but the file is the artifact and you are the first reader. This is the smaller corner, and it is where imprnt lives.

That split decides everything downstream: whether you can audit what was stored, whether the memory survives the tool being uninstalled, and whether a wrong fact is a line you fix or an opaque vector you cannot find.

## imprnt's bets against the field

imprnt makes four load-bearing calls. Each one is the minority position. The table is the field consensus on each, stated plainly.

| imprnt's bet | What the field mostly does | Who comes closest |
|---|---|---|
| **No embeddings.** Retrieval is BM25 plus grep, local arithmetic, no model in the read loop. | Embeddings and a vector index as the core recall driver. Every tool below ships them. | Basic Memory defaults to SQLite full-text search, then adds vectors as the recommended mode. |
| **Conscious capture.** You decide what gets filed, on demand. | LLM auto-extraction from every conversation turn. | Basic Memory also captures on a deliberate `write_note`. The agent-memory crowd auto-captures. |
| **No server over the vault.** The agent greps the Markdown files directly. | An MCP server or a vector DB sits between the agent and the data. | Nobody. Even the Markdown-native tools interpose a derived index and a protocol. |
| **Ration the model by where it runs.** Spend it on the write path, keep it off the read path. | Optimize read-side retrieval scores, often with a model on every query. | Not a framing anyone else uses. The benchmark leaders push in the opposite direction. |

The honest read: imprnt's specific white space is "plain Markdown the agent reads directly, BM25 and grep, no vector DB, no server." No tool in the field occupies it. That is a real gap, and it is also a real bet that could be wrong if BM25 over curated notes turns out to lose badly to vectors over raw logs on the queries you actually ask. More on that below.

## The field, tool by tool

Facts are pulled from each project's own README and docs. Benchmark numbers are self-reported by the vendor under its own harness, so read them as "the project claims X", never as a settled leaderboard. The numbers are contested even among the vendors (Zep published a direct rebuttal of mem0's headline LoCoMo claim, which is the clearest public sign that these scores are not neutral).

| Tool | Where memory lives | Retrieval | Capture | Agent reads via |
|---|---|---|---|---|
| **imprnt** | Plain Markdown files you own | BM25 + grep, no model in loop | Conscious, on demand | Greps the files directly, no server |
| **Basic Memory** | Markdown files + derived SQLite index | SQLite full-text default, optional vector hybrid (recommended) | Conscious `write_note` | MCP server |
| **Reor** | Markdown files + LanceDB vectors | Embeddings, vector similarity | Auto-embed on every write | Built-in desktop app, no MCP |
| **Khoj** | Its own Postgres + pgvector DB | Embeddings + neural re-rank | Sync and index your docs | App + MCP server |
| **Obsidian / Logseq AI plugins** | Your notes + a sidecar vector store | Embeddings | Auto-embed in the background | Inside the GUI app |
| **mem0** | Vector store (15 backends) | Semantic-first, BM25 only as a re-rank boost | LLM auto-extract from turns | API or OpenMemory MCP |
| **Letta / MemGPT** | Postgres + pgvector memory blocks | Embeddings over archival memory | Agent self-edits its own memory | Letta server / API |
| **Zep / Graphiti** | Temporal knowledge graph (Neo4j) | Hybrid: embeddings + BM25 + graph | LLM auto-extract into the graph | SaaS (Zep) or MCP (Graphiti) |
| **cognee** | Graph + vectors + relational | Hybrid, with a model on the read path | LLM auto-extract from 38+ formats | Library or MCP |
| **mempalace** | Vector DB (ChromaDB default) | Embeddings + boosting + optional LLM re-rank | Both manual and auto hooks | MCP server (29 tools) |
| **iai-pme** | Encrypted SQLite, tiered store | Vectors + graph + recency | Automatic, every turn | MCP + auto-inject at session start |

Posture varies on cloud too. mem0, Zep, and Supermemory are cloud services first with a local mode available. Letta, Khoj, cognee, mempalace, and iai-pme self-host. imprnt has no hosted mode and no account at all, because the files are already on your disk.

## The closest neighbor: Basic Memory

Of everything in the field, Basic Memory is the one that shares imprnt's floor. It treats Markdown as the source of truth, keeps a derived SQLite index in sync, and captures on a deliberate write rather than scraping every turn. If you want imprnt's "own your files" stance with a more conventional MCP-server delivery, it is a real and good choice.

The split is downstream of storage. Basic Memory puts a derived database, an MCP server, and (in its recommended mode) vector embeddings between the agent and the Markdown. imprnt removes that whole layer and has the agent grep the files with BM25, the model touching only the two ends of a query. Basic Memory's answer to good retrieval is "add a server and embeddings." imprnt's answer is "keep it grep and arithmetic, so you never pay a model or a vector index on a read, and recall never goes stale on an edit." Same respect for the file, opposite call on the machinery around it.

## The benchmark question

Two tools in the table, mempalace and iai-pme, lead with strong LongMemEval recall numbers (both claim R@5 around 0.96). imprnt has no such number, and that is the fair thing to say up front.

The reframe is honest, not a dodge. Those benchmarks measure recall over auto-logged conversation dumps: a model captured thousands of raw turns, and the test asks whether the right turn can be found again. imprnt is solving a different problem, which is retrieval from a small set of consciously curated, typed, linked notes. The corpus is smaller and cleaner by design, because the judgment happened at write time instead of being deferred to a vector search at read time. BM25 over a few hundred good notes is not the same task as vector recall over fifty thousand raw messages, so the score would not transfer either way.

What is true is that imprnt should be able to state its own number on its own task, and it cannot yet. Building that eval (BM25 over a real curated vault, measured on the queries a person actually asks) is on the roadmap. Until it exists, the claim here is a design argument, not a measured win, and it is labeled as such.

## When imprnt is the wrong tool

A comparison page that only lists strengths is an ad. Here are the cases where you should pick something else.

- **You want zero-effort ambient memory.** If the goal is that your assistant silently remembers every chat with no filing step from you, imprnt's conscious capture is friction, not a feature. iai-pme and mempalace are built exactly for that, capturing every turn and injecting recall at session start.
- **You are building a product, not a personal vault.** A multi-user app that needs a memory API, a hosted service, and per-user isolation wants mem0, Zep, or Supermemory. imprnt is single-owner, local, and has no API surface.
- **You want the agent to manage its own state at scale.** Letta is the purest version of an agent that pages and self-edits its own memory across long autonomous runs. imprnt has no agent runtime owning the store. You own it.
- **You need semantic recall across messy unlabeled text.** If your corpus is large, unstructured, and you will not tag it on the way in, embeddings will out-recall BM25. imprnt's bet pays off only because the write path does the labeling. Skip that work and the bet weakens.

imprnt is for one person who wants their knowledge to be plain files they own, read, and keep after any tool is gone. If that is the thing you want, the rest of the field is solving a different problem well. If it is not, one of these is a better fit, and the table above should help you find it.
