import {
  diffUnits,
  resetCommand,
  seenUnits,
  startCommand,
  stopCommand,
  wantedState,
} from "../os/diff.ts";
import { entryIdOf, isOurs, unitName } from "../os/names.ts";
import type { OsSeam, WantedUnit } from "../os/types.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import { listAgents, personOf, runEntriesFor } from "../registry/entries.ts";
import { loadRegistry, readSetting } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { readPeaks, residentIds } from "../hub/peak.ts";
import { findingId, type Finding } from "./finding.ts";
import { kernelFindings, type KernelView } from "./kernel.ts";
import { readJobStamps, staleJobs } from "./schedule.ts";
import { silentRunners } from "./silence.ts";

export type { Finding } from "./finding.ts";
export { findingId } from "./finding.ts";

/**
 * `check` compares what runs with what the registry lists, and REPORTS the
 * difference rather than acting on it.
 *
 * D-90 makes it a state sheet: one row per finding id, edited in place, and a
 * finding that no longer applies leaves no line behind. The ids are
 * machine-scoped, because two machines write into one store and a run on one of
 * them removes only the rows under its own prefix.
 *
 * NOTHING HERE ACTS. Every finding carries its fix as TEXT and no code path in
 * this module runs one, which is L13's "never stopped by a robot" made
 * structural rather than promised. It invokes no service manager of its own
 * either: the only manager it ever speaks to is the seam it was handed, and
 * then only through that seam's reading verbs.
 */
export const CHECK_SHEET = "check";

/** D-103. Two restarts, read from the counter and never from the running flag. */
const CRASH_LOOP_RESTARTS = 2;

function setting(registry: unknown, key: string, fallback: number): number {
  const found = readSetting(registry, key);
  return found === undefined || found === null ? fallback : Number(found);
}

/**
 * The newest WORK event for each agent, whichever shape its subject wears.
 *
 * A turn the runner fed itself from the chat log is deliberately not work. L2
 * has every spawned session read the tail of the log back to itself before a
 * human message reaches it, and that turn answers nobody: counting it would
 * make a runner that had just been started look busy for the rest of the day,
 * which is the opposite of what STORE-01 asks. A turn record says which it was.
 */
async function newestWork(store: StoreLike): Promise<Map<string, string>> {
  const rows = (await store.sql.unsafe(
    `select coalesce(i.agent, e.subject) as agent, max(e.at) as at
       from ledger_event e
       left join inbound i on i.id = e.subject
      where (e.stream = 'memory'
             or (e.stream = 'turn' and coalesce(e.detail ->> 'tail', 'false') <> 'true')
             or (e.stream = 'inbound' and e.kind in ('acked', 'answered')))
      group by 1`,
  )) as { agent: string; at: string | Date }[];
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(String(row.agent), new Date(row.at as string).toISOString());
  }
  return out;
}

/**
 * Every runner's newest `connected` line, and the identifier of the store this
 * run is reading (03b item 4).
 *
 * The identifier is `initdb`'s own, generated per cluster, so a line carrying
 * one that is not this store's was written against some other cluster and the
 * household's rows are not all in one place. The NEWEST line per runner is what
 * counts, so a runner that was pointed somewhere else and then corrected clears
 * its own finding by reconnecting.
 */
async function connectedRunners(store: StoreLike): Promise<{
  here: string;
  said: { runner: string; identifier: string }[];
}> {
  const [control] = (await store.sql.unsafe(
    "select system_identifier::text as id from pg_control_system()",
  )) as { id: string }[];
  const rows = (await store.sql.unsafe(
    `select distinct on (subject) subject, detail::text as detail
       from ledger_event
      where stream = 'runner' and kind = 'connected'
      order by subject, seq desc`,
  )) as { subject: string; detail: string | null }[];
  return {
    here: String(control?.id ?? ""),
    said: rows.map((row) => ({
      runner: String(row.subject),
      identifier: String(fieldOf(row.detail, "system_identifier")),
    })),
  };
}

/**
 * One field of a `detail` read back as jsonb TEXT.
 *
 * MEASURED: this client sends a bound jsonb parameter as a JSON string, so a
 * writer that binds an already serialised object stores a jsonb SCALAR STRING
 * whose contents are the object, while `appendEntry`'s own writes store the
 * object itself. Both are details a household can find in its ledger, and a
 * reader that understood only one of them would report the other as carrying
 * nothing at all, which is a finding that silently never fires. So the text is
 * parsed here and one layer of string encoding is unwrapped.
 */
