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

/** One run of transcript text. A bare string is plain body; a marked segment is
 *  a vault path, a recovered fact, a superseded value, or muted chrome. */
export type TermSeg = string | { k: "path" | "key" | "gone" | "faint"; v: string };
export type TermLine = { who: string; segs: TermSeg[] };

export const hero = {
  eyebrow: "Open source · MIT",
  headlineLead: "Your AI's memory,",
  headlineAccent: "boring on purpose",
  motto: "Delete imprnt. Every note still opens.",
  // Two paragraphs on purpose. The first says what it does to what you give it,
  // the second says what that buys you later. The old single block welded both
  // plus the runs-anywhere line into one 60-word sentence nobody finished.
  subheadParas: [
    "Hand it anything: a meeting transcript, an article, a rambling voice note. It splits that into small pieces and <strong>writes each one to its own markdown file</strong> on your disk. One file per person, per project, per decision, per event.",
    "Ask three weeks later and the answer comes back from those files. <strong>No model reads your vault to find them.</strong> Works under Claude Code, Gemini CLI, and any agent that can run a shell command.",
  ],
  installCaption: "Paste that line once. After that your assistant runs imprnt for you, so it is the last imprnt command you type by hand.",
  ctaPrimary: { label: "Get started", href: "/getting-started/" },
  ctaSecondary: { label: "View source", href: site.repo },
  terminalLabel: "one chat, three weeks apart",
  // Segmented, not flat strings. The transcript is this section's visual anchor,
  // so the things the product actually produced (the vault paths) and the facts
  // it recovered (the date, the owner, the struck-out old date) are marked up
  // instead of buried in a wall of mono. `gone` renders the contract's real
  // supersede behaviour: the old value stays visible with a line through it.
  terminal: <TermLine[]>[
    {
      who: "You",
      segs: [
        "Here is my 1:1 with ",
        { k: "key", v: "Boris" },
        " from this morning. ",
        { k: "faint", v: "[paste the transcript]" },
      ],
    },
    {
      who: "imp",
      segs: [
        "Filed it. Created ",
        { k: "path", v: "people/boris-carter" },
        ", updated ",
        { k: "path", v: "projects/access-platform" },
        " with the new cutover date, and logged the meeting under ",
        { k: "path", v: "events/" },
        ".",
      ],
    },
    { who: "gap", segs: ["three weeks later"] },
    { who: "You", segs: ["What did we decide about the access-platform cutover?"] },
    {
      who: "imp",
      segs: [
        "From your notes: the cutover moved to ",
        { k: "key", v: "July 15" },
        ", once the two-week parallel run clears. ",
        { k: "key", v: "Boris" },
        " owns it. The earlier ",
        { k: "gone", v: "June" },
        " date is superseded.",
      ],
    },
  ],
  terminalCaption:
    "You write the two prompts. The rest is the assistant's own output. Each path is a real file it created, and the struck-out date is how the vault records a fact that changed.",
};

export const how = {
  eyebrow: "How it works",
  headingLead: "The model writes the note.",
  headingRest: "Math finds it later.",
  // The opening is the origin story, not a maxim ("an agent doing the same job
  // twice is a bug" is dead - it opened on a rule nobody had a reason to care
  // about yet). Alex's own PAI moment carries the argument: a per-token bill
  // made him afraid to ask, which is the failure the split fixes. Claims held
  // to what he lived and what the code does - no context-window size, no
  // "nobody ever solved it" absolutes.
  //
  // NEVER open a sentence with "imprnt": the wordmark is lowercase, so a
  // sentence-initial one reads as a typo. Reword so it sits mid-sentence.
  paras: [
    "A model can do almost anything, so <strong>almost everything got built on one</strong>. Wrap a chat model, call it an AI product, ship it. That worked while tokens were cheap.",
    "Tokens are not cheap now. I put a personal-assistant setup on my work laptop. It burned <strong>30,000 tokens before I typed a word</strong>, because it had loaded every skill and every MCP server up front. I was paying per token, so I started thinking twice before asking anything. <strong>An assistant you are afraid to use is not an assistant.</strong>",
    "So imprnt splits the job. A model reads your mess and writes it down.<br /><strong>You do not need one to find a file on disk.</strong>",
  ],
  spec: ["no embeddings", "no vector store", "no index to rebuild"],
  paras2: [
    "Keyword search has one famous weakness: you search for a word the note never used. The fix happens at filing time. <strong>The model writes down the other names a thing is called</strong>, so the note about Boris Carter also matches a search for Boris. Rename him and the old name stays on the note.",
    "Every search after that runs <strong>BM25</strong>. It is a ranking formula from 1994, and Lucene and Elasticsearch still run it today. It counts how often your words appear, weighs <strong>rare words heavier</strong>, and puts a word in the title above the same word buried in the body. Nothing caches, so a note you fixed a minute ago is already findable.",
    "Every session pays <strong>about 200 tokens</strong> up front. That is one short note: the vault exists, and here are the two commands that read it and write to it. The <strong>full filing contract runs about 7,000 tokens</strong>, and it loads only when a session writes. Everything else is a command, and a command costs nothing until it runs.",
    "That is why imprnt is a command line tool and not an MCP server. <strong>An MCP server loads its tool descriptions into every chat by default.</strong> You pay for those before you ask anything.",
  ],
  link: { label: "the full arguments, decision by decision", href: "/design-decisions/" },
};

