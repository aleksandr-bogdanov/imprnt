// projectRoot — the user's WORKING dir, holding vault/, raw/, plugins/, CLAUDE.local.md. This is
// where plugin wiring and the check/apply aggregators operate. It is cwd-based, so it is safe to
// compute from anywhere (a lib file, an inlined bundle) — unlike a package-relative path.
//
// The other root, the install location (packageRoot, source for templates/ + CLAUDE.md), is NOT
// here on purpose: it must be derived from the ENTRY file's own location (cli.ts -> dist/cli.js),
// which sits exactly one level under the package in both dev and the bundle. A lib helper can't do
// that — bundling inlines it into dist/cli.js and rewrites its import.meta.url — so cli.ts computes
// packageRoot itself. In the dev clone the two roots coincide; for an installed user they diverge.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// IMPRINT_ROOT overrides (mirrors IMPRINT_VAULT); otherwise walk up from `start` to the first
// ancestor that looks like an imprint project (has vault/ or CLAUDE.local.md); otherwise fall back
// to `start` — the `init`-in-an-empty-dir case, before any marker exists.
export function projectRoot(start: string = process.cwd()): string {
  const override = process.env.IMPRINT_ROOT;
  if (override) return override;
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "vault")) || existsSync(join(dir, "CLAUDE.local.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