function fieldOf(detail: string | null, field: string): string {
  if (detail === null || detail === "") return "";
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return "";
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value === null || typeof value !== "object") return "";
  const found = (value as Record<string, unknown>)[field];
  return found === undefined || found === null ? "" : String(found);
}

/**
 * Which runner ids the server currently has a client for.
 *
 * The columns are chosen for what a NON-superuser can see. PostgreSQL masks
 * most of `pg_stat_activity` for a backend the reading role is not a member of
 * and has no `pg_read_all_stats` for, and `backend_type` is one of the masked
 * ones: read as `hub_hub`, every runner's row comes back with a null
 * backend_type, so a filter on it would hide exactly the rows this is looking
 * for and report a whole household of runners silent. `application_name`
 * survives the masking, which is why D-85 can derive silence from it at all.
 * A database-scoped row with a name of its own is a client by construction:
 * the server's own background processes carry no database and no name.
 */
async function liveApplications(store: StoreLike): Promise<string[]> {
  const rows = (await store.sql.unsafe(
    `select distinct application_name as name
       from pg_stat_activity
      where datname = current_database()
        and application_name is not null
        and application_name <> ''`,
  )) as { name: string }[];
  return rows.map((row) => String(row.name));
}

export async function runCheck(options: {
  machine: string;
  registryFile: string;
  store: StoreLike;
  os?: OsSeam | null;
  kernel?: KernelView | null;
  now?: Date;
}): Promise<Finding[]> {
  const machine = options.machine;
  const now = options.now ?? new Date();
  const registry = loadRegistry(options.registryFile);
  const entries = runEntriesFor(registry, machine);
  const findings: Finding[] = [];

  // --- what runs against what is listed, both directions (criterion 1) -----
  const os = options.os ?? null;
  if (os) {
    const wanted: WantedUnit[] = entries.map((entry) => ({
      id: entry.id,
      name: unitName(entry.id),
      state: wantedState(entry),
      entry,
    }));
    const found = await seenUnits(os, entries);
    const difference = diffUnits({ wanted, found });

    for (const one of difference.missing) {
      findings.push({
        id: findingId(machine, "unit-missing", one.id),
        kind: "unit-missing",
        subject: one.id,
        machine,
        says: `${one.id} is on the registry's list and the service manager is not ${one.state === "running" ? "running" : "carrying"} it`,
        fix: startCommand(os.flavour, one.id),
      });
    }
    for (const unit of difference.extra) {
      findings.push({
        id: findingId(machine, "unit-extra", unit.name),
        kind: "unit-extra",
        subject: unit.name,
        machine,
        says: `${unit.name} is loaded and no registry entry implies it, so nothing on the list asked for it`,
        // TEXT, and nothing here or anywhere else runs it (L13).
        fix: stopCommand(os.flavour, unit.name),
      });
    }

    // D-103. The counter is the one reading that means the same thing on both
    // flavours: at the moment the finding fires launchd is still bouncing the
    // job while systemd has parked it in `failed`, so a rule that read the
    // running flag would answer opposite on the two for the same illness.
    // The unit's own name travels with the count, because the fix is a command
    // a human pastes about THAT unit and only the manager's listing knows what
    // it is called. A timer never carries the count that matters, so a service
    // is preferred whenever both are listed for one entry.
    const worst = new Map<string, { restarts: number; unit: string }>();
    for (const unit of found) {
      const id = entryIdOf(unit.name);
      if (id === null || !isOurs(unit.name)) continue;
      if (!entries.some((entry) => entry.id === id)) continue;
      const restarts = Number(unit.restarts ?? 0);
      if (!Number.isFinite(restarts)) continue;
      const already = worst.get(id);
      const timer = unit.name.endsWith(".timer");
      if (already === undefined) {
        worst.set(id, { restarts, unit: unit.name });
        continue;
      }
      const preferName = timer && !already.unit.endsWith(".timer") ? already.unit : unit.name;
      worst.set(id, {
        restarts: Math.max(already.restarts, restarts),
        unit: restarts >= already.restarts ? preferName : already.unit,
      });
    }
    for (const [id, seen] of worst) {
      if (seen.restarts < CRASH_LOOP_RESTARTS) continue;
      findings.push({
        id: findingId(machine, "crash-loop", id),
        kind: "crash-loop",
        subject: id,
        machine,
        says: `${id} has been started again ${seen.restarts} times, so it is dying in a loop rather than running`,
        // The state a parked unit is really in is what has to be cleared, and
        // the command that clears it belongs to the seam that knows the
        // flavour (03b items 3 and 7).
        fix: resetCommand(os.flavour, seen.unit),
      });
    }
  }

  // --- every scheduled job's own success stamp (criterion 2) ---------------
  findings.push(
    ...staleJobs({
      entries,
      stamps: await readJobStamps(options.store),
      graceSeconds: setting(registry, "hub.job_grace_seconds", 300),
      now,
    }),
  );

  // --- every resident piece has a measured peak (criterion 6) --------------
  const peaks = new Set((await readPeaks(options.store)).map((row) => row.id));
  for (const id of residentIds(registry, machine)) {
    if (peaks.has(id)) continue;
    findings.push({
      id: findingId(machine, "peak-missing", id),
      kind: "peak-missing",
      subject: id,
      machine,
      says: `${id} runs all day and nothing has ever measured what it holds`,
      fix: `let the hub run a tick with ${id} up, or measure it once with /usr/bin/time -l`,
    });
  }

  // --- an agent that cannot be boxed, because the tree is the boundary -----
  //     (03b item 1, D-92, D-93). A finding and never a refusal: whether a
  //     person has a tree is a question about a machine and not about the file,
  //     so the registry loads and the agent runs, unfenced, loudly.
  const ownRunners = new Set(
    entries.filter((entry) => entry.kind === "runner").map((entry) => entry.id),
  );
  for (const agent of listAgents(registry)) {
    if (!ownRunners.has(agent.runner)) continue;
    const person = personOf(registry, agent.id);
    // No `[[people]]` table at all is the shape a household starts with and is
    // not a finding, which is the same tolerance the loader gives the field.
    if (person === null || person.tree !== "") continue;
    findings.push({
      id: findingId(machine, "agent-unboxed", agent.id),
      kind: "agent-unboxed",
      subject: agent.id,
      machine,
      says: `${agent.id} runs unboxed, because the person ${agent.person} declares no tree and the tree is what the box fences`,
      fix: `give ${agent.person} a tree in ${options.registryFile}, as tree = "/var/lib/imprnt-hub/${agent.person}" under that [[people]] entry`,
    });
  }

  // --- every runner reached the ONE store (03b item 4, D5) ----------------
  const reached = await connectedRunners(options.store);
  for (const one of reached.said) {
    if (one.identifier === "" || one.identifier === reached.here) continue;
    findings.push({
      id: findingId(machine, "store-split", one.runner),
      kind: "store-split",
      subject: one.runner,
      machine,
      says: `${one.runner} last connected to the server ${one.identifier}, and the store being read here is ${reached.here}, so the household's rows are in two places`,
      fix: `point every runner's hub.store_url at the one store, then restart ${one.runner}`,
    });
  }

  // --- what the kernel could add (criterion 8) ----------------------------
  findings.push(...kernelFindings(options.kernel ?? null, machine));

  // --- a runner that is off the store with no recent work (criterion 10) ---
  const runners = entries.filter((entry) => entry.kind === "runner").map((entry) => entry.id);
  if (runners.length > 0) {
    const work = await newestWork(options.store);
    const agents = listAgents(registry);
    const lastEventAt: Record<string, string | null> = {};
    for (const runner of runners) {
      let newest: string | null = null;
      for (const agent of agents.filter((one) => one.runner === runner)) {
        const at = work.get(agent.id) ?? null;
        if (at !== null && (newest === null || at > newest)) newest = at;
      }
      lastEventAt[runner] = newest;
    }
    findings.push(
      ...silentRunners({
        runners,
        liveApplications: await liveApplications(options.store),
        lastEventAt,
        hours: setting(registry, "hub.silent_runner_hours", 6),
        now,
        machine,
      }),
    );
  }

  // --- the sheet: one row per finding id, and a fixed one leaves NO line ---
  const standing = new Set(findings.map((finding) => finding.id));
  for (const finding of findings) {
    await putRow(options.store, CHECK_SHEET, finding.id, { ...finding });
  }
  for (const row of await readSheet(options.store, CHECK_SHEET)) {
    // Only this machine's own rows: the other machine's run is what clears its.
    if (!row.id.startsWith(`${machine}/`)) continue;
    if (standing.has(row.id)) continue;
    await removeRow(options.store, CHECK_SHEET, row.id);
  }

  return findings;
}
