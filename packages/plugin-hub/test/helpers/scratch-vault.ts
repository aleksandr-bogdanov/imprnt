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

import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { imprntCliPath } from "./imprnt-shim.ts";

export interface ScratchVault {
  /** The project root: the directory holding `vault/` and `raw/`. */
  root: string;
  /** `<root>/vault`, which is what `--vault` is handed. */
  vaultDir: string;
  /** `<root>/raw`, the sibling `applyStaged` resolves its snapshots under. */
  rawDir: string;
  /** The scratch `XDG_CONFIG_HOME` this init registered itself in. */
  configHome: string;
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

  return {
    root,
    vaultDir,
    rawDir,
    configHome,
    async remove() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      await rm(configHome, { recursive: true, force: true }).catch(() => {});
    },
  };
}
