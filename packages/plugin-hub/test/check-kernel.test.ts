// Check: the two kernel findings fire when they apply. (SPEC §6, L4, RUN-14)
//
// L4: "`hub check` names what the kernel could add, as findings with the fix in
// them", while "the installer never does it". The fix text is fixed by the
// record and is quoted into the finding: append `cgroup_enable=memory
// cgroup_memory=1` to `/boot/firmware/cmdline.txt` and reboot, and
// `sudo apt install earlyoom`.
//
// WHY THE VIEW IS SUPPLIED (D-91). On the machine this phase is built on the
// boot command line ALREADY carries both words, the user slice already delegates
// `cpu memory pids`, and earlyoom is already installed and active, so NEITHER
// finding applies there and a check that read the real box could only ever
// assert an absence. So the views are planted, and the real box is an extra
// control that must produce neither.
//
// PURE, BOTH PLATFORMS, NO GATE, AND IT GREPS NOTHING. RUN-14's other half,
// "an installer that edits a boot file", is bound behaviourally in check 5 by
// the set of paths `install` reported, which is what the rule is actually
// about: an installer that shells out to something that edits a boot file
// passes a grep.
//
// Red reason: import missing, src/check/kernel.ts.

import { test, expect } from "bun:test";
import { seam } from "./helpers/cluster.ts";
import type { Finding } from "./helpers/finding.ts";

const HEALTHY = {
  // The hub box's own boot line, as measured this morning.
  cmdline:
    "console=serial0,115200 console=tty1 root=PARTUUID=deadbeef-02 rootfstype=ext4 fsck.repair=yes rootwait cgroup_enable=memory cgroup_memory=1",
  bootFile: "/boot/firmware/cmdline.txt",
  controllers: ["cpu", "memory", "pids"],
  earlyoom: "active" as const,
};

// A box that is not a Raspberry Pi: no boot file to edit, a kernel line that
// never carries the two words, and the controller on regardless. Debian and
// Ubuntu look like this, and CI's runner is one.
const PLAIN_LINUX = {
  cmdline: "BOOT_IMAGE=/boot/vmlinuz root=UUID=deadbeef ro quiet",
  bootFile: null,
  controllers: ["cpu", "memory", "pids"],
  earlyoom: "active" as const,
};

