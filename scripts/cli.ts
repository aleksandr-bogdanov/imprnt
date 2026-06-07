#!/usr/bin/env bun
// imprint — dispatcher. Subcommands are thin; the real work is in sibling scripts.
import { cpSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openNeedsReview } from "./lib/resolve.ts";
import { listPluginDirs, isEnabled, addPlugin, rmPlugin } from "./lib/plugins.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [cmd, ...rest] = process.argv.slice(2);

function vaultArg(): string {
  const i = rest.indexOf("--vault");
  return i >= 0 ? rest[i + 1] : (process.env.IMPRINT_VAULT ?? "./vault");
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
    if (!existsSync(p)) { console.error(`no hot.md at ${p} — run \`imprint init\``); process.exit(1); }
    console.log(readFileSync(p, "utf8"));
    break;
  }
  case "plugin": {
    // Generic plugin wiring. Toggles one @import line per plugin in CLAUDE.local.md at the
    // repo root. No per-plugin logic: it works on plugins/<name>/ by convention only.
    const [sub, spec] = rest;
    if (sub === "list") {
      const dirs = listPluginDirs(root);
      if (!dirs.length) { console.log("no plugins found under plugins/"); break; }
      console.log("plugins:");
      for (const name of dirs) {
        const mark = isEnabled(root, name) ? "[on] " : "[off]";
        console.log(`  ${mark} ${name}`);
      }
      console.log("\nenable: imprint plugin add <name>   disable: imprint plugin rm <name>");
      break;
    }
    if (sub === "add") {
      if (!spec) { console.error("usage: imprint plugin add <name> | <name>/<file.md>"); process.exit(1); }
      const { entry, added } = addPlugin(root, spec);
      console.log(added ? `wired @${entry}` : `already wired @${entry}`);
      break;
    }
    if (sub === "rm") {
      if (!spec) { console.error("usage: imprint plugin rm <name>"); process.exit(1); }
      const removed = rmPlugin(root, spec);
      console.log(removed ? `unwired ${spec} (${removed} line${removed === 1 ? "" : "s"})` : `${spec} was not wired`);
      break;
    }
    console.error("usage: imprint plugin list | add <name> | rm <name>");
    process.exit(1);
  }
  case "init": {
    // v3 layout: entity folders (cross-cutting) + domain folders (life-areas) + form folders, all flat
    // under vault/. raw/ holds immutable by-source snapshots. Topic is a tag, never a folder.
    const entities = ["people", "orgs", "holdings"];
    const domains = ["identity", "health", "finances", "work", "life", "projects"];
    const forms = ["events", "mistakes"];
    const vaultDirs = [...entities, ...domains, ...forms];
    for (const d of ["vault", ...vaultDirs.map((t) => `vault/${t}`), "raw"]) {
      mkdirSync(join(process.cwd(), d), { recursive: true });
    }
    for (const f of ["index.md", "hot.md", "log.md", "_tags.md"]) {
      const dst = join(process.cwd(), "vault", f);
      if (!existsSync(dst)) cpSync(join(root, "templates", f), dst);
    }
    console.log("scaffolded ./vault:");
    console.log(`  entities: ${entities.join(", ")}`);
    console.log(`  domains:  ${domains.join(", ")}`);
    console.log(`  forms:    ${forms.join(", ")}`);
    console.log("  + raw/ for immutable by-source snapshots.");
    console.log("snapshot a source (`imprint snapshot <path> --dest pai/...`) or ingest one, then `imprint check`.");
    break;
  }
  default:
    console.log(`imprint — deterministic-first markdown knowledge vault

usage:
  imprint init                              scaffold ./vault (entities/domains/forms) and ./raw
  imprint snapshot <src> --dest <relpath>   mirror a file/dir into raw/<relpath> (immutable, hashed) — the migration's deterministic half
  imprint ingest <file|text> [--vault D]    snapshot a source -> raw/; a transcript file also gets an event skeleton (no LLM)
  imprint recall "<query>" [--vault D]      synonym-aware BM25 ranking over the vault
  imprint check [--all] [--vault D]         integrity (orphan links, disconnected notes, uncovered snapshots) + regenerate index.md; --all also runs each plugins/*/check.ts
  imprint ingest --apply <file> [--vault D] file a pre-enriched staged note from a plugin into the vault (snapshot + resolve); --apply-all globs plugins/*/proposed/
  imprint hot [--vault D]                   needs-review + the session primer
  imprint plugin list                       show gallery plugins and which are enabled
  imprint plugin add <name>[/<file.md>]     wire a plugin into CLAUDE.local.md (idempotent)
  imprint plugin rm <name>                  unwire a plugin from CLAUDE.local.md

layout: entities (people · orgs · holdings) · domains (identity · health · finances · work · life · projects) · forms (events · mistakes)
the vault is plain markdown. an agent greps it directly — no MCP, no DB.
recall ranks with BM25 (core, in recall.ts). opt-in plugins live in plugins/ (guard built; graph to adapt from PAI).`);
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
}
