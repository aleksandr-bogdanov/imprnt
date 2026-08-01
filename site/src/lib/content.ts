/**
 * Shared site strings, as data. One place to read, one place to anti-slop scan.
 * Nav, Footer, and Layout read from here. Landing-page copy lives in landing.ts.
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
  { label: "Vault layout", href: "/vault-layout/" },
  { label: "Plugins", href: "/plugins/" },
  { label: "Docs", href: "/getting-started/" },
];

type FooterLink = { label: string; href: string; external?: boolean };

export const footer: {
  blurb: string;
  copyright: string;
  columns: { title: string; links: FooterLink[] }[];
} = {
  blurb: "Your AI's memory, boring on purpose.",
  copyright: "MIT licensed. © 2026 Aleksandr Bogdanov.",
  columns: [
    {
      title: "Docs",
      links: [
        { label: "Getting started", href: "/getting-started/" },
        { label: "How it works", href: "/how-it-works/" },
        { label: "Vault layout", href: "/vault-layout/" },
        { label: "Plugins", href: "/plugins/" },
      ],
    },
    {
      title: "Project",
      links: [
        { label: "GitHub", href: "https://github.com/aleksandr-bogdanov/imprnt", external: true },
        { label: "The vault contract", href: "https://github.com/aleksandr-bogdanov/imprnt/blob/master/CLAUDE.md", external: true },
        { label: "How it compares", href: "/comparison/" },
        { label: "Design decisions", href: "/design-decisions/" },
      ],
    },
  ],
};
