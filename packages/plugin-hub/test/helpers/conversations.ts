// Test infrastructure for the conversation and attempt tests. It PLANTS rows and
// processes the way the door and the OS would; it decides nothing the runner or
// the store decides, so a check built on it still proves the real thing.

import { taskDigest } from "../../src/door/dispatch.ts";
import { groupOf } from "../../src/os/tree.ts";
import type { JobSource } from "../../src/store/inbound.ts";
import type { Cluster } from "./cluster.ts";
import { CHAT, DOOR, PERSON, insertInbound } from "./hub-fixture.ts";

/**
 * The provenance the door writes on an approved job, planted so a job row can
 * be put on the queue without running a door. The approval digest is over the
 * task, exactly as the runner's own gate reads it, so the row is one the
 * runner will accept; `conversation` is the explicit follow-up.
 */
export function jobSource(id: string, over: { target: string; task: string; dispatcher?: string; conversation?: string }): JobSource {
  const at = new Date().toISOString();
  return {
    log_id: id,
    at,
    from: PERSON,
    text: over.task,
    dispatch: {
      dispatcher: over.dispatcher ?? "p1-lair",
      target: over.target,
      approved: { by: PERSON, at, digest: taskDigest(over.task), source: "chat-command" },
      return: { agent: over.dispatcher ?? "p1-lair", door: DOOR, chat: CHAT },
      ...(over.conversation ? { conversation: over.conversation } : {}),
    },
  };
}

/** A job on the queue for an agent that takes jobs alone. */
export async function insertJob(cluster: Cluster, database: string, job: { id: string; target: string; task: string; conversation?: string }): Promise<void> {
  await insertInbound(cluster, database, {
    id: job.id, agent: job.target, body: job.task, kind: "job", logReady: true,
    source: jobSource(job.id, job) as never,
  });
}

/**
 * A process that stays until it is killed, standing in for an engine some earlier
 * runner started. It leads a process group of its own, the way the production
 * adapter asks its child to, and `group` is that group as the process table reads
 * it back, or null when the runtime would not give it one (then nothing here can
 * stand in for a managed group, and a test that needs one says so).
 */
export function livingProcess(): { pid: number; group: number | null; stop(): Promise<void> } {
  const child = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore", stdin: "ignore", ...({ detached: true } as object) });
  const group = groupOf(child.pid) === child.pid ? child.pid : null;
  // Awaited to its exit, because a killed child nobody has reaped is still an
  // entry in the process table, and "gone" is what the runner is being asked.
  return { pid: child.pid, group, async stop() { try { child.kill(9); } catch { /* it was gone */ } await child.exited; } };
}
