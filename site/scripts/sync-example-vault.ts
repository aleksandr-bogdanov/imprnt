/**
 * Copies the example vault into the site so the landing's note popovers can read it.
 *
 * Why this exists: Railway builds this service with the Root Directory set to `site/`,
 * so the build context contains ONLY this folder. Reading `../examples/...` works
 * locally and fails in production, which is exactly how the first deploy of the
 * interactive popovers broke. The copy is committed, so the build never reaches
 * outside its own context.
 *
 * The copy is GENERATED. `examples/organization/vault` in the repo root is the source
 * of truth. Run `bun scripts/sync-example-vault.ts` after changing it, and
 * `--check` fails if the two have drifted, which is what CI runs.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "examples", "organization", "vault");
const DEST = join(import.meta.dir, "..", "src", "data", "example-vault");
const check = process.argv.includes("--check");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

if (!existsSync(SRC)) {
  // running inside the site-only build context: the committed copy is all there is
  if (!existsSync(DEST)) {
    console.error(`no example vault at ${SRC} and no committed copy at ${DEST}`);
    process.exit(1);
  }
  console.log("source vault not in this context, using the committed copy");
  process.exit(0);
}

const srcFiles = walk(SRC).map((p) => relative(SRC, p)).sort();
const destFiles = walk(DEST).map((p) => relative(DEST, p)).sort();

const drifted =
  srcFiles.join("\n") !== destFiles.join("\n") ||
  srcFiles.some((f) => readFileSync(join(SRC, f), "utf8") !== readFileSync(join(DEST, f), "utf8"));

if (check) {
  if (drifted) {
    console.error("example vault copy is out of sync - run: bun scripts/sync-example-vault.ts");
    process.exit(1);
  }
  console.log(`example vault in sync (${srcFiles.length} notes)`);
  process.exit(0);
}

rmSync(DEST, { recursive: true, force: true });
for (const f of srcFiles) {
  mkdirSync(dirname(join(DEST, f)), { recursive: true });
  cpSync(join(SRC, f), join(DEST, f));
}
console.log(`synced ${srcFiles.length} notes -> src/data/example-vault`);