test(
  "RUN-14 the two kernel findings fire when they apply, and a healthy view produces neither: the boot words missing and the memory controller undelegated are the same finding by two routes, an absent or inactive earlyoom is the other, each carries the record's own fix text, and on this box the REAL view produces nothing (SPEC §6, L4, D-91)",
  async () => {
    const { kernelFindings, readKernelView } = await seam("src/check/kernel.ts");
    expect(typeof kernelFindings).toBe("function");
    expect(typeof readKernelView).toBe("function");

    const findings = kernelFindings as (view: unknown, machine: string) => Finding[];
    const read = readKernelView as () => Promise<unknown>;

    const only = (list: Finding[], kind: string): Finding => {
      const found = list.filter((f) => f.kind === kind);
      expect(found.length).toBe(1);
      return found[0];
    };

    // --- 1. a boot line with neither word.
    const noWords = findings(
      { ...HEALTHY, cmdline: "console=tty1 root=PARTUUID=deadbeef-02 rootwait" },
      "pi",
    );
    const cgroup = only(noWords, "kernel-memory-cgroup");
    expect(cgroup.machine).toBe("pi");
    expect(cgroup.id).toContain("pi/");
    expect(cgroup.id).toContain("kernel-memory-cgroup");
    expect(cgroup.says.length).toBeGreaterThan(0);
    // The fix is the record's own words, not merely a non-empty string.
    expect(cgroup.fix).toContain("cgroup_enable=memory");
    expect(cgroup.fix).toContain("cgroup_memory=1");
    expect(cgroup.fix).toContain("/boot/firmware/cmdline.txt");
    expect(cgroup.fix.toLowerCase()).toContain("reboot");
    expect(noWords.filter((f) => f.kind === "kernel-earlyoom")).toEqual([]);

    // Half the words is still the finding, or a half-applied fix reads as done.
    expect(
      findings({ ...HEALTHY, cmdline: "rootwait cgroup_enable=memory" }, "pi").filter(
        (f) => f.kind === "kernel-memory-cgroup",
      ).length,
    ).toBe(1);
    expect(
      findings({ ...HEALTHY, cmdline: "rootwait cgroup_memory=1" }, "pi").filter(
        (f) => f.kind === "kernel-memory-cgroup",
      ).length,
    ).toBe(1);

    // --- 2. both words present, and the controller NOT delegated. The words in
    //     the file are not the same fact as the controller actually being
    //     delegated to the user slice, and a check that read only the boot line
    //     would call this box healthy while nothing could hold a limit.
    const undelegated = findings({ ...HEALTHY, controllers: ["cpu", "pids"] }, "pi");
    const byController = only(undelegated, "kernel-memory-cgroup");
    expect(byController.fix).toContain("cgroup_enable=memory");
    expect(undelegated.filter((f) => f.kind === "kernel-earlyoom")).toEqual([]);

    // --- 3. earlyoom, absent and inactive, each its own one finding.
    for (const state of ["absent", "inactive"] as const) {
      const list = findings({ ...HEALTHY, earlyoom: state }, "pi");
      const oom = only(list, "kernel-earlyoom");
      expect(oom.machine).toBe("pi");
      expect(oom.id).toContain("pi/");
      expect(oom.fix).toContain("apt install earlyoom");
      expect(list.filter((f) => f.kind === "kernel-memory-cgroup")).toEqual([]);
    }

    // --- 4. the control, without which this is a check on a function that
    //     always complains.
    expect(findings(HEALTHY, "pi")).toEqual([]);

    // --- 4b. a box with no boot file is not told to edit one. The words are a
    //     Raspberry Pi's switch, and a Debian or Ubuntu kernel never carries
    //     them while its controller is on. Only the controller route applies
    //     there, and its fix names the controller, not a file the box lacks.
    expect(findings(PLAIN_LINUX, "box")).toEqual([]);
    const plainUndelegated = only(
      findings({ ...PLAIN_LINUX, controllers: ["cpu", "pids"] }, "box"),
      "kernel-memory-cgroup",
    );
    expect(plainUndelegated.fix).not.toContain("/boot/firmware/cmdline.txt");
    expect(plainUndelegated.fix.toLowerCase()).toContain("memory");

    // --- 5. the two at once, so neither hides the other.
    const both = findings(
      { cmdline: "rootwait", controllers: ["cpu", "pids"], earlyoom: "absent" },
      "pi",
    );
    expect(both.map((f) => f.kind).sort()).toEqual([
      "kernel-earlyoom",
      "kernel-memory-cgroup",
    ]);
    // Machine-scoped ids, so two machines writing into one store cannot each
    // erase the other's row (D-90).
    expect(findings({ cmdline: "rootwait", controllers: [], earlyoom: "absent" }, "mac")[0].id)
      .toContain("mac/");
    expect(both[0].id).not.toBe(
      findings({ cmdline: "rootwait", controllers: [], earlyoom: "absent" }, "mac")[0].id,
    );

    // --- 6. the real box. On linux the view reads, and the findings it yields
    //     are exactly the ones the view itself justifies: the controller route
    //     fires iff memory is not delegated, the words route iff the box has a
    //     boot file that lacks them, earlyoom iff it is not active. That holds
    //     on the hub box (neither fires) and on a bare CI runner (earlyoom is
    //     absent there, honestly). Asserting an EMPTY list here would be a claim
    //     about the box running the suite, not about the code. On darwin there
    //     is no cgroup question at all, so the reader returns null and
    //     `kernelFindings(null, ...)` is empty.
    const real = await read();
    if (process.platform === "darwin") {
      expect(real).toBeNull();
      expect(findings(null, "mac")).toEqual([]);
    } else {
      expect(real).not.toBeNull();
      const view = real as {
        cmdline: string;
        bootFile: string | null;
        controllers: string[];
        earlyoom: string;
      };
      expect(typeof view.cmdline).toBe("string");
      expect(view.bootFile === null || typeof view.bootFile === "string").toBe(true);
      expect(Array.isArray(view.controllers)).toBe(true);
      expect(["active", "inactive", "absent"]).toContain(view.earlyoom);
      const realFindings = findings(real, "pi").map((f) => f.kind).sort();
      const expected: string[] = [];
      const wordsMissing =
        view.bootFile !== null &&
        !(view.cmdline.includes("cgroup_enable=memory") && view.cmdline.includes("cgroup_memory=1"));
      if (wordsMissing || !view.controllers.includes("memory")) expected.push("kernel-memory-cgroup");
      if (view.earlyoom !== "active") expected.push("kernel-earlyoom");
      expect(realFindings).toEqual(expected.sort());
    }
  },
  30_000,
);
