import { readdirSync, readFileSync, existsSync } from "node:fs";
import { findingId, type Finding } from "./finding.ts";

/**
 * What the kernel could add, named as findings with the fix in them, while the
 * installer never does it (L4, RUN-14).
 *
 * D-91. The view is SUPPLIED rather than read, because on the machine this was
 * built for the boot line already carries both words, the user slice already
 * delegates the memory controller and earlyoom is already active, so a check
 * that read the real box could only ever assert an absence. `readKernelView`
 * exists so the real box can be the extra control that produces neither.
 */
export interface KernelView {
  cmdline: string;        // the contents of the boot command line file
  controllers: string[];  // the controllers the user slice delegates
  earlyoom: "active" | "inactive" | "absent";
}

const CGROUP_FIX =
  "append cgroup_enable=memory cgroup_memory=1 to /boot/firmware/cmdline.txt, then reboot";
const EARLYOOM_FIX = "sudo apt install earlyoom";

/** The boot command line, from the file a household edits, not from the kernel. */
function bootCommandLine(): string {
  for (const file of ["/boot/firmware/cmdline.txt", "/boot/cmdline.txt", "/proc/cmdline"]) {
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
    } catch {
      // Unreadable is the same as absent for this question.
    }
  }
  return "";
}

/** The controllers this user's own slice has been delegated. */
function delegated(): string[] {
  const uid = process.getuid?.() ?? -1;
  const places = [
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/cgroup.controllers`,
    "/sys/fs/cgroup/user.slice/cgroup.controllers",
    "/sys/fs/cgroup/cgroup.controllers",
  ];
  for (const file of places) {
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim().split(/\s+/).filter(Boolean);
    } catch {
      // The next one.
    }
  }
  return [];
}

/**
 * Whether earlyoom is installed and running, read from `/proc` rather than from
 * the service manager: `check` invokes no manager of its own, and a process
 * that is running is the fact the finding is about.
 */
function earlyoomState(): KernelView["earlyoom"] {
  const installed = ["/usr/bin/earlyoom", "/usr/sbin/earlyoom", "/bin/earlyoom"].some((path) =>
    existsSync(path),
  );
  let running = false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (readFileSync(`/proc/${entry}/comm`, "utf8").trim() === "earlyoom") {
          running = true;
          break;
        }
      } catch {
        // A process that left between the listing and the read.
      }
    }
  } catch {
    running = false;
  }
  if (running) return "active";
  return installed ? "inactive" : "absent";
}

/** The real box's own view, or null on darwin, where there is no cgroup question. */
export async function readKernelView(): Promise<KernelView | null> {
  if (process.platform !== "linux") return null;
  return {
    cmdline: bootCommandLine(),
    controllers: delegated(),
    earlyoom: earlyoomState(),
  };
}

export function kernelFindings(view: KernelView | null, machine: string): Finding[] {
  if (!view) return [];
  const out: Finding[] = [];
  const words = ["cgroup_enable=memory", "cgroup_memory=1"];
  const missingWords = words.filter((word) => !String(view.cmdline).includes(word));
  const undelegated = !(view.controllers ?? []).includes("memory");
  if (missingWords.length > 0 || undelegated) {
    // The words in the file and the controller actually being delegated are two
    // different facts, and either one missing means nothing can hold a limit.
    const says =
      missingWords.length > 0
        ? `the boot command line is missing ${missingWords.join(" and ")}, so no memory limit can hold`
        : `the user slice delegates ${(view.controllers ?? []).join(" ") || "nothing"} and not memory, so no memory limit can hold`;
    out.push({
      id: findingId(machine, "kernel-memory-cgroup"),
      kind: "kernel-memory-cgroup",
      subject: "",
      machine,
      says,
      fix: CGROUP_FIX,
    });
  }
  if (view.earlyoom !== "active") {
    out.push({
      id: findingId(machine, "kernel-earlyoom"),
      kind: "kernel-earlyoom",
      subject: "",
      machine,
      says: `earlyoom is ${view.earlyoom}, so a box under memory pressure stalls instead of losing one process`,
      fix: EARLYOOM_FIX,
    });
  }
  return out;
}
