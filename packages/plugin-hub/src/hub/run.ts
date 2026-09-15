import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEntry } from "../records/diary.ts";
import { diffUnits, seenUnits, wantedState } from "../os/diff.ts";
import { entryIdOf, unitName } from "../os/names.ts";
import { thisOs } from "../os/index.ts";
import type { OsSeam, RenderContext, WantedUnit } from "../os/types.ts";
import { listMachines, runEntriesFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type RunEntry } from "../registry/load.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { POSTGRES_PEAK_ID, recordPeak, residentIds } from "./peak.ts";
import { readRequests, refuseRestart, type RestartRequest } from "./restart.ts";

/**
 * The hub: one process per machine, ours, unsandboxed, and the only thing that
 * talks to the operating system (D7).
 *
 * On its tick it reads the registry file, renders the entries for ITS machine,
 * compares them with what the manager has, and installs, starts, stops or
 * removes. It acts on the restart requests in the ledger and refuses the two
 * shapes RUN-10 forbids. It records a measured peak for every resident piece.
 *
 * WHAT IT MAY TOUCH IS THE FENCE (D-78). A unit under the RENDER prefix with no
 * entry for this machine is one the hub itself generated and the registry no
 * longer wants, so the hub stops and removes it. A unit under the SCAN prefix
 * that is not under the render prefix was never the hub's to write: it is
 * `check`'s to report, with the stop command as text, and nothing here touches
 * it or even writes a line about it.
 *
 * A TICK THAT CHANGED NOTHING WRITES NOTHING. The rendered text is compared with
 * what is on disk, so a hub that reinstalled every tick would churn the manager
 * and make every later assertion about a pid meaningless.
 */
export interface HubHandle {
  machine: string;
  stop(): Promise<void>;
}

export class HubRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubRefused";
  }
}

const KINDS: Record<string, string> = { door: "door", runner: "runner" };

function setting(registry: unknown, key: string, fallback: number): number {
  const found = readSetting(registry, key);
  return found === undefined || found === null ? fallback : Number(found);
}

