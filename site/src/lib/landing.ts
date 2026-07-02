/**
 * Landing-page copy, as data. One place to read, one place to anti-slop scan.
 * Landing-only on purpose: the shared strings (site name, install command,
 * nav, footer) stay in content.ts, which Nav, Footer, and Layout also read.
 * Product voice: clean, confident, plain. Facts and commands are verified,
 * rewrite phrasing freely but never a number, a path, or a capability.
 */
import { site } from "./content";

export const hero = {
  eyebrow: "Open source · MIT · runs on your machine",
  headlineLead: "Give your assistant a memory you",
  headlineAccent: "own",
  subhead:
    "imprnt keeps what you know in plain markdown on your disk. You talk, your assistant files what matters, and weeks later it answers from your real history.",
  ctaPrimary: { label: "Get started", href: "/getting-started/" },
  ctaSecondary: { label: "View source", href: site.repo },
  graphHintMobile: "a real example vault - every dot is a note, tap one",
};

export const problem = {
  eyebrow: "The problem",
  heading: "Your assistant forgets everything between chats.",
  intro:
    "Every session starts blank. You re-explain your projects, your people, and the decisions you already made, and whatever the assistant learned dies when the chat closes.",
  flip:
    "imprnt keeps the part that lasts in plain files you own. Your assistant reads from your real history every session, and no company can take it away.",
};

export const flow = {
  eyebrow: "How it feels",
  heading: "You talk once. It files notes you can read.",
  lead:
    "Hand over a transcript, a document, or a single fact. The model sorts it into small linked notes, plain markdown you can open in any editor. Ask weeks later, and the answer comes straight from those files.",
  steps: [
    { n: "01", title: "You talk", sub: "paste a meeting, a doc, or one fact" },
    { n: "02", title: "It files", sub: "small linked notes land on your disk" },
    { n: "03", title: "You ask later", sub: "the answer comes from your own notes" },
  ],
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
  noteLabel: "the file behind that answer",
  noteCaption:
    "This is the real shape of a note. A few labeled lines up top that code can check, prose you can read, and links that wire it to the people and meetings around it. When a fact changes, the old line is struck and stamped, never silently overwritten.",
};

export const lockin = {
  eyebrow: "No lock-in",
  heading: "Swap the assistant, keep the memory.",
  lead:
    "Everything lives in one folder of plain markdown on your disk, searched locally, with no vendor memory store in the middle. The vault outlives whatever model you run this year, and the agent on top stays swappable.",
  kicker: "Delete imprnt tomorrow and every note still opens, because markdown needs no app.",
  cta: { label: "See how it compares", href: "/comparison/" },
};

export const different = {
  eyebrow: "Why it's different",
  heading: "Nothing runs until you run it.",
  lead: "You own the files, you run the commands, and the off switch is real.",
  features: [
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
