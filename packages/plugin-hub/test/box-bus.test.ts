// The box must not leave a boxed command a path to this account's systemd. The
// user session bus and systemd's private socket live under /run/user and the
// system bus under /run/dbus, and a connection to either takes a start-a-unit
// call from the same account, which runs a process OUTSIDE the box. A fresh
// tmpfs over each directory empties it.
//
// The pure half asserts the rendered Linux argv carries both masks, after the
// pid namespace's /proc and inside the masks the box applies last. It runs on
// either platform because it executes nothing.
//
// The exec half is gated on a working bwrap. From inside a real box built by the
// code's own function, with an emptied environment, a property read against the
// user manager over its own socket and against the system bus must both fail to
// connect. A property read is the whole probe: nothing is started, and no
// mutating method is called. The control is a trivial boxed command that runs,
// so a box that simply broke every command is never mistaken for the fence.
//
// The same two halves cover the docker socket, which is the other way out of the
// box on a host that runs the daemon: a container started through it can bind the
// host's root directory and write to it as root.

import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { plantTrees } from "./helpers/trees.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";

const gate = boxGate();

function stage(dir: string) {
  const trees = plantTrees(dir, ["p1", "p2"]);
  const spec: RegistrySpec = {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: dir, shared_zone: trees.sharedZone },
    machines: [{ id: "pi", os: "linux" }],
    people: trees.people.map((p) => ({ id: p.id, tree: p.tree })),
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: trees.people.map((p, n) => ({ id: `${p.id}-lair`, person: p.id, preset: "daily", chat: `000000000${n}`, door: "door-fake", runner: "runner-pi" })),
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  };
  return { trees, registry: loadRegistry(writeRegistry(dir, spec)) };
}

test("the rendered Linux box masks the user runtime directory and the system bus directory with a tmpfs, after the pid namespace and among the last masks", async () => {
  const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-box-bus-"));
  try {
    const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
    const { argv } = (boxCommand as Function)(["/bin/true"], { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
    const tmpfsAt = (path: string) => argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === path);
    const proc = argv.findIndex((a, i) => a === "--proc" && argv[i + 1] === "/proc");
    const sep = argv.lastIndexOf("--");
    for (const path of ["/run/user", "/run/dbus"]) {
      expect(tmpfsAt(path), `${path} is masked`).toBeGreaterThan(-1);
      expect(tmpfsAt(path), `${path} is masked after the pid namespace`).toBeGreaterThan(proc);
      expect(tmpfsAt(path), `${path} is masked before the command`).toBeLessThan(sep);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the rendered Linux box covers the docker socket with /dev/null, before the command", async () => {
  const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-box-control-"));
  try {
    const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
    const { argv } = (boxCommand as Function)(["/bin/true"], { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
    const nulled = (path: string) => argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === realpathSync(path));
    // The socket is only on a box that runs the daemon, so it is asserted where
    // it exists and the argv simply skips it where it does not.
    if (existsSync("/run/docker.sock")) {
      expect(nulled("/run/docker.sock"), "the docker socket is masked").toBe(true);
      const sep = argv.lastIndexOf("--");
      expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null")).toBeLessThan(sep);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

beforeAll(() => {
  process.stderr.write(`[box-gate] the bus fence on ${process.platform}: ${gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`}\n`);
});

test.skipIf(!(gate.ok && process.platform === "linux"))(
  `inside a real Linux box the user manager and the system bus do not answer a property read, while a trivial boxed command still runs${gate.ok && process.platform === "linux" ? "" : ` [skipped: ${gate.reason || "not linux"}]`}`,
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-box-bus-exec-"));
    try {
      const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
      const uid = process.getuid!();
      const version = "org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version";
      const probe = ["/bin/sh", "-c", [
        `echo control-ran`,
        `printf user-bus:; busctl --address=unix:path=/run/user/${uid}/bus get-property ${version} 2>&1 | head -1`,
        `printf system-bus:; busctl --system get-property ${version} 2>&1 | head -1`,
      ].join("; ")];
      const { argv } = (boxCommand as Function)(probe, { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
      const done = Bun.spawnSync(argv, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" });
      const out = done.stdout.toString() + done.stderr.toString();
      // The control proves the box runs a command at all.
      expect(out).toContain("control-ran");
      // A version string is only ever returned by a bus that answered. Neither may.
      const userLine = out.split("\n").find((l) => l.startsWith("user-bus:")) ?? "";
      const systemLine = out.split("\n").find((l) => l.startsWith("system-bus:")) ?? "";
      expect(userLine, `the user manager answered: ${userLine}`).not.toMatch(/^user-bus:\s*s\s/);
      expect(systemLine, `the system bus answered: ${systemLine}`).not.toMatch(/^system-bus:\s*s\s/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  120_000,
);

test.skipIf(!(gate.ok && process.platform === "linux"))(
  `inside a real Linux box the docker socket refuses a connect, while the same connect succeeds outside it${gate.ok && process.platform === "linux" ? "" : ` [skipped: ${gate.reason || "not linux"}]`}`,
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-box-control-exec-"));
    try {
      // A connect and nothing else: no request is ever sent to the daemon. It
      // goes in a file rather than through -c, because a shell hands a -c
      // program its backslashes and python reads those as line continuations.
      const script = join(dir, "connect.py");
      writeFileSync(script, [
        "import socket",
        "s = socket.socket(socket.AF_UNIX)",
        "try:",
        '    s.connect("/run/docker.sock")',
        '    print("docker:connected")',
        "except Exception as error:",
        '    print("docker:refused", type(error).__name__)',
        "",
      ].join("\n"));
      const probe = ["/bin/sh", "-c", [
        `echo control-ran`,
        `python3 ${script} 2>&1 | tail -1`,
      ].join("; ")];
      const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
      const { argv } = (boxCommand as Function)(probe, { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
      const run = (command: string[]) => {
        const done = Bun.spawnSync(command, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" });
        return done.stdout.toString() + done.stderr.toString();
      };
      const outside = run(probe);
      const inside = run(argv);
      expect(inside).toContain("control-ran");
      // The socket: only judged on a box that runs the daemon, and only when the
      // same connect succeeds outside, which is what makes the refusal the fence.
      if (outside.includes("docker:connected")) {
        expect(inside.includes("docker:connected"), `the docker socket connected inside the box:\n${inside}`).toBe(false);
      } else {
        process.stderr.write(`[box-gate] the docker socket is not connectable on this box, so there is nothing to judge here\n`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  120_000,
);