export const proof = {
  // The eyebrow said "The proof" and the heading said "The proof ships in the
  // repo" - the same words twice, and the sentence meant nothing. What it was
  // reaching for is "go check it", so the heading now says that. "eval" is
  // gone: it is jargon that assumes the reader already knows the word.
  eyebrow: "Does it work",
  heading: "Check it yourself.",
  leadTop: "It finds the right note <strong>9 times out of 10</strong>.",
  leadBody:
    "That number comes from <strong>39 hand-written questions</strong>, run against the two example vaults in the repo. It is a small test, and I wrote both the questions and the scoring. Clone the repo and run it before you believe it.",
  stats: [
    { value: "89.7%", label: "answered by the first note returned" },
    { value: "97.4%", label: "caught by the top five" },
    { value: "~100", label: "tokens per lookup, measured on the example vault" },
  ],
  recallLabel: "examples/organization",
  // Segmented for the same reason the hero transcript is: this is the product's
  // real output, so the parts that carry meaning (the score, the folder, the
  // file) are marked instead of dissolved into one grey block. Verbatim data -
  // the strings are a real run, only the marking is ours.
  recallCommand: [
    { k: "cmd", v: "imprnt recall" },
    { k: "str", v: '"double charge billing"' },
    { k: "flag", v: "--limit 5" },
  ],
  recallHeader: [
    { k: "plain", v: 'recall "double charge billing" ' },
    { k: "dim", v: "[double charge billing double charge charge billing]" },
    { k: "plain", v: " - 10 match(es), showing top 5, BM25-ranked:" },
  ],
  recallHits: [
    { score: "3.73", dir: "mistakes/", file: "2026-05-double-charge-incident.md" },
    { score: "3.20", dir: "orgs/", file: "bramble-plumbing.md" },
    { score: "2.50", dir: "projects/", file: "billing-v2.md" },
    { score: "1.75", dir: "events/", file: "2026-05-18-eng-planning.md" },
    { score: "0.09", dir: "people/", file: "tom-decker.md" },
  ],
  recallFooter: "... 5 lower-ranked hit(s) hidden. Raise with --limit if needed. Usually you do not.",
  recallCaption:
    "A real query against the example vault in the repo, output verbatim. The number on the left is the BM25 score. No model was in the ranking loop.",
  letta:
    "Letta sells memory tools. Its own benchmark scored plain files at 74.0%, ahead of its own tools and ahead of mem0's best run at 68.5%. Letta is now rebuilding its flagship around markdown in git.",
  dogfood:
    "I run my own vault on this, work and life in the same folder, and I have queried it every day since the first commit.",
  evalLink: { label: "the questions and the scores", href: "https://github.com/aleksandr-bogdanov/imprnt/tree/main/eval" },
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
  sub: "Open source, MIT licensed, and yours to read end to end.",
  install: site.install,
  ctaPrimary: { label: "Read the docs", href: "/getting-started/" },
  ctaSecondary: { label: "Star on GitHub", href: site.repo },
  quip: "People who enjoy re-introducing themselves to their AI every morning should not install this.",
};
