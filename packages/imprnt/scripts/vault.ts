// `imprnt vault` — the vault as a first-class object, independent of anything that reads it.
//
// WHY THIS EXISTS AS ITS OWN COMMAND. The dependency between a vault and an agent runs one way: a
// vault means something with no agent attached (plain markdown you can read, grep and open in any
// editor for the rest of your life), while an agent with no vault is a process pointed at nothing.
// So an agent is disposable and a vault is not, and the lifecycle of the durable object must not
// live inside a command that manages the disposable one. Before this, deleting an assistant was
// the same act as deleting the knowledge it read — one flag away from a mistake nothing recovers.
//
//   imprnt vault list                      what is registered on this machine
//   imprnt vault archive [name|path]       one verified tarball, never a delete
//   imprnt vault restore <archive> <dir>   put one back
//   imprnt vault move <note> <mount>/<f>   share one note into a mount — the seam crossing
//
// There is deliberately no `vault delete`. Removing knowledge is a human act with `rm` and a path,
// not a subcommand that can be reached by a script, a typo, or an agent being helpful.
// Creating one is still `imprnt init` — it already prompts, refuses to nest, and registers.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isVaultProject, readRegistry } from "./lib/registry.ts";
import { loadFolders } from "./lib/folders.ts";
import { collectNotes, frontmatter } from "./lib/moc.ts";
import { corpusOf, deadSourceTargets, graphLinks, hasMountTwin, isSeamLeak, mountAcceptsFolder, mountFolderRoster, mountOf, mountPresent, moveDoneLine, moveInProgressLine, replaceOutsideCode, resolveSlugs, setFrontmatterKey, sourceTargets } from "./lib/seam.ts";

const args = process.argv.slice(2);
const sub = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positionals = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]?.startsWith("--")));

const expand = (p: string): string => resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// Notes are what a vault IS, so every line that names one says how many it holds. The corpus is
// defined exactly as check/moc define it - dot and underscore names skipped, symlinks skipped, and
// the generated control files excluded AT THE ROOT ONLY. Counting index.md as a note would make
// this command disagree with `imprnt check` about the size of the same vault, which is the kind of
// small inconsistency that makes a person stop trusting both numbers.
const CONTROL = new Set(["index.md", "hot.md", "log.md", "_tags.md"]);
function noteCount(project: string): number {
  const root = join(project, "vault");
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string, atRoot: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      if (e.isSymbolicLink()) continue;
      if (atRoot && CONTROL.has(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), false);
      else if (e.name.endsWith(".md")) n++;
    }
  };
  try { walk(root, true); } catch { /* unreadable subtree: report what we could count */ }
  return n;
}

// A vault named on the command line, by registry name or by path. Falls back to the default.
function resolveTarget(token?: string): { name: string; path: string } {
  const reg = readRegistry();
  if (token) {
    if (reg.vaults[token]) return { name: token, path: reg.vaults[token]! };
    const p = expand(token);
    if (isVaultProject(p)) {
      const named = Object.entries(reg.vaults).find(([, v]) => v === p)?.[0];
      return { name: named ?? basename(p), path: p };
    }
    console.error(`no vault called "${token}", and ${p} is not a vault project`);
    console.error(`known: ${Object.keys(reg.vaults).join(", ") || "(none registered — run \`imprnt init\`)"}`);
    process.exit(1);
  }
  const name = reg.default ?? Object.keys(reg.vaults)[0];
  const path = name ? reg.vaults[name] : undefined;
  if (!name || !path) { console.error("no vault registered — run `imprnt init`"); process.exit(1); }
  return { name, path };
}

// --- imprnt vault move: the seam crossing ---------------------------------------------------
// Sharing a note is MOVING it, the way 1Password shares an item: copy into the shared vault, delete
// from the private one, new ID, one screen naming who will now see it. The alternative - a copy, or a
// stub left behind - creates two versions of one fact that drift, and the one in the shared tree is
// the one the other person reads. So there is no `copy` verb and no stub, deliberately.
//
// What the code does here is the mechanical half: the file move, the link rewrite, the domain: field,
// the log line, and the two refusals a machine can decide. What it prints is the other half: the
// things only the person moving the note can decide, because they turn on meaning.

