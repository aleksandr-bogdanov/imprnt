# Reor

**One-line:** A private, local, desktop AI note-taking app that auto-embeds every note into an internal vector database to power semantic search, automatic related-note linking, and RAG Q&A over your own markdown.

**Status (checked 2026-06-20):** archived - the GitHub repo carries the banner "This repository was archived by the owner on Mar 7, 2026. It is now read-only." (confirmed via the GitHub API field `archived: true`). The last code push was 2025-05-13 and the last release was 2025-04-05, so the project was already dormant for roughly a year before it was formally archived. It is effectively dead, with no named successor.

**Latest release:** v-0.2.32, 2025-04-05 | **Stars:** 8,563 | **License:** AGPL-3.0 | **Hosting:** self-host (local desktop app, no cloud backend)

## What it is

Reor is a self-contained Electron desktop note app that stores plain markdown in one directory you pick, then runs embedding and language models locally to link, search, and answer questions over those notes. Its core bet is that the model layer should be local by default, with an optional escape hatch to any OpenAI-compatible endpoint.

> **Reor** is an AI-powered desktop note-taking app: it automatically links related notes, answers questions on your notes and provides semantic search. Everything is stored locally and you can edit your notes with an Obsidian-like markdown editor.

> The hypothesis of the project is that AI tools for thought should run models locally _by default_.

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

The GitHub repo description is more specific about the audience: "Private & local AI personal knowledge management app for high entropy people."

- https://api.github.com/repos/reorproject/reor (accessed 2026-06-20)

## Status, timeline, recency

- **2023-11-27** - GitHub repo `reorproject/reor` created (`created_at: 2023-11-27T01:30:44Z`). Source: https://api.github.com/repos/reorproject/reor (accessed 2026-06-20). Note: some release tags on the releases page carry 2023 dates earlier than this (e.g. v0.2.17 "Reor now has a writing assistant feature!"), consistent with a repo history that predates the current repo record. Source: https://github.com/reorproject/reor/releases (accessed 2026-06-20).
- **2024** - Active development period. The README still carries a live-development announcement: "We are now on [Discord](https://discord.gg/b7zanGCTUY)! Our team is shipping very quickly right now so sharing ❤️feedback❤️ with us will really help shape the product 🚀". Source: https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20).
- **2025-04-05** - Last release published: v-0.2.32, titled "Convert to BlockNote, Image support, Video Support, tamagui theme, white and black theme" (`published_at: 2025-04-05T18:33:39Z`). Source: https://api.github.com/repos/reorproject/reor/releases/latest (accessed 2026-06-20).
- **2025-05-13** - Last code push to the default branch (`pushed_at: 2025-05-13T21:28:59Z`). After this, no further commits. Source: https://api.github.com/repos/reorproject/reor (accessed 2026-06-20).
- **2026-03-07** - Repo archived by the owner. Banner verbatim: "This repository was archived by the owner on Mar 7, 2026. It is now read-only." Source: https://github.com/reorproject/reor (accessed 2026-06-20).
- **Recency verdict:** dormant from ~May 2025, formally archived March 2026. As of 2026-06-20 the project is dead: no active maintenance, no successor repo in the org. The org `reorproject` lists a single repository (`reor`, archived) and no newer project. Source: https://github.com/reorproject (accessed 2026-06-20).
- **Funding / pivots:** unverified. No primary-source funding announcement or pivot notice was found. The official site `reorproject.org` was unreachable at access time (connection refused), so no live marketing or shutdown notice could be confirmed there.
- **Stars:** 8,563. **Forks:** 527. **Open issues:** 127 (frozen, repo is read-only). Source: https://api.github.com/repos/reorproject/reor (accessed 2026-06-20).

## Where memory lives (storage and architecture)

Notes are plain markdown files in a single filesystem directory the user chooses on first launch. Alongside that, Reor maintains an internal LanceDB vector database that holds chunked embeddings of every note.

> Reor works within a single directory in the filesystem. You choose the directory on first boot.

> 1. Every note you write is chunked and embedded into an internal vector database.

