// imprnt — dispatcher. Subcommands are thin; the real work is in sibling scripts.
// No shebang: the shipped bin gets `#!/usr/bin/env node` injected at build time (--banner), and
// dev runs this via `bun scripts/cli.ts`. A source shebang would survive bundling and collide.
import { cpSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { openNeedsReview } from "./lib/resolve.ts";
import { listPluginDirs, isEnabled, addPlugin, rmPlugin, specError } from "./lib/plugins.ts";
import { installPlugin, purgePlugin, coreChannel, OFFICIAL } from "./lib/install.ts";
import { projectRoot } from "./lib/roots.ts";
import { collectNotes } from "./lib/moc.ts";
import { registerVault, vaultProjectRoot, registeredRoot, configPath, isVaultProject } from "./lib/registry.ts";
import { buildLaunch, launchClaude } from "./lib/launch.ts";

// packageRoot: the install location, source for templates/ + CLAUDE.md. Computed from THIS entry
// file, which sits one level under the root in both dev (scripts/cli.ts) and the bundle (dist/cli.js).
// The user's working dir is projectRoot() instead — see lib/roots.ts for why they must differ.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const [cmd, ...rest] = process.argv.slice(2);

// Set by the imp.ts entry. The two bins share this dispatcher; only the BARE behavior differs:
// `imp` opens a Claude session where you stand, `imprnt` prints help (safe for scripts/agents).
const asImp = (globalThis as Record<string, unknown>).__IMPRNT_IMP__ === true;

// Project root for the plugin commands. projectRoot() stays cwd-only (init nest-check, check/apply
// aggregators rely on that - see lib/roots.ts). Plugin management, though, should work from anywhere
// like `imp`: a project you are standing IN wins (manage a second vault in place), otherwise fall
// back to your registered default vault. IMPRNT_ROOT still overrides via projectRoot().
function pluginRoot(): string {
  const local = projectRoot();
  if (process.env.IMPRNT_ROOT || process.env.IMPRINT_ROOT) return local; // explicit override wins
  // A real project has the markers projectRoot walks up for; if local lacks them it fell back to a
  // bare cwd, so prefer the registered vault. registeredRoot returns it only if it is a live vault.
  if (existsSync(join(local, "vault")) || existsSync(join(local, "CLAUDE.local.md"))) return local;
  return registeredRoot() ?? local;
}

function vaultArg(): string {
  const i = rest.indexOf("--vault");
  if (i >= 0) {
    const val = rest[i + 1];
    if (val === undefined) {
      console.error("usage: --vault <dir> (missing directory after --vault)");
      process.exit(1);
    }
    return val;
  }
  // || not ??: a set-but-empty IMPRNT_VAULT reads as unset, matching how roots.ts/registry.ts
  // read the same vars (truthiness) - "" must fall through to ./vault, never become the path.
  return process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT || "./vault";
}

// lair + context cannot proceed without the vault home, and they must give the SAME hint from
// the same broken state. Bare `imp` (the default case) deliberately does not use this: it warns
// and launches plain claude instead, so imp stays useful before any init.
function requireVaultHome(): string {
  const home = vaultProjectRoot();
  if (!home) {
    console.error("no vault project found — run `imprnt init` in your vault project first");
    process.exit(1);
  }
  return home;
}

// Expand a leading `~` to the home dir, then resolve against `base` (cwd by default). A bare `~`
// or `~/...` is the only tilde form handled - `~user` is left alone (it would resolve relative to
// cwd, which is the safe surprise-free default). Pure given home/base, so it is unit-testable.
function resolvePath(input: string, base: string = process.cwd(), home: string = homedir()): string {
  let p = input;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  return resolve(base, p);
}

// The first token of `rest` that is NOT a flag (does not start with `-`) is the init positional
// path. Flags like --register (any position) and future flags are skipped, so `init --register foo`
// and `init foo --register` both read `foo` as the path. Returns undefined when there is no
// positional, which routes init to the prompt (interactive) or cwd fallback (non-TTY).
function initPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

// Delegated scripts parse process.argv.slice(2) themselves. Strip the subcommand token
// so `cli.ts ingest <file>` looks like `ingest.ts <file>` to the delegate.
if (["ingest", "recall", "snapshot", "check"].includes(cmd)) process.argv.splice(2, 1);

switch (cmd) {
  case "ingest":
    await import("./ingest.ts");
    break;
  case "recall":
    await import("./recall.ts");
    break;
  case "snapshot":
    await import("./snapshot.ts");
    break;
  case "check":
    await import("./check.ts");
    break;
  case "hot": {
    const vault = vaultArg();
    const review = openNeedsReview(vault);
    if (review.length) {
      console.log(`⚠ NEEDS REVIEW (${review.length}) — clear these:`);
      for (const r of review) console.log(r);
      console.log("");
    }
    const p = join(vault, "hot.md");
    if (!existsSync(p)) { console.error(`no hot.md at ${p} — run \`imprnt init\``); process.exit(1); }
    console.log(readFileSync(p, "utf8"));
    break;
  }
  case "lair": {
    // The assistant's home: the SAME launch assembly with cwd swapped to the vault project, so the
    // lair is just imp standing at the root, never a special case. buildLaunch's inside branch does
    // the right things there: no fragment injection (CLAUDE.md + CLAUDE.local.md load natively from
    // cwd), harness plugins still ride as launch flags (claude never auto-discovers
    // plugins/<name>/, lair included), and the env gets IMPRNT_VAULT so an in-session cd keeps the
    // engine on this vault. Personal history + permission grants accumulate in one resumable place.
    const home = requireVaultHome();
    const lair = buildLaunch({ cwd: home, vaultProject: home, pkgRoot, passthrough: rest });
    process.exit(launchClaude(home, lair.args, lair.env));
  }
  case "context": {
    // The demand-paged contract: prints the vault project's CLAUDE.md. The pointer injected into
    // every imp session tells agents to run this before writing a note, so the ~9k tokens of
    // filing rules are paid only by sessions that actually write, at the moment they write.
    const home = requireVaultHome();
    const contract = join(home, "CLAUDE.md");
    if (!existsSync(contract)) {
      console.error(`no CLAUDE.md at ${home} — run \`imprnt init\` there to drop the contract`);
      process.exit(1);
    }
    process.stdout.write(readFileSync(contract, "utf8"));
    break;
  }
  case "plugin": {
    // Plugin commands operate on the user's PROJECT root (not the installed package): plugins/ and
    // CLAUDE.local.md live there. `add <name>` fetches the package imprnt-plugin-<name> and copies
    // it into plugins/<name>/ before wiring; `add <name>/<file.md>` just wires a local file (the
    // _personal cast). No per-plugin logic in core.
    const proj = pluginRoot();
    // A project you stand in wins; otherwise plugin ops target your registered vault, so they work
    // from anywhere like `imp`. Say so when it is not cwd, so the target is never a surprise.
    if (proj !== process.cwd()) console.error(`(targeting vault project: ${proj})`);
    const [sub, ...specs] = rest;
    if (sub === "list") {
      const dirs = listPluginDirs(proj);
      console.log("plugins:");
      if (!dirs.length) console.log("  (none installed under plugins/)");
      for (const name of dirs) console.log(`  ${isEnabled(proj, name) ? "[on] " : "[off]"} ${name}`);
      const available = OFFICIAL.filter((o) => !dirs.includes(o));
      if (available.length) console.log(`\navailable to add: ${available.join(", ")}`);
      console.log("\nenable: imprnt plugin add <name>   disable: imprnt plugin rm <name> [--purge]");
      break;
    }
    if (sub === "add") {
      // Pull flags out of the spec list; --from/--force apply to every fetched name in the call.
      let from: string | undefined;
      let force = false;
      const names: string[] = [];
      for (let i = 0; i < specs.length; i++) {
        if (specs[i] === "--from") {
          from = specs[++i];
          // A dangling --from must never read as "no --from": that would silently swap the
          // user's local dev tree for the published npm artifact.
          if (from === undefined) {
            console.error("usage: --from <dir> (missing directory after --from)");
            process.exit(1);
          }
        } else if (specs[i] === "--force") force = true;
        else names.push(specs[i]!);
      }
      if (!names.length) { console.error("usage: imprnt plugin add <name> [--from <dir>] [--force] | <name>/<file.md>"); process.exit(1); }
      // --from feeds ONE local dir, so it can install exactly one plugin. Applying that single dir
      // to every name would copy the wrong plugin's content into the others (reported as success),
      // and a typo'd extra token would install + wire the typo with real content (--from
      // short-circuits the registry fetch, so even a 404-worthy name "succeeds"). Reject up front,
      // before any copy or wire. The registry path (no --from) fetches each name's own package, so
      // multi-name there stays valid and is untouched by this guard.
      if (from !== undefined && names.length > 1) {
        console.error(`--from installs one local plugin - name exactly one (got: ${names.join(", ")})`);
        process.exit(1);
      }
      // An edge core pulls edge plugins (latest fallback); a stable core pulls latest. Read once.
      const channel = coreChannel(pkgRoot);
      // One report line per name, idempotent. A failed name doesn't stop the others; exit non-zero
      // if any failed. The catch keeps that contract even for an fs throw (read-only dir, etc).
      let failed = false;
      for (const name of names) {
        try {
          // `<name>/<file.md>` is a local wire-only (a hand-placed file like _personal/voice.md): no fetch.
          if (name.includes("/")) {
            const { entry, added, error } = addPlugin(proj, name);
            if (error) { console.error(`${name}: ${error}`); failed = true; continue; }
            console.log(added ? `wired @${entry}` : `already wired @${entry}`);
            continue;
          }
          // Bare name: fetch+copy the package into plugins/<name>/, then wire its agent.md.
          const r = installPlugin(proj, name, { from, force, channel });
          if (r.error) { console.error(`${name}: ${r.error}`); failed = true; continue; }
          if (r.copied) console.log(`installed ${name} → plugins/${name}/`);
          else if (r.skipped) console.log(`plugins/${name}/ already present (use --force to refresh)`);
          const { entry, added, error } = addPlugin(proj, name);
          if (error) {
            // The copy already landed, so a wire failure leaves half-state: say so explicitly.
            console.error(`${name}: ${error}${r.copied ? ` (plugins/${name}/ is installed but not wired)` : ""}`);
            failed = true;
            continue;
          }
          console.log(added ? `wired @${entry}` : `already wired @${entry}`);
        } catch (e) {
          console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
          failed = true;
        }
      }
      if (failed) process.exit(1);
      break;
    }
    if (sub === "rm") {
      let purge = false;
      const names: string[] = [];
      for (const s of specs) { if (s === "--purge") purge = true; else names.push(s); }
      if (!names.length) { console.error("usage: imprnt plugin rm <name> [--purge] [<name> ...]"); process.exit(1); }
      // Same loop contract as add: one report line per name, a failed name doesn't stop the
      // others, exit non-zero if any failed. The spec is contained BEFORE anything is touched -
      // `rm .. --purge` used to resolve to the project root and delete the whole project.
      let failed = false;
      for (const name of names) {
        try {
          const invalid = specError(proj, name);
          if (invalid) { console.error(`${name}: ${invalid}`); failed = true; continue; }
          const removed = rmPlugin(proj, name);
          let msg = removed ? `unwired ${name} (${removed} line${removed === 1 ? "" : "s"})` : `${name} was not wired`;
          if (purge) msg += purgePlugin(proj, name) ? `, purged plugins/${name}/` : `, nothing to purge`;
          console.log(msg);
        } catch (e) {
          console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
          failed = true;
        }
      }
      if (failed) process.exit(1);
      break;
    }
    console.error("usage: imprnt plugin list | add <name> [--from <dir>] [--force] | rm <name> [--purge]");
    process.exit(1);
  }
  case "init": {
    // Resolve the TARGET dir to scaffold. Three sources, in priority order:
    //   1. an explicit positional path (`imprnt init <path>`, ~ expanded, resolved against cwd),
    //   2. an interactive prompt with an editable default (only when both stdin AND stdout are a
    //      TTY, so a human is really there), Enter takes the default,
    //   3. the cwd fallback when there is no TTY - this is the path every script/CI/test hits, and
    //      it must behave exactly as init always did (scaffold ./vault here, register cwd).
    let target: string;
    const positional = initPositional(rest);
    if (positional !== undefined) {
      target = resolvePath(positional);
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      // Default: re-init cwd in place when it is already a vault project, otherwise ~/imprnt. The
      // display string is what shows in the prompt brackets; ~/imprnt shows literally as ~/imprnt
      // (resolved to <home>/imprnt only after the user accepts it).
      const inPlace = isVaultProject(process.cwd());
      const display = inPlace ? process.cwd() : "~/imprnt";
      const fallback = inPlace ? process.cwd() : join(homedir(), "imprnt");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`vault location [${display}]: `)).trim();
      rl.close();
      target = answer ? resolvePath(answer) : fallback;
    } else {
      // Non-interactive, no positional: every script/CI/test path. Use cwd exactly as before so
      // those paths never block on stdin and keep their existing "./vault" output + cwd registration.
      target = process.cwd();
    }
    // toCwd: when the target is the working dir, keep the historic relative "./vault" phrasing
    // (existing tests + the muscle-memory output assert it). A different target prints absolute.
    const toCwd = target === process.cwd();
    const rel = (sub: string) => (toCwd ? `./${sub}` : join(target, sub));

    // Refuse to nest: init INTO a subdirectory of an existing vault project would scaffold a
    // second vault INSIDE the real one and pollute its corpus with fresh control files. Walk up
    // from the TARGET (lib/roots.ts); only a genuinely initialized vault above blocks - a fresh
    // dir (walk-up falls back to target) inits as before. The target need not exist yet:
    // projectRoot walks ancestors via existsSync, which is fine for a path like ~/imprnt.
    const enclosing = projectRoot(target);
    if (enclosing !== target && isVaultProject(enclosing)) {
      console.error(`refusing to init: ${toCwd ? "this directory" : target} is inside the vault project at ${enclosing} - run \`imprnt init\` there instead`);
      process.exit(1);
    }
    // v3 layout: entity folders (cross-cutting) + domain folders (life-areas) + form folders, all flat
    // under vault/. raw/ holds immutable by-source snapshots. Topic is a tag, never a folder.
    const entities = ["people", "orgs", "holdings"];
    const domains = ["identity", "health", "finances", "work", "life", "projects"];
    const forms = ["events", "mistakes"];
    const vaultDirs = [...entities, ...domains, ...forms];
    // init is idempotent: it only ever creates what's missing and never touches a note. Track what
    // actually changed so the summary states the truth — a fresh scaffold vs. topping up an existing
    // vault — instead of unconditionally claiming to have scaffolded one.
    const vaultPath = join(target, "vault");
    const vaultExisted = existsSync(vaultPath);
    let createdDirs = 0;
    // The target dir itself goes first, so a fresh path like ~/imprnt exists before the vault/<dirs>
    // mkdir loop runs (mkdirSync recursive would make it anyway, but listing it keeps the createdDirs
    // count + the clean per-dir error honest for the new-location case).
    for (const d of ["", "vault", ...vaultDirs.map((t) => `vault/${t}`), "raw"]) {
      const abs = d ? join(target, d) : target;
      if (!existsSync(abs)) createdDirs++;
      try {
        mkdirSync(abs, { recursive: true });
      } catch (e) {
        // A plain FILE squatting on a dir name (EEXIST) or a permission problem: one clean line.
        console.error(`cannot create ${d ? rel(d) : target}: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }
    const added: string[] = [];
    for (const f of ["index.md", "hot.md", "log.md", "_tags.md"]) {
      const dst = join(vaultPath, f);
      if (!existsSync(dst)) { cpSync(join(pkgRoot, "templates", f), dst); added.push(`vault/${f}`); }
    }
    // Drop the vault contract into the project so an installed agent loads it. The dev clone
    // already has CLAUDE.md at root; this is what makes a fresh `npm i -g` install self-describing,
    // and what the @import lines in CLAUDE.local.md resolve against. Never overwrite a local copy.
    const claudeMd = join(target, "CLAUDE.md");
    if (!existsSync(claudeMd) && existsSync(join(pkgRoot, "CLAUDE.md"))) {
      cpSync(join(pkgRoot, "CLAUDE.md"), claudeMd);
      added.push("CLAUDE.md");
    }

    // Register this project so `imp` and `imprnt context` find the vault from any directory.
    // First init becomes the default; an existing different default is kept and reported, never
    // silently replaced — `imprnt init --register` here switches it on purpose.
    // A registration failure (unwritable config dir) must NOT abort the successful scaffold: the
    // vault is fully usable via ./vault or IMPRNT_VAULT even unregistered. Print one clean line on
    // stderr and fall through to the normal scaffold report (exit 0) - init's real job is done.
    const reg = registerVault(target, { force: rest.includes("--register") });
    if (reg.status === "registered") console.log(`registered as imp's default vault project (${configPath()})`);
    else if (reg.status === "kept") console.log(`kept the existing default vault project (${reg.current}) — run \`imprnt init --register\` here to switch`);
    else if (reg.status === "error") console.error(`could not register as imp's default vault project (${configPath()}): ${reg.error} — the vault still works via ./vault or IMPRNT_VAULT`);

    if (!vaultExisted) {
      // Brand-new vault: show the layout so the user learns the shape, then point at the next step.
      console.log(`initialized vault at ${rel("vault")}`);
      console.log(`  entities: ${entities.join(", ")}`);
      console.log(`  domains:  ${domains.join(", ")}`);
      console.log(`  forms:    ${forms.join(", ")}`);
      console.log(`  + ${rel("raw")} for immutable by-source snapshots`);
      console.log("next: type `imp` to talk, or ingest a source (`imprnt ingest <file>`), then `imprnt check`.");
    } else {
      // Existing vault: lead with the count so it's obvious the notes were found, not made, and
      // report only the idempotent top-up. Never imply anything was created or overwritten.
      const noteCount = collectNotes(vaultPath).length;
      console.log(`found existing vault at ${rel("vault")} — ${noteCount} note${noteCount === 1 ? "" : "s"}, left untouched`);
      if (added.length) console.log(`  added missing control file${added.length === 1 ? "" : "s"}: ${added.join(", ")}`);
      else if (createdDirs) console.log(`  added ${createdDirs} missing folder${createdDirs === 1 ? "" : "s"}`);
      else console.log("  already initialized — nothing to add");
      console.log("run `imprnt check` to validate the graph.");
    }
    break;
  }
  default: {
    // Bare `imp` (or `imp <claude flags>`) opens a Claude session where you stand. The TTY guard
    // covers ONLY the bare form: a script or agent calling it bare gets the help text below,
    // never a surprise interactive session. Explicit claude flags launch regardless — piped
    // one-shot modes (`imp -p "..." | tee`) are exactly what those flags are for. Unknown WORDS
    // still fall through to help + exit 1 under both bins, so a typo'd subcommand never turns
    // into a claude prompt.
    const isHelp = cmd === "help" || cmd === "--help" || cmd === "-h";
    const bare = cmd === undefined;

    // Generic MODULE command: `imprnt <module> <args>` runs plugins/<module>/<module>.js by
    // convention — so a module's commands are clean (`imprnt session-host login`, `imprnt
    // kleinanzeigen sync`) instead of `node plugins/.../x.js`. Zero per-module knowledge: discovered
    // by filename, the same convention `check --all` uses to glob check.js. A built-in subcommand
    // always wins (this is the default arm, reached only when cmd matched no case above).
    if (cmd && !isHelp && !bare && !cmd.startsWith("-")) {
      const modScript = join(pluginRoot(), "plugins", cmd, `${cmd}.js`);
      if (existsSync(modScript)) {
        const proc = spawnSync(process.execPath, [modScript, ...rest], { stdio: "inherit" });
        process.exit(proc.status ?? 1);
      }
    }

    const wantsLaunch = asImp && !isHelp && (bare || cmd.startsWith("-"));
    if (wantsLaunch && (!bare || (process.stdin.isTTY && process.stdout.isTTY))) {
      const home = vaultProjectRoot();
      if (!home) {
        console.error("imp: no vault registered yet — run `imprnt init` in your vault project to give your assistant a memory. Launching plain claude.");
      }
      const { args, env } = buildLaunch({ cwd: process.cwd(), vaultProject: home, pkgRoot, passthrough: bare ? [] : [cmd, ...rest] });
      process.exit(launchClaude(process.cwd(), args, env));
    }
    console.log(`imprnt — deterministic-first markdown knowledge vault

the front door (the \`imp\` bin):
  imp                                      open your assistant HERE: claude + your cast + the vault pointer
  imp lair                                 open it in your vault project — full contract, resumable history
  imp -c | --resume | <claude flags>       flags pass through to claude

engine (same subcommands under \`imp\` or \`imprnt\`):
  imprnt init [path] [--register]          scaffold vault (entities/domains/forms) + raw, register as imp's default; prompts for a location when run interactively with no path (default ~/imprnt)
  imprnt snapshot <src> --dest <relpath>   mirror a file/dir into raw/<relpath> (immutable, hashed) — the migration's deterministic half
  imprnt ingest <file|text> [--vault D]    snapshot a source -> raw/; a transcript file also gets an event skeleton (no LLM)
  imprnt recall "<query>" [--vault D]      synonym-aware BM25 ranking over the vault
  imprnt context                           print the vault contract — agents run this before writing any note
  imprnt check [--all] [--vault D]         integrity (orphan links, disconnected notes, uncovered snapshots) + regenerate index.md; --all also runs each plugins/*/check.js
  imprnt ingest --apply <file> [--vault D] file a pre-enriched staged note from a plugin into the vault (snapshot + resolve); --apply-all globs plugins/*/proposed/
  imprnt hot [--vault D]                   needs-review + the session primer
  imprnt plugin list                       show installed plugins (on/off) + official ones available to add
  imprnt plugin add <name> [--from D]      fetch imprnt-plugin-<name>, copy into plugins/, wire it (idempotent; --force refreshes)
  imprnt plugin rm <name> [--purge]        unwire a plugin; --purge also deletes plugins/<name>/
  imprnt <module> <command> [...]          run an installed module's command (e.g. \`imprnt session-host login\`, \`imprnt kleinanzeigen sync\`) — no \`node\` paths

layout: entities (people · orgs · holdings) · domains (identity · health · finances · work · life · projects) · forms (events · mistakes)
the vault is plain markdown. an agent greps it directly — no MCP, no DB.`);
    if (cmd && !isHelp) process.exit(1);
  }
}
