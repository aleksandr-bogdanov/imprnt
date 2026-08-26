#!/usr/bin/env node
// memrot — a read-only checkup for markdown memory workspaces.
//
// Points at a folder of plain-markdown agent memory (an OpenClaw workspace, a nanobot
// workspace, an Obsidian vault, any pile of .md files an agent reads and writes) and
// reports what has rotted in it: links to files that no longer exist, files nothing
// references, near-duplicate records, past-due markers, facts that disagree with each
// other, merge-conflict debris, template placeholders that were never filled in.
//
// Guarantees, by construction:
//   - read-only: opens files, never writes, never deletes, never touches mtimes beyond atime
//   - local: no network, no index, no embeddings
//   - zero dependencies: node >= 18, nothing else
//   - no runtime needed: it reads the files on disk, not the agent that made them
//
// Usage: memrot [dir] [--json] [--stale-days N]
//   dir defaults to ~/.openclaw/workspace when that exists, else the current directory.

import { readdirSync, readFileSync, statSync, lstatSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- scan

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024; // memory notes are small; anything bigger is not prose

/** Walk `root`, returning every regular file as a posix-relative path. Never follows symlinks. */
export function scan(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .git, .openclaw-repair, .obsidian, ...
      if (e.isSymbolicLink()) continue; // read-only promise includes "never escapes the tree"
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          continue;
        }
        files.push({ rel, abs, size });
      }
    }
  };
  walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return files;
}

// ---------------------------------------------------------------- text helpers

/**
 * Blank out fenced code blocks and inline code spans while preserving line structure,
 * so link/placeholder/date scans skip examples but keep real line numbers.
 * (Lesson borrowed from every linter that ever flagged its own documentation.)
 */
export function maskCode(text) {
  const out = [];
  let inFence = false;
  let fenceMark = "";
  for (const line of text.split("\n")) {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (inFence) {
      out.push("");
      if (open && open[1][0] === fenceMark[0] && open[1].length >= fenceMark.length) inFence = false;
      continue;
    }
    if (open) {
      inFence = true;
      fenceMark = open[1];
      out.push("");
      continue;
    }
    // inline code spans
    out.push(line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)));
  }
  return out.join("\n");
}

/** Blank the leading YAML frontmatter block, preserving line count. */
export function maskFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < Math.min(lines.length, 80); i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") {
      return lines
        .map((l, j) => (j <= i ? "" : l))
        .join("\n");
    }
  }
  return text; // unclosed — hygiene check reports it; leave text alone here
}

const WORD_RE = /[a-z0-9][a-z0-9'-]*/g;
function tokens(s) {
  return (s.toLowerCase().match(WORD_RE) ?? []);
}

const STOP = new Set(
  "a an the and or but of to in on at for with by from as is are was were be been do does did don't not no never always prefer avoid use it its this that these those i you your my me we our".split(
    " ",
  ),
);
function contentTokens(s) {
  return tokens(s).filter((t) => !STOP.has(t) && t.length > 2);
}

function isoDaysAgo(iso, today) {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((today.getTime() - d.getTime()) / 86400000);
}

// ---------------------------------------------------------------- checks

// Files the host runtime loads by convention, so "nothing links to them" is fine.
const WELL_KNOWN_ROOT = new Set(
  [
    "AGENTS.md", "CLAUDE.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md",
    "MEMORY.md", "memory.md", "BOOTSTRAP.md", "BOOT.md", "HEARTBEAT.md",
    "DREAMS.md", "README.md", "WIKI.md", "index.md", "inbox.md", "hot.md", "log.md",
  ].map((s) => s.toLowerCase()),
);

const DATED_FILE_RE = /(^|\/)(19|20)\d{2}-\d{2}-\d{2}[^/]*\.md$/i;

function isDatedLog(rel) {
  return DATED_FILE_RE.test(rel) || rel.startsWith("memory/") || rel.startsWith("memories/");
}

const NOISE_KEYS = new Set([
  "summary", "title", "status", "date", "source", "session key", "session id",
  "reason", "read when", "read_when", "homepage", "description", "tags", "type",
  "note", "notes", "example", "examples", "important", "warning", "tip", "caution",
  "todo", "nb", "ps", "update", "edit", "aka", "e g", "i e", "created", "updated",
  "context", "goal", "result", "output", "input", "see", "see also", "related", "links",
]);

const DUE_RE =
  /\b(due|deadline|expires?|expiry|renew(?:al|s)?|review by|re-?check|remind(?:er)?|follow[- ]?up|valid until|until|by)\b[^.\n]{0,60}?\b((?:19|20)\d{2}-\d{2}-\d{2})\b/i;

const OBSERVED_RE = /<!--\s*observed:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|YYYY-MM-DD)\s*\|\s*status:\s*(\w+)\s*-->/g;

