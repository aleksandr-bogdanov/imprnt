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

interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}

const HEALTHY = {
  // The hub box's own boot line, as measured this morning.
  cmdline:
    "console=serial0,115200 console=tty1 root=PARTUUID=deadbeef-02 rootfstype=ext4 fsck.repair=yes rootwait cgroup_enable=memory cgroup_memory=1",
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

    // --- 6. the real box. On linux the view reads and produces neither finding,
    //     which is the recorded truth of the machine this phase is built on. On
    //     darwin there is no cgroup question at all, so the reader returns null
    //     and `kernelFindings(null, ...)` is empty.
    const real = await read();
    if (process.platform === "darwin") {
      expect(real).toBeNull();
      expect(findings(null, "mac")).toEqual([]);
    } else {
      expect(real).not.toBeNull();
      const view = real as { cmdline: string; controllers: string[]; earlyoom: string };
      expect(typeof view.cmdline).toBe("string");
      expect(Array.isArray(view.controllers)).toBe(true);
      expect(["active", "inactive", "absent"]).toContain(view.earlyoom);
      expect(findings(real, "pi")).toEqual([]);
    }
  },
  30_000,
);
