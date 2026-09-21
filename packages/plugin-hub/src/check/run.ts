import { checkLoopSource } from "../adapters/index.ts";
import type { LoopProbeOptions, LoopProbeTimeout } from "../adapters/launch.ts";
import { acceptRepair, finding as findingLine, syncRepair, unitNotStopped } from "../door/lines.ts";
import { basename, dirname } from "node:path";
import {
  diffUnits,
  removeFileCommand,
  resetCommand,
  seenUnits,
  startCommand,
  stillUp,
  stopCommand,
  wantedUnits,
} from "../os/diff.ts";
import { entryIdOf, isOurs } from "../os/names.ts";
import type { OsSeam } from "../os/types.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import {
  credentialFor,
  harvestFor,
  listAgents,
  listCredentials,
  listMachines,
  listPeople,
  listRunEntries,
  personOf,
  runEntriesFor,
  thresholdsFor,
  transcribedSecondsFor,
  transcriberFor,
  voiceFor,
} from "../registry/entries.ts";
import { credentialOfPreset } from "../registry/presets.ts";
import { loadRegistry, readSetting, type CredentialEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { overLimit, readPeaks, residentIds } from "../hub/peak.ts";
import {
  copyFindings,
  credentialFindings,
  doorCredential,
  realProber,
  type CredentialProber,
} from "./credentials.ts";
import { findingId, type Finding } from "./finding.ts";
import { harvestFindings, readHarvestState } from "./harvest.ts";
import { allowlistFindings, deniedSenderFindings, readDeniedSenders } from "./senders.ts";
import { readStampRows, stampFindings } from "./stamps.ts";
import { readVoiceState, transcribingFindings, voiceFindings } from "./voice.ts";
import { kernelFindings, type KernelView } from "./kernel.ts";
import { readJobStamps, staleJobs } from "./schedule.ts";
import { silentRunners } from "./silence.ts";

export type { Finding } from "./finding.ts";
export { findingId } from "./finding.ts";

/**
 * `check` compares what runs with what the registry lists, and REPORTS the
 * difference rather than acting on it.
 *
 * The findings are a state sheet: one row per finding id, edited in place, and a
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

/** Two restarts, read from the counter and never from the running flag. */
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
 * run is reading.
 *
 * The identifier is `initdb`'s own, generated per cluster, so a line carrying
 * one that is not this store's was written against some other cluster and the
 * household's rows are not all in one place. The NEWEST line per runner is what
 * counts, so a runner that was pointed somewhere else and then corrected clears
 * its own finding by reconnecting.
 */
async function connectedRunners(store: StoreLike): Promise<{
  here: string;
  said: { runner: string; identifier: string; silence: string }[];
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
    said: rows.map((row) => {
      const identifier = String(fieldOf(row.detail, "system_identifier"));
      // WHY this line names no server, when it names none. A runner that could
      // not read the identifier writes the reason into its own line, and a
      // detail in an encoding this cannot read carries no reason to find, so
      // the second case says that instead of saying nothing.
      const said = fieldOf(row.detail, "identifier_error");
      const silence =
        identifier !== ""
          ? ""
          : said !== ""
            ? said
            : "its connect line carries no readable system_identifier";
      return { runner: String(row.subject), identifier, silence };
    }),
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
 * survives the masking, which is what makes silence derivable at all.
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
  /**
   * How a credential is opened, in the style of `os` and `kernel`. The
   * default is the real reader, so a household that hands nothing still has
   * every credential OPENED rather than merely listed: "presence is not
   * health" is the whole of L10 rule 2.
   */
  credentials?: CredentialProber;
  /**
   * Which `claude` the capability probe asks and how long one call may take,
   * in the same style. The defaults are the installed CLI and the production
   * wait. A check shortens the wait so a hanging CLI costs seconds, not tens.
   */
  loopProbe?: LoopProbeOptions;
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
    const wanted = wantedUnits(entries);
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
    // The mirror of `unit-missing`, beside it so a reader sees the pair: the
    // registry says this piece is stopped and the manager is still carrying it,
    // as a running service or as a timer still armed to start one.
    //
    // THE FIX NAMES EVERY UNIT THAT IS STILL UP, the timer first, which is the
    // order the hub's own stop uses. Stopping the service of a scheduled entry
    // and leaving its timer armed is a command that does not fix what it was
    // handed. The command is TEXT and nothing here or anywhere else runs it
    // (L13).
    for (const one of wanted) {
      if (one.state !== "stopped") continue;
      const still = found
        .filter((unit) => entryIdOf(unit.name) === one.id && stillUp(unit))
        .map((unit) => unit.name)
        .sort((a, b) => Number(b.endsWith(".timer")) - Number(a.endsWith(".timer")));
      if (still.length === 0) continue;
      findings.push({
        id: findingId(machine, "unit-not-stopped", one.id),
        kind: "unit-not-stopped",
        subject: one.id,
        machine,
        says: unitNotStopped("en", { id: one.id }),
        fix: stopCommand(os.flavour, still.join(" ")),
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

    // A unit FILE under the hub's own prefix that no registry entry
    // declares. `remove` disables, then deletes the files, then stops, so a hub
    // that dies between the disable and the delete leaves a file that is
    // enabled nowhere and that the manager may no longer list, and `seenUnits`
    // above asks the manager only about entries the registry still carries. So
    // this half reads the unit directory, through the seam, which is the one
    // place that knows where it is. Declared means declared ANYWHERE in the
    // file, which is the fence the hub's own reconcile draws around another
    // machine's entries, so two hubs sharing one box never report each other.
    const declaredIds = new Set(listRunEntries(registry).map((entry) => entry.id));
    for (const path of (await os.unitFiles?.()) ?? []) {
      const name = basename(path);
      const id = entryIdOf(name);
      if (id === null || declaredIds.has(id)) continue;
      findings.push({
        id: findingId(machine, "unit-file-orphaned", name),
        kind: "unit-file-orphaned",
        subject: name,
        machine,
        says: `${path} is a hub unit file and no registry entry declares ${id}, so it was left behind and nothing on the list asked for it`,
        // TEXT, and nothing here or anywhere else runs it (L13).
        fix: removeFileCommand(os.flavour, path),
      });
    }

    // The counter is the one reading that means the same thing on both
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
    // The unit rows by name, so a finding can quote the state the manager
    // reported for the very unit it names.
    const byName = new Map(found.map((unit) => [unit.name, unit]));
    for (const [id, seen] of worst) {
      if (seen.restarts < CRASH_LOOP_RESTARTS) continue;
      // WHAT THE MANAGER SAYS IT IS, beside the count. A
      // count alone reads the same for a unit the manager is still patiently
      // restarting and for one it has given up on and parked, and those two
      // need different things done to them: the second does not come back from
      // `start` at all until its failure is reset, which is why the fix below
      // is `reset-failed` and why the sentence has to say that is the state it
      // is in. The word is the manager's own, unedited, and the sentence says
      // which manager said it, because systemd and launchd do not share a
      // vocabulary. The RESULT rides along when there is one worth reading,
      // which is where the limiter's own evidence lands when it lands
      // (`start-limit-hit`); on this systemd it usually does not, because the
      // manager keeps a unit's FIRST failure result and the limiter's later
      // refusal does not overwrite it.
      const said = byName.get(seen.unit) ?? null;
      const state =
        said?.state == null
          ? `and ${os.flavour} does not say what state it is in`
          : `and ${os.flavour} has it ${said.state}`;
      const result =
        said?.result == null || said.result === "success"
          ? ""
          : `, with ${said.result} as its last result`;
      findings.push({
        id: findingId(machine, "crash-loop", id),
        kind: "crash-loop",
        subject: id,
        machine,
        says: `${id} has been started again ${seen.restarts} times, so it is dying in a loop rather than running, ${state}${result}`,
        // The state a parked unit is really in is what has to be cleared, and
        // the command that clears it belongs to the seam that knows the
        // flavour.
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
  const peakRows = await readPeaks(options.store);
  const resident = residentIds(registry, machine);
  const peaks = new Set(peakRows.map((row) => row.id));
  for (const id of resident) {
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

  // --- a resident holding more than the registry asked for -----------------
  //
  //     For every resident on this machine, the doors and the hub included and
  //     not the transcriber alone: the hub already samples each resident pid on
  //     its tick and writes the reading down, so the comparison costs nothing
  //     and the answer is the same question for all of them.
  //
  //     THE FIX NAMES THE TWO KERNEL FINDINGS beside the entry. A unit's own
  //     `MemoryMax` is inert on a box whose firmware leaves the memory cgroup
  //     off, and launchd has no equivalent at all, so pointing a household at
  //     the unit alone would point it at a lever that does not move.
  for (const one of overLimit({ rows: peakRows, entries, resident })) {
    findings.push({
      id: findingId(machine, "memory-over-limit", one.id),
      kind: "memory-over-limit",
      subject: one.id,
      machine,
      says:
        `${one.id} was last measured holding ${Math.round(one.reading_bytes / (1024 * 1024))} MB ` +
        `and the registry asks for ${one.limit_mb} MB`,
      fix:
        `raise memory_limit_mb for ${one.id} in ${options.registryFile} or make it hold less, and ` +
        `note that the limit only binds where kernel-memory-cgroup and kernel-earlyoom are clear`,
    });
  }

  // --- an agent that cannot be boxed, because the tree is the boundary -----
  //     A finding and never a refusal: whether a
  //     person has a tree is a question about a machine and not about the file,
  //     so the registry loads. The launch takes the box as an input
  //     and refuses one with no tree before any child exists, for a turn and
  //     for a harvest alike, and the runner retries that refusal for ever. So
  //     the agent never starts and never answers, and the sentence says that
  //     rather than naming a fence with nothing inside it.
  const ownRunners = new Set(
    entries.filter((entry) => entry.kind === "runner").map((entry) => entry.id),
  );
  for (const agent of listAgents(registry)) {
    if (!ownRunners.has(agent.runner)) continue;
    const person = personOf(registry, agent.id);
    // A DECLARED PERSON WITH NO TREE AND NO PERSON AT ALL ARE THE SAME
    // FINDING. The narrow reading, where a file carrying no `[[people]]` table
    // is silent, rests on the argument that half the fixtures would otherwise
    // carry a row. That is an argument about the fixtures. What `check` is being asked
    // is whether this machine's agents can run inside a box, and the answer for
    // an agent whose person the file never mentions is no, exactly as loudly as
    // for one whose entry omits the field: the box context carries an empty
    // tree either way and the launch refuses it. The two differ only in the
    // line a household has to add, so the finding says which.
    if (person !== null && person.tree !== "") continue;
    const declared = person !== null;
    findings.push({
      id: findingId(machine, "agent-unboxed", agent.id),
      kind: "agent-unboxed",
      subject: agent.id,
      machine,
      says: declared
        ? `${agent.id} cannot start and will not answer anyone, because the person ${agent.person} declares no tree and an agent is only launched inside the box that tree fences`
        : `${agent.id} cannot start and will not answer anyone, because ${options.registryFile} carries no [[people]] entry for ${agent.person} at all, and an agent is only launched inside the box that entry's tree fences`,
      fix: declared
        ? `give ${agent.person} a tree in ${options.registryFile}, as tree = "/var/lib/imprnt-hub/${agent.person}" under that [[people]] entry`
        : `add a [[people]] entry for ${agent.person} to ${options.registryFile}, carrying tree = "/var/lib/imprnt-hub/${agent.person}"`,
    });
  }

  // --- every runner reached the ONE store (D5) ----------------------------
  //
  // A RUNNER THAT NAMED NO SERVER IS A FINDING TOO, and it is the same one. An
  // empty identifier is never skipped in silence: that would make a runner
  // that could not read the server's identity indistinguishable from one that
  // read it and found it right, and `store-split` could never fire for that
  // runner however wrong its store was. The finding kind is not split in two,
  // because the question a household is asking is the same in both cases and
  // the answer to it is the same line in the file. What changes is the reason
  // the finding gives.
  const reached = await connectedRunners(options.store);
  for (const one of reached.said) {
    if (one.identifier !== "" && one.identifier === reached.here) continue;
    findings.push({
      id: findingId(machine, "store-split", one.runner),
      kind: "store-split",
      subject: one.runner,
      machine,
      says:
        one.identifier === ""
          ? `${one.runner} last connected without saying which server it reached (${one.silence}), and the store being read here is ${reached.here}, so nothing here can say whether the household's rows are all in one place`
          : `${one.runner} last connected to the server ${one.identifier}, and the store being read here is ${reached.here}, so the household's rows are in two places`,
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

  // --- every human row past its person's own threshold (criterion 1) ------
  //
  // THE MACHINE IS THE AGENT'S RUNNER'S, so two machines running `check` do not
  // both report one row. The set is the one `agent-unboxed` already computed.
  const mine = listAgents(registry).filter((agent) => ownRunners.has(agent.runner));
  if (mine.length > 0) {
    findings.push(
      ...stampFindings({
        rows: await readStampRows(options.store, { agents: mine.map((agent) => agent.id) }),
        thresholds: (person) => thresholdsFor(registry, person),
        runnerOf: (agent) => mine.find((one) => one.id === agent)?.runner ?? "",
        machine,
        now,
      }),
    );
  }

  // --- the recognizer, and the rows waiting on it (criterion 1) ------------
  //
  //     A HOUSEHOLD THAT NAMES NO RECOGNIZER HEARS NOTHING HERE. Every setting
  //     under the voice table is read only when one is named, and so is this:
  //     `voiceFor` answers null and both functions return nothing, so a
  //     household that did not install the component has no voice finding to
  //     read and no voice sentence to wonder about.
  //
  //     The rows go with the `mine` set like the stamps above, so two machines
  //     running `check` never both report one row.
  const voice = voiceFor(registry);
  if (voice !== null) {
    const state = await readVoiceState(options.store, { agents: mine.map((agent) => agent.id) });
    const dialled = voice.credential === null ? null : credentialFor(registry, voice.credential);
    findings.push(
      ...voiceFindings({
        state,
        recognizer: { name: voice.recognizer, provider: voice.provider },
        transcriberEntry: transcriberFor(registry, machine)?.id ?? null,
        credentialFile: dialled?.file ?? null,
        machine,
        now,
      }),
      ...transcribingFindings({
        state,
        patience: (person) => transcribedSecondsFor(registry, person),
        graceSeconds: setting(registry, "hub.job_grace_seconds", 300),
        doorOf: (agent) => mine.find((one) => one.id === agent)?.door ?? "",
        recognizer: voice.recognizer,
        machine,
        now,
      }),
    );
  }

  // --- every chat whose slice has outlived a quiet period plus a day, and ---
  // every person who has chosen no harvester at all (criterion 1).
  //
  //     THE MACHINE IS THE AGENT'S RUNNER'S, which is the `mine` set above, so
  //     two machines running `check` do not both report one chat or one person.
  //     A spoke whose `hub.state_dir` is not on it sees no logs and reports no
  //     stale chat, which is honest rather than silent, and the undeclared
  //     finding is a question about the FILE and fires wherever that person's
  //     agent runs.
  if (mine.length > 0) {
    const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
    findings.push(
      ...harvestFindings({
        chats:
          stateDir === ""
            ? []
            : await readHarvestState(options.store, { stateDir, agents: mine, now, registry }),
        settings: (person) => harvestFor(registry, person),
        people: [...new Set(mine.map((agent) => agent.person))],
        machine,
        registryFile: options.registryFile,
        now,
      }),
    );
  }

  // --- check OPENS every credential and asks whether it still works --------
  //     (L10 rule 2). The incident behind it: a login
  //     died, thirteen turns failed over 31 hours, and `check` was green
  //     throughout because it never opened the file.
  const prober = options.credentials ?? realProber();
  const declared = listCredentials(registry);
  const doors: CredentialEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "door") continue;
    const said = (registry.data.run as Record<string, unknown>[] | undefined)?.find(
      (one) => (one as { id?: unknown }).id === entry.id,
    ) as { platform?: string; person?: string; token_file?: string } | undefined;
    if (!said?.platform || !said.token_file) continue;
    const credential = doorCredential({
      id: entry.id,
      platform: said.platform,
      person: said.person,
      token_file: said.token_file,
    });
    if (credential) doors.push(credential);
  }
  const opened = [...declared, ...doors];
  findings.push(
    ...(await credentialFindings({ entries: opened, prober, machine })),
  );

  // --- a copy anywhere inside the roots the registry names (criterion 2) ---
  findings.push(
    ...(await copyFindings({
      entries: declared,
      prober,
      roots: [
        ...listPeople(registry).map((person) => person.tree),
        String(readSetting(registry, "hub.shared_zone") ?? ""),
        String(readSetting(registry, "hub.state_dir") ?? ""),
        ...opened.map((entry) => dirname(entry.file)),
      ],
      machine,
    })),
  );

  // --- a plan preset that names no credential is REPORTED, never refused ---
  //     A household that has not written the table yet still runs and
  //     is told, loudly, because nothing can open what the file does not name.
  const usedHere = new Set(mine.map((agent) => agent.preset));
  for (const [name, preset] of Object.entries(registry.presets)) {
    if (!usedHere.has(name)) continue;
    if (preset.paid !== "plan") continue;
    if (credentialOfPreset(registry, name) !== null) continue;
    findings.push({
      id: findingId(machine, "credential-undeclared", name),
      kind: "credential-undeclared",
      subject: name,
      machine,
      says: `the preset ${name} runs on a plan and names no credential, so nothing can open the login it runs on: what the file does not name cannot be checked`,
      fix: `add credential = "<an id>" to [presets.${name}] in ${options.registryFile}, and a [[credentials]] entry carrying that id, its kind, its file and its owner`,
    });
  }

  // --- a credential the box can only mask one file at a time on Linux --------
  //     On Linux a single-file mask is a bind over one directory entry, and the
  //     kernel lifts it if the host replaces the file by renaming a new one over
  //     it. Where a masked credential has a directory to itself, the box masks
  //     the whole directory, which a rename cannot lift. A credential that shares
  //     a directory with the launched login cannot be masked that way, so an
  //     agent steered by outside content could read it after a re-login. This
  //     fires for nothing when there is one shared login and tokens live in the
  //     secrets directory.
  if (listMachines(registry).find((one) => one.id === machine)?.os === "linux") {
    const loginByDir = new Map<string, string>();
    for (const preset of new Set(mine.map((agent) => agent.preset))) {
      const id = credentialOfPreset(registry, preset);
      const login = id ? listCredentials(registry).find((one) => one.id === id) : undefined;
      if (login) loginByDir.set(dirname(login.file), login.file);
    }
    const files = new Set([
      ...listCredentials(registry).map((one) => one.file),
      ...listRunEntries(registry).map((one) => (typeof one.token_file === "string" ? one.token_file : "")),
    ]);
    for (const file of files) {
      if (file === "" || loginByDir.get(dirname(file)) === file) continue;
      if (!loginByDir.has(dirname(file))) continue;
      findings.push({
        id: findingId(machine, "credential-file-mask", file),
        kind: "credential-file-mask",
        subject: file,
        machine,
        says: `${file} shares a directory with a launched model login on this Linux machine, so the box can only mask it one file at a time, and that mask is lifted if the file is replaced by a rename`,
        fix: `move ${file} into the secrets directory, or give it a directory of its own, so the box masks the whole directory`,
      });
    }
  }

  if (!options.credentials) {
    const presets = new Set(mine.map(agent => agent.preset));
    for (const agent of mine) {
      const harvest = harvestFor(registry, agent.person);
      if (harvest) presets.add(harvest.harvester);
    }
    for (const preset of presets) {
      try { await checkLoopSource(registry, preset, options.loopProbe); }
      catch (error) {
        // A CLI that did not answer is a timeout, and the operator is
        // told so. "Unsupported" would send them after a login source that is
        // sound, when what needs looking at is a CLI that hangs.
        if ((error as Error)?.name === "LoopProbeTimeout") {
          const { call, timeoutMs } = error as LoopProbeTimeout;
          const kind = "loop-probe-timeout";
          findings.push({ id: findingId(machine, kind, preset), kind, subject: preset, machine,
            says: findingLine("en", { code: kind, target: preset, cause: `claude ${call} timed out after ${timeoutMs / 1000} s, twice` }),
            fix: `run claude ${call} by hand to see whether it answers, then imprnt hub check ${options.registryFile}`,
          });
          continue;
        }
        const kind = "credential-source-unsupported";
        findings.push({ id: findingId(machine, kind, preset), kind, subject: preset, machine,
          says: findingLine("en", { code: kind, target: preset, cause: "invalid configuration" }),
          fix: findingLine("en", { code: "credential-source", target: preset, cause: "invalid configuration" }),
        });
      }
    }
  }

  // --- the sheet: one row per finding id, and a fixed one leaves NO line ---
  for (const row of await readSheet(options.store, "sync")) {
    if (!entries.some(entry => entry.id === row.id && entry.kind === "sync")) continue;
    for (const repo of (row.data.repositories ?? []) as { id: string; status: string; cause?: string }[]) {
      if (repo.status !== "failed") continue;
      const target = `${row.id}/${repo.id}`;
      findings.push({ id: findingId(machine, "sync-failed", target), kind: "sync-failed", subject: target, machine,
        says: findingLine("en", { code: "sync-failed", target, cause: repo.cause }),
        fix: syncRepair("en", { target }) });
    }
  }
  for (const row of await readSheet(options.store, "agent_health")) {
    if (row.data.status !== "retry" || !listAgents(registry).some(agent => agent.id === row.id &&
      runEntriesFor(registry, machine).some(entry => entry.id === agent.runner))) continue;
    findings.push({ id: findingId(machine, "agent-retry", row.id), kind: "agent-retry", subject: row.id, machine,
      fix: `imprnt hub recover <registry> agent:${row.id}`, says: findingLine("en", { code: "agent-retry", target: row.id, cause: String(row.data.cause ?? "task failed") }) });
  }
  for (const row of await readSheet(options.store, "door_health")) {
    if (!row.data.cause || !entries.some(entry => entry.id === row.data.door)) continue;
    const target = `${row.data.door}/${row.data.chat}`;
    // A chat the door could not READ is a platform failure and a restart is the
    // move. A batch it fetched and could not ACCEPT is a refusal on this side,
    // the store or the chat log file, and the door replays that same batch every
    // tick, so telling the operator to restart the door sends them nowhere. The
    // two are separate findings with separate advice.
    //
    // The row's `cause` for an acceptance failure is the fixed wording the
    // person is told in their other chat, so the finding takes the row's
    // `detail`, which is what was really thrown.
    const accepting = row.data.code === "accept-failed";
    const kind = accepting ? "accept-failed" : "chat-unreadable";
    findings.push({ id: findingId(machine, kind, target), kind, subject: target, machine,
      says: findingLine("en", { code: row.data.code, target, cause: accepting ? (row.data.detail ?? row.data.cause) : row.data.cause }),
      fix: accepting ? acceptRepair("en", { target }) : `imprnt hub recover <registry> door:${row.data.door}` });
  }
  // --- a refused sender, and an agent that refuses everyone --
  //     A refused message never becomes an inbound row, so no stamp finding
  //     can see it. The door records each refused sender on the sheet this
  //     reads, and the allowlist itself is read off the file. The refusal is
  //     this machine's when its door is, and the allowlist is a question about
  //     an agent, so it goes with the `mine` set like the others.
  findings.push(
    ...deniedSenderFindings({
      denied: await readDeniedSenders(options.store),
      registry,
      doors: new Set(entries.filter((entry) => entry.kind === "door").map((entry) => entry.id)),
      machine,
      registryFile: options.registryFile,
      now,
    }),
    ...allowlistFindings({ agents: mine, registry, machine, registryFile: options.registryFile }),
  );
  const failedDeliveries = await options.store.sql`select o.id, o.route, o.failure, coalesce(o.agent, i.agent) as agent
    from outbox o left join inbound i on i.id = o.inbound_id where o.delivery_state = 'failed'`;
  for (const row of failedDeliveries) {
    const door = row.route?.door ?? listAgents(registry).find(agent => agent.id === row.agent)?.door;
    if (!entries.some(entry => entry.id === door)) continue;
    const target = `${door}/${row.route?.chat ?? row.agent}`;
    findings.push({ id: findingId(machine, "delivery-failed", String(row.id)), kind: "delivery-failed", subject: target, machine,
      says: findingLine("en", { code: row.failure?.code ?? "delivery-failed", target, cause: row.failure?.cause ?? "operation failed" }),
      fix: `imprnt hub recover <registry> door:${door}` });
  }
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
