/**
 * Landing-page copy, as data. One place to read, one place to anti-slop scan.
 * Landing-only on purpose: the shared strings (site name, install command,
 * nav, footer) stay in content.ts, which Nav, Footer, and Layout also read.
 * Product voice: clean, confident, plain. Facts and commands are verified,
 * rewrite phrasing freely but never a number, a path, or a capability.
 *
 * v3 = the panel assembly (2026-07-30): the copy chief's rewrite (16/16
 * one-screen clarity, fifth-grader language) merged with the 14 patches the
 * 16-persona council + claims audit prescribed. Structure: hero / how it
 * works (3 paragraphs + spec strip, the old 4-principle ledger collapsed) /
 * proof / the file / closing. Claims law: "no model in the ranking loop"
 * (never "touches a query"), MCP schemas "by default", the 150-token pointer
 * stated, no approval absolutes, contract-attributed stamps and payload.
 * The terminal transcript and recall capture are verbatim data, never retouch.
 */
import { site } from "./content";

export const hero = {
  eyebrow: "Open source · MIT · runs on your machine · nothing runs on its own",
  headlineLead: "Your AI's memory,",
  headlineAccent: "boring on purpose",
  motto: "Delete imprnt. Every note still opens.",
  subhead:
    "Your assistant writes markdown notes into a folder on your computer when you hand it something worth keeping: a transcript, a decision, a fact. When you ask weeks later, a lookup returns a ranked top 15 in about a hundred tokens, with no model in the ranking loop. Works today under Claude Code and Gemini CLI, and under any agent that can run a shell command.",
  installCaption: "Two commands to install. After that, your assistant runs the CLI for you. You never type these yourself.",
  ctaPrimary: { label: "Get started", href: "/getting-started/" },
  ctaSecondary: { label: "View source", href: site.repo },
  terminalLabel: "one chat, three weeks apart",
  terminal: [
    { who: "You", text: "Here is my 1:1 with Boris from this morning. [paste the transcript]" },
    {
      who: "imp",
      text:
        "Filed it. Created people/boris-carter, updated projects/access-platform with the new cutover date, and logged the meeting under events/.",
    },
    { who: "gap", text: "(three weeks later)" },
    { who: "You", text: "What did we decide about the access-platform cutover?" },
    {
      who: "imp",
      text:
        "From your notes: the cutover moved to July 15, gated on the two-week parallel-run numbers. Boris owns it. The earlier June date is superseded.",
    },
  ],
  terminalCaption:
    "One paste becomes notes about a person, a project, and a meeting. Three weeks later the answer comes back from those files, with the old date struck out.",
};

export const how = {
  eyebrow: "How it works",
  heading: "The model writes the note. Math finds it.",
  paras: [
    "An agent doing the same job twice is a bug. So the model does each note's thinking <strong>once, at filing time</strong>: it reads what you pasted, decides what it is, writes a one-line summary, picks tags, and links the people and projects it mentions.",
    "The classic objection to keyword search, vocabulary mismatch, is answered right there: <strong>the model coins aliases and tags as it files</strong>, then shapes your question into keywords when you ask. Rename someone and the old name stays on as an alias, so tomorrow's search still finds them.",
    "Every search after that is <strong>BM25</strong>, the ranking math search engines have run for decades: how often your words appear, weighted by how rare those words are, boosted by where they sit in the note.",
    "Every query reads the folder fresh, so an edit can never go stale. <strong>The read path cannot call a model</strong>, because no model client exists in it.",
  ],
  spec: ["no embeddings", "no vector store", "no index to rebuild"],
  paras2: [
    "The one standing cost is <strong>a pointer of about 150 tokens</strong> that tells each session the vault exists. The full filing rules load only when a session actually writes. Everything else is a command, and a command costs nothing until it runs.",
    "That is why imprnt is a plain command line tool instead of an MCP server: <strong>an MCP server loads its tool descriptions into every chat by default</strong>, a cost you pay before you ask anything.",
  ],
  link: { label: "the full arguments, decision by decision", href: "/design-decisions/" },
};

export const proof = {
  eyebrow: "The proof",
  heading: "The proof ships in the repo.",
  lead:
    "It finds the right note nine times out of ten. The number comes from an eval of 39 hand-written questions against the two example vaults, scored by a public script. It is a small, self-run test. Run it yourself before you trust it.",
  stats: [
    { value: "89.7%", label: "answered by the first note returned" },
    { value: "97.4%", label: "caught by the top five" },
    { value: "~100", label: "tokens per lookup, measured on the example vault" },
  ],
  recallLabel: "examples/organization",
  recallCommand: 'imprnt recall "double charge billing" --limit 5',
  recallOutput: [
    'recall "double charge billing" [double charge billing double charge charge billing] — 10 match(es), showing top 5, BM25-ranked:',
    "",
    "  [3.73] mistakes/2026-05-double-charge-incident.md",
    "  [3.20] orgs/bramble-plumbing.md",
    "  [2.50] projects/billing-v2.md",
    "  [1.75] events/2026-05-18-eng-planning.md",
    "  [0.09] people/tom-decker.md",
    "",
    "  … 5 lower-ranked hit(s) hidden. Raise with --limit if needed; usually you don't.",
  ],
  recallCaption:
    "A real query against the example vault that ships in the repo, output verbatim. The scores are BM25, the files are plain markdown, and no model was in the ranking loop.",
  letta:
    "A memory vendor found the same thing: Letta, a company that sells memory tools, benchmarked plain files at 74.0%, ahead of its own tools and of mem0's best variant at 68.5%, and is now rebuilding its flagship around markdown in git.",
  dogfood:
    "The oldest vault in production is the author's own, work and life both, queried every day since the first commit.",
  evalLink: { label: "the eval, questions and script", href: "https://github.com/aleksandr-bogdanov/imprnt/tree/main/eval" },
  compareLink: { label: "how it compares", href: "/comparison/" },
};

export const file = {
  eyebrow: "What lands on disk",
  heading: "Swap the assistant, keep the memory.",
  paras: [
    "Every note is a markdown file: <strong>a small typed header that code can check</strong>, prose you can read, and links, so a person or a project is its own note you can jump to.",
    "Your editor works on them too, Obsidian included: the vault is plain markdown with ordinary wikilinks. <strong>Fix a note by hand and the next search picks it up.</strong> An old vault enters the same way everything enters: one ingest pass, where the model reads your notes once and files them into the schema.",
    "When a fact changes, the contract <strong>strikes through the old line and stamps in what replaced it</strong>. Ingest refuses to silently overwrite a conflicting note and stages it for your review instead. There is also check, the vault's integrity check (its fsck): it flags orphan links and untagged notes, rebuilds the index, and never edits a note.",
    "No background process ships, and nothing captures on its own. Machinery on a schedule is your own cron's business. The trade for all of this: <strong>capture is conscious</strong>. You say what gets filed, and anything never filed cannot be found. Everything past the small core is a plugin you can remove in one line, with zero edits to the core.",
  ],
  noteLabel: "the file behind the demo answer",
  noteCaption:
    "The contract requires each note to carry the source's real payload: the numbers, the rows, the exact wording. The summary sits on top of that data.",
};

export const closing = {
  heading: "Start your vault in two commands.",
  sub: "Open source, MIT licensed, and yours to read end to end.",
  install: site.install,
  ctaPrimary: { label: "Read the docs", href: "/getting-started/" },
  ctaSecondary: { label: "Star on GitHub", href: site.repo },
  quip: "People who enjoy re-introducing themselves to their AI every morning should not install this.",
};
