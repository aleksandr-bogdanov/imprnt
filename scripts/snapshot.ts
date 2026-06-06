#!/usr/bin/env bun
// imprint snapshot <src> --dest <relpath> [--vault DIR]
//
// Mirror a source file or directory tree into raw/<relpath>, immutable + hashed + manifested. This is
// the deterministic, dumb half of a migration: PROVENANCE ONLY — copy the bytes, record the hash, no
// classification and no notes. Copies ALL kinds, including binaries (CSVs, PDFs, images). The LLM reads
// raw/ afterward and fans each source out into vault notes; `imprint check` then reconciles coverage.
//
// raw/ is keyed by SOURCE (one folder per source): the CALLER picks the dest mirror, so the judgment of
// WHAT to include stays explicit at the call site and this tool stays a pure copy:
//   imprint snapshot ~/.claude/PAI/USER/TELOS --dest pai/USER/TELOS
//   imprint snapshot ./tax2025.csv          --dest tax-2025
import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename } from "node:path";
import { loadManifest, saveManifest } from "./lib/manifest.ts";

const args = process.argv.slice(2);
let vault = "./vault";
let dest = "";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") vault = args[++i];
  else if (args[i] === "--dest") dest = args[++i];
  else positional.push(args[i]);
}
const src = positional[0];
if (!src || !dest) {
  console.error("usage: imprint snapshot <src> --dest <relpath> [--vault DIR]");
  process.exit(1);
}
if (!existsSync(src)) { console.error(`no such source: ${src}`); process.exit(1); }

const rawRoot = join(vault, "..", "raw");
const destRoot = join(rawRoot, dest);
const manifest = loadManifest(vault);

const SKIP = new Set([".git", ".DS_Store", "node_modules", ".manifest.json"]);

// Collect (absoluteSrc, relativeUnderSrc) pairs. A file maps to its basename under dest.
function collect(p: string, base: string): { abs: string; rel: string }[] {
  const st = statSync(p);
  if (st.isFile()) return [{ abs: p, rel: basename(p) }];
  const out: { abs: string; rel: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const f = join(dir, entry);
      if (statSync(f).isDirectory()) walk(f);
      else out.push({ abs: f, rel: relative(base, f) });
    }
  };
  walk(p);
  return out;
}

const files = collect(src, src);
let copied = 0, unchanged = 0;

for (const { abs, rel } of files) {
  const rawPath = join(destRoot, rel);
  const hash = createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  const key = join("raw", dest, rel); // stable manifest key, vault-relative

  if (manifest[key]?.hash === hash && existsSync(rawPath)) { unchanged++; continue; }

  mkdirSync(join(rawPath, ".."), { recursive: true });
  copyFileSync(abs, rawPath);
  manifest[key] = { hash, note: "", ingested: new Date().toISOString(), raw: key, src: abs };
  copied++;
}

saveManifest(vault, manifest);
console.log(`snapshot ${src} → raw/${dest}/`);
console.log(`  ${copied} copied, ${unchanged} unchanged (immutable). ${files.length} file(s) total.`);
if (copied) console.log(`  next: the LLM reads raw/${dest}/ and fans sources out into vault notes (source: raw/${dest}/...).`);