> Reor stands on the shoulders of the giants [Ollama](https://github.com/ollama/ollama), [Transformers.js](https://github.com/xenova/transformers.js) & [LanceDB](https://github.com/lancedb/lancedb) to enable both LLMs and embedding models to run locally

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

So there are two parallel stores: the markdown files (human-readable, portable, survive the app) and a derived LanceDB vector index (an internal embedding store that is rebuilt from the notes). The vector DB is the retrieval substrate. The markdown is the source of truth. It is a desktop app, AGPL-3.0, no server or cloud component.

## Retrieval

Retrieval is vector-similarity search over the LanceDB embedding store, not keyword/BM25 grep. Every note is chunked, embedded, and matched by semantic distance.

> 2. Related notes are connected automatically via vector similarity.

> 4. Everything can be searched semantically.

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

Retrieval surfaces in two places: a "related notes" sidebar inside the editor, and the context-fetch step that feeds the Q&A chat.

> One way to think about Reor is as a RAG app with two generators: the LLM and the human. In Q&A mode, the LLM is fed retrieved context from the corpus to help answer a query. Similarly, in editor mode, the human can toggle the sidebar to reveal related notes "retrieved" from the corpus. This is quite a powerful way of "augmenting" your thoughts by cross-referencing ideas in a current note against related ideas from your corpus.

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

## Capture

Capture is writing notes in the built-in editor. The README describes an "Obsidian-like markdown editor". Release v-0.2.32 moved the editor to BlockNote and added image and video support.

> Everything is stored locally and you can edit your notes with an Obsidian-like markdown editor.

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

Embedding happens automatically and continuously on write: "Every note you write is chunked and embedded into an internal vector database." There is no conscious, on-demand capture gate. The index updates as you type/save.

Importing from other apps is manual and lossy. You drop markdown files into the chosen directory yourself, and frontmatter handling is unreliable.

> To import notes/files from another app, you'll need to populate that directory manually with markdown files. Note that if you have frontmatter in your markdown files it may not parse correctly. Integrations with other apps are hopefully coming soon!

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

(The "Integrations... coming soon!" line never shipped. The repo is now archived.)

## How the AI reads it

The AI does not grep the markdown files directly. It reads retrieved chunks pulled by vector similarity from the LanceDB index, then generates an answer (RAG). Models run locally by default through Ollama (LLMs) and Transformers.js (embeddings), with an option to point at any OpenAI-compatible API.

> 3. LLM-powered Q&A does RAG on your corpus of notes.

> Reor interacts directly with Ollama which means you can download and run models locally right from inside Reor. Head to Settings->Add New Local LLM then enter the name of the model you want Reor to download.

> You can also [connect to an OpenAI-compatible API](https://www.reorproject.org/docs/documentation/openai-like-api) like Oobabooga, Ollama or OpenAI itself!

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

No MCP (Model Context Protocol) support is mentioned anywhere in the README. The only model interface is local Ollama/Transformers.js plus the OpenAI-compatible endpoint. MCP support: unverified, and there is no primary-source evidence it exists (the linked docs page at `reorproject.org/docs/...` was unreachable at access time).

## Pricing and license

Free and open source. There is no paid tier, subscription, or cloud plan. The app is downloaded and run locally. Any model cost is whatever you pay your own LLM provider if you choose the OpenAI-compatible route, otherwise zero with local Ollama models.

> AGPL-3.0 license. See `LICENSE` for details.

- https://raw.githubusercontent.com/reorproject/reor/main/README.md (accessed 2026-06-20)

License confirmed independently via the API field `license.spdx_id: AGPL-3.0`. Source: https://api.github.com/repos/reorproject/reor (accessed 2026-06-20). No pricing page exists or could be verified. The official site was unreachable at access time, and the README points only to free downloads for Mac, Linux, and Windows.

## Benchmarks (vendor self-reported)

None. No benchmarks, retrieval-quality numbers, or performance figures are published in the README, releases, or any reachable primary source. Unverified by absence.

## vs imprnt

| Dimension | Reor | imprnt |
|---|---|---|
| Status | Archived 2026-03-07, dead, no successor | Active |
| Storage | Markdown in one chosen dir + internal LanceDB vector DB (derived) | Plain markdown files only, no derived index DB |
| Retrieval | Vector similarity (embeddings) over LanceDB | BM25 + grep, deterministic, zero embeddings |
| How the AI reads | RAG over embedded chunks, AI never greps files | AI greps the markdown files directly |
| Capture | Automatic, continuous: every note embedded on write | Conscious, on-demand capture |
| Schema | No typed entity model, flat markdown + auto-links | Typed entity contract (people/orgs/holdings with aliases) |
| Models | Local-default (Ollama, Transformers.js), optional OpenAI-compatible | Bring-your-own AI, no embedding model required |
| Server | None (desktop Electron app) | None |
| Survives the tool | Markdown survives, but the vector index and related-notes graph die with the app | Files outlive the tool being deleted, nothing derived to lose |
| License | AGPL-3.0 | (imprnt) |

The sharpest contrast: Reor builds a derived embedding index (LanceDB) and routes all AI reading through vector RAG, so the "intelligence" lives in a database the markdown does not contain. imprnt keeps everything in the files and uses BM25 + grep so the AI reads the files directly, with no embedding store to rebuild, drift, or lose. Reor's auto-embed-everything-on-write is the opposite of imprnt's conscious on-demand capture. And Reor being archived is the live demonstration of imprnt's "files outlive the tool" thesis: a Reor user keeps their markdown but loses the related-notes graph and semantic search the moment the unmaintained Electron app stops running on a new OS.

## When it wins over imprnt

- You want a single integrated desktop app with a built-in WYSIWYG editor (BlockNote, image/video support) rather than editing markdown in your own tools.
- You specifically want semantic / fuzzy "find conceptually related notes" via embeddings, where vector similarity can surface links that share no keywords (the case BM25 + grep cannot match).
- You want fully local LLM inference baked in (one-click Ollama model download from inside the app) with zero config glue.
- You prefer automatic, zero-effort indexing of everything you write over deciding what to capture.
- Caveat that undercuts all of the above: the project is archived and unmaintained as of 2026-06-20, so adopting it today means running dead software with no fixes, no security updates, and no future OS-compatibility work.

## Sources

- [Reor README (raw, main branch)](https://raw.githubusercontent.com/reorproject/reor/main/README.md) - accessed 2026-06-20
- [Reor GitHub repo (archive banner, stars, license)](https://github.com/reorproject/reor) - accessed 2026-06-20
- [GitHub API: repo metadata (archived, pushed_at, stars, license, description)](https://api.github.com/repos/reorproject/reor) - accessed 2026-06-20
- [GitHub API: latest release (v-0.2.32, published_at)](https://api.github.com/repos/reorproject/reor/releases/latest) - accessed 2026-06-20
- [Reor GitHub releases page](https://github.com/reorproject/reor/releases) - accessed 2026-06-20
- [reorproject GitHub org (single repo, no successor)](https://github.com/reorproject) - accessed 2026-06-20
- [Official site reorproject.org](https://reorproject.org) - accessed 2026-06-20 (unreachable, connection refused)

## Confidence and gaps

- **High confidence (verified via primary sources):** archived status and exact archive date (2026-03-07), latest release version and date (v-0.2.32, 2025-04-05), last push date (2025-05-13), star count (8,563), forks (527), license (AGPL-3.0), repo description, the local-vector-DB + RAG architecture, Ollama/Transformers.js/LanceDB stack, OpenAI-compatible endpoint support, single-directory markdown storage, lossy frontmatter import, no successor in the org.
- **Repo creation date discrepancy:** the API reports `created_at: 2023-11-27`, but the releases page shows tags dated July-October 2023. Not resolved from primary sources. Likely repo history predating the current record (rename/migration). Flagged, low impact.
- **Unverified - official site content:** `reorproject.org` returned a connection-refused error at access time, so the homepage tagline, any pricing/marketing copy, and any shutdown/successor notice on the site could not be confirmed live. The docs page for the OpenAI-compatible API (`reorproject.org/docs/...`) was likewise unreachable.
- **Unverified - MCP support:** no primary-source evidence of Model Context Protocol support. The README mentions only Ollama, Transformers.js, and an OpenAI-compatible endpoint. Treated as not supported, but stated as unverified because the docs site could not be read.
- **Unverified - funding / company / pivot:** no primary-source funding round, company entity, or formal shutdown statement was found. Reason it is dead is inferred from the archive banner plus ~1 year of inactivity, not from an explicit announcement.
- **Unverified - benchmarks:** none published, recorded by absence.
