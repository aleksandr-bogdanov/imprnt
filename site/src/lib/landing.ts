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
export type TermSeg = string | { k: "path" | "key" | "gone" | "faint"; v: string; pop?: string };
export type TermLine = { who: string; segs: TermSeg[] };

export const hero = {
  eyebrow: "Open source · MIT",
  headlineLead: "Your AI's memory,",
  headlineAccent: "boring on purpose",
  motto: "Essentially, a folder of markdown files.",
  // Two paragraphs on purpose. The first says what it does to what you give it,
  // the second says what that buys you later. The old single block welded both
  // plus the runs-anywhere line into one 60-word sentence nobody finished.
  subheadParas: [
    "Hand it anything: a meeting transcript, an article, a rambling voice note. It gets <strong>imprinted</strong>: normalised into separate markdown files on your disk, each one typed, tagged, and linked to the others. One note per person, per project, per decision, per event.",
    "Ask three weeks later and the answer comes back from those files. <strong>Plain code finds them, and the model reads only the handful it returns.</strong> Works today with Claude Code and Gemini CLI.",
  ],
  installCaption: "Paste that line once. After that your assistant runs imprnt for you, so it is the last command you type by hand.",
  ctaPrimary: { label: "Get started", href: "/getting-started/" },
  ctaSecondary: { label: "View source", href: site.repo },
  terminalLabel: "two separate sessions, three weeks apart",
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
        {
          k: "faint",
          v: "[paste the transcript]",
          pop:
            "You: how did the parallel run go over the weekend?\n\n" +
            "Boris: read path is clean. Two hundred million requests, zero mismatches.\n" +
            "Writes are the problem, we are still at forty milliseconds p99 against\n" +
            "twelve on the old stack.\n\n" +
            "You: is that a blocker or a nice-to-have?\n\n" +
            "Boris: blocker. Checkout calls it synchronously. At forty we would push\n" +
            "the whole page over budget and support would feel it inside a day.\n\n" +
            "You: so June 30 is dead.\n\n" +
            "Boris: June 30 was always optimistic. I want two more weeks of numbers\n" +
            "before I sign anything. If the writes come down we cut over mid-July.\n\n" +
            "You: let us say July 15, gated on the parallel-run numbers. If the p99\n" +
            "is not under twenty by then we slip again and I will take that to Lena.\n\n" +
            "Boris: agreed. I will own the cutover. Priya already has the dashboards,\n" +
            "she is adding a write-latency panel this week.\n\n" +
            "You: anything you need from me?\n\n" +
            "Boris: nothing. Just do not let anyone add scope before the fifteenth.",
        },
      ],
    },
    {
      who: "imp",
      segs: [
        "Filed it. Wrote three notes: ",
        {
          k: "path",
          v: "people/boris-carter",
          pop:
            "---\ntype: person\nteam: platform\nrole: staff engineer\n" +
            'owns: ["[[projects/access-platform]]"]\n' +
            "tags: [work, access-platform]\n" +
            "summary: Owns the access-platform cutover. Signs off on the parallel-run numbers.\n---\n\n" +
            "# Boris Carter\n\nOwns [[projects/access-platform]] end to end.",
        },
        ", updated ",
        {
          k: "path",
          v: "projects/access-platform",
          pop:
            "---\ntype: project\nstatus: active\n" +
            'owner: "[[people/boris-carter]]"\n' +
            "updated: 2026-06-11\ntags: [work, access-platform]\n" +
            "summary: Cutover moved to July 15, gated on the parallel-run numbers.\n---\n\n" +
            "# Access platform cutover\n\n" +
            "> superseded by [[events/2026-06-11-boris-1-1]]\n" +
            "~~Cutover on June 30.~~\n\n" +
            "Cutover July 15, after two weeks of parallel-run numbers.",
        },
        " with the new cutover date, and the meeting itself as ",
        {
          k: "path",
          v: "events/2026-06-11-boris-1-1",
          pop:
            "---\ntype: event\ndate: 2026-06-11\n" +
            'participants: ["[[people/boris-carter]]"]\n' +
            'project: "[[projects/access-platform]]"\nstatus: enriched\n---\n\n' +
            "# 1:1 with Boris, 11 June\n\n" +
            "## Decisions\n- Cutover moves to July 15, gated on the two-week parallel run.\n" +
            "- Boris owns it. Priya owns the dashboards.",
        },
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
        {
          k: "gone",
          v: "June",
          pop:
            "The old line is kept, not deleted:\n\n" +
            "> superseded by [[events/2026-06-11-boris-1-1]]\n" +
            "~~Cutover on June 30.~~\n\n" +
            "So the vault can always show you what it used to say, and what replaced it.",
        },
        " date is superseded.",
      ],
    },
  ],
  terminalCaption:
    "Nothing carried over between the two sessions except the files on disk.",
};

