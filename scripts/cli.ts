#!/usr/bin/env bun
// knowful — dispatcher. Subcommands are thin; the real work is in sibling scripts.
import { cpSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [cmd, ...rest] = process.argv.slice(2);

function vaultArg(): string {
  const i = rest.indexOf("--vault");
  return i >= 0 ? rest[i + 1] : "./vault";
}

// Delegated scripts parse process.argv.slice(2) themselves, expecting their own args
// first. Strip the subcommand token so `cli.ts ingest <file>` looks like `ingest.ts <file>`.
if (cmd === "ingest" || cmd === "recall") process.argv.splice(2, 1);

switch (cmd) {
  case "ingest":
    await import("./ingest.ts");
    break;
  case "recall":
    await import("./recall.ts");
    break;
  case "hot": {
    const p = join(vaultArg(), "hot.md");
    if (!existsSync(p)) { console.error(`no hot.md at ${p} — run \`knowful init\``); process.exit(1); }
    console.log(readFileSync(p, "utf8"));
    break;
  }
  case "init": {
    for (const d of ["vault", "vault/people", "vault/workstreams", "vault/meetings", "vault/mistakes", "raw"]) {
      mkdirSync(join(process.cwd(), d), { recursive: true });
    }
    for (const f of ["index.md", "hot.md", "log.md"]) {
      const dst = join(process.cwd(), "vault", f);
      if (!existsSync(dst)) cpSync(join(root, "templates", f), dst);
    }
    console.log("scaffolded ./vault and ./raw. drop a transcript in raw/ and run `knowful ingest`.");
    break;
  }
  default:
    console.log(`knowful — deterministic-first markdown knowledge vault

usage:
  knowful init                      scaffold ./vault and ./raw
  knowful ingest <file> [--vault D] parse a transcript -> structured note (no LLM)
  knowful recall "<query>" [--vault D]  tiered grep over the vault
  knowful hot [--vault D]           print the session primer

the vault is plain markdown. an agent greps it directly — no MCP, no DB.`);
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
}
