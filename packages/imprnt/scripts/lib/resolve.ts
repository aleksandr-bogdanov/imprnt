// Entity resolution (deterministic) + needs-review surfacing.
// A person is "resolved" if a people/<slug>.md exists, or any person note lists the
// name as an alias. Unresolved entities are soft-failed to _needs-review.md,
// which `imprnt hot` prints in your face — the only lint that works on a single-user system.
import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function personResolved(vault: string, slug: string, displayName: string): boolean {
  const dir = join(vault, "people");
  if (existsSync(join(dir, `${slug}.md`))) return true;
  if (!existsSync(dir)) return false;
  const needle = displayName.toLowerCase();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    // Accept CRLF (`\r\n`) fences so Windows-authored notes parse frontmatter. Without `\r?` the closing
    // `---\r` line never matches and aliases fall through, so a CRLF person note never resolves. Mirrors recall.ts.
    const fm = readFileSync(join(dir, f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const aliases = (fm.match(/aliases:\s*\[(.*?)\]/i)?.[1] ?? "").toLowerCase();
    // v2 emits no `title:` key (H1 is the title); alias-matching carries resolution.
    if (aliases.split(",").some((a) => a.trim().replace(/["']/g, "") === needle)) return true;
  }
  return false;
}

export function flagNeedsReview(vault: string, line: string): void {
  const p = join(vault, "_needs-review.md");
  if (!existsSync(p)) writeFileSync(p, "---\ntype: needs-review\n---\n\n# Needs review\n\n");
  appendFileSync(p, line.endsWith("\n") ? line : line + "\n");
}

export function openNeedsReview(vault: string): string[] {
  const p = join(vault, "_needs-review.md");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("- [ ]"));
}
