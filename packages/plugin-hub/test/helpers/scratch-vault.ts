// Test infrastructure: a real vault, scaffolded by the real `imprnt init`.
//
// A harvested note is filed by the real CLI into a real vault, so a check that
// binds the filing needs a real vault to file into. `imprnt init <root>`
// scaffolds `<root>/vault` and `<root>/raw` and writes the vault contract as
// `<root>/vault/CLAUDE.md`, which is what makes a loop started in that
// directory load the filing rules the way any agent working in a vault does.
//
// `XDG_CONFIG_HOME` IS NOT OPTIONAL. Measured on 2026-09-16: `imprnt init`
// registers the new vault in `$XDG_CONFIG_HOME/imprnt`, or in `~/.config/imprnt`
// when that variable is unset. A check that let it run unset would edit the
// developer's own registry and change which vault their assistant opens. So the
// variable is pointed at a directory under the scratch dir, always, and a
// helper that could not do that would be a helper nobody may use.
//
// The scratch root must not sit INSIDE another vault project either: `imprnt
// init` walks up from the target and refuses to nest. `scratchDir()` puts it
// under the system temp directory, which is not one.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { hubPath } from "./cluster.ts";
import { imprntCliPath } from "./imprnt-shim.ts";

/**
 * The vault contract, as a published `imprnt` carries it.
 *
 * MEASURED, and it is why this helper does one thing the
 * plan did not ask for. `imprnt init <root>` copies `<packageRoot>/CLAUDE.md`
 * to `<root>/CLAUDE.md`, and `packages/imprnt/package.json` gets that file from
 * the repository root through its `shipdocs` script at PUBLISH time. So an
 * installed `imprnt` writes the contract and the monorepo's own
 * `scripts/cli.ts`, which is what `hub.imprnt` names in every check, copies
 * nothing and says nothing about it.
 *
 * The whole point is that a loop started in the vault root loads the filing
 * rules the way any agent working in a vault does, so a scratch vault without
 * the contract is not the vault this phase is about. The helper puts the same
 * bytes there that a published install would: the repository's OWN `CLAUDE.md`,
 * unconditionally, rather than a `packages/imprnt/CLAUDE.md` that exists only
 * on a machine where `shipdocs` has been run and can be a stale copy there.
 */
function contractPath(): string | null {
  const at = hubPath("../../CLAUDE.md");
  return existsSync(at) ? at : null;
}

export interface ScratchVault {
  /** The project root: the directory holding `vault/` and `raw/`. */
  root: string;
  /** `<root>/vault`, which is what `--vault` is handed. */
  vaultDir: string;
  /** `<root>/raw`, the sibling `applyStaged` resolves its snapshots under. */
  rawDir: string;
  remove(): Promise<void>;
}

/**
 * Scaffold one vault under `dir` and answer where it is.
 *
 * It throws when the init did not exit 0 or did not leave the two directories
 * behind, so a check that leans on it fails with the CLI's own words rather
 * than later, inside an apply, for a reason no plan names.
 */
export async function scratchVault(
  dir: string,
  name = "vault-project",
): Promise<ScratchVault> {
  const root = join(dir, name);
  const configHome = join(dir, "xdg");
  mkdirSync(root, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const child = Bun.spawn([process.execPath, imprntCliPath(), "init", root], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // The whole point of this helper. Everything else of the environment is
    // inherited, because the CLI is a normal program and needs a normal one.
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const vaultDir = join(root, "vault");
  const rawDir = join(root, "raw");
  if (exit !== 0 || !existsSync(vaultDir) || !existsSync(rawDir)) {
    throw new Error(
      `imprnt init ${root} did not scaffold a vault (exit ${exit}).\n` +
        `stdout: ${out}\nstderr: ${err}`,
    );
  }

  // The contract the published CLI would have left here. Never overwritten, so
  // a CLI that did write one keeps its own copy.
  const contract = join(root, "CLAUDE.md");
  const from = contractPath();
  if (!existsSync(contract) && from !== null) copyFileSync(from, contract);

  return {
    root,
    vaultDir,
    rawDir,
    async remove() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(configHome, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * The slug the CLI derives from an H1, computed by the TEST from the vault
 * contract's own rule: kebab-case, at most sixty characters.
 *
 * THREE CHECKS WROTE THIS OUT AND THE THREE COPIES WERE BYTE-IDENTICAL, which
 * is three places for one rule to drift. It stays a test ORACLE and imports
 * nothing from `src/` or from the vault CLI: a slug asked of the code under
 * test would agree with a build that derived it any way at all, and the path a
 * note lands at has to be one the check worked out rather than one it was told.
 */
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
