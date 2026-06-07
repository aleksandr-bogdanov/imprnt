// Plugin wiring (generic, deterministic). The whole job: list plugin dirs under plugins/
// and toggle one `@import` line per plugin in CLAUDE.local.md. Core never knows a specific
// plugin name. Adding a gallery plugin is dropping a dir, never a code edit here.
//
// CLAUDE.local.md lives at the repo root next to the committed CLAUDE.md, because Claude Code
// resolves `@import` lines from there. We append/remove exactly one line and keep it idempotent.
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HEADER = `# Personal plugin toggles (this machine only)

> Gitignored. Claude Code auto-loads this right after CLAUDE.md, so whatever you @import here is
> wired into the agent every session. This is the on/off switch: add a line to enable a plugin,
> delete or comment it to disable. Managed by \`imprint plugin add/rm\`, or hand-edit it.

`;

// The wiring line for a plugin spec. `<name>` resolves to plugins/<name>/agent.md;
// `<name>/<file.md>` wires that exact file. Returns the relative import target used in the line.
export function entryFor(spec: string): string {
  if (spec.includes("/")) return `plugins/${spec}`;
  return `plugins/${spec}/agent.md`;
}

function localPath(root: string): string {
  return join(root, "CLAUDE.local.md");
}

function importLine(entry: string): string {
  return `@${entry}`;
}

// Every top-level dir under plugins/ except _personal/ (private) and any file (README.md).
export function listPluginDirs(root: string): string[] {
  const dir = join(root, "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name !== "_personal" && !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readLocal(root: string): string {
  const p = localPath(root);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// A plugin counts as enabled if CLAUDE.local.md has an uncommented @import line pointing
// anywhere inside plugins/<name>/. Both `add <name>` and `add <name>/<file>` land here.
export function isEnabled(root: string, name: string): boolean {
  const prefix = `@plugins/${name}/`;
  return readLocal(root)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l.startsWith(prefix));
}

// Wire a plugin in. Creates CLAUDE.local.md with a header on first add. Idempotent: a line
// already present is left alone. Returns the import target, plus whether it was newly added.
export function addPlugin(root: string, spec: string): { entry: string; added: boolean } {
  const entry = entryFor(spec);
  const line = importLine(entry);
  const p = localPath(root);
  let content = existsSync(p) ? readFileSync(p, "utf8") : HEADER;
  const already = content.split(/\r?\n/).some((l) => l.trim() === line);
  if (already) return { entry, added: false };
  if (!content.endsWith("\n")) content += "\n";
  content += line + "\n";
  writeFileSync(p, content);
  return { entry, added: true };
}

// Unwire a plugin. Removes every uncommented @import line under plugins/<name>/.
// Idempotent: no file or no match is a clean no-op. Returns how many lines went away.
export function rmPlugin(root: string, name: string): number {
  const p = localPath(root);
  if (!existsSync(p)) return 0;
  const prefix = `@plugins/${name}/`;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => !l.trim().startsWith(prefix));
  const removed = lines.length - kept.length;
  if (removed) writeFileSync(p, kept.join("\n"));
  return removed;
}
