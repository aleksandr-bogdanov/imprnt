/**
 * Landing copy, as data. One place to read, one place to anti-slop scan.
 * The landing sells. The depth lives in the docs (site/docs/, rendered by Starlight).
 * Product voice: clean, confident, plain.
 */

export const site = {
  name: "imprnt",
  tagline: "A knowledge vault you own and run locally.",
  description:
    "imprnt is a local-first, plain-markdown knowledge vault for your AI assistant. The LLM builds the tools, the tools do the work.",
  repo: "https://github.com/aleksandr-bogdanov/imprnt",
  install: "npm i -g imprnt && imprnt init",
  principle: "The LLM builds the tools. The tools do the work.",
};

export const nav = [
  { label: "How it works", href: "/how-it-works/" },
  { label: "The model", href: "/the-model/" },
  { label: "Plugins", href: "/plugins/" },
  { label: "Docs", href: "/getting-started/" },
];

export const hero = {
  eyebrow: "Open source · MIT · runs on your machine",
  headlineLead: "Give your assistant a memory you",
  headlineAccent: "own",
  subhead:
    "imprnt keeps what you know in plain markdown on your disk. You talk, your assistant files what matters, and weeks later it answers from your real history.",
  ctaPrimary: { label: "Get started", href: "/getting-started/" },
  ctaSecondary: { label: "View source", href: site.repo },
};

export const problem = {
  eyebrow: "The problem",
  heading: "Your assistant forgets everything between chats.",
  body: [
    "Every session starts blank. You re-explain your projects, your people, and the decisions you already made, and whatever the assistant learned dies when the chat closes.",
    "imprnt keeps the part that lasts in plain files you own. Your assistant reads from your real history every session, and no company can take it away.",
  ],
};

export const demo = {
  eyebrow: "How it feels",
  heading: "Talk. It files. It recalls.",
  lead: "Hand over a transcript, a document, or a single fact and ask. The model files structured, linked notes. Weeks later, the answer comes straight from your own vault.",
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
};

export const different = {
  eyebrow: "Why it's different",
  heading: "Nothing runs until you run it.",
  lead: "You own the files, you run the commands, and the off switch is real.",
  features: [
    {
      title: "Own your files",
      body: "Plain markdown on your disk, owner-only and local. It opens in any editor, graphs in Obsidian, and traces every note back to its source.",
      icon: "files",
      href: "/the-model/",
    },
    {
      title: "Cheap, local recall",
      body: "A lookup is about a hundred tokens of local ranked search. No vector database, no server, and it never goes stale on an edit.",
      icon: "bolt",
      href: "/how-it-works/",
    },
    {
      title: "No daemon, no cloud",
      body: "No always-on hooks, no auto-injected context, no background loop. The model never takes an action you did not approve.",
      icon: "shield",
      href: "/how-it-works/",
    },
    {
      title: "Plugins you delete",
      body: "A tiny core plus opt-in plugins you add by name and remove with one line. Compose the assistant you want.",
      icon: "blocks",
      href: "/plugins/",
    },
  ],
};

export const closing = {
  heading: "Start your vault in two commands.",
  sub: "Open source, MIT licensed, and yours to read end to end.",
  install: site.install,
  ctaPrimary: { label: "Read the docs", href: "/getting-started/" },
  ctaSecondary: { label: "Star on GitHub", href: site.repo },
};

export const footer = {
  blurb: "A knowledge vault you own and run locally.",
  copyright: "MIT licensed. © 2026 Aleksandr Bogdanov.",
  columns: [
    {
      title: "Docs",
      links: [
        { label: "Getting started", href: "/getting-started/" },
        { label: "How it works", href: "/how-it-works/" },
        { label: "The model", href: "/the-model/" },
        { label: "Plugins", href: "/plugins/" },
      ],
    },
    {
      title: "Project",
      links: [
        { label: "GitHub", href: "https://github.com/aleksandr-bogdanov/imprnt", external: true },
        { label: "The vault contract", href: "https://github.com/aleksandr-bogdanov/imprnt/blob/main/CLAUDE.md", external: true },
        { label: "Architecture", href: "/architecture/" },
        { label: "Design decisions", href: "/design-decisions/" },
      ],
    },
  ],
};
