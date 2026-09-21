import { Readable } from "node:stream";
import type { LoopProbeOptions } from "../adapters/launch.ts";
import { runCheck, CHECK_SHEET } from "../check/run.ts";
import type { CredentialProber } from "../check/credentials.ts";
import { readKernelView, type KernelView } from "../check/kernel.ts";
import {
  actRefused,
  actRequested,
  checkRan,
  editApplied,
  editUnavailable,
  pageMissing,
} from "../door/lines.ts";
import { requestRecovery } from "../hub/control.ts";
import { readPeaks } from "../hub/peak.ts";
import { readStatus } from "../hub/status.ts";
import { readStampMetrics } from "../metrics/stamps.ts";
import { readSheet } from "../records/statesheet.ts";
import { lifetimeFor, listAgents, listMachines, listPeople, listRunEntries, voiceFor } from "../registry/entries.ts";
import { loadRegistry, type RunEntry } from "../registry/load.ts";
import type { OsSeam } from "../os/types.ts";
import type { StoreLike } from "../store/connect.ts";
import { readOpenTurns } from "../store/turns.ts";
import { readVoiceHealth } from "../voice/health.ts";
import { serveArtifact } from "./artifacts.ts";
import { findingsPage, machinesPage, metricsPage, peoplePage, type CheckRow, type ControlRow } from "./pages.ts";

/**
 * The board as a program: one `Bun.serve` on one specific address, four pages
 * assembled from the readers the command line already calls, and acts that are
 * the one recovery verb or an edit to the registry file.
 *
 * NOTHING RUNS BETWEEN REQUESTS. No timer, no `LISTEN`, no interval, no
 * sampler. The store handle is held open, which issues no statement, and
 * `Bun.serve` sleeps on accept, so a board nobody is looking at costs nothing
 * and a phone left open overnight costs nothing after its last render. That is
 * a measured property and not a promise: `test/board-idle.test.ts` counts the
 * statements and the processor time.
 *
 * THE BOARD HOLDS NO STATE OF ITS OWN. It opens no file for writing anywhere,
 * samples nothing and keeps no index. Every page is a read of the one store and
 * the OS seam, which is what makes it acceptable for a reader nobody
 * identified: there is nothing here for an agent's box to mask and nothing an
 * agent could read through it.
 *
 * IT NEVER CALLS AN ACTING VERB ON THE SEAM. It holds a seam at all for the
 * reading verbs the machines page needs, and restart goes through the shipped
 * `requestRecovery` so the hub is the one thing that talks to the service
 * manager. Two implementations of a control verb is the forbidden shape this
 * arrangement exists to make unreachable.
 */

/**
 * The registry writer, as a SHAPE rather than a module: set one key inside one
 * named table, validate the candidate by loading it before anything is
 * replaced, replace atomically and keep every comment, order and other table a
 * hand-edited file carries. Passing nothing is a real answer, and then start,
 * stop and pause say so and a person edits the file.
 */
export type RegistryKeyWriter = (change: {
  file: string;
  table: "run" | "agents";
  id: string;
  key: string;
  value: boolean;
}) => Promise<void>;

export interface BoardOptions {
  entry: RunEntry;
  registryFile: string;
  store: StoreLike;
  os: OsSeam;
  writeRegistryKey?: RegistryKeyWriter;
  /**
   * What `check now` runs with. The defaults are the command line's own: the
   * real credential prober and this machine's kernel view. A check hands in its
   * own, because opening a household's real login from a test is not a test.
   */
  check?: { credentials?: CredentialProber; kernel?: KernelView | null; loopProbe?: LoopProbeOptions };
  now?: () => Date;
}

