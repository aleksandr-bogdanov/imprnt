import { wantedState } from "../os/diff.ts";
import { RegistryEditRefused, setKey } from "../registry/edit.ts";
import { listAgents, listRunEntries } from "../registry/entries.ts";
import { registryDigest, type Registry } from "../registry/load.ts";
import { clip } from "../runner/move-handoff.ts";
import { profileDifference, profileOf } from "../runner/move-profile.ts";
import type { StoreLike } from "../store/connect.ts";
import {
  blockMove, movesForHub, recordRegistryWritten, refreshRegistryReceipt, unblockMove, type MoveRow, type RegistryReceipt,
} from "../store/moves.ts";
import { storeMachineOf } from "./digest.ts";

/**
 * THE HUB'S HALF OF A MOVE THAT WAS ACTIVATED: bind the agent to the destination's runner in the registry, and tell the store exactly which
 * registry that produced. The hub is the only process that writes the registry, and it writes it ONLY through the editor (`registry/edit.ts`:
 * a line edit under the directory lock, a candidate loaded and compared with the one intended change, a rename), never a second way.
 *
 * WHAT THE WRITE IS: the one key `agents[<id>].runner`, from the move's source runner to its destination runner, judged INSIDE the writer's lock
 * on the bytes the edit is built from (`setKey`'s precondition): the agent is still there and still on the source (or already on the destination:
 * then nothing is written), the destination is a runner of the destination machine the file still keeps running, and the agent's profile is still
 * what the destination recorded at its preflight. A write of the runner key alone is NEVER readiness: only the destination's `serveMove` moves on.
 *
 * WHAT THE RECEIPT BINDS (`recordRegistryWritten`): the digest of the registry bytes the hub OBSERVED after its write (read, parsed and read again:
 * a file that changed in between is looked at on the next tick), the agent, the destination runner and machine, the placement generation
 * activation set, and the destination's own recorded profile, which the registry as it now stands must still give the agent (the receipt never
 * states a profile the file does not). A later unrelated edit changes the digest: while the binding still holds the receipt is refreshed
 * (`refreshRegistryReceipt`, equality only), and a binding that no longer holds is the hub's named block `registry_binding_changed`.
 *
 * A COPY ON ANOTHER MACHINE is not this module's: the destination serves only the registry whose digest is the receipt's (`move-serve.ts`),
 * and how a spoke's copy comes to equal this file is the hub's existing registry distribution. Only the hub of the STORE MACHINE writes, as for
 * every other registry edit (a spoke's copy is measured against it).
 *
 * Every refusal is the hub's own named block, cleared by itself when its reason is gone. An activated move cannot be withdrawn; the owner's
 * way out of a block is to restore what it names.
 */

export const HUB_CODES: ReadonlySet<string> = new Set([
  "registry_agent_missing", "registry_runner_unusable", "registry_conflict", "registry_profile_changed", "registry_write_failed",
  "registry_receipt_invalid", "registry_binding_changed",
]);

export interface RegistryMovesContext {
  store: StoreLike;
  registryFile: string;
  /** This hub's machine. */
  machine: string;
  /** The registry as it is now, loaded for this machine. May throw for a file caught half written: then nothing is done this pass. */
  load: () => Registry;
  say?: (kind: string, subject: string, detail: Record<string, unknown>) => Promise<void>;
}

/** One pass over the moves the hub has registry work for. The first error is thrown after every move had its look. */
export async function registerMoves(ctx: RegistryMovesContext): Promise<void> {
  const reference = storeMachineOf(ctx.load());
  if (reference !== null && reference !== ctx.machine) return;
  let failed: { error: unknown } | null = null;
  for (const move of await movesForHub(ctx.store)) {
    try { await registerOne(ctx, move); } catch (error) { failed ??= { error }; }
  }
  if (failed) throw failed.error;
}

type Verdict = { ok: true } | { ok: false; code: string; detail: Record<string, unknown> };

/**
 * Whether `registry` still carries out what the destination recorded and the activation set: pure, asked of the registry the writer holds its
 * lock on and again of the one observed after the write. `bound` is the state of the runner key it requires.
 */
function judge(registry: Registry, move: MoveRow, bound: "source" | "destination" | "either"): Verdict {
  const facts = move.dest_facts;
  if (!facts) return { ok: false, code: "registry_binding_changed", detail: { why: "no-preflight" } };
  const agent = listAgents(registry).find(one => one.id === move.agent);
  if (!agent) return { ok: false, code: "registry_agent_missing", detail: { agent: move.agent } };
  const runner = listRunEntries(registry).find(one => one.id === move.dest_runner && one.kind === "runner");
  if (!runner || runner.machine !== move.dest_machine || wantedState(runner) !== "running") {
    return { ok: false, code: "registry_runner_unusable", detail: { runner: move.dest_runner, machine: move.dest_machine } };
  }
  const allowed = bound === "source" ? [move.source_runner] : bound === "destination" ? [move.dest_runner] : [move.source_runner, move.dest_runner];
  if (!allowed.includes(agent.runner)) return { ok: false, code: "registry_conflict", detail: { runner: clip(agent.runner), wanted: allowed.map(one => clip(one)) } };
  const differs = profileDifference(profileOf(registry, move.agent), facts.profile);
  if (differs.length > 0) return { ok: false, code: "registry_profile_changed", detail: { sections: differs.slice(0, 16) } };
  return { ok: true };
}

