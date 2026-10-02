import { placeOf } from "../door/deletion-lines.ts";
import type { StoreLike } from "../store/connect.ts";
import { confirmedDeletions, deletionSchemaReady, receiptsOf } from "../store/deletions.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What a person has to know about a topic deletion, as findings, one per thing and keyed on it so it disappears when the thing is
 * settled: a deletion that is waiting for something to stop, one waiting for a machine, one that part of cannot be erased, one the
 * store refused, and the state of the earlier backup copies, which a deletion does not erase.
 *
 * Said by the machine whose door the topic was on, so two machines never say one twice. A deletion that has finished says nothing,
 * except that its earlier backup copies have no expiry (retention not configured) or an expiry nothing can verify: those are said until
 * the owner configures a retention, or the destination can enforce it, because they are the one part of "deleted" that is not done.
 */

/** A confirmed deletion still stopping the agent's work after this long is said, with what it waits for. */
export const QUIESCE_GRACE_MS = 10 * 60 * 1000;

export async function deletionFindings(args: { store: StoreLike; machine: string; now: Date; doors: ReadonlySet<string> }): Promise<Finding[]> {
  const findings: Finding[] = [];
  // A store that has not been migrated to 017 has deleted nothing, and none of the tables below: the runners say it is behind, by name.
  if (!(await deletionSchemaReady(args.store))) return findings;
  const rows = (await confirmedDeletions(args.store)).filter(one => args.doors.has(one.door));
  const stamps = (await args.store.sql`select id, updated_at, confirmed_at from topic_deletion where stage <> 'superseded'`) as unknown as
    { id: string; updated_at: Date; confirmed_at: Date | null }[];
  const at = new Map(stamps.map(one => [one.id, one]));
  let unconfigured = 0;
  let unverified = 0;
  let blocked = 0;
  for (const deletion of rows) {
    const subject = deletion.id;
    const waited = args.now.getTime() - new Date(at.get(deletion.id)?.confirmed_at ?? args.now).getTime();
    if (deletion.stage === "quiescing" && waited > QUIESCE_GRACE_MS) {
      findings.push({
        id: findingId(args.machine, "deletion-stopping", subject), kind: "deletion-stopping", subject, machine: args.machine,
        says: `the deletion of ${deletion.agent_id} was confirmed ${Math.round(waited / 60000)} minutes ago and is still waiting for the agent or its delegated work to be shown stopped. Nothing is erased until it is`,
        fix: `imprnt hub check, then look at the unresolved attempt of ${deletion.agent_id}: a stop that cannot be shown stays unresolved by design`,
      });
    } else if (deletion.stage === "pending_machine") {
      const open = await receiptsOf(args.store, deletion.id, { open: true, historical: false });
      findings.push({
        id: findingId(args.machine, "deletion-waiting-machine", subject), kind: "deletion-waiting-machine", subject, machine: args.machine,
        says: `the deletion of ${deletion.agent_id} is not complete: ${[...new Set(open.map(one => placeOf("en", one)))].join("; ")} has not been reported erased`,
        fix: `start the hub on ${[...new Set(open.map(one => one.machine).filter(one => one !== ""))].join(", ") || "the machines named"}: each removes its own copies when it runs, and nothing is called done before`,
      });
    } else if (deletion.stage === "blocked_scope") {
      const refused = await receiptsOf(args.store, deletion.id, { historical: false });
      const bad = refused.filter(one => one.state === "unsupported" || one.state === "blocked");
      findings.push({
        id: findingId(args.machine, "deletion-blocked", subject), kind: "deletion-blocked", subject, machine: args.machine,
        says: `the deletion of ${deletion.agent_id} cannot be completed by this hub: ${bad.map(one => `${placeOf("en", one)} (${one.state})`).join("; ")}`,
        fix: "delete those by hand where the platform allows it; the hub does not call the deletion complete while any is left",
      });
    } else if (deletion.stage === "failed") {
      findings.push({
        id: findingId(args.machine, "deletion-failed", subject), kind: "deletion-failed", subject, machine: args.machine,
        says: `the removal for the deletion of ${deletion.agent_id} was refused by the store (${String(deletion.failure?.code ?? "refused")}); it is tried again`,
        fix: "nothing to run: the door tries the confirmed deletion again",
      });
    }
    if (deletion.retention_state === "not_configured") unconfigured += 1;
    if (deletion.retention_state === "retention_unverified") unverified += 1;
    if (deletion.retention_state === "retention_blocked") blocked += 1;
  }
  if (unconfigured > 0) {
    findings.push({
      id: findingId(args.machine, "backup-retention-not-configured"), kind: "backup-retention-not-configured", subject: "hub.backup_retention_days", machine: args.machine,
      says: `${unconfigured} deleted topic${unconfigured === 1 ? "" : "s"} still ${unconfigured === 1 ? "has" : "have"} earlier backup copies with no expiry date: no backup retention is configured`,
      fix: "set hub.backup_retention_days in the registry to the number of days the owner chooses (30 was only proposed, and nothing applies it)",
    });
  }
  if (unverified > 0) {
    findings.push({
      id: findingId(args.machine, "backup-retention-unverified"), kind: "backup-retention-unverified", subject: "hub.backup_retention_days", machine: args.machine,
      says: `${unverified} deleted topic${unverified === 1 ? "" : "s"} ${unverified === 1 ? "is" : "are"} counted against a configured backup retention that the backup destination cannot verify or carry out: earlier copies remain until removed by hand`,
      fix: "remove earlier backup copies older than the configured days at the destination yourself, or declare list_argv and expire_argv on the backup entry, with an upload that gives each copy a place of its own ({generation}), so that the job can enumerate and expire them; add retained_argv (what the destination still retains, versions and trash included) so removals are verified against it, and seal_argv if the destination still holds its old single-directory copy. The reasons are in the deletion's retention detail",
    });
  }
  if (blocked > 0) {
    findings.push({
      id: findingId(args.machine, "backup-retention-blocked"), kind: "backup-retention-blocked", subject: "hub.backup_retention_days", machine: args.machine,
      says: `${blocked} deleted topic${blocked === 1 ? "" : "s"} ${blocked === 1 ? "has" : "have"} an earlier backup copy that is past the configured retention and that the destination did not remove (its expiry command failed, or the copy is still listed after it)`,
      fix: "look at the backup-retention failure in the diary, make the destination's expire command work or remove the copy by hand; the next backup run asks again",
    });
  }
  return findings;
}
