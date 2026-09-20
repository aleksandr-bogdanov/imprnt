import { existsSync, readFileSync } from "node:fs";
import { appendEntry } from "../records/diary.ts";
import { diffUnits, seenUnits, wantedState, wantedUnits } from "../os/diff.ts";
import { entryIdOf } from "../os/names.ts";
import { thisOs } from "../os/index.ts";
import type { OsSeam, RenderContext } from "../os/types.ts";
import { listMachines, listRunEntries, runEntriesFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type RunEntry } from "../registry/load.ts";
import { openStore, type Store } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { POSTGRES_PEAK_ID, readStorePid, recordPeak, residentIds } from "./peak.ts";
import { readRequests, refuseRestart, type RestartRequest } from "./restart.ts";
import { watchControls } from "./control.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { programForKind, transcriberArgv } from "./program.ts";

/**
 * The hub: one process per machine, ours, unsandboxed, and the only thing that
 * talks to the operating system (D7).
 *
 * On its tick it reads the registry file, renders the entries for ITS machine,
 * compares them with what the manager has, and installs, starts, stops or
 * removes. It acts on the restart requests in the ledger and refuses the two
 * forbidden shapes. It records a measured peak for every resident piece.
 *
 * WHAT IT MAY TOUCH IS THE FENCE. A unit under the RENDER prefix with no
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

function setting(registry: unknown, key: string, fallback: number): number {
  const found = readSetting(registry, key);
  return found === undefined || found === null ? fallback : Number(found);
}

export async function runHub(options: {
  machine: string;
  registryFile: string;
  os?: OsSeam;
}): Promise<HubHandle> {
  const first = loadRegistry(options.registryFile);
  // A hub that acted for a machine whose declared os is not the one it is
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
    url: storeUrlFor(first, "hub_hub", application),
  });

  // SPEC section 6 and D7: ONE hub process per machine. Two of them reconciling
  // the same machine fight over every unit on it, which has taken a box down
  // before now. The register of who is running is
  // the store itself, because the hub is already connected to it, so there is
  // no lock file and nothing to clean up after a crash: a dead hub's backend is
  // gone by the time anybody asks. This happens BEFORE the first tick, so a hub
  // that refuses has touched no unit on its way out.
  //
  // IT IS A LOCK AND NOT A COUNT. Counting the other backends
  // with this name and then carrying on is a check-then-act: two hubs starting
  // in the same instant both count zero and both proceed, which enforces "one
  // hub per machine unless two start together". `pg_try_advisory_lock` is the
  // same register answered atomically, held by the SESSION, so exactly one of
  // any number of simultaneous starts gets it and a hub that dies by any route
  // gives it back with its backend. The key is this machine's own application
  // name hashed to the bigint the function takes, so two machines against one
  // store never collide.
  //
  // WHAT THE LOCK'S DURABILITY RESTS ON, and it is NOT the store being opened
  // with one connection, because a store holds several. It rests on
  // `pg_try_advisory_lock` being held by the SESSION that took it and on this
  // client keeps its connections for the life of the store rather than opening
  // and closing one per statement. Measured on a throwaway cluster: the lock
  // taken through the pool stays held across churn and a second store on the
  // same url is refused, which is what `test/hub-single.test.ts` asks for.
  const [{ mine }] = (await store.sql.unsafe(
    `select pg_try_advisory_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint) as mine`,
    [application],
  )) as { mine: boolean }[];
  if (!mine) {
    await appendEntry(store, {
      stream: "refusal",
      subject: options.machine,
      kind: "refused.second_hub",
      actor: "hub",
      detail: {
        machine: options.machine,
        application_name: application,
        reason: "another hub for this machine already holds this machine's lock in this store",
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

  const contextFor = (registry: unknown, entry: RunEntry): RenderContext => ({
    machine: options.machine,
    execPath: process.execPath,
    entryScript: programForKind(entry.kind),
    // One function answers this for both callers that render a unit, so a unit
    // installed by hand and a unit written on a tick cannot differ.
    argv: entry.kind === "transcriber" ? transcriberArgv(registry, entry) : undefined,
    registryFile: options.registryFile,
    stateDir: String(readSetting(registry, "hub.state_dir")),
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
    await acknowledge(entries);
    const started = new Set<string>();

    for (const entry of entries) {
      const files = os.render(entry, contextFor(registry, entry));
      const changed = files.some(
        (file) => !existsSync(file.path) || readFileSync(file.path, "utf8") !== file.text,
      );
      if (!changed) continue;
      let written: string[];
      try { written = await os.install(files); }
      catch (error) { await recordOperationFailure(store, { operation: "install", target: entry.id, error }); continue; }
      await say("unit.installed", entry.id, { entry: entry.id, machine: options.machine, files: written });
      if (wantedState(entry) === "running") {
        try { await os.start(entry.id); }
        catch (error) { await recordOperationFailure(store, { operation: "start", target: entry.id, error }); continue; }
        started.add(entry.id);
        await say("unit.started", entry.id, { entry: entry.id, machine: options.machine });
      }
    }

    const wanted = wantedUnits(entries);
    const elsewhere = new Set(listRunEntries(registry).filter(e => listMachines(registry).length > 1 && e.machine !== options.machine).map(e => e.id));
    const found = (await seenUnits(os, entries)).filter(unit => !elsewhere.has(entryIdOf(unit.name) ?? ""));
    const difference = diffUnits({ wanted, found });

    for (const one of difference.missing) {
      if (one.state !== "running" || started.has(one.id)) continue;
      try { await os.start(one.id); }
      catch (error) { await recordOperationFailure(store, { operation: "start", target: one.id, error }); continue; }
      await say("unit.started", one.id, { entry: one.id, machine: options.machine });
    }

    for (const unit of difference.stale) {
      const id = entryIdOf(unit.name);
      if (id === null) continue;
      await os.remove(id);
      await say("unit.stopped", id, { entry: id, machine: options.machine, unit: unit.name });
      await say("unit.removed", id, { entry: id, machine: options.machine, unit: unit.name });
    }

    await measure(registry, entries);
  };

  /** The restart requests, each acted on or refused exactly once. */
  const acknowledge = async (entries: RunEntry[]): Promise<void> => {
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

  /** A measured peak for every resident piece, and the current reading beside it. */
  const measure = async (registry: unknown, entries: RunEntry[]): Promise<void> => {
    for (const id of residentIds(registry, options.machine)) {
      let pid: number | null = null;
      if (id === POSTGRES_PEAK_ID) {
        // The file the household DECLARED, never a process tree.
        // With no `[store]` section nothing is measured for the store and
        // `check` keeps `peak-missing:postgres`, which is the honest state.
        pid = readStorePid(registry).pid;
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
          // What it is holding right now, beside the high-water mark. Nothing
          // new is sampled for it: this is the reading already taken.
          reading_bytes: reading.current_bytes,
        });
      } catch {
        // A process that went away between the listing and the reading is not a
        // peak, and it is not an error either.
      }
    }
  };

  /**
   * When each entry was last restarted from a control row, so the one a wedged
   * recognizer earns cannot become a restart loop.
   *
   * THE LIMIT LIVES HERE AND NOT IN THE ASKER. A refusal is a `refusal` line and
   * the door holds no insert policy for that stream, so a door-side limit would
   * be a fence widened for a diagnostic this side can already write.
   */
  const restartedAt = new Map<string, number>();
  const targets = (data: Record<string, unknown>, kind: string): boolean =>
    runEntriesFor(loadRegistry(options.registryFile), options.machine)
      .some(e => e.id === data.target_id && e.kind === kind);
  const controls = await watchControls(store, "hub",
    // A recognizer entry of THIS machine joins the door as a target. Anything
    // else, and anything on another machine, is not this hub's to act on.
    data => (data.target_kind === "door" && targets(data, "door")) ||
      (data.target_kind === "run" && targets(data, "transcriber")), async data => {
      const id = String(data.target_id);
      // The limit is the RECOGNIZER's alone. An operator asking for a door back
      // is a person who meant it, and nothing about a door's failures makes a
      // second ask a loop.
      const bounded = data.target_kind === "run";
      const seconds = setting(loadRegistry(options.registryFile), "hub.outage_retry_seconds", 300);
      const last = restartedAt.get(id);
      if (bounded && last !== undefined && Date.now() - last < seconds * 1000) {
        throw new Error(`${id} was restarted less than ${seconds} s ago, which is this household's retry interval`);
      }
      try { await os.restart(id); }
      catch (error) { await recordOperationFailure(store, { operation: "restart", target: id, error }); throw error; }
      if (bounded) restartedAt.set(id, Date.now());
    });

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
      await controls.close();
      await store.close();
    },
  };
}
