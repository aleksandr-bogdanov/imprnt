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
//
// There is deliberately no `vault delete`. Removing knowledge is a human act with `rm` and a path,
// not a subcommand that can be reached by a script, a typo, or an agent being helpful.
// Creating one is still `imprnt init` — it already prompts, refuses to nest, and registers.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isVaultProject, readRegistry } from "./lib/registry.ts";

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

  default:
    console.log(`imprnt vault — the vault as its own object

  imprnt vault list                        vaults registered on this machine
  imprnt vault archive [name|path]         one verified tarball  (--out <dir>)
  imprnt vault restore <archive> <dir>     put one back

Create one with \`imprnt init\`. There is no \`vault delete\`: removing knowledge is a
human act with rm and a path, not a subcommand a script or an agent can reach.

A vault means something with no agent attached. An agent with no vault is a process
pointed at nothing — so the vault outlives whatever reads it.`);
    process.exit(sub && sub !== "help" && sub !== "--help" ? 1 : 0);
}