// The vault DIRECTORY this command works on. --vault wins (same meaning as everywhere else in the
// CLI: the dir holding the notes), then the env override, then the registered default project's
// vault/, then ./vault. A move needs the vault, not the project, because every path it touches is a
// note path.
function resolveVaultDir(explicit?: string): string {
  if (explicit) return expand(explicit);
  const env = process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT;
  if (env) return env;
  const reg = readRegistry();
  const name = reg.default ?? Object.keys(reg.vaults)[0];
  const p = name ? reg.vaults[name] : undefined;
  if (p && isVaultProject(p)) return join(p, "vault");
  return "./vault";
}

// Rewrite every wikilink pointing at `from` so it points at `to`, in one note's text. Path-form links
// only: a BARE `[[rent]]` link resolves by basename and keeps resolving after the move, so rewriting
// it would churn notes for nothing. The alias and heading tails (`|`, `#`) are preserved verbatim, and
// a `.md` suffix is accepted the same way the resolver accepts it.
//
// The rewrite runs through seam.ts's replaceOutsideCode, the same fence rule `check` reads links by.
// A raw text replace edited a literal `[[old/path]]` inside a fenced example - a documented snippet
// rewritten by a command nobody pointed at it, and one the checker had already ruled out as an edge.
function linkRe(from: string): RegExp {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\[${esc}(?:\\.md)?((?:#|\\|)[^\\]]*)?\\]\\]`, "g");
}
function rewriteLinks(text: string, from: string, to: string): { text: string; count: number } {
  return replaceOutsideCode(text, linkRe(from), (m) => `[[${to}${m[1] ?? ""}]]`);
}

// The mover's own log.md, written in TWO steps around the delete. The move happened on THIS side, so
// it is this vault's history: the shared tree gets the note, the private vault keeps the record of
// having sent it. `openMove` appends the in-progress line BEFORE the source is deleted, `closeMove`
// rewrites that line to the finished one after. A crash in between therefore leaves a trace of a note
// that exists twice, which `imprnt check` reports as `move-fork` - the alternative was two silent
// copies of one fact and nothing anywhere saying so.
function openMove(vault: string, from: string, to: string, mount: string, day: string): void {
  const p = join(vault, "log.md");
  if (!existsSync(p)) writeFileSync(p, "---\ntype: log\ntags: [\"log\"]\n---\n\n# Log\n\n");
  const prev = readFileSync(p, "utf8");
  appendFileSync(p, `${prev.endsWith("\n") ? "" : "\n"}${moveInProgressLine(day, from, to, mount)}\n`);
}
function closeMove(vault: string, from: string, to: string, mount: string, day: string): void {
  const p = join(vault, "log.md");
  const open = moveInProgressLine(day, from, to, mount);
  const text = readFileSync(p, "utf8");
  // A function replacer, so a `$` anywhere in a slug is never read as a substitution pattern.
  writeFileSync(p, text.replace(open, () => moveDoneLine(day, from, to, mount)));
}

// tar is not in node, and shelling out is the honest option: it is on macOS, every Linux, and
// Windows 10+. When it is absent, say so instead of half-writing something.
function tar(...a: string[]): number {
  const r = spawnSync("tar", a, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) { console.error(`tar is not available: ${r.error.message}`); process.exit(1); }
  return r.status ?? 1;
}

switch (sub) {
  case "list": {
    const reg = readRegistry();
    const names = Object.keys(reg.vaults);
    if (!names.length) { console.log("no vaults registered — run `imprnt init`"); break; }
    const def = reg.default ?? names[0];
    for (const n of names) {
      const p = reg.vaults[n]!;
      // A registered path whose vault/ is gone is the case worth naming loudly: the pointer
      // outlives the thing, and every read through it silently answers from nowhere.
      const live = isVaultProject(p);
      const mark = n === def ? "*" : " ";
      const detail = live ? `${noteCount(p)} notes` : "MISSING — the path is registered but holds no vault";
      console.log(`${mark} ${n.padEnd(12)} ${p}  (${detail})`);
    }
    console.log("\n* = default (what `imp` and `imprnt context` resolve to)");
    break;
  }

  case "archive": {
    const { name, path } = resolveTarget(positionals[0]);
    if (!isVaultProject(path)) { console.error(`${path} is not a vault project`); process.exit(1); }
    const outDir = expand(flag("--out") ?? ".");
    mkdirSync(outDir, { recursive: true });
    // Date only: an archive is a thing you take before doing something, and a second one the same
    // day overwriting the first is the correct behaviour, not a surprise.
    const stamp = new Date().toISOString().slice(0, 10);
    const out = join(outDir, `${name}-${stamp}.tar.gz`);
    // The WHOLE project dir, not a git bundle: a bundle holds only what was committed, and the
    // notes somebody wrote this afternoon are exactly the ones nobody has committed yet.
    if (tar("czf", out, "-C", dirname(path), basename(path)) !== 0) { console.error("archive failed"); process.exit(1); }
    // Verify by reading it back. An archive nobody has opened is a promise, not a backup.
    if (tar("tzf", out) !== 0) { console.error(`${out} does not read back — treat it as no archive at all`); process.exit(1); }
    const size = (statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`archived ${name} (${noteCount(path)} notes) → ${out}  ${size} MB, verified`);
    console.log(`restore with: imprnt vault restore ${out} <dir>`);
    break;
  }

  case "restore": {
    const src = expand(positionals[0] ?? "");
    const dest = expand(positionals[1] ?? "");
    if (!positionals[0] || !positionals[1]) { console.error("usage: imprnt vault restore <archive.tar.gz> <dir>"); process.exit(1); }
    if (!existsSync(src)) { console.error(`no archive at ${src}`); process.exit(1); }
    // Never restore ONTO an existing vault. The one moment somebody reaches for restore is the
    // moment they are least able to afford overwriting the copy they still have.
    if (existsSync(dest) && readdirSync(dest).length) { console.error(`${dest} is not empty — restore into a new directory, then move it`); process.exit(1); }
    mkdirSync(dest, { recursive: true });
    if (tar("xzf", src, "-C", dest) !== 0) { console.error("restore failed"); process.exit(1); }
    // The archive holds the project dir itself, so the vault is one level down.
    const inner = readdirSync(dest).map((e) => join(dest, e)).filter((p) => statSync(p).isDirectory());
    const project = inner.find((p) => isVaultProject(p)) ?? (isVaultProject(dest) ? dest : undefined);
    if (!project) { console.error(`extracted, but ${dest} holds no vault project — check the archive`); process.exit(1); }
    console.log(`restored ${noteCount(project)} notes → ${project}`);
    console.log(`register it with: cd ${project} && imprnt init`);
    break;
  }

  case "move": {
    // Own arg parse: the shared positional filter above cannot see a boolean flag, so `move --force a b`
    // would silently eat `a`. A command that DELETES the source file gets its own parse.
    let force = false;
    let vaultFlag: string | undefined;
    const pos: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--force") force = true;
      else if (a === "--vault") {
        vaultFlag = args[++i];
        if (vaultFlag === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
      } else if (a.startsWith("--")) { console.error(`unknown flag ${a} — usage: imprnt vault move <note> <mount>/<folder> [--force] [--vault DIR]`); process.exit(1); }
      else pos.push(a);
    }
    if (pos.length !== 2) {
      console.error("usage: imprnt vault move <note> <mount>/<folder> [--force] [--vault DIR]");
      console.error("  e.g. imprnt vault move finances/rent household/finances");
      process.exit(1);
    }
    const vault = resolveVaultDir(vaultFlag);
    if (!existsSync(vault)) { console.error(`no vault at ${vault} — run \`imprnt init\` first`); process.exit(1); }
    const roles = loadFolders(vault);

    // --- the destination ---------------------------------------------------------------------
    const destParts = pos[1]!.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean);
    if (destParts.length !== 2) {
      console.error(`destination must be <mount>/<folder>, got "${pos[1]}"`);
      process.exit(1);
    }
    const mount = destParts[0]!.normalize("NFC").toLowerCase();
    const folder = destParts[1]!.normalize("NFC").toLowerCase();
    if (!roles.mounts.has(mount)) {
      console.error(`"${mount}" is not a mount of this vault — a note only crosses into a shared tree`);
      console.error(`  declared mounts: ${[...roles.mounts].join(", ") || "(none — declare one under \`## Mounts\` in vault/_folders.md)"}`);
      process.exit(1);
    }
    if (!mountPresent(vault, mount)) {
      console.error(`the "${mount}" mount is declared but not checked out at ${join(vault, mount)} — nothing to move into`);
      process.exit(1);
    }
    // The mount's OWN roles decide which folders exist inside it. The predicate lives in seam.ts and
    // `ingest --apply` asks it too, so the two writers can never disagree about where a note may land.
    const mr = loadFolders(join(vault, mount));
    if (!mountAcceptsFolder(folder, mr)) {
      console.error(`"${folder}" is not a folder ${mount}/ declares in its own _folders.md`);
      console.error(`  ${mountFolderRoster(mount, mr)}`);
      process.exit(1);
    }

    // --- the note ----------------------------------------------------------------------------
    const token = pos[0]!;
    const bySlug = join(vault, `${token.replace(/^\.\//, "").replace(/\.md$/, "")}.md`);
    let src = "";
    if (existsSync(bySlug) && statSync(bySlug).isFile()) src = bySlug;
    else {
      const p = expand(token);
      if (existsSync(p) && statSync(p).isFile()) src = p;
    }
    if (!src) { console.error(`no note at ${token} (looked for ${bySlug})`); process.exit(1); }
    const rel = relative(vault, src).split("\\").join("/");
    if (rel.startsWith("..") || isAbsolute(rel)) { console.error(`${src} is outside the vault at ${vault}`); process.exit(1); }
    if (!rel.endsWith(".md")) { console.error(`${rel} is not a note (.md)`); process.exit(1); }
    const srcSlug = rel.replace(/\.md$/, "");
    const already = mountOf(srcSlug, roles.mounts);
    if (already) { console.error(`${srcSlug} already lives in the ${already}/ mount — it is shared already`); process.exit(1); }
    const destSlug = `${mount}/${folder}/${basename(src, ".md")}`;
    const destPath = join(vault, `${destSlug}.md`);
    if (existsSync(destPath)) {
      console.error(`${destSlug} already exists — moving onto it would overwrite the shared copy; rename one of them first`);
      process.exit(1);
    }

    // --- the two refusals a machine can decide -------------------------------------------------
    const text = readFileSync(src, "utf8");
    const fm = frontmatter(text);
    // A source: into raw/ is dead the moment anyone else opens the note: the snapshot sits in this
    // vault's private tree and nothing over there can resolve it. --force does NOT override this one,
    // because there is no version of "leave it" that is not a broken link in a shared file.
    const dead = deadSourceTargets(fm);
    if (dead.length) {
      console.error(`refusing to move ${srcSlug}: its source: points into this vault's private raw/`);
      for (const d of dead) console.error(`  source: "[[${d}]]"  — dead across the seam`);
      console.error(`  put the evidence in ${mount}/_raw/ and point at it, or record the provenance in the body as prose, then move it.`);
      console.error(`  (--force does not override this: a snapshot link nobody else can resolve is broken by construction.)`);
      process.exit(1);
    }
    const notes = collectNotes(vault);
    const corpus = corpusOf(notes);
    const folderOf = new Map<string, string>(notes.map((n) => [n.slug, n.folder]));
    const blockers: string[] = [];   // entity links with no answer inside the mount
    const repoint: string[] = [];    // links that will still point out of the mount after the move
    for (const l of new Set(graphLinks(text, roles.mounts))) {
      // The SAME predicate `check` uses for seam-leak, so the list printed here and the findings
      // reported there are one list, never two views that disagree.
      if (!isSeamLeak(l, mount, corpus)) continue;
      const twin = hasMountTwin(l, mount, corpus);
      const entity = resolveSlugs(l, corpus).some((s) => roles.entities.has(folderOf.get(s) ?? ""));
      if (entity && !twin) blockers.push(l);
      else repoint.push(twin ? `[[${l}]] — a ${mount}/ note of the same name exists; re-point it at [[${mount}/${l}]]` : `[[${l}]] — resolves only in this vault`);
    }
    if (blockers.length && !force) {
      console.error(`refusing to move ${srcSlug}: ${blockers.length} entity link(s) resolve only in this vault`);
      for (const b of blockers) console.error(`  [[${b}]] — no ${mount}/${b} on the other side`);
      console.error(`  file the entity inside ${mount}/ first (a stub is enough), or drop the link. \`--force\` moves anyway and leaves them,`);
      console.error(`  in which case \`imprnt check\` reports each one as seam-leak until it is fixed.`);
      process.exit(1);
    }

    // --- the move ------------------------------------------------------------------------------
    // domain: names the SOURCE vault's life-area, which means nothing across the seam. Drop it, then
    // set the destination's own when the mount declares that folder a domain — the value is decided
    // by where the note lands, so it is filing, not judgment.
    const wantsDomain = mr.declared && mr.domains.has(folder);
    const self = rewriteLinks(setFrontmatterKey(text, "domain", wantsDomain ? folder : null), srcSlug, destSlug); // a self-link travels with the note
    mkdirSync(dirname(destPath), { recursive: true });
    // The order is the recovery story. Write the destination, RECORD the move as in progress, delete
    // the source, then rewrite the links, then finalise the record. The one window where the note
    // exists twice is the window the log line covers, so a crash there leaves `imprnt check` a
    // `move-fork` to report instead of two silent copies of one fact.
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(destPath, self.text);
    openMove(vault, srcSlug, destSlug, mount, day);
    rmSync(src); // no stub: a stub is the second copy the seam exists to prevent

    let rewritten = self.count;
    let touched = 0;
    for (const n of notes) {
      if (n.path === src) continue;
      const before = readFileSync(n.path, "utf8");
      const { text: after, count } = rewriteLinks(before, srcSlug, destSlug);
      if (!count) continue;
      writeFileSync(n.path, after);
      touched++;
      rewritten += count;
    }
    closeMove(vault, srcSlug, destSlug, mount, day);

    console.log(`moved ${srcSlug} → ${destSlug}`);
    console.log(`  who sees it now: everyone who has the ${mount}/ mount — it is a shared tree, not your vault`);
    console.log(`  ${rewritten} link(s) rewritten across ${touched} note(s); no stub left behind`);
    console.log(`  ${wantsDomain ? `domain: ${folder}  (${mount}/_folders.md declares ${folder} a domain)` : "domain: dropped (a mount note carries none)"}`);
    console.log(`  one line appended to log.md`);
    console.log("");
    console.log("only a human can decide:");
    const src0 = sourceTargets(fm).filter((t) => !t.startsWith(`${mount}/_raw/`));
    if (src0.length) for (const s of src0) console.log(`  - source: "[[${s}]]" — make it a ${mount}/_raw/ link or prose, so it reads on the other side`);
    for (const r of repoint) console.log(`  - ${r}`);
    if (blockers.length) for (const b of blockers) console.log(`  - [[${b}]] — LEFT by --force; \`imprnt check\` will report it as seam-leak until it is fixed`);
    console.log(`  - the language: ${mount}/ is read by everyone who has it, and it may be kept in a different language than your vault`);
    break;
  }

  default:
    console.log(`imprnt vault — the vault as its own object

  imprnt vault list                        vaults registered on this machine
  imprnt vault archive [name|path]         one verified tarball  (--out <dir>)
  imprnt vault restore <archive> <dir>     put one back
  imprnt vault move <note> <mount>/<dir>   share a note into a mount  (--force, --vault <dir>)

Sharing is MOVING: the note goes into the mount, the private copy is deleted, its path
becomes its new ID and every link to it is rewritten. There is no \`copy\` — a copy is a
fork, and the two halves drift. The move refuses a note whose source: points into this
vault's private raw/, or whose entity links have no answer inside the mount.

Create one with \`imprnt init\`. There is no \`vault delete\`: removing knowledge is a
human act with rm and a path, not a subcommand a script or an agent can reach.

A vault means something with no agent attached. An agent with no vault is a process
pointed at nothing — so the vault outlives whatever reads it.`);
    process.exit(sub && sub !== "help" && sub !== "--help" ? 1 : 0);
}
