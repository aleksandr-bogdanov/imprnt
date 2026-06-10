#!/usr/bin/env bun
// imprnt snapshot <src> --dest <relpath> [--vault DIR]
//
// Mirror a source file or directory tree into raw/<relpath>, immutable + hashed + manifested. This is
// the deterministic, dumb half of a migration: PROVENANCE ONLY — copy the bytes, record the hash, no
// classification and no notes. Copies ALL kinds, including binaries (CSVs, PDFs, images). The LLM reads
// raw/ afterward and fans each source out into vault notes; `imprnt check` then reconciles coverage.
//
// raw/ is keyed by SOURCE (one folder per source): the CALLER picks the dest mirror, so the judgment of
// WHAT to include stays explicit at the call site and this tool stays a pure copy:
//   imprnt snapshot ~/.claude/PAI/USER/TELOS --dest pai/USER/TELOS
//   imprnt snapshot ./tax2025.csv          --dest tax-2025
import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync, statSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename, extname, resolve, sep } from "node:path";
import { loadManifest, saveManifest } from "./lib/manifest.ts";

// Guard a user-supplied dest relpath so it can never escape raw/. A `../`-laden dest would otherwise
// resolve outside rawRoot and let snapshot write into vault/ or anywhere writable, breaking the
// "raw/ immutable" contract. Resolve both paths and require the dest to stay strictly inside rawRoot.
function destWithinRaw(rawRoot: string, dest: string): string | null {
  const rootResolved = resolve(rawRoot);
  const destResolved = resolve(rootResolved, dest);
  if (destResolved !== rootResolved && !destResolved.startsWith(rootResolved + sep)) return null;
  return destResolved;
}

const args = process.argv.slice(2);
let vault = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
let dest = "";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") {
    const v = args[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    vault = v;
  }
  else if (args[i] === "--dest") {
    const d = args[++i];
    if (d === undefined) { console.error("--dest requires a path argument"); process.exit(1); }
    dest = d;
  }
  else positional.push(args[i]);
}
const src = positional[0];
if (!src || !dest) {
  console.error("usage: imprnt snapshot <src> --dest <relpath> [--vault DIR]");
  process.exit(1);
}
if (!existsSync(src)) { console.error(`no such source: ${src}`); process.exit(1); }

const rawRoot = join(vault, "..", "raw");
const destRoot = destWithinRaw(rawRoot, dest);
if (!destRoot) {
  console.error(`refusing --dest '${dest}': it escapes raw/ (resolves outside ${resolve(rawRoot)}). raw/ is immutable — pick a dest inside it.`);
  process.exit(1);
}
const manifest = loadManifest(vault);

const SKIP = new Set([".git", ".DS_Store", "node_modules", ".manifest.json"]);

// Collect (absoluteSrc, relativeUnderSrc) pairs. A file maps to its basename under dest.
// Symlink discipline (lstat first, never blind-stat): a healthy FILE symlink is followed and copied
// as the bytes it points at (a dotfiles mirror wants the content). A DANGLING link is skipped and
// counted - statSync on it would abort the whole bulk snapshot with ENOENT before anything copies.
// A DIRECTORY symlink is skipped and counted: following one can recurse forever on a cycle, and
// skipping is the simple safe choice over tracking visited real paths.
function collect(p: string, base: string): { files: { abs: string; rel: string }[]; skippedLinks: number } {
  let skippedLinks = 0;
  const st = statSync(p); // the top-level src: following a user-passed symlink is intentional
  if (st.isFile()) return { files: [{ abs: p, rel: basename(p) }], skippedLinks };
  const out: { abs: string; rel: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const f = join(dir, entry);
      const ls = lstatSync(f);
      if (ls.isSymbolicLink()) {
        let target;
        try { target = statSync(f); } catch { skippedLinks++; continue; } // dangling
        if (target.isFile()) out.push({ abs: f, rel: relative(base, f) });
        else skippedLinks++; // a directory (or other) symlink - never followed
        continue;
      }
      if (ls.isDirectory()) walk(f);
      else if (ls.isFile()) out.push({ abs: f, rel: relative(base, f) });
      // anything else (fifo/socket/device) is not snapshot material
    }
  };
  walk(p);
  return { files: out, skippedLinks };
}

const { files, skippedLinks } = collect(src, src);
let copied = 0, unchanged = 0, disambiguated = 0;

for (const { abs, rel } of files) {
  const srcBytes = readFileSync(abs);
  const hash = createHash("sha256").update(srcBytes).digest("hex").slice(0, 16);
  let rawPath = join(destRoot, rel);
  let key = join("raw", dest, rel); // stable manifest key, vault-relative

  if (manifest[key]?.hash === hash && existsSync(rawPath)) { unchanged++; continue; }

  // raw/ is immutable: NEVER overwrite an existing snapshot. Compare the actual disk bytes:
  //   - identical -> a skip, and the manifest row is refreshed in place. This also absorbs legacy
  //     rows whose hash was computed wrong - the disk bytes, not the stale row, are the truth.
  //   - different (a changed source re-snapshot, a basename collision from another source, or two
  //     files mapping to the same rel WITHIN this run - the first was just copied, the second lands
  //     here) -> file the new bytes under a content-address-disambiguated name (<stem>-<hash8><ext>,
  //     ingest's scheme) under its OWN manifest key. The existing file and its row stay untouched.
  if (existsSync(rawPath)) {
    if (Buffer.compare(readFileSync(rawPath), srcBytes) === 0) {
      manifest[key] = { hash, note: manifest[key]?.note ?? "", ingested: new Date().toISOString(), raw: key, src: abs };
      unchanged++;
      continue;
    }
    const ext = extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    // hash8 is content-addressed, so a re-run of the same changed bytes lands on the same name. If
    // that name is also taken by DIFFERENT bytes (a hash8 collision), step a numeric suffix.
    let relD = `${stem}-${hash.slice(0, 8)}${ext}`;
    let n = 2;
    while (existsSync(join(destRoot, relD)) && Buffer.compare(readFileSync(join(destRoot, relD)), srcBytes) !== 0) {
      relD = `${stem}-${hash.slice(0, 8)}-${n}${ext}`;
      n++;
    }
    rawPath = join(destRoot, relD);
    key = join("raw", dest, relD);
    if (existsSync(rawPath)) {
      // identical bytes already snapshotted under the disambiguated name on an earlier run - a skip
      manifest[key] = { hash, note: manifest[key]?.note ?? "", ingested: new Date().toISOString(), raw: key, src: abs };
      unchanged++;
      continue;
    }
    console.log(`  ! raw/${join(dest, rel)} already holds different bytes - immutable, writing raw/${join(dest, relD)} instead`);
    disambiguated++;
  }

  mkdirSync(join(rawPath, ".."), { recursive: true });
  copyFileSync(abs, rawPath);
  manifest[key] = { hash, note: "", ingested: new Date().toISOString(), raw: key, src: abs };
  copied++;
}

saveManifest(vault, manifest);
console.log(`snapshot ${src} → raw/${dest}/`);
console.log(`  ${copied} copied, ${unchanged} unchanged (immutable). ${files.length} file(s) total.`);
if (disambiguated) console.log(`  ${disambiguated} filed under a disambiguated name - an existing raw/ snapshot is never overwritten.`);
if (skippedLinks) console.log(`  ${skippedLinks} symlink(s) skipped (dangling or directory links).`);
if (copied) console.log(`  next: the LLM reads raw/${dest}/ and fans sources out into vault notes (source: raw/${dest}/...).`);
