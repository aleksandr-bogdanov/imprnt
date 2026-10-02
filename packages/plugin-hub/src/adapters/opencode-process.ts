import { alive, groupAlive, groupOf, groupPresence, observeTree, presence } from "../os/tree.ts";
import type { ExitEvidence } from "./types.ts";

/** The four things this reads of a spawned child, so any spawn's handle fits without its stream types. */
export interface WatchedChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly exited: Promise<number>;
}

/**
 * What a hub knows about the process tree of one engine child: which processes were
 * ever seen under it, whether its group is empty, and how to stop all of it and say what
 * is provably gone. It is the same discipline the Claude adapter keeps for its child,
 * written once here for the engines that are a server, and it is kept apart from the
 * Claude adapter on purpose: that file is not changed by adding an engine.
 *
 * The group is the only witness for what was never seen, and it is claimed only when the
 * child was started as the leader of one and the process table says so. Nothing here says
 * an effect outside the process table (a file, an API call, a message) was undone.
 */
export function watchChild(child: WatchedChild) {
  const ownGroup: number | null = (() => {
    if (!child.pid || child.pid === process.pid) return null;
    return groupOf(child.pid) === child.pid ? child.pid : null;
  })();
  // Every process ever seen under the child: a leader that exited says nothing about its
  // tools, so what is judged afterwards is everything that was ever observed.
  const seenTree = new Set<number>();
  // A failed read of the process table is not an empty tree, and it is said.
  let incomplete = false;
  const gone = () => child.exitCode !== null || child.signalCode !== null;

  const snapshot = (): number[] | null => {
    if (!child.pid) return null;
    if (gone()) return [];
    const under = observeTree(child.pid);
    if (!under.complete) incomplete = true;
    const tree = [child.pid, ...under.pids];
    for (const one of tree) seenTree.add(one);
    return tree;
  };

  const evidence = (via: string): ExitEvidence => {
    const pids = [...seenTree];
    const looked = pids.map(one => [one, presence(one)] as const);
    const survivors = looked.filter(([, said]) => said === "present").map(([one]) => one);
    const unknown = looked.filter(([, said]) => said === "unknown").map(([one]) => one);
    const leader = child.pid === undefined ? "unknown" : gone() ? "exited" : "alive";
    const inGroup = ownGroup === null ? null : groupPresence(ownGroup);
    const others = survivors.some(one => one !== child.pid) || (gone() && inGroup === "present");
    const verified = inGroup === "absent" && unknown.length === 0;
    const descendants = others ? "survivors" : verified ? "none" : "unverified";
    return { confirmed: leader === "exited" && descendants === "none" && !survivors.includes(child.pid!), leader, descendants, pids, survivors,
      unknown, partial: incomplete, basis: inGroup === "absent" ? "process-group" : "observed-tree", group: ownGroup, via };
  };

  /** Whether the leader has exited and nothing seen under it, nor anything in its group, is left, waited for up to `limitMs`. */
  const settled = async (limitMs: number) => {
    const empty = () => gone() && [...seenTree].every(one => !alive(one)) && (ownGroup === null || !groupAlive(ownGroup));
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
      if (empty()) return true;
      await Bun.sleep(25);
    }
    return empty();
  };

  return {
    ownGroup,
    gone,
    snapshot,
    partial: () => incomplete,
    async exitEvidence(): Promise<ExitEvidence> {
      // A leader still running is not waited for: it is not gone. One that is exiting is given a moment.
      if (!gone()) await Promise.race([child.exited, Bun.sleep(200)]);
      if (gone()) await settled(1000);
      return evidence(ownGroup === null
        ? "the process tree observed under the engine (no process group of its own, so what was never observed is not covered)"
        : "the engine's process group and every process recorded under it, looked up again (a process that left the group before it was recorded is not covered)");
    },
    /**
     * Ask, wait, then end what is left. The tree is read while the leader is alive, because
     * once it is gone its tools are reparented and nothing names them any more. Tools first, then
     * the engine, then the group for what was reparented out of sight.
     */
    async stop(graceMs: number): Promise<ExitEvidence> {
      snapshot();
      const tools = [...seenTree].filter(one => one !== child.pid).reverse();
      const signal = (pids: number[], name: NodeJS.Signals) => {
        for (const one of pids) { try { process.kill(one, name); } catch { /* it left first */ } }
      };
      const signalGroup = (name: NodeJS.Signals) => {
        if (ownGroup === null) return;
        try { process.kill(-ownGroup, name); } catch { /* the group is empty */ }
      };
      signal(tools, "SIGTERM");
      if (child.pid) signal([child.pid], "SIGTERM");
      signalGroup("SIGTERM");
      if (!await settled(graceMs)) {
        signal(tools, "SIGKILL");
        if (child.pid) signal([child.pid], "SIGKILL");
        signalGroup("SIGKILL");
        await settled(2000);
      }
      return evidence(ownGroup === null
        ? "abort asked of the engine, then terminate and kill after the grace, judged on the observed process tree"
        : "abort asked of the engine, then terminate and kill after the grace, judged on the process group and the observed process tree");
    },
  };
}
