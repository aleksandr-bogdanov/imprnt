import { runnerAdmission } from "../registry/entries.ts";
import type { RunEntry } from "../registry/load.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * A runner whose three memory numbers admit fewer agents at once than its
 * `max_active_children` says.
 *
 * The admission reserves each child's own `child_memory_limit_mb` whenever
 * that is under the budget, so a 2048 MB limit inside a 3072 MB budget admits
 * ONE agent however many the count says, and a resident agent then holds the
 * only slot while every other agent of that runner waits for ever. Seen live,
 * that looked like a login failure. The file is still loaded, because a
 * budget under the count is a legal way to bound a fleet, and the finding
 * says what the numbers really admit and the two edits that would admit the
 * declared count.
 *
 * Pure, so the arithmetic is readable without a store.
 */
export function admissionFindings(args: { entries: RunEntry[]; machine: string }): Finding[] {
  const out: Finding[] = [];
  for (const entry of args.entries) {
    if (entry.kind !== "runner") continue;
    const it = runnerAdmission(entry);
    if (it.admits >= it.max_active_children) continue;
    out.push({
      id: findingId(args.machine, "runner-admits-fewer", entry.id),
      kind: "runner-admits-fewer",
      subject: entry.id,
      machine: args.machine,
      says:
        `${entry.id} admits ${it.admits} ${it.admits === 1 ? "agent" : "agents"} at a time and its max_active_children says ` +
        `${it.max_active_children}: each child reserves ${it.reserve_mb} MB of a child_memory_budget_mb of ` +
        `${it.child_memory_budget_mb} MB, so a resident agent can hold the only slot while the rest wait`,
      fix:
        `in the registry set ${entry.id}'s child_memory_budget_mb to at least ` +
        `${it.max_active_children * it.child_memory_limit_mb}, or its child_memory_limit_mb to at most ` +
        `${Math.floor(it.child_memory_budget_mb / it.max_active_children)}`,
    });
  }
  return out;
}
