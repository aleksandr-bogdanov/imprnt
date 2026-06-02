#!/usr/bin/env bun
// knowful ingest <transcript> [--vault DIR]
//
// Deterministic transcript -> structured meeting note. NO LLM CALL.
// Parses speakers, date, and heuristically extracts decisions / action items / open questions
// with provenance markers. Leaves the semantic Summary for the agent (the only LLM step).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { loadManifest, saveManifest } from "./lib/manifest.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// --- arg parsing -----------------------------------------------------------
const args = process.argv.slice(2);
let vault = "./vault";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") vault = args[++i];
  else positional.push(args[i]);
}
const src = positional[0];
if (!src) {
  console.error("usage: knowful ingest <transcript> [--vault DIR]");
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(1);
}

// --- delta manifest (incremental) ------------------------------------------
const text = readFileSync(src, "utf8");
const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
const manifest = loadManifest(vault);
if (manifest[src]?.hash === hash) {
  console.log(`unchanged (hash ${hash}) — skipping ${src}. note: ${manifest[src].note}`);
  process.exit(0);
}

// --- parse -----------------------------------------------------------------
const fname = basename(src);
const dateMatch = fname.match(/(\d{4}-\d{2}-\d{2})/) || text.match(/^\s*date:\s*(\d{4}-\d{2}-\d{2})/im);
const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

const lines = text.split(/\r?\n/);
const SPEAKER = /^([A-Z][A-Za-z .'-]{1,40}):\s*(.*)$/;
const META_KEYS = new Set(["date", "subject", "topic", "note", "notes", "attendees", "participants"]);

type Turn = { speaker: string; text: string };
const turns: Turn[] = [];
const speakers = new Set<string>();
let subject = "";
for (const line of lines) {
  const m = line.match(SPEAKER);
  if (m) {
    const key = m[1].trim().toLowerCase();
    if (META_KEYS.has(key)) {
      if (key === "subject" || key === "topic") subject = m[2].trim();
      continue;
    }
    turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    speakers.add(m[1].trim());
  } else if (turns.length) {
    turns[turns.length - 1].text += " " + line.trim();
  }
}

const DECISION = /\b(decided|we'?ll go with|going with|agreed|final decision|settled on|conclusion is|let'?s use)\b/i;
const ACTION = /\b(I'?ll|we'?ll|will |need to|action item|TODO|follow up|by (?:monday|tuesday|wednesday|thursday|friday|eod|next week|end of)|take ownership|own this)\b/i;
const QUESTION = /\?\s*$/;

type Item = { speaker: string; text: string };
const decisions: Item[] = [];
const actions: Item[] = [];
const questions: Item[] = [];
for (const t of turns) {
  // split long turns into sentences so one turn can yield several items
  const sentences = t.text.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0);
  for (const s of sentences) {
    if (DECISION.test(s)) decisions.push({ speaker: t.speaker, text: s.trim() });
    else if (ACTION.test(s)) actions.push({ speaker: t.speaker, text: s.trim() });
    else if (QUESTION.test(s)) questions.push({ speaker: t.speaker, text: s.trim() });
  }
}

// workstream guess: from filename keywords or recurring capitalized tokens
const wsGuess = /(sts2|bigquery|migration|pipeline|airflow|identity)/i.exec(fname + " " + subject + " " + text);
const workstream = wsGuess ? slugify(wsGuess[0]) : "";

// --- render note -----------------------------------------------------------
const title = subject || `1:1 — ${[...speakers].join(", ")}`;
const noteSlug = `${date}-${slugify(subject || [...speakers].join("-") || "meeting")}`;
const people = [...speakers].map((s) => `"[[people/${slugify(s)}]]"`);
const tags = ["meeting", workstream].filter(Boolean).map((t) => `"${t}"`);

const fm = [
  "---",
  "type: meeting",
  `date: ${date}`,
  `participants: [${people.join(", ")}]`,
  `tags: [${tags.join(", ")}]`,
  workstream ? `workstream: "[[workstreams/${workstream}]]"` : "",
  `source: "${src}"`,
  `source_hash: ${hash}`,
  "status: draft-deterministic",
  `ingested: ${new Date().toISOString()}`,
  "---",
].filter(Boolean).join("\n");

const fmt = (items: Item[]) =>
  items.length ? items.map((i) => `- ${i.text} — _${i.speaker}_ ^[extracted]`).join("\n") : "_none detected — confirm during semantic clean_";

const body = `# ${title}

> ${turns.length} turns · ${speakers.size} participants · parsed deterministically. No LLM was used to produce this draft.

## Summary
<!-- semantic-clean: pending — the agent fills this. This is the only step that should cost LLM tokens. -->

## Decisions
${fmt(decisions)}

## Action items
${fmt(actions)}

## Open questions
${fmt(questions)}

## Participants
${[...speakers].map((s) => `- [[people/${slugify(s)}]]`).join("\n") || "_none detected_"}

## Source
Raw transcript: \`${src}\` (sha256:${hash}). Immutable — do not edit; re-ingest instead.
`;

const note = `${fm}\n\n${body}`;
const dir = join(vault, "meetings");
mkdirSync(dir, { recursive: true });
const notePath = join(dir, `${noteSlug}.md`);
writeFileSync(notePath, note);

manifest[src] = { hash, note: notePath, ingested: new Date().toISOString() };
saveManifest(vault, manifest);

console.log(`ingested ${src}`);
console.log(`  -> ${notePath}`);
console.log(`  ${decisions.length} decisions · ${actions.length} actions · ${questions.length} questions · ${speakers.size} participants (all ^[extracted], deterministic)`);
console.log(`  next: agent fills the ## Summary and extends people/ + workstreams/ (the only LLM step)`);