export const how = {
  eyebrow: "How it works",
  headingLead: "The model imprints it.",
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
    "A model can do almost anything, so <strong>almost everything got built on one</strong>. Wrap ChatGPT, call it an AI product, ship it, take the investor money. That worked while tokens were cheap.",
    "That is not the case anymore. I put a personal-assistant setup on my work laptop. It burned <strong>30,000 tokens before I typed a word</strong>, because it had loaded every skill and every MCP server up front. I was paying per token, so I started thinking twice before asking anything. <strong>An assistant you are afraid to use is not an assistant.</strong>",
    "So imprnt splits the job in two. Imprinting takes a model.<br /><strong>Finding does not need one.</strong>",
  ],
  spec: ["no embeddings", "no vector store", "no index to rebuild"],
  paras2: [
    "Keyword search has one famous weakness. <strong>You search for a synonym and nothing comes back.</strong> We fix it while writing, not while searching. The model records the synonyms and the other names a thing goes by, so the note about <code>Boris Carter</code> also matches a search for <code>Boris</code>. Rename him and the old name stays on the note.",
    "Every search after that runs <strong>BM25</strong>. It is a ranking formula from 1994, and <strong>Lucene and Elasticsearch</strong> still run it today. It counts how often your words appear, weighs rare words heavier, and puts a word in the title above the same word buried in the body. There is no index to refresh, so a note you edited by hand in Obsidian a minute ago is already findable.",
    "Every session pays <strong>about 200 tokens</strong>: one short note saying the vault exists and naming its two commands. <strong>A session that only asks questions never pays more.</strong> A session that files a note reads the filing rules first, about 7,000 tokens, paid once.",
    "That is why imprnt is a command line tool and not an MCP server. <strong>An MCP server loads its tool descriptions into every chat by default.</strong> You pay for those before you ask anything.",
  ],
  link: { label: "the full arguments, decision by decision", href: "/design-decisions/" },
};

export const proof = {
  // Numbers are the paper's OWN metric (token F1, all five categories including the
  // adversarial ones Letta drops), run through the unmodified snap-research scorer.
  // That is the only metric the paper's human and model baselines are on, so it is the
  // only one where showing them beside ours is honest. Our 76.3% figure is a DIFFERENT
  // metric (Letta's SimpleQA grader, adversarial dropped) and putting it next to 87.9%
  // would be exactly the mistake this whole exercise exists to catch. That comparison
  // lives in docs/benchmark-2026-08.md, not here.
  eyebrow: "Does it work",
  heading: "Check it yourself.",
  leadTop: "<strong>64.2%</strong> on LoCoMo. A person scores <strong>87.9%</strong>.",
  leadParas: [
    "LoCoMo is the benchmark this kind of tool is rated on. <strong>1,540 questions about conversations that ran for months</strong>, written by the paper's authors.",
    "It asks the awkward ones on purpose: facts spread across several sessions, questions about when something happened, and <strong>questions with no answer at all</strong>, to catch a system that invents one.",
    "Each conversation is read once and filed. Every answer comes only from the notes, never from the original text.",
  ],
  leadLink: { label: "the LoCoMo paper and dataset", href: "https://arxiv.org/abs/2402.17753" },
  stats: [
    { value: "64.2%", label: "imprnt, with Claude Sonnet reading and writing. Answers come only from the notes." },
    { value: "87.9%", label: "a person answering the same questions, from the paper" },
    { value: "32.1%", label: "the paper's own AI baseline, on the same questions" },
  ],
  recallCaption:
    "You ask in plain language and the agent runs the search itself. Hover any file to read it.",
  dogfood:
    "I have used imprnt every day for almost half a year, building it and living on it at the same time.<br />Work and life in the same folder.",
  evalLink: { label: "the benchmark run, every question and verdict", href: "https://github.com/aleksandr-bogdanov/imprnt/tree/master/eval" },
  compareLink: { label: "how it compares", note: "a technical read", href: "/comparison/" },
};

export const file = {
  eyebrow: "What lands on disk",
  heading: "Swap the assistant, keep the memory.",
  // Line breaks are deliberate: a sentence that starts a new idea starts a new line,
  // rather than beginning halfway across the line above it.
  paras: [
    "Every note is a markdown file. <strong>It opens with a small typed header that code can read</strong>, then the prose you actually read.<br />Every person and every project gets a note of its own, and the other notes link to it.",
    "Your own editor can edit the notes, Obsidian included, because a vault is plain markdown with ordinary wikilinks.<br /><strong>Fix a note by hand and the next search picks it up.</strong><br />Notes you already have come in the same way: the model reads them once and files them.",
    "Change a fact and the old line is <strong>struck through with the new one stamped beside it</strong>, never silently overwritten. When a new note contradicts one you already have, imprnt holds it back and asks you which is right.",
  ],
  noteLabel: "the file behind the demo answer",
};

export const closing = {
  // Same words, split only so the line breaks at the phrase. text-wrap:balance
  // put "in" alone at the end of line one, because "in two commands." is a
  // hair WIDER than "Start your vault in" - no max-width can force the better
  // break, only keeping the phrase whole can. Same device as how.headingLead.
  headingLead: "Start your vault",
  headingTail: "with one pasted line.",
  sub: "Open source, MIT licensed, and yours end to end.",
  install: site.install,
  ctaPrimary: { label: "Read the docs", href: "/getting-started/" },
  ctaSecondary: { label: "Star on GitHub", href: site.repo },
  quip: "People who enjoy re-introducing themselves to their AI every morning should not install this.",
};
