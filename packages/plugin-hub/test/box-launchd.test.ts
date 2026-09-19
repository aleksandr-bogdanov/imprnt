// The macOS box must not let a boxed command hand work to launchd. The profile
// has to allow mach-lookup for the loop to start at all, and that reaches the
// user launchd, which would run a submitted job with no box around it and so
// outside the fence around this person's tree.
//
// The pure half asserts the profile carries the job-creation deny, and is the
// half that fails without it.
//
// The exec half binds the outcome on a real box: a bootstrap of a throwaway job
// is refused and creates nothing, while reading launchd's own state and spawning
// an ordinary child still work, so the refusal is the fence and not a box that
// broke the loop. MEASURED, and the reason this half is a standing guard rather
// than the failing check: the deny-default profile already refuses a bootstrap
// on its own, so the outcome is the same with the deny line and without it. The
// line is what keeps it refused if a later profile ever opens something broader.
//
// The throwaway job never runs anything: it carries /usr/bin/true and does not
// load at start, it is booted out again whatever happens, and the check fails if
// it was ever created.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";

const gate = boxGate();
const onMac = gate.ok && process.platform === "darwin";

function context(tree: string) {
  return { agent: "p1-lair", person: "p1", tree, sharedZone: "", otherTrees: [] as string[], purpose: "ordinary" as const };
}

test("the macOS profile denies job creation", async () => {
  const { boxCommand } = await seam("src/box/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-launchd-"));
  try {
    const built = (boxCommand as Function)(["/usr/bin/true"], context(dir), "darwin") as { profile: { text: string } };
    expect(built.profile.text).toContain("(deny job-creation)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!onMac)(
  `inside a real macOS box a launchd bootstrap is refused and creates nothing, while launchd still answers a read and an ordinary child still runs${onMac ? "" : ` [skipped: ${gate.reason || "not macOS"}]`}`,
  async () => {
    const { boxCommand } = await seam("src/box/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-launchd-exec-"));
    const label = `hub-box-check-${crypto.randomUUID().slice(0, 8)}`;
    const uid = process.getuid!();
    const plist = join(dir, `${label}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>
<key>RunAtLoad</key><false/>
</dict></plist>
`);
    const exists = () => Bun.spawnSync(["/bin/launchctl", "print", `gui/${uid}/${label}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    try {
      const probe = ["/bin/sh", "-c", [
        `echo child-ran`,
        `printf read:; /bin/launchctl print gui/${uid} >/dev/null 2>&1 && echo OK || echo REFUSED`,
        `printf bootstrap:; /bin/launchctl bootstrap gui/${uid} ${plist} >/dev/null 2>&1 && echo CREATED || echo REFUSED`,
      ].join("; ")];
      const built = (boxCommand as Function)(probe, { ...context(dir), sessionDir: dir }, "darwin") as { argv: string[]; profile: { path: string; text: string } };
      writeFileSync(built.profile.path, built.profile.text);
      const done = Bun.spawnSync(built.argv, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      const out = done.stdout.toString() + done.stderr.toString();
      const said = (what: string) => (out.split("\n").find((l) => l.startsWith(`${what}:`)) ?? "").slice(what.length + 1);
      // The controls: the box runs a command, and launchd still answers a read,
      // so a refusal below is the deny and not a box that broke everything.
      expect(out, out).toContain("child-ran");
      expect(said("read"), out).toBe("OK");
      // The fence itself, judged on launchd's own state as well as on the exit.
      expect(said("bootstrap"), out).toBe("REFUSED");
      expect(exists(), "a job was created from inside the box").toBe(false);
      rmSync(built.profile.path, { force: true });
    } finally {
      if (exists()) Bun.spawnSync(["/bin/launchctl", "bootout", `gui/${uid}/${label}`], { stdout: "ignore", stderr: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