export interface BoardHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** The 404, and it is the same answer for every reason there is. */
function missing(): Response {
  return new Response(pageMissing("en") + "\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function html(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The sentence an act left behind, rebuilt from a KEY and its values.
 *
 * The text is never carried across the redirect. A page that printed whatever
 * a caller put in a query would be repeating a stranger's sentence as its own,
 * so what travels is one of the pinned keys and the values it takes, and the
 * page says its own line.
 */
function noticeFrom(params: URLSearchParams): string | null {
  const target = params.get("target") ?? "";
  switch (params.get("said")) {
    case "actRequested":
      return actRequested("en", { target });
    case "actRefused":
      return actRefused("en", { target, cause: params.get("cause") ?? "" });
    case "editApplied":
      return editApplied("en", { field: params.get("field") ?? "", value: params.get("value") ?? "", target });
    case "editUnavailable":
      return editUnavailable("en", { target });
    case "checkRan":
      return checkRan("en", { count: params.get("count") ?? "", at: params.get("at") ?? "" });
    default:
      return null;
  }
}

function redirect(to: string, said: Record<string, string>): Response {
  const params = new URLSearchParams(said);
  return new Response(null, { status: 303, headers: { location: `${to}?${params.toString()}` } });
}

export async function runBoard(options: BoardOptions): Promise<BoardHandle> {
  const { entry, registryFile, store, os } = options;
  const machine = entry.machine;
  const now = options.now ?? (() => new Date());

  const sheet = async (name: string) => await readSheet(store, name);
  const findings = async (): Promise<CheckRow[]> =>
    (await sheet(CHECK_SHEET)).map((row) => ({
      ...(row.data as unknown as CheckRow),
      updated_at: new Date(row.updated_at).toISOString(),
    }));

  /**
   * What the manager says about this machine's own entries, or nothing.
   *
   * A machine whose service manager does not answer is not a reason for the
   * page to die: the list, the limits, the other machine's findings and the
   * acts are all still readable, and the columns only the manager could fill
   * print nothing rather than a guess.
   */
  const liveStatus = async () => {
    try {
      return await readStatus({ registryFile, machine, os });
    } catch {
      return [];
    }
  };

  const machines = async (notice: string | null): Promise<Response> => {
    const registry = loadRegistry(registryFile);
    const controls = (await sheet("control")).map((row) => ({
      ...(row.data as unknown as ControlRow),
      id: row.id,
    }));
    return html(
      machinesPage({
        machine,
        entries: listRunEntries(registry),
        machines: listMachines(registry),
        status: await liveStatus(),
        findings: await findings(),
        peaks: await readPeaks(store),
        acts: controls,
        notice,
      }),
    );
  };

  const people = async (notice: string | null): Promise<Response> => {
    const registry = loadRegistry(registryFile);
    const agents = listAgents(registry);
    const openTurns: Record<string, number> = {};
    for (const agent of agents) {
      openTurns[agent.id] = (await readOpenTurns(store, { agent: agent.id })).length;
    }
    const lifetimes: Record<string, { mode: string; sleeping: boolean }> = {};
    for (const agent of agents) {
      const life = lifetimeFor(registry, agent.id);
      lifetimes[agent.id] = { mode: life.mode, sleeping: life.sleeping };
    }
    return html(
      peoplePage({
        people: listPeople(registry),
        agents,
        openTurns,
        agentHealth: await sheet("agent_health"),
        doorHealth: await sheet("door_health"),
        lifetimes,
        findings: await findings(),
        notice,
      }),
    );
  };

  const findingsOf = async (notice: string | null): Promise<Response> =>
    html(findingsPage({ findings: await findings(), notice }));

  const metrics = async (notice: string | null): Promise<Response> => {
    // A household that names no recognizer reads no sheet and sees no voice
    // block, which is a different answer from a recognizer that has never
    // failed. The registry is what tells the two apart.
    const health =
      voiceFor(loadRegistry(registryFile)) === null
        ? null
        : [...(await readVoiceHealth(store))].map(([recognizer, row]) => ({ recognizer, ...row }));
    return html(metricsPage({ rows: await readStampMetrics(store, { now: now() }), health, notice }));
  };

  /** What a restart of this target is called, read off the file and nowhere else. */
  const kindOf = (registry: unknown, target: string): string => {
    if (listAgents(registry).some((agent) => agent.id === target)) return "agent";
    const found = listRunEntries(registry).find((one) => one.id === target);
    return found?.kind === "door" ? "door" : "run";
  };

  const restart = async (target: string): Promise<Response> => {
    const registry = loadRegistry(registryFile);
    try {
      const row = (await requestRecovery(store, {
        id: crypto.randomUUID(),
        source: "board",
        // Nobody on this page is identified, and `board` is the true answer.
        actor: "board",
        target_kind: kindOf(registry, target),
        target_id: target,
        registry,
        registryFile,
      })) as { status?: string; cause?: unknown };
      if (row?.status === "refused") {
        return redirect("/", { said: "actRefused", target, cause: String(row.cause ?? "") });
      }
      return redirect("/", { said: "actRequested", target });
    } catch (error) {
      return redirect("/", { said: "actRefused", target, cause: (error as Error).message });
    }
  };

  const edit = async (
    to: string,
    table: "run" | "agents",
    id: string,
    key: string,
    value: boolean,
  ): Promise<Response> => {
    if (!options.writeRegistryKey) return redirect(to, { said: "editUnavailable", target: id });
    try {
      await options.writeRegistryKey({ file: registryFile, table, id, key, value });
      return redirect(to, { said: "editApplied", field: key, value: String(value), target: id });
    } catch (error) {
      return redirect(to, { said: "actRefused", target: id, cause: (error as Error).message });
    }
  };

  const checkNow = async (): Promise<Response> => {
    const at = now().toISOString();
    const asked = options.check ?? {};
    const rows = await runCheck({
      machine,
      registryFile,
      store,
      os,
      kernel: Object.hasOwn(asked, "kernel") ? (asked.kernel ?? null) : await readKernelView(),
      credentials: asked.credentials,
      loopProbe: asked.loopProbe,
      now: new Date(at),
    });
    return redirect("/findings", { said: "checkRan", count: String(rows.length), at });
  };

  const artifact = async (path: string): Promise<Response> => {
    const parts = path.split("/").filter((one) => one !== "");
    // `/artifacts/<person>/<path>`, and nothing shorter is a file.
    if (parts.length < 3) return missing();
    const person = decodeURIComponent(parts[1]);
    const found = await serveArtifact({
      registry: loadRegistry(registryFile),
      person,
      path: parts.slice(2).join("/"),
    });
    if (!found) return missing();
    // Served from the file that was checked, never reopened by name, which is
    // what closes the gap between the check and the open. The stream closes it
    // when the body ends or the reader goes away. Measured: `Bun.file` on a
    // descriptor, or the handle's own web stream, holds the file open after
    // the response, one per request.
    const body = Readable.toWeb(found.handle.createReadStream({ autoClose: true })) as ReadableStream;
    return new Response(body, { status: 200, headers: { "content-type": found.type } });
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      const notice = noticeFrom(url.searchParams);
      if (path.startsWith("/artifacts/")) return await artifact(path);
      if (path === "/") return await machines(notice);
      if (path === "/people") return await people(notice);
      if (path === "/findings") return await findingsOf(notice);
      if (path === "/metrics") return await metrics(notice);
      return missing();
    }
    if (request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const target = form.get("target") ?? "";
      const value = form.get("value") === "true";
      if (path === "/act/restart") return await restart(target);
      if (path === "/act/enabled") return await edit("/", "run", target, "enabled", value);
      if (path === "/act/sleeping") return await edit("/people", "agents", target, "sleeping", value);
      if (path === "/act/check") return await checkNow();
    }
    return missing();
  };

  // ONE SPECIFIC ADDRESS. A bind this machine does not hold throws out of here
  // and the program exits with the cause named: there is no fallback to any
  // other address, and no retry loop of the board's own, because the service
  // manager is the retry loop.
  const server = Bun.serve({
    hostname: entry.bind,
    port: entry.port,
    fetch: answer,
  });

  const port = Number(server.port);
  return {
    url: `http://${entry.bind}:${port}`,
    port,
    async stop() {
      await server.stop(true);
    },
  };
}