const DIRECTIVE_RE = /^\s*[-*]\s+(Always|Never|Don'?t|Do not|Prefer|Avoid|Only|Use|No)\b(.{3,160})$/i;
const NEGATIVE = new Set(["never", "dont", "don't", "do not", "avoid", "no"]);

/**
 * Run every check over a workspace directory.
 * Returns { findings, stats } — findings are { check, severity, file, line, message },
 * severity one of "problem" | "warn" | "info".
 */
export function runChecks(root, opts = {}) {
  const today = opts.today ?? new Date();
  const staleDays = opts.staleDays ?? 180;
  const findings = [];
  const add = (check, severity, file, line, message) =>
    findings.push({ check, severity, file, line, message });

  const files = scan(root);
  const mdFiles = files.filter((f) => f.rel.toLowerCase().endsWith(".md") && f.size <= MAX_FILE_BYTES);

  // --- read everything once
  const docs = new Map(); // rel -> { raw, masked, lines, maskedLines }
  for (const f of mdFiles) {
    let raw;
    try {
      raw = readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    if (raw.includes("\u0000")) {
      add("hygiene", "warn", f.rel, 1, "contains NUL bytes — not a text file?");
      continue;
    }
    const masked = maskFrontmatter(maskCode(raw));
    docs.set(f.rel, { raw, masked, lines: raw.split("\n"), maskedLines: masked.split("\n"), size: f.size });
  }

  // --- layout sniff (only used to enable convention-aware extras; the core checks are generic)
  const rootNames = new Set(files.filter((f) => !f.rel.includes("/")).map((f) => f.rel));
  const openclawish =
    rootNames.has("AGENTS.md") && (rootNames.has("SOUL.md") || files.some((f) => f.rel.startsWith("memory/")));

  // --- link resolution maps
  const fileSet = new Set(files.map((f) => f.rel));
  const lowerMap = new Map();
  const baseMap = new Map(); // basename without .md, lowercased -> [rel]
  for (const f of files) {
    const lower = f.rel.toLowerCase();
    if (!lowerMap.has(lower)) lowerMap.set(lower, []);
    lowerMap.get(lower).push(f.rel);
    const base = path.posix.basename(lower).replace(/\.md$/, "");
    if (!baseMap.has(base)) baseMap.set(base, []);
    baseMap.get(base).push(f.rel);
  }

  // case-collision: two paths differing only by case break every mac<->linux sync
  for (const [, rels] of lowerMap) {
    if (rels.length > 1) {
      add("hygiene", "problem", rels[0], 0, `filename case collision: ${rels.join("  vs  ")}`);
    }
  }

  const inbound = new Map(); // rel -> count of inbound links

  const resolveTarget = (fromRel, target, { wiki }) => {
    let t = target.trim();
    try {
      t = decodeURIComponent(t);
    } catch { /* leave as-is */ }
    t = t.split("#")[0].trim();
    if (!t) return { kind: "ok", rel: null }; // pure anchor
    const candidates = [t, t + ".md"];
    const bases = [path.posix.dirname(fromRel), ""];
    for (const base of bases) {
      for (const c of candidates) {
        const norm = path.posix.normalize(path.posix.join(base === "." ? "" : base, c));
        if (norm.startsWith("..")) continue;
        if (fileSet.has(norm)) return { kind: "ok", rel: norm };
        const ci = lowerMap.get(norm.toLowerCase());
        if (ci) return { kind: "case", rel: ci[0], wanted: norm };
      }
    }
    // wikilinks resolve by unique basename anywhere in the tree (the Obsidian rule)
    const base = path.posix.basename(t.toLowerCase()).replace(/\.md$/, "");
    const hits = baseMap.get(base);
    if (hits && wiki) return { kind: "ok", rel: hits[0] };
    if (hits) return { kind: "moved", rel: hits[0] };
    return { kind: "dead" };
  };

  const WIKILINK_RE = /!?\[\[([^\]\n|#]*)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;
  const MDLINK_RE = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const [rel, doc] of docs) {
    doc.maskedLines.forEach((line, i) => {
      for (const m of line.matchAll(WIKILINK_RE)) {
        const target = m[1].trim();
        if (!target) continue;
        const r = resolveTarget(rel, target, { wiki: true });
        if (r.kind === "ok" && r.rel) inbound.set(r.rel, (inbound.get(r.rel) ?? 0) + 1);
        else if (r.kind === "case")
          add("links", "problem", rel, i + 1, `[[${target}]] matches only by case — actual file is ${r.rel} (breaks on case-sensitive disks)`);
        else if (r.kind === "dead")
          add("links", "problem", rel, i + 1, `[[${target}]] points at a file that doesn't exist`);
      }
      for (const m of line.matchAll(MDLINK_RE)) {
        const url = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // http:, mailto:, tel:, ...
        if (url.startsWith("#") || url.startsWith("/")) continue; // anchor / absolute: out of scope
        const r = resolveTarget(rel, url, { wiki: false });
        if (r.kind === "ok" && r.rel) inbound.set(r.rel, (inbound.get(r.rel) ?? 0) + 1);
        else if (r.kind === "case")
          add("links", "problem", rel, i + 1, `(${url}) matches only by case — actual file is ${r.rel} (breaks on case-sensitive disks)`);
        else if (r.kind === "moved")
          add("links", "problem", rel, i + 1, `(${url}) is dead — a file with that name now lives at ${r.rel} (moved?)`);
        else if (r.kind === "dead")
          add("links", "problem", rel, i + 1, `(${url}) points at a file that doesn't exist`);
      }
    });
  }

  // --- orphans: markdown nothing links to, that no runtime convention loads either.
  const orphanRels = [];
  for (const [rel] of docs) {
    if (inbound.get(rel)) continue;
    if (isDatedLog(rel)) continue; // date-loaded / log-structured
    if (!rel.includes("/") && WELL_KNOWN_ROOT.has(rel.toLowerCase())) continue;
    if (/(^|\/)skills\/[^/]+\/[^/]+$/i.test(rel)) continue; // skill bundles are loaded by name
    orphanRels.push(rel);
  }
  // When most of a tree has no inbound links, linking just isn't how it's organized —
  // listing every file would be noise, not signal. Say it once instead.
  if (orphanRels.length > Math.max(20, docs.size * 0.3)) {
    add(
      "orphans",
      "info",
      "",
      0,
      `${orphanRels.length} of ${docs.size} files have no inbound links — this tree isn't organized by linking, so per-file orphan reports would be noise (skipped)`,
    );
  } else {
    for (const rel of orphanRels)
      add("orphans", "info", rel, 0, "no other file links here — reachable only by search or by remembering it exists");
  }

  // --- near-duplicate files (minhash candidates, then exact Jaccard on 5-word shingles)
  const shingleSets = new Map();
  const SIG_K = 12;
  const sigBuckets = new Map();
  for (const [rel, doc] of docs) {
    const words = tokens(doc.masked);
    if (words.length < 60) continue;
    const set = new Set();
    for (let i = 0; i + 5 <= words.length; i++) {
      const sh = words.slice(i, i + 5).join(" ");
      let h = 2166136261;
      for (let j = 0; j < sh.length; j++) {
        h ^= sh.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      set.add(h >>> 0);
    }
    shingleSets.set(rel, set);
    const sig = [...set].sort((a, b) => a - b).slice(0, SIG_K);
    for (const s of sig) {
      if (!sigBuckets.has(s)) sigBuckets.set(s, []);
      sigBuckets.get(s).push(rel);
    }
  }
  const pairCount = new Map();
  for (const [, rels] of sigBuckets) {
    if (rels.length < 2 || rels.length > 50) continue;
    for (let i = 0; i < rels.length; i++)
      for (let j = i + 1; j < rels.length; j++) {
        const key = rels[i] + "\u0000" + rels[j];
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
  }
  const dupSeen = new Set();
  for (const [key, n] of pairCount) {
    if (n < 3) continue; // needs several shared min-shingles before the exact check
    const [a, b] = key.split("\u0000");
    if (dupSeen.has(a + b)) continue;
    const sa = shingleSets.get(a);
    const sb = shingleSets.get(b);
    let inter = 0;
    const [small, big] = sa.size < sb.size ? [sa, sb] : [sb, sa];
    for (const s of small) if (big.has(s)) inter++;
    const jac = inter / (sa.size + sb.size - inter);
    if (jac >= 0.5) {
      dupSeen.add(a + b);
      const pct = Math.round(jac * 100);
      add(
        "duplicates",
        "warn",
        a,
        0,
        jac > 0.95
          ? `practically identical to ${b} — same record saved twice`
          : `${pct}% same content as ${b} — two records of the same thing that will drift apart`,
      );
    }
  }

  // --- the same long line copied across many files
  const lineIndex = new Map(); // normalized line -> Map(rel -> firstLineNo)
  for (const [rel, doc] of docs) {
    doc.maskedLines.forEach((line, i) => {
      const t = line.trim();
      if (t.length < 50 || t.startsWith("#")) return;
      const norm = t.toLowerCase().replace(/\s+/g, " ");
      if (!lineIndex.has(norm)) lineIndex.set(norm, new Map());
      const m = lineIndex.get(norm);
      if (!m.has(rel)) m.set(rel, i + 1);
    });
  }
  const repeated = [...lineIndex.entries()]
    .filter(([, m]) => m.size >= 3)
    .sort((x, y) => y[1].size - x[1].size)
    .slice(0, 8);
  for (const [, m] of repeated) {
    const where = [...m.entries()];
    const [firstFile, firstLine] = where[0];
    const text = docs.get(firstFile).maskedLines[firstLine - 1].trim();
    add(
      "duplicates",
      "info",
      firstFile,
      firstLine,
      `this exact line appears in ${m.size} files (${where.slice(0, 4).map(([f]) => f).join(", ")}${m.size > 4 ? ", …" : ""}) — an edit in one won't reach the others: "${text.slice(0, 90)}${text.length > 90 ? "…" : ""}"`,
    );
  }

  // --- stale dates
  for (const [rel, doc] of docs) {
    const dated = isDatedLog(rel);
    doc.maskedLines.forEach((line, i) => {
      if (!dated) {
        const m = line.match(DUE_RE);
        if (m) {
          const days = isoDaysAgo(m[2], today);
          if (days !== null && days > 0)
            add("stale", "warn", rel, i + 1, `"${line.trim().slice(0, 100)}" — that date passed ${days} day${days === 1 ? "" : "s"} ago and this line still reads as pending`);
        }
      }
    });
    // observed/status markers (the OpenClaw USER.md convention, harmless elsewhere)
    for (const m of doc.masked.matchAll(OBSERVED_RE)) {
      const lineNo = doc.masked.slice(0, m.index).split("\n").length;
      if (m[1] === "YYYY-MM-DD") {
        add("hygiene", "warn", rel, lineNo, "template placeholder never filled in: <!-- observed: YYYY-MM-DD … -->");
        continue;
      }
      const days = isoDaysAgo(m[1], today);
      if (days === null) continue;
      if (days < 0) add("stale", "warn", rel, lineNo, `directive observed in the future (${m[1]}) — typo?`);
      else if (m[2].toLowerCase() === "active" && days > staleDays)
        add("stale", "info", rel, lineNo, `directive marked active but last observed ${days} days ago (${m[1]}) — still true?`);
    }
    // relative time words in durable root files rot the moment the session ends
    if (!rel.includes("/") && /^(memory|user)\.md$/i.test(rel)) {
      doc.maskedLines.forEach((line, i) => {
        const m = line.match(/\b(yesterday|tomorrow|next week|last week|next month|last month|this week|this weekend)\b/i);
        if (m)
          add("stale", "warn", rel, i + 1, `"${m[1]}" in a durable memory file — relative to when? (rots the moment it's written)`);
      });
    }
  }

  // --- contradictions: same key, different values, across durable root files
  const rootDurable = [...docs.keys()].filter((rel) => !rel.includes("/") && !isDatedLog(rel));
  const kv = new Map(); // key -> [{file, line, value}]
  for (const rel of rootDurable) {
    const doc = docs.get(rel);
    doc.maskedLines.forEach((line, i) => {
      const m = line.match(/^\s*[-*]?\s*(?:\*\*)?([A-Za-z][A-Za-z0-9 _/&-]{1,40}?)(?:\*\*)?\s*:\s+(\S.{0,119})$/);
      if (!m) return;
      const key = m[1].trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
      if (NOISE_KEYS.has(key)) return;
      const value = m[2].trim().replace(/[.,;]\s*$/, "");
      if (!kv.has(key)) kv.set(key, []);
      kv.get(key).push({ file: rel, line: i + 1, value });
    });
  }
  for (const [key, entries] of kv) {
    if (entries.length < 2 || entries.length > 6) continue;
    const values = new Set(entries.map((e) => e.value.toLowerCase().replace(/\s+/g, " ")));
    if (values.size < 2) continue;
    const spots = entries.map((e) => `${e.file}:${e.line} says "${e.value}"`).join("  |  ");
    add("conflicts", "warn", entries[0].file, entries[0].line, `"${key}" has ${values.size} different values — ${spots}`);
  }

  // --- contradictions: overlapping always/never-style directives
  const directives = [];
  for (const rel of rootDurable) {
    const doc = docs.get(rel);
    doc.maskedLines.forEach((line, i) => {
      const m = line.match(DIRECTIVE_RE);
      if (!m) return;
      const verb = m[1].toLowerCase().replace(/’/g, "'");
      const toks = new Set(contentTokens(m[2]));
      if (toks.size < 3) return;
      directives.push({ file: rel, line: i + 1, verb, toks, text: line.trim() });
    });
  }
  for (let i = 0; i < directives.length; i++) {
    for (let j = i + 1; j < directives.length; j++) {
      const a = directives[i];
      const b = directives[j];
      let inter = 0;
      for (const t of a.toks) if (b.toks.has(t)) inter++;
      const overlap = inter / Math.min(a.toks.size, b.toks.size);
      if (inter < 3 || overlap < 0.6) continue;
      const negA = NEGATIVE.has(a.verb) || NEGATIVE.has(a.verb.replace(/'/g, ""));
      const negB = NEGATIVE.has(b.verb) || NEGATIVE.has(b.verb.replace(/'/g, ""));
      if (negA !== negB)
        add("conflicts", "warn", a.file, a.line, `possible contradiction: "${a.text.slice(0, 80)}" (${a.file}:${a.line}) vs "${b.text.slice(0, 80)}" (${b.file}:${b.line})`);
      else if (overlap >= 0.85)
        add("conflicts", "info", a.file, a.line, `near-duplicate directives: "${a.text.slice(0, 80)}" (${a.file}:${a.line}) and "${b.text.slice(0, 80)}" (${b.file}:${b.line})`);
    }
  }

  // --- hygiene
  for (const [rel, doc] of docs) {
    if (doc.raw.trim().length === 0) {
      add("hygiene", "warn", rel, 1, "file is empty");
      continue;
    }
    const first = doc.lines.findIndex((l) => /^<{7} /.test(l));
    if (first >= 0 && doc.lines.some((l) => /^>{7} /.test(l)))
      add("hygiene", "problem", rel, first + 1, "unresolved git merge conflict markers (<<<<<<< / >>>>>>>) — two versions of this memory are interleaved");
    if (doc.lines[0]?.trim() === "---") {
      const close = doc.lines.slice(1, 80).findIndex((l) => l.trim() === "---" || l.trim() === "...");
      if (close === -1) add("hygiene", "warn", rel, 1, "frontmatter opens with --- but never closes — parsers will eat the body");
    }
    if (/\x1b/.test(doc.raw))
      add("hygiene", "warn", rel, doc.raw.slice(0, doc.raw.indexOf("\x1b")).split("\n").length, "raw terminal escape codes in the text — pasted from a terminal without cleaning?");
    doc.maskedLines.forEach((line, i) => {
      // bare-identifier moustaches only: {{name}}, {{ DATE }} — never JSX ({{ "k": v }}) or code
      if (/\{\{\s*[A-Za-z_][\w .-]{0,40}\s*\}\}/.test(line))
        add("hygiene", "warn", rel, i + 1, `template placeholder never filled in: ${line.trim().slice(0, 80)}`);
      if (/^\s*[-*]\s+\w+\s+\.\.\.\s*$/.test(line))
        add("hygiene", "warn", rel, i + 1, `unfinished template line: "${line.trim()}"`);
    });
  }

  // --- convention extras for OpenClaw-style workspaces
  if (openclawish) {
    const skillDirs = new Set(
      files.filter((f) => /^skills\/[^/]+\//.test(f.rel)).map((f) => f.rel.split("/")[1]),
    );
    for (const d of skillDirs) {
      if (!fileSet.has(`skills/${d}/SKILL.md`))
        add("hygiene", "warn", `skills/${d}/`, 0, "skill folder without a SKILL.md — the runtime can't load it");
    }
  }

  // --- context bloat: what gets read into every single session
  let alwaysLoaded = [];
  if (openclawish) {
    const roots = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "MEMORY.md"].filter((n) =>
      docs.has(n),
    );
    const dailies = [...docs.keys()].filter((r) => /^memory\/(19|20)\d{2}-\d{2}-\d{2}/.test(r)).sort().slice(-2);
    alwaysLoaded = [...roots, ...dailies];
    const bytes = alwaysLoaded.reduce((s, r) => s + docs.get(r).size, 0);
    const tokensEst = Math.round(bytes / 4);
    if (tokensEst > 12000)
      add(
        "bloat",
        "warn",
        alwaysLoaded.reduce((a, b) => (docs.get(a).size > docs.get(b).size ? a : b)),
        0,
        `the always-loaded set (${alwaysLoaded.join(", ")}) is ~${(bytes / 1024).toFixed(0)} KB ≈ ${tokensEst.toLocaleString("en-US")} tokens read into EVERY session before you say a word`,
      );
  }

  const stats = {
    root,
    fileCount: files.length,
    mdCount: docs.size,
    openclawish,
    alwaysLoaded,
    problems: findings.filter((f) => f.severity === "problem").length,
    warns: findings.filter((f) => f.severity === "warn").length,
    infos: findings.filter((f) => f.severity === "info").length,
  };
  return { findings, stats };
}

// ---------------------------------------------------------------- report

const CHECK_TITLES = {
  links: "broken links",
  orphans: "unreferenced files",
  duplicates: "duplicated content",
  stale: "stale dates",
  conflicts: "facts that disagree",
  hygiene: "file hygiene",
  bloat: "context bloat",
};

export function render({ findings, stats }, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const out = [];
  const home = homedir();
  const shownRoot = stats.root.startsWith(home) ? "~" + stats.root.slice(home.length) : stats.root;
  out.push(`memrot — markdown memory checkup`);
  out.push(`workspace: ${shownRoot}  (${stats.mdCount} markdown files scanned, read-only)`);
  out.push("");

  const bySeverity = [
    ["problem", "PROBLEMS — these are broken now", "31"],
    ["warn", "WORTH A LOOK — probably rot, you decide", "33"],
    ["info", "FYI", "36"],
  ];
  let any = false;
  for (const [sev, title, colorCode] of bySeverity) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    any = true;
    out.push(c(colorCode, title));
    const byCheck = new Map();
    for (const f of group) {
      if (!byCheck.has(f.check)) byCheck.set(f.check, []);
      byCheck.get(f.check).push(f);
    }
    for (const [check, list] of byCheck) {
      out.push(`  ${CHECK_TITLES[check] ?? check} (${list.length})`);
      for (const f of list.slice(0, 25)) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        out.push(`    ${loc}  ${f.message}`);
      }
      if (list.length > 25) out.push(`    … and ${list.length - 25} more`);
    }
    out.push("");
  }
  if (!any) out.push("nothing rotten found — either this workspace is fresh, or it's disciplined. Both are good.\n");

  out.push(
    `summary: ${stats.problems} broken, ${stats.warns} worth a look, ${stats.infos} FYI — across ${stats.mdCount} files`,
  );
  out.push("");
  out.push("what a generic pass like this can't see (nothing in plain markdown marks it):");
  out.push("  - which of two disagreeing facts is the current one — nothing records supersession");
  out.push('  - whether "Sam", "Sam K." and "sam-k" are one person or three — no entity records, no aliases');
  out.push("  - whether a note still matches the source it came from — no provenance links to check against");
  out.push("");
  out.push("(memrot ships with imprnt, a memory contract that turns these into checkable invariants: github.com/aleksandr-bogdanov/imprnt)");
  return out.join("\n");
}

// ---------------------------------------------------------------- cli

function main() {
  const args = process.argv.slice(2);
  let dir = null;
  let json = false;
  let staleDays = 180;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--stale-days") staleDays = Number(args[++i]) || 180;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: memrot [dir] [--json] [--stale-days N]\n\n" +
          "Read-only checkup for a folder of markdown agent memory.\n" +
          "dir defaults to ~/.openclaw/workspace when it exists, else the current directory.",
      );
      return 0;
    } else if (!a.startsWith("-") && !dir) dir = a;
    else {
      console.error(`unknown option: ${a}`);
      return 2;
    }
  }
  if (!dir) {
    const oc = path.join(homedir(), ".openclaw", "workspace");
    dir = existsSync(oc) ? oc : process.cwd();
  }
  dir = path.resolve(dir.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`);
    return 2;
  }
  const result = runChecks(dir, { staleDays });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(render(result, { color: process.stdout.isTTY }));
  return result.stats.problems > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
