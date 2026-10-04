// The Windows setup's box probe: the hub's own Linux box, rendered by `boxCommand` with this
// machine's real WSL view and masks, runs one command that resolves one name. A bare `bwrap` box
// proves bubblewrap works and nothing about the masks; this proves a boxed agent on this distro
// can still reach a name server once WSL's shared folder is emptied, which every turn needs.
//
// Usage: bun tools/windows/box-probe.ts <name>
// Prints one line, `box: ok ...` or `box: <why>`, and exits non-zero on anything but ok. It reads
// no credential, starts no agent and sends nothing but the one name lookup.

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boxCommand } from "../../src/box/index.ts";
import { readWslView, wslMaskPaths } from "../../src/os/wsl.ts";

const name = process.argv[2] ?? "";
if (!/^[A-Za-z0-9.-]+$/.test(name)) {
  console.log("box: usage: bun tools/windows/box-probe.ts <host name>");
  process.exit(2);
}
const lookup = ["/usr/bin/getent", "hosts", name];
// The control: a distro that resolves nothing outside the box is not a box problem.
if (Bun.spawnSync(lookup, { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
  console.log(`box: this distro does not resolve ${name} even outside the box (its network or name server)`);
  process.exit(3);
}
const view = readWslView();
const tree = join(homedir(), ".imprnt-hub", "setup", "box-probe");
mkdirSync(tree, { recursive: true, mode: 0o700 });
try {
  const { argv } = boxCommand(lookup, { agent: "box-probe", person: "box-probe", tree, otherTrees: [], secretPaths: [] }, "linux", { wsl: view });
  const ran = Bun.spawnSync(argv, { stdout: "ignore", stderr: "pipe" });
  const masks = wslMaskPaths(view).join(",") || "none";
  if (ran.exitCode !== 0) {
    console.log(`box: the hub's box resolves no name (exit ${ran.exitCode}; wsl=${view ? view.version : "no"}; masks=${masks}): ${ran.stderr.toString().trim().slice(-300)}`);
    process.exit(4);
  }
  console.log(`box: ok, ${name} resolves inside the hub's box (wsl=${view ? view.version : "no"}; masks=${masks})`);
} finally {
  rmSync(tree, { recursive: true, force: true });
}