/** The pid of the process that fathered this backend, when it is on this box. */
async function postmasterPid(store: Store): Promise<number | null> {
  try {
    const [row] = (await store.sql`select pg_backend_pid() as pid`) as { pid: number }[];
    const backend = Number(row?.pid ?? 0);
    if (!backend) return null;
    let parent = 0;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${backend}/stat`, "utf8");
      parent = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1] ?? 0);
    } else {
      const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(backend)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      parent = Number((out.stdout?.toString() ?? "").trim());
    }
    if (!parent || parent <= 1) return null;
    // The backend's parent is the postmaster, and this only holds when the store
    // is on the same box. A spoke reading a store over the tailnet gets a pid
    // that is not a process here, so the name is checked before it is believed.
    const named = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(parent)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const comm = (named.stdout?.toString() ?? "").trim().toLowerCase();
    return comm.includes("postgres") ? parent : null;
  } catch {
    return null;
  }
}

export async function runHub(options: {
  machine: string;
  registryFile: string;
  os?: OsSeam;
}): Promise<HubHandle> {
  const first = loadRegistry(options.registryFile);
  // D-77. A hub that acted for a machine whose declared os is not the one it is
  // running on would write systemd unit files onto a Mac, so it refuses loudly
  // instead, which catches a mis-set machine id at the first tick rather than
  // in the unit directory.
  const declared = listMachines(first).find((one) => one.id === options.machine);
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  if (declared && declared.os !== platform) {
    throw new HubRefused(
      `${options.registryFile} says ${options.machine} runs ${declared.os}, and this process is on ${platform}`,
    );
  }

  const os = options.os ?? thisOs();
  const application = `hub-${options.machine}`;
  const store: Store = await openStore({
    url: storeUrlAs(String(readSetting(first, "hub.store_url")), "hub_hub", application),
  });

  // SPEC section 6 and D7: ONE hub process per machine. Two of them reconciling
  // the same machine fight over every unit on it, and BUILD-NOTES B.2 already
  // records what one stray hub does to a box. The register of who is running is
  // the store's own client list, because the hub names itself at connect the
  // same way the runner does, so there is no lock file and nothing to clean up
  // after a crash: a dead hub's backend is gone from `pg_stat_activity` by the
  // time anybody asks. This happens BEFORE the first tick, so a hub that
  // refuses has touched no unit on its way out.
  const [{ others }] = (await store.sql.unsafe(
    `select count(*)::int as others
       from pg_stat_activity
      where datname = current_database()
        and application_name = $1
        and pid <> pg_backend_pid()`,
    [application],
  )) as { others: number }[];
  if (Number(others) > 0) {
    await appendEntry(store, {
      stream: "refusal",
      subject: options.machine,
      kind: "refused.second_hub",
      actor: "hub",
      detail: {
        machine: options.machine,
        application_name: application,
        reason: "another hub for this machine is already connected to this store",
      },
    });
    await store.close().catch(() => {});
    throw new HubRefused(
      `a hub for ${options.machine} is already connected to this store, and a machine has one hub`,
    );
  }

  // The watermark starts at what the ledger already holds, so a hub that is
  // started again does not act on every request the household ever made.
  let watermark = 0;
  try {
    const [row] = (await store.sql`select coalesce(max(seq), 0) as seq from ledger_event`) as {
      seq: string;
    }[];
    watermark = Number(row?.seq ?? 0);
  } catch {
    watermark = 0;
  }

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const say = async (kind: string, subject: string, detail: Record<string, unknown>) => {
    await appendEntry(store, { stream: "machine", subject, kind, actor: "hub", detail });
  };

  const scriptFor = (entry: RunEntry): string =>
    join(import.meta.dir, "..", "entry", `${KINDS[entry.kind] ?? "hub"}.ts`);

  const contextFor = (registry: unknown, entry: RunEntry): RenderContext => ({
    machine: options.machine,
    execPath: process.execPath,
    entryScript: scriptFor(entry),
    registryFile: options.registryFile,
    restartDelaySeconds: setting(registry, "hub.restart_delay_seconds", 1),
    giveUpAfter: setting(registry, "hub.give_up_after", 5),
    giveUpWindowSeconds: setting(registry, "hub.give_up_window_seconds", 300),
  });

  const act = async (): Promise<void> => {
    let registry: unknown;
    try {
      registry = loadRegistry(options.registryFile);
    } catch {
      // A file half written by an editor is a file this tick cannot read. The
      // next tick reads the finished one, and nothing is installed from half a
      // file.
      return;
    }
    const entries = runEntriesFor(registry, options.machine);
    // The explicit asks come first, before the reconcile's own work, so a
    // request lands within one tick of being written rather than behind
    // whatever the registry happened to change in the same pass.
    await acknowledge(registry, entries);
    const started = new Set<string>();

    for (const entry of entries) {
      const files = os.render(entry, contextFor(registry, entry));
      const changed = files.some(
        (file) => !existsSync(file.path) || readFileSync(file.path, "utf8") !== file.text,
      );
      if (!changed) continue;
      const written = await os.install(files);
      await say("unit.installed", entry.id, { entry: entry.id, machine: options.machine, files: written });
      if (wantedState(entry) === "running") {
        await os.start(entry.id);
        started.add(entry.id);
        await say("unit.started", entry.id, { entry: entry.id, machine: options.machine });
      }
    }

    const wanted: WantedUnit[] = entries.map((entry) => ({
      id: entry.id,
      name: unitName(entry.id),
      state: wantedState(entry),
      entry,
    }));
    const difference = diffUnits({ wanted, found: await seenUnits(os, entries) });

    for (const one of difference.missing) {
      if (one.state !== "running" || started.has(one.id)) continue;
      await os.start(one.id);
      await say("unit.started", one.id, { entry: one.id, machine: options.machine });
    }

    for (const unit of difference.stale) {
      const id = entryIdOf(unit.name);
      if (id === null) continue;
      await os.stop(id);
      await say("unit.stopped", id, { entry: id, machine: options.machine, unit: unit.name });
      await os.remove(id);
      await say("unit.removed", id, { entry: id, machine: options.machine, unit: unit.name });
    }

    await measure(registry, entries);
  };

  /** The restart requests, each acted on or refused exactly once. */
  const acknowledge = async (registry: unknown, entries: RunEntry[]): Promise<void> => {
    let requests: RestartRequest[];
    try {
      requests = await readRequests(store, { after: watermark });
    } catch {
      return;
    }
    for (const request of requests) {
      watermark = Math.max(watermark, request.seq);
      const entry = entries.find((one) => one.id === request.target);
      if (request.askedBy !== "" && request.askedBy === request.target) {
        await refuseRestart(store, {
          request,
          reason: "a piece can never ask for its own restart, because the asker is what would go away",
        });
        continue;
      }
      if (entry && entry.kind === "hub") {
        await refuseRestart(store, {
          request,
          reason: "the hub is what acts on a restart, so it is never what a restart acts on",
        });
        continue;
      }
      // A target this machine does not run belongs to the other machine's hub.
      if (!entry) continue;
      // The line goes down BEFORE the manager is asked, because the line is
      // what the hub decided and not a report that the process came back. On
      // launchd `kickstart -k` returns while the old process is still dying, so
      // the diary already could not promise a live pid; on systemd `restart`
      // returns only once the new one is up, and a line written after it would
      // reach the store AFTER anything watching the pid saw it change, leaving
      // the reason for the change absent at the only moment someone would look
      // for it. Written first, the two flavours say the same thing in the same
      // order, and a manager that refuses the restart throws out of the tick
      // loudly rather than quietly.
      await say("unit.restarted", request.target, {
        entry: request.target,
        machine: options.machine,
        asked_by: request.askedBy,
        why: request.why,
      });
      await os.restart(request.target);
    }
  };

  /** A measured peak for every resident piece, and only when it grew (D-84). */
  const measure = async (registry: unknown, entries: RunEntry[]): Promise<void> => {
    for (const id of residentIds(registry, options.machine)) {
      let pid: number | null = null;
      if (id === POSTGRES_PEAK_ID) {
        pid = await postmasterPid(store);
      } else if (entries.some((entry) => entry.id === id)) {
        pid = (await os.show(id))?.pid ?? null;
      }
      if (!pid || pid <= 0) continue;
      try {
        const reading = await os.memory(pid);
        const bytes = reading.peak_bytes ?? reading.current_bytes;
        if (!(bytes > 0)) continue;
        await recordPeak(store, {
          id,
          bytes,
          at: new Date().toISOString(),
          how: reading.peak_bytes === null ? "sampled" : "vmhwm",
          machine: options.machine,
          pid,
        });
      } catch {
        // A process that went away between the listing and the reading is not a
        // peak, and it is not an error either.
      }
    }
  };

  const tick = setting(first, "hub.tick_seconds", 5) * 1000;
  const loop = (async () => {
    while (!stopping) {
      try {
        await act();
      } catch {
        // Loud enough to see in the ledger where it matters, and never a hub
        // that falls over because one manager call failed once.
      }
      if (stopping) break;
      await Promise.race([Bun.sleep(tick), stopped]);
    }
  })();

  return {
    machine: options.machine,
    async stop() {
      stopping = true;
      release();
      await loop;
      await store.close();
    },
  };
}
