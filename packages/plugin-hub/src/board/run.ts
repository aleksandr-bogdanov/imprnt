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
import { loadRegistry, NEVER_STOPPED, type RunEntry } from "../registry/load.ts";
import type { OsSeam } from "../os/types.ts";
import type { StoreLike } from "../store/connect.ts";
import { readOpenTurns } from "../store/turns.ts";
import { readVoiceHealth } from "../voice/health.ts";
import { isLocalAddress, sameAddress } from "../net/address.ts";
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
  /**
   * Who a request came from, as an address. The default is the server's own
   * answer. A check hands in its own, because a check in this runtime IS this
   * machine and the rule below is about which machine asked.
   */
  peer?: (request: Request, server: PeerReader) => string | null;
  now?: () => Date;
}

/** As much of the server as the peer reader needs. */
export interface PeerReader {
  requestIP(request: Request): { address: string } | null;
}

export interface BoardHandle {
  url: string;
  port: number;
  /** Where artifacts are served, or null when this board serves none. */
  artifactsUrl: string | null;
  artifactsPort: number | null;
  stop(): Promise<void>;
}

/** The 404, and it is the same answer for every reason there is. */
function missing(): Response {
  return new Response(pageMissing("en") + "\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * A page, which no other page may frame.
 *
 * A board page inside somebody else's frame is a page whose buttons a person
 * can be tricked into pressing, and that press would carry the board's own
 * origin, so the origin rule below could not tell it apart.
 */
function html(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    },
  });
}

/**
 * A `Host` header's address and port, the port defaulting to eighty, or null
 * for anything that is not an address and a port.
 */
