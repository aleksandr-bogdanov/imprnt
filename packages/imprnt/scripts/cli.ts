// imprnt — dispatcher. Subcommands are thin; the real work is in sibling scripts.
// No shebang: the shipped bin gets `#!/usr/bin/env node` injected at build time (--banner), and
// dev runs this via `bun scripts/cli.ts`. A source shebang would survive bundling and collide.
import { cpSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openNeedsReview } from "./lib/resolve.ts";
import { listPluginDirs, isEnabled, addPlugin, rmPlugin } from "./lib/plugins.ts";
import { installPlugin, purgePlugin, OFFICIAL } from "./lib/install.ts";
import { projectRoot } from "./lib/roots.ts";
import { collectNotes } from "./lib/moc.ts";

// packageRoot: the install location, source for templates/ + CLAUDE.md. Computed from THIS entry
// file, which sits one level under the root in both dev (scripts/cli.ts) and the bundle (dist/cli.js).
// The user's working dir is projectRoot() instead — see lib/roots.ts for why they must differ.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const [cmd, ...rest] = process.argv.slice(2);

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
  return process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
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
  case "plugin": {
    // Plugin commands operate on the user's PROJECT root (not the installed package): plugins/ and
    // CLAUDE.local.md live there. `add <name>` fetches the package imprnt-plugin-<name> and copies
    // it into plugins/<name>/ before wiring; `add <name>/<file.md>` just wires a local file (the
    // _personal cast). No per-plugin logic in core.
    const proj = projectRoot();
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
        if (specs[i] === "--from") from = specs[++i];
        else if (specs[i] === "--force") force = true;
        else names.push(specs[i]!);
      }
      if (!names.length) { console.error("usage: imprnt plugin add <name> [--from <dir>] [--force] | <name>/<file.md>"); process.exit(1); }
      // One report line per name, idempotent. A failed name doesn't stop the others; exit non-zero if any failed.
      let failed = false;
      for (const name of names) {
        // `<name>/<file.md>` is a local wire-only (a hand-placed file like _personal/voice.md): no fetch.
        if (name.includes("/")) {
          const { entry, added, error } = addPlugin(proj, name);
          if (error) { console.error(`${name}: ${error}`); failed = true; continue; }
          console.log(added ? `wired @${entry}` : `already wired @${entry}`);
          continue;
        }
        // Bare name: fetch+copy the package into plugins/<name>/, then wire its agent.md.
        const r = installPlugin(proj, name, { from, force });
        if (r.error) { console.error(`${name}: ${r.error}`); failed = true; continue; }
        if (r.copied) console.log(`installed ${name} → plugins/${name}/`);
        else if (r.skipped) console.log(`plugins/${name}/ already present (use --force to refresh)`);
        const { entry, added, error } = addPlugin(proj, name);
        if (error) { console.error(`${name}: ${error}`); failed = true; continue; }
        console.log(added ? `wired @${entry}` : `already wired @${entry}`);
      }
      if (failed) process.exit(1);
      break;
    }
    if (sub === "rm") {
      let purge = false;
      const names: string[] = [];
      for (const s of specs) { if (s === "--purge") purge = true; else names.push(s); }
      if (!names.length) { console.error("usage: imprnt plugin rm <name> [--purge] [<name> ...]"); process.exit(1); }
      for (const name of names) {
        const removed = rmPlugin(proj, name);
        let msg = removed ? `unwired ${name} (${removed} line${removed === 1 ? "" : "s"})` : `${name} was not wired`;
        if (purge) msg += purgePlugin(proj, name) ? `, purged plugins/${name}/` : `, nothing to purge`;
        console.log(msg);
      }
      break;
    }
    console.error("usage: imprnt plugin list | add <name> [--from <dir>] [--force] | rm <name> [--purge]");
    process.exit(1);
  }
  case "init": {
    // v3 layout: entity folders (cross-cutting) + domain folders (life-areas) + form folders, all flat
    // under vault/. raw/ holds immutable by-source snapshots. Topic is a tag, never a folder.
    const entities = ["people", "orgs", "holdings"];
    const domains = ["identity", "health", "finances", "work", "life", "projects"];
    const forms = ["events", "mistakes"];
    const vaultDirs = [...entities, ...domains, ...forms];
    // init is idempotent: it only ever creates what's missing and never touches a note. Track what
    // actually changed so the summary states the truth — a fresh scaffold vs. topping up an existing
    // vault — instead of unconditionally claiming to have scaffolded one.
    const vaultPath = join(process.cwd(), "vault");
    const vaultExisted = existsSync(vaultPath);
    let createdDirs = 0;
    for (const d of ["vault", ...vaultDirs.map((t) => `vault/${t}`), "raw"]) {
      const abs = join(process.cwd(), d);
      if (!existsSync(abs)) createdDirs++;
      mkdirSync(abs, { recursive: true });
    }
    const added: string[] = [];
    for (const f of ["index.md", "hot.md", "log.md", "_tags.md"]) {
      const dst = join(vaultPath, f);
      if (!existsSync(dst)) { cpSync(join(pkgRoot, "templates", f), dst); added.push(`vault/${f}`); }
    }
    // Drop the vault contract into the project so an installed agent loads it. The dev clone
    // already has CLAUDE.md at root; this is what makes a fresh `npm i -g` install self-describing,
    // and what the @import lines in CLAUDE.local.md resolve against. Never overwrite a local copy.
    const claudeMd = join(process.cwd(), "CLAUDE.md");
    if (!existsSync(claudeMd) && existsSync(join(pkgRoot, "CLAUDE.md"))) {
      cpSync(join(pkgRoot, "CLAUDE.md"), claudeMd);
      added.push("CLAUDE.md");
    }

    if (!vaultExisted) {
      // Brand-new vault: show the layout so the user learns the shape, then point at the next step.
      console.log("initialized vault at ./vault");
      console.log(`  entities: ${entities.join(", ")}`);
      console.log(`  domains:  ${domains.join(", ")}`);
      console.log(`  forms:    ${forms.join(", ")}`);
      console.log("  + raw/ for immutable by-source snapshots");
      console.log("next: ingest a source (`imprnt ingest <file>`), then `imprnt check`.");
    } else {
      // Existing vault: lead with the count so it's obvious the notes were found, not made, and
      // report only the idempotent top-up. Never imply anything was created or overwritten.
      const noteCount = collectNotes(vaultPath).length;
      console.log(`found existing vault at ./vault — ${noteCount} note${noteCount === 1 ? "" : "s"}, left untouched`);
      if (added.length) console.log(`  added missing control file${added.length === 1 ? "" : "s"}: ${added.join(", ")}`);
      else if (createdDirs) console.log(`  added ${createdDirs} missing folder${createdDirs === 1 ? "" : "s"}`);
      else console.log("  already initialized — nothing to add");
      console.log("run `imprnt check` to validate the graph.");
    }
    break;
  }
  default:
    console.log(`imprnt — deterministic-first markdown knowledge vault

usage:
  imprnt init                              scaffold ./vault (entities/domains/forms) and ./raw
  imprnt snapshot <src> --dest <relpath>   mirror a file/dir into raw/<relpath> (immutable, hashed) — the migration's deterministic half
  imprnt ingest <file|text> [--vault D]    snapshot a source -> raw/; a transcript file also gets an event skeleton (no LLM)
  imprnt recall "<query>" [--vault D]      synonym-aware BM25 ranking over the vault
  imprnt check [--all] [--vault D]         integrity (orphan links, disconnected notes, uncovered snapshots) + regenerate index.md; --all also runs each plugins/*/check.ts
  imprnt ingest --apply <file> [--vault D] file a pre-enriched staged note from a plugin into the vault (snapshot + resolve); --apply-all globs plugins/*/proposed/
  imprnt hot [--vault D]                   needs-review + the session primer
  imprnt plugin list                       show installed plugins (on/off) + official ones available to add
  imprnt plugin add <name> [--from D]      fetch imprnt-plugin-<name>, copy into plugins/, wire it (idempotent; --force refreshes)
  imprnt plugin rm <name> [--purge]        unwire a plugin; --purge also deletes plugins/<name>/

layout: entities (people · orgs · holdings) · domains (identity · health · finances · work · life · projects) · forms (events · mistakes)
the vault is plain markdown. an agent greps it directly — no MCP, no DB.
recall ranks with BM25 (core, in recall.ts). opt-in plugins live in plugins/ (guard built; graph to adapt from PAI).`);
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
}
