# Logseq

**One-line:** A local-first, open-source outliner notebook (Markdown/Org plain-text files) for personal knowledge management, with bidirectional links, block references, a graph view, and Datalog queries, now officially split in two: the SQLite-backed "DB version" carries the Logseq name as the main product, and the file version continues as maintenance-mode "Logseq OG".
**Status (checked 2026-06-20, re-checked 2026-08-27):** pivoted, DB version still beta - the split is official. The 2026-04-24 announcement "Big update: Logseq is splitting into two versions" assigns "Logseq OG → File-based graphs (Markdown)" and "Logseq → Database graphs", keeps the main repo for the DB product, and puts OG on "maintenance and reliability rather than new feature development" in a separate repo ([logseq/og](https://github.com/logseq/og)). The first official DB release, 2.0.1, shipped 2026-07-13, by its own notes "an early beta" ("our first Logseq 2.0 beta release is finally here", [2.0.1 release](https://github.com/logseq/logseq/releases/tag/2.0.1)). Migration for file-graph users is optional: "You can continue using Logseq OG (file-based) for as long as you like. There's no forced migration." ([split announcement](https://logseq.io/p/e3YDyX5AYr) - accessed 2026-08-27)
**Latest release:** 2.0.1 ("Desktop APP 2.0.1 (Beta Testing)"), published 2026-07-13 (the latest non-prerelease, first official DB-version release; the file line's last release on this repo stays 0.10.15, 2025-12-01) | **Stars:** 44,643 (2026-08-27) | **License:** AGPL-3.0 | **Hosting:** self-host / local-first (optional paid cloud sync add-on)

## What it is
Logseq is a privacy-first, local-first outliner that stores a user's notes as plain Markdown or Org-mode files on their own disk, and layers bidirectional links, block-level references, a graph view, and a Datalog query engine on top. It is open source under AGPL-3.0 and free to self-host. The project is mid-transition: the long-standing "file/MD version" keeps Markdown files canonical, while a newer "DB version" makes a local SQLite database canonical and treats Markdown as an export.

> "A privacy-first, open-source platform for knowledge management and collaboration"
- GitHub repo description and README `<h4>` tagline, [github.com/logseq/logseq](https://github.com/logseq/logseq) and [README](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - accessed 2026-06-20

> "It focuses on **privacy**, **longevity**, and [**user control**]"
- [README](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - accessed 2026-06-20

> "support for multiple file formats, including **Markdown** and **Org-mode**"
- [README](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - accessed 2026-06-20

## Status, timeline, recency
- **2020-05-23** - repository created on GitHub (`created_at: 2020-05-23T00:06:06Z`). Source: [GitHub API](https://api.github.com/repos/logseq/logseq) - accessed 2026-06-20.
- **2024-10-31** - co-founder Ramses on the official forum tempers DB-version expectations: "Sorry, we have no idea when Logseq DB will be stable enough to build and test the local apps." and "The current experience will be the default for at least another year, after which new users will have more than enough experience and comfort to migrate to Logseq DB." Source: [discuss.logseq.com DB release schedule thread](https://discuss.logseq.com/t/logseq-db-version-release-schedule/29668) - accessed 2026-06-20.
- **2025-08-07** - release 0.10.13 (file version), prerelease=false. Source: [GitHub releases API](https://api.github.com/repos/logseq/logseq/releases?per_page=5) - accessed 2026-06-20.
- **2025-09-18** - release 0.10.14 (file version), prerelease=false. Source: [GitHub releases API](https://api.github.com/repos/logseq/logseq/releases?per_page=5) - accessed 2026-06-20.
- **2025-10-13** - an independent how-to documents that to get the DB version you still pull an unofficial build from GitHub Actions artifacts: it is "an unofficial release build of a totally redesigned version" and the official downloads remain v0.10.x. Source: [preslav.me DB install guide](https://preslav.me/2025/10/13/how-to-install-logseq-db-version-on-your-computer-sqlite/) - accessed 2026-06-20.
- **2025-12-01** - release 0.10.15 ("Desktop/Android APP 0.10.15 (Beta Testing)"), prerelease=false. Release notes: "Fix: Youtube embeds not working" and "Bump Electron to 38.4.0". This is the latest stable (non-prerelease) tag. Source: [GitHub releases API](https://api.github.com/repos/logseq/logseq/releases?per_page=5) - accessed 2026-06-20.
- **2026-04-28** - the DB-version docs are stamped "This page describes DB (database) graph functionality as of April 28th, 2026." Source: [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20.
- **2026-06-19** - latest activity: a nightly prerelease "Desktop app Nightly Release 20260619" (tag `nightly`, prerelease=true), and `pushed_at: 2026-06-19T20:32:01Z`, `updated_at: 2026-06-20T03:30:34Z`. The repo is actively committed-to. Source: [GitHub releases API](https://api.github.com/repos/logseq/logseq/releases?per_page=5) and [GitHub API](https://api.github.com/repos/logseq/logseq) - accessed 2026-06-20.

The bullets below were added 2026-08-27 (the re-check). Two of them predate the 2026-06-20 check but were not visible then, since the split announcement came via the roadmap/blog, and the og repo carried no signal we were watching.

- **2025-12-25** - repo `logseq/og` created, description "Logseq og (file version)" (`created_at: 2025-12-25T03:44:34Z`). Source: [GitHub search API, org:logseq](https://api.github.com/search/repositories?q=org:logseq+og) - accessed 2026-08-27.
- **2026-04-15** - Logseq OG ships release 1.0.0 ("Desktop/Android APP 1.0.0 (Beta Testing)") in the og repo, so the file version's release line now lives there. Source: [GitHub API: repos/logseq/og/releases](https://api.github.com/repos/logseq/og/releases) - accessed 2026-08-27.
- **2026-04-24** - official announcement "Big update: Logseq is splitting into two versions": "Logseq OG → File-based graphs (Markdown)" and "Logseq → Database graphs". OG keeps "Security fixes and patches" and "Electron and dependency upgrades", with focus on "maintenance and reliability rather than new feature development". Migration is optional: "No. You can continue using Logseq OG (file-based) for as long as you like. There's no forced migration." New users are "guided to the Logseq app, defaulting to database graphs." On whether the DB version will support Markdown files: "That is the plan, but we are still researching the best way to do this." Source: [logseq.io/p/e3YDyX5AYr](https://logseq.io/p/e3YDyX5AYr) - accessed 2026-08-27.
- **2026-07-13** - release 2.0.1 published on the main repo, the first official DB-version release (prerelease=false, name "Desktop APP 2.0.1 (Beta Testing)", `published_at: 2026-07-13T14:10:34Z`). Release notes: "our first Logseq 2.0 beta release is finally here" and "This is an early beta, so you may encounter some rough edges." No 2.0.0 tag appears on the releases API. Source: [release 2.0.1](https://github.com/logseq/logseq/releases/tag/2.0.1) and [GitHub releases API](https://api.github.com/repos/logseq/logseq/releases?per_page=15) - accessed 2026-08-27.
- **2026-08-26** - latest activity: nightly "Desktop app Nightly Release 20260826", `pushed_at: 2026-08-26T16:32:21Z`. Stars 44,643, forks 2,790, open issues 953. The og repo's last push is 2026-05-28. Source: [GitHub API](https://api.github.com/repos/logseq/logseq) and [GitHub API: repos/logseq/og](https://api.github.com/repos/logseq/og) - accessed 2026-08-27.

**Recency verdict:** the project is ACTIVE in development (nightly builds dated 2026-06-19, push activity within the last day), but the user-facing STABLE release is stale: the newest non-prerelease tag is 0.10.15 from 2025-12-01, roughly 6.5 months old as of 2026-06-20. The DB-version pivot has been "about a year out" since late 2024 and is still in beta / not default in mid-2026.

**Recency verdict update (2026-08-27):** the pivot landed. The DB version is the official main product with a real release on the main repo (2.0.1, 2026-07-13), and file-version development moved to maintenance in `logseq/og`. A stable DB release has still not shipped: 2.0.1 calls itself "an early beta", and the README (accessed 2026-08-27) keeps the warning "The DB version is in beta status while the new mobile app and RTC is in alpha. This means that **data loss is possible**". So: pivoted, with the stable DB build still pending.

Recency snapshot from the GitHub API:
> Stargazers Count: 43,466 / Forks Count: 2,677 / Open Issues Count: 917 / License SPDX ID: AGPL-3.0 / Pushed At: 2026-06-19T20:32:01Z
- [GitHub API](https://api.github.com/repos/logseq/logseq) - accessed 2026-06-20

## Where memory lives (storage and architecture)
Two architectures coexist, and which one you get depends on which build you install.

**File / MD version (the shipping stable app, v0.10.x):** notes are plain Markdown or Org-mode files in a folder on your disk. The files are canonical. The repo and community describe it as "stored as plain text files (Markdown or Org mode) that remain accessible even if the application becomes unavailable" ([WebSearch summary of Logseq architecture](https://deepwiki.com/logseq/logseq) - accessed 2026-06-20). Under the hood the running app loads those files into an in-memory Datascript database for querying.

**DB version (v0.11.x+, beta):** a local SQLite database becomes canonical and Markdown becomes an export. The DB docs reframe the data model around "nodes" and offer explicit export actions:

> "A node is a new term for a page or block because the two now behave similarly."
- [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20

> "Export SQLite DB - Export graph as a SQLite .db file."
- [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20

> "Export as standard Markdown (no block properties) - Export graph as standard markdown, not Logseq markdown."
- [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20

The crucial point for a plain-files comparison: in the DB version Markdown is an export target, not the live store. The data lives in SQLite, and the official sync (RTC) operates over that database. The README states the DB version is beta with possible data loss:

> "The DB version is in beta status while the new mobile app and RTC is in alpha. This means that **data loss is possible** so we recommend automated backups or regular SQLite DB backups."
- [README](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - accessed 2026-06-20

**Which version a user gets today (2026-06-20):** the file version. The official stable download is v0.10.x. The DB version, as of the most recent first-hand install guide, was distributed as an unofficial build pulled from GitHub Actions artifacts, bundled alongside the file version in one larger download:

> "you now have two separate versions of Logseq in the same build"
- [preslav.me DB install guide](https://preslav.me/2025/10/13/how-to-install-logseq-db-version-on-your-computer-sqlite/) - accessed 2026-06-20

> "an unofficial release build of a totally redesigned version"
- [preslav.me DB install guide](https://preslav.me/2025/10/13/how-to-install-logseq-db-version-on-your-computer-sqlite/) - accessed 2026-06-20

The two graph types can coexist (you choose DB-graph or file-graph per graph), so installing the DB build does not wipe your file graphs, but the DB version is not stable, not bundled into the official stable release, and not the default. Version tags supporting the SQLite-based graphs start from v0.11.x. The official line is still v0.10.x.

**Update (2026-08-27): this flipped.** The latest release on the main repo is now the DB version (2.0.1, 2026-07-13), the split announcement says new users are "guided to the Logseq app, defaulting to database graphs", and the official home of the file version is the [logseq/og](https://github.com/logseq/og) repo (its release 1.0.0, 2026-04-15). The unofficial-artifact era is over. The DB build remains beta by its own release notes.

## Retrieval
Retrieval is human-driven and deterministic, with no AI in the loop by default. Logseq uses Datascript as its in-memory database and Datalog as the query language:

> "Logseq uses Datascript for the database and Datalog as the query engine, with the built-in queries of Logseq all written in Datalog and users able to write their own using the language."
- [WebSearch summary citing Logseq community/docs](https://deepwiki.com/logseq/logseq) - accessed 2026-06-20

Users find information through bidirectional links, block references, a graph view, full-text search, and hand-written queries (simple `{{query}}` syntax or advanced Datalog). Content is modeled as hierarchical blocks:

> "The content management system centers around blocks as atomic content units that can be organized hierarchically, linked bidirectionally, and queried dynamically."
- [WebSearch summary citing Logseq architecture](https://deepwiki.com/logseq/logseq) - accessed 2026-06-20

There is no semantic search, no embeddings, and no vector index in core. Retrieval quality depends on the user's linking discipline and query-writing skill rather than on a ranking algorithm. (Unverified whether any first-party semantic search exists in the DB version. The DB docs describe nodes/properties and queries, not embeddings.)

## Capture
Capture is manual and outliner-native: the user types into the daily journal page or any page, and every line is a block in an outline. Tags (`#tag`), page links (`[[Page]]`), block references, and inline properties wire notes together at write time, by hand. Logseq also supports PDF annotation and task management as capture surfaces (per the README feature set and Product Hunt tagline "Your joyful, private digital garden"). There is no automatic classification, no entity resolution, and no LLM-assisted enrichment at capture in core. Structure is whatever the user types.

## How the AI reads it
There is no built-in AI in core Logseq. The app ships no LLM features by default. Retrieval and structure are deterministic (Datalog/Datascript over the local graph). AI is only available through community plugins (for example, plugins that call OpenAI or other providers via Logseq's plugin API). The README and repo description make no claim of native AI. Any "AI code creation" wording in the GitHub UI is GitHub's own navigation chrome, not a Logseq feature.

> "The skill establishes a connection to a locally running Logseq instance through a bridge plugin or the @logseq/libs proxy, with commands issued to specific API namespaces such as Editor for content manipulation or DB for data retrieval."
- [WebSearch summary of Logseq plugin API](https://www.toolify.ai/openclaw-skills/logseq-9849) - accessed 2026-06-20

So an external agent reads a Logseq graph either by parsing the Markdown/Org files directly (file version) or by reading the SQLite DB / using the plugin API (DB version). No first-party AI reads the vault. (Unverified: whether the DB version roadmap adds any native AI. The public DB docs do not describe one.)

## Pricing and license
The app is free and open source under AGPL-3.0. The only paid product is Logseq Sync, an optional end-to-end-encrypted cloud sync run by the Logseq team. During the current beta, Sync access is gated behind Open Collective contributions rather than a subscription page.

> "we'll implement a normal subscription system once we launch Sync to the general public."
- [blog.logseq.com Sync setup guide](https://blog.logseq.com/how-to-setup-and-use-logseq-sync/) - accessed 2026-06-20

Sync beta access tiers (Open Collective):
- Backer: "$5 per month"
- Sponsor: "$15 per month"
- Source: [blog.logseq.com Sync setup guide](https://blog.logseq.com/how-to-setup-and-use-logseq-sync/) - accessed 2026-06-20

Sync beta limits (verbatim):
> "Maximum number of remote graphs: 10"
> "Maximum graph size (per graph): 10 gigabyte"
> "Maximum asset size (per asset): 100 megabyte"
- [blog.logseq.com Sync setup guide](https://blog.logseq.com/how-to-setup-and-use-logseq-sync/) - accessed 2026-06-20

The DB-version RTC sync is similarly gated:
> "NOTE: This feature is a paid feature that is currently _invite only_."
- [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20

Free sync alternatives (no Logseq Sync needed): point the file version at an iCloud/Dropbox folder or a Git repo, since the data is plain files. (This works for the file version. The DB version's canonical SQLite store is designed around RTC rather than file-folder sync.)

Core feature pricing: $0. All core features (notes, bidirectional links, graph view, plugins, themes, local storage, queries) are free under AGPL-3.0. Source: [costbench.com Logseq pricing](https://costbench.com/software/note-taking/logseq/) and the AGPL-3.0 license field in the [GitHub API](https://api.github.com/repos/logseq/logseq) - accessed 2026-06-20.

## Benchmarks (vendor self-reported)
None. Logseq publishes no performance or retrieval benchmarks. There are no vendor-reported accuracy, latency, or recall numbers to cite. The only quantitative public signals are repository metrics (43,466 stars, 2,677 forks, 917 open issues as of 2026-06-20, per the [GitHub API](https://api.github.com/repos/logseq/logseq)), which measure popularity, not performance. Marked unverified by absence: no benchmark exists to verify.

## vs imprnt
- **Plain files vs canonical SQLite.** imprnt keeps plain Markdown canonical, full stop, and a tool deletion leaves the files intact. Logseq's file version shares the plain-files property, but the project is pivoting toward the DB version where SQLite is canonical and Markdown is "Export as standard Markdown" ([docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md)). The pivot walks away from the plain-files guarantee. imprnt has no such pivot. (Update 2026-08-27: the pivot is official - the DB product carries the Logseq name, the file version is maintenance-mode "Logseq OG". See the timeline.)
- **Retrieval.** imprnt uses BM25 ranking plus grep over the files, the AI shapes the query and reads the top hits, no per-query LLM re-rank. Logseq uses hand-written Datalog/Datascript queries plus links and graph view, deterministic but author-driven, with no ranking layer. Logseq demands query-writing and linking discipline. imprnt returns a ranked candidate set from a natural-language question.
- **AI reading the vault.** imprnt is designed for an LLM to grep the files directly and answer. Logseq ships no native AI. An agent must parse the files or use a community plugin / the plugin API. AI is a bolt-on in Logseq, a first-class read path in imprnt.
- **Capture and structure.** imprnt has a typed entity contract (people/orgs/holdings with aliases, types, summaries, tags) and conscious on-demand capture with LLM-assisted classification and entity resolution. Logseq capture is manual outlining: blocks, tags, links typed by hand, no entity resolution, no typed schema.
- **Server / hosting.** imprnt has no server. Logseq core is local-first too, but its differentiated sync (Logseq Sync, and DB-version RTC) is a paid, server-backed, invite-only cloud service.
- **Longevity.** imprnt's pitch is "the files outlive the tool." Logseq's file version honors this. The DB-version direction does not, since the canonical store becomes an app-specific SQLite database with a beta-grade "data loss is possible" warning ([README](https://raw.githubusercontent.com/logseq/logseq/master/README.md)). (Update 2026-08-27: the file version now lives in maintenance mode as Logseq OG, with "no forced migration" per the split announcement, and Markdown support inside the DB version is still at the "we are still researching the best way to do this" stage.)

## When it wins over imprnt
- **You want a polished GUI outliner with a graph view and an editor.** Logseq is a full desktop/mobile app with visual graph exploration, PDF annotation, and a mature plugin/theme ecosystem. imprnt is files plus a CLI plus an LLM, no GUI.
- **You think in outlines and block references.** Logseq's block-level addressing and transclusion are stronger than a flat Markdown vault for deeply nested, reusable, hierarchical notes.
- **You want hand-written precise queries.** If you enjoy Datalog and want exact, reproducible, author-controlled retrieval over a structured graph, Logseq's query engine beats BM25's fuzzy ranking for precision.
- **You want real-time multi-user collaboration.** The DB-version RTC sync targets Google-Docs-style collaboration ("supports collaboration between users in real time like Google Docs!", [docs/db-version.md](https://raw.githubusercontent.com/logseq/docs/master/db-version.md)). imprnt is single-owner, private, no collaboration.
- **You want a large existing community and plugin marketplace.** 43k+ stars and a broad plugin ecosystem mean more themes, integrations, and prior art than a young single-purpose tool.

## Sources
- [github.com/logseq/logseq (repo page)](https://github.com/logseq/logseq) - accessed 2026-06-20
- [Logseq README (raw, master)](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - accessed 2026-06-20
- [GitHub API: repos/logseq/logseq](https://api.github.com/repos/logseq/logseq) - accessed 2026-06-20
- [GitHub API: releases (per_page=5)](https://api.github.com/repos/logseq/logseq/releases?per_page=5) - accessed 2026-06-20
- [GitHub releases page](https://github.com/logseq/logseq/releases) - accessed 2026-06-20
- [docs/db-version.md (raw, master)](https://raw.githubusercontent.com/logseq/docs/master/db-version.md) - accessed 2026-06-20
- [docs/db-version.md (GitHub)](https://github.com/logseq/docs/blob/master/db-version.md) - accessed 2026-06-20
- [blog.logseq.com: How to Set Up and Use Logseq Sync](https://blog.logseq.com/how-to-setup-and-use-logseq-sync/) - accessed 2026-06-20
- [discuss.logseq.com: Logseq DB Version Release Schedule?](https://discuss.logseq.com/t/logseq-db-version-release-schedule/29668) - accessed 2026-06-20
- [preslav.me: How to Install Logseq's DB Version (SQLite)](https://preslav.me/2025/10/13/how-to-install-logseq-db-version-on-your-computer-sqlite/) - accessed 2026-06-20
- [costbench.com: Logseq Pricing 2026](https://costbench.com/software/note-taking/logseq/) - accessed 2026-06-20
- [deepwiki.com: logseq/logseq architecture](https://deepwiki.com/logseq/logseq) - accessed 2026-06-20
- [toolify.ai: Logseq Plugin API](https://www.toolify.ai/openclaw-skills/logseq-9849) - accessed 2026-06-20

Added at the 2026-08-27 re-check:
- [logseq.io/p/e3YDyX5AYr: "Big update: Logseq is splitting into two versions"](https://logseq.io/p/e3YDyX5AYr) - accessed 2026-08-27
- [Release 2.0.1 (notes: "our first Logseq 2.0 beta release")](https://github.com/logseq/logseq/releases/tag/2.0.1) - accessed 2026-08-27
- [GitHub API: repos/logseq/logseq (stars 44,643, pushed 2026-08-26)](https://api.github.com/repos/logseq/logseq) - re-accessed 2026-08-27
- [GitHub API: releases (per_page=15, 2.0.1 prerelease=false)](https://api.github.com/repos/logseq/logseq/releases?per_page=15) - accessed 2026-08-27
- [GitHub API: repos/logseq/og (file version, maintenance repo)](https://api.github.com/repos/logseq/og) - accessed 2026-08-27
- [GitHub API: repos/logseq/og/releases (OG 1.0.0, 2026-04-15)](https://api.github.com/repos/logseq/og/releases) - accessed 2026-08-27
- [Logseq README (raw, master, beta warning still present)](https://raw.githubusercontent.com/logseq/logseq/master/README.md) - re-accessed 2026-08-27

## Confidence and gaps
- **High confidence (primary, live):** AGPL-3.0 license, 43,466 stars / 2,677 forks / 917 open issues, latest stable 0.10.15 dated 2025-12-01, nightly dated 2026-06-19, push activity within the last day, DB version is beta with a "data loss is possible" warning, SQLite-as-canonical with Markdown-as-export, RTC sync is paid and invite-only, DB docs stamped 2026-04-28. All from the repo README, GitHub API, and official docs.
- **DB-version default status:** confirmed NOT the default as of 2026-06-20. The shipping stable line is v0.10.x (file version). The DB version is v0.11.x+ beta. The most recent first-hand install evidence (Oct 2025) shows it distributed as unofficial GitHub Actions artifact builds. Gap: I could not find a primary-source statement of an exact GA date for the DB version becoming default. The 2024 forum quotes ("default for at least another year") plus a still-beta status in mid-2026 indicate the timeline slipped well past the original estimate. Treat any specific GA date as unverified.
- **Exact stable Logseq Sync public pricing (post-beta):** unverified. The team explicitly says a "normal subscription system" comes only at general launch. Current numbers ($5 Backer, $15 Sponsor) are Open Collective beta-access tiers, not a finalized Sync price sheet. Third-party sites quote "$5/month Backer" which matches.
- **End-to-end encryption of Logseq Sync:** widely reported as E2E encrypted, but the specific official page I fetched did not state it verbatim, so I label the E2E claim partially unverified against the exact source fetched (the blog setup guide).
- **Native AI in the DB version roadmap:** unverified. Public DB docs describe nodes/properties/queries/RTC, not any first-party AI. Core has none today.
- **Last commit exact timestamp:** the API `pushed_at` (2026-06-19T20:32:01Z) is the proxy used. I did not fetch the individual head-commit SHA/date, so "last commit" is reported via push activity rather than a single commit object.
- **(Added 2026-08-27) "Stable" wording on 2.0.1:** GitHub marks 2.0.1 `prerelease=false`, but its title says "(Beta Testing)" and the notes call it "an early beta" that will "shape the stable release". Every Logseq release title back through 0.10.x carries "(Beta Testing)", so the flag proves nothing about stability. Treat DB 2.0 as beta until the project's own notes say stable. Two smaller gaps: no 2.0.0 tag is visible on the releases API (whether one existed and was pulled is unverified), and whether the DB desktop app still bundles a file-version mode is unverified (the official file-version line now points at logseq/og).