/** What the hub's block is, restated: a code of its own with the detail, and only ever its own (`blockMove` with no party is the hub). */
async function refuse(ctx: RegistryMovesContext, move: MoveRow, code: string, detail: Record<string, unknown>): Promise<void> {
  const answer = await blockMove(ctx.store, move.id, null, code, detail);
  if (answer === "blocked") await ctx.say?.("move.registry-blocked", move.id, { move: move.id, code, ...detail });
}

/** This side's own block, cleared when it is one of the hub's codes: never another party's. */
async function clearOwn(ctx: RegistryMovesContext, move: MoveRow): Promise<void> {
  if (move.block && move.block.by === "hub" && HUB_CODES.has(move.block.code)) await unblockMove(ctx.store, move.id, null, move.block.code);
}

/** The registry bytes' digest, the registry parsed from them, and the digest again: null when the file changed while it was read. */
function observe(ctx: RegistryMovesContext): { digest: string; registry: Registry } | null {
  const before = registryDigest(ctx.registryFile);
  const registry = ctx.load();
  return registryDigest(ctx.registryFile) === before ? { digest: before, registry } : null;
}

async function registerOne(ctx: RegistryMovesContext, move: MoveRow): Promise<void> {
  if (!move.dest_facts || move.dest_generation === null) return;
  const facts = move.dest_facts;
  const receiptFor = (digest: string): RegistryReceipt => ({
    digest, agent: move.agent, runner: move.dest_runner, machine: move.dest_machine, placement_generation: move.dest_generation!, profile: facts.profile,
  });

  if (move.stage === "registry_written") {
    // A refresh is a reconciliation and no block stops it. Unchanged bytes need no refresh, but the hub's own block stands until the binding
    // is seen to hold again: the owner's revert to the receipt's exact bytes is the way out of it.
    const seen = observe(ctx);
    if (!seen || !move.registry_receipt) return;
    if (seen.digest === move.registry_receipt.digest) {
      if (move.block?.by === "hub" && judge(seen.registry, move, "destination").ok) await clearOwn(ctx, move);
      return;
    }
    const verdict = judge(seen.registry, move, "destination");
    if (!verdict.ok) { await refuse(ctx, move, "registry_binding_changed", { why: verdict.code, ...verdict.detail }); return; }
    const answer = await refreshRegistryReceipt(ctx.store, move.id, receiptFor(seen.digest));
    if (answer === "refreshed") { await clearOwn(ctx, move); await ctx.say?.("move.registry-refreshed", move.id, { move: move.id }); }
    else if (answer === "binding-changed") await refuse(ctx, move, "registry_binding_changed", { why: "store-binding" });
    return;
  }
  if (move.stage !== "activated") return;

  // Before the write: the file must already say what the move needs (the destination runner is one, the agent is there, the profile is the
  // recorded one). The same judgment is made again inside the writer's lock, on the bytes the edit is built from.
  const before = judge(ctx.load(), move, "either");
  if (!before.ok) { await refuse(ctx, move, before.code, before.detail); return; }

  let wrote = false;
  try {
    const result = await setKey(ctx.registryFile, `agents[${move.agent}]`, "runner", move.dest_runner, {
      precondition: locked => {
        const verdict = judge(locked, move, "either");
        if (!verdict.ok) return { ok: false, reason: `${verdict.code}: ${JSON.stringify(verdict.detail)}` };
        const agent = listAgents(locked).find(one => one.id === move.agent);
        return { ok: true, present: agent?.runner === move.dest_runner };
      },
    });
    wrote = result.changed;
  } catch (error) {
    if (!(error instanceof RegistryEditRefused)) throw error;
    // A writer that is busy, or a file edited while the candidate was prepared, is tried again on the next tick and is no block.
    if (error.step === "locked" || error.step === "concurrent") return;
    const code = error.step === "precondition" ? (/^(registry_[a-z_]+):/.exec(error.message)?.[1] ?? "registry_conflict") : "registry_write_failed";
    await refuse(ctx, move, HUB_CODES.has(code) ? code : "registry_write_failed", { step: error.step, why: clip(error.message) ?? "" });
    return;
  }

  // The registry as it stands NOW, observed once, and judged again: the receipt states only what the file says.
  const seen = observe(ctx);
  if (!seen) return;
  const after = judge(seen.registry, move, "destination");
  if (!after.ok) { await refuse(ctx, move, after.code, after.detail); return; }
  await clearOwn(ctx, move);
  const answer = await recordRegistryWritten(ctx.store, move.id, receiptFor(seen.digest));
  switch (answer) {
    case "written":
      await ctx.say?.("move.registry-written", move.id, { move: move.id, runner: move.dest_runner, wrote, digest: seen.digest.slice(0, 16) });
      return;
    case "use-refresh": {
      const refreshed = await refreshRegistryReceipt(ctx.store, move.id, receiptFor(seen.digest));
      if (refreshed === "binding-changed") await refuse(ctx, move, "registry_binding_changed", { why: "store-binding" });
      return;
    }
    case "receipt-invalid":
      await refuse(ctx, move, "registry_receipt_invalid", { answer });
      return;
    default:
      // `replay`, `stage`, `blocked`, `topic-not-active`, `terminal`, `unknown-move`: nothing for the hub to do now.
      return;
  }
}