export function hostParts(header: string | null): { address: string; port: number } | null {
  if (!header) return null;
  const text = header.trim();
  let address: string;
  let port: string | null = null;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    address = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest.startsWith(":")) port = rest.slice(1);
    else if (rest !== "") return null;
  } else {
    const colon = text.indexOf(":");
    if (colon >= 0 && text.lastIndexOf(":") !== colon) return null;
    address = colon >= 0 ? text.slice(0, colon) : text;
    if (colon >= 0) port = text.slice(colon + 1);
  }
  if (port !== null && !/^\d{1,5}$/.test(port)) return null;
  return { address, port: port === null ? 80 : Number(port) };
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

  /** Whether a host names this listener: its own address, however spelled, and its own port. */
  const isOwn = (host: string | null, port: number): boolean => {
    const parts = hostParts(host);
    return parts !== null && parts.port === port && sameAddress(parts.address, entry.bind!);
  };

  /**
   * Whether the browser says another page sent this.
   *
   * `Sec-Fetch-Site` is the browser's own word and a page cannot set it, and
   * only `same-origin` is the board's own page: another port on this address
   * is `same-site`, which is a different origin. `Origin`, where present, must
   * be the board's own, and the `null` a sandboxed frame or a file sends is
   * not. A request carrying neither is not a browser's, and the peer rule is
   * what answers that one.
   */
  const fromAnotherPage = (request: Request, port: number): boolean => {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return true;
    const origin = request.headers.get("origin");
    if (origin === null) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return true;
    }
    return url.protocol !== "http:" || !isOwn(url.host, port);
  };

  /**
   * Who asked, and whether that is this machine.
   *
   * WHY AN ACT FROM THIS MACHINE IS REFUSED. Every agent in this household
   * runs in a box that shares this machine's network, so an agent that decided
   * to restart a runner, or a page it wrote that somebody opened, reaches the
   * board from one of this machine's own addresses. A person reaches it from
   * another device on the tailnet. Nobody here is identified, so which machine
   * asked is the one honest thing a request carries, and it is enough to keep
   * the household's own agents out of its controls.
   *
   * WHAT IT DOES NOT COVER, said plainly: an agent on ANOTHER machine of the
   * household reaches this board from an address that is not this machine's,
   * and this rule does not stop it. That one needs reader identity, which the
   * contract defers.
   *
   * READS ARE LEFT ALONE. Every page is a read of the store and the seam, an
   * agent can already see its own household's state, and a rule that refused
   * reads would refuse this box its own status page.
   */
  const asked = options.peer ?? ((request: Request, server: PeerReader) => server.requestIP(request)?.address ?? null);
  const fromThisMachine = (request: Request, server: PeerReader): boolean =>
    isLocalAddress(asked(request, server));

  const answer = async (request: Request, server: PeerReader): Promise<Response> => {
    // THE HOST MUST BE THE BOARD'S OWN. A website that rebinds its own name to
    // this address reaches the socket with its own name in the header, and
    // answering it would let that website read the pages it made a browser
    // fetch.
    if (!isOwn(request.headers.get("host"), port)) return missing();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      const notice = noticeFrom(url.searchParams);
      if (path === "/") return await machines(notice);
      if (path === "/people") return await people(notice);
      if (path === "/findings") return await findingsOf(notice);
      if (path === "/metrics") return await metrics(notice);
      return missing();
    }
    if (request.method === "POST") {
      if (fromAnotherPage(request, port)) return missing();
      if (fromThisMachine(request, server)) return missing();
      const form = new URLSearchParams(await request.text());
      const target = form.get("target") ?? "";
      const value = form.get("value") === "true";
      if (path === "/act/restart") return await restart(target);
      if (path === "/act/enabled") {
        // The file refuses this field on the hub and on the board, so a form
        // somebody wrote by hand is answered here rather than by a writer that
        // would produce a candidate file nothing could load.
        const kind = listRunEntries(loadRegistry(registryFile)).find((one) => one.id === target)?.kind ?? "";
        if ((NEVER_STOPPED as readonly string[]).includes(kind)) {
          return redirect("/", { said: "actRefused", target, cause: "enabled-not-for-this-kind" });
        }
        return await edit("/", "run", target, "enabled", value);
      }
      if (path === "/act/sleeping") return await edit("/people", "agents", target, "sleeping", value);
      if (path === "/act/check") return await checkNow();
    }
    return missing();
  };

  /**
   * The artifacts listener, on a port of its own.
   *
   * WHAT IT IS FOR: an agent writes what is served here, so a page an agent
   * wrote and a person opened from a chat link must not be the board's own
   * origin. On its own port it is a different origin, and a browser then
   * refuses its script every page of the board and refuses its form every act,
   * whatever that page tries. It serves GET and nothing else, it has no page
   * and no act of its own, and a household that names no artifacts port serves
   * no artifact at all.
   */
  const artifactsAnswer = async (request: Request): Promise<Response> => {
    if (!isOwn(request.headers.get("host"), artifactsPort)) return missing();
    if (request.method !== "GET") return missing();
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/artifacts/")) return missing();
    return await artifact(path);
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

  // Read by `answer`, which no request reaches before this line has run.
  const port = Number(server.port);
  let artifacts: ReturnType<typeof Bun.serve> | null = null;
  try {
    artifacts = entry.artifacts_port === undefined
      ? null
      : Bun.serve({ hostname: entry.bind, port: entry.artifacts_port, fetch: artifactsAnswer });
  } catch (error) {
    // The pages are already up on their own port, and a half-served board is
    // not what the household asked for, so the whole thing goes and the
    // service manager starts it again. The port that failed travels with the
    // error, because the two ports fail the same way and say so differently.
    await server.stop(true);
    (error as { port?: number }).port = entry.artifacts_port;
    throw error;
  }
  const artifactsPort = artifacts === null ? 0 : Number(artifacts.port);
  return {
    url: `http://${entry.bind}:${port}`,
    port,
    artifactsUrl: artifacts === null ? null : `http://${entry.bind}:${artifactsPort}`,
    artifactsPort: artifacts === null ? null : artifactsPort,
    async stop() {
      await server.stop(true);
      await artifacts?.stop(true);
    },
  };
}
