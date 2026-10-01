import { agentsFor } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { readMove, serveMove, unblockMove, type LoadedEvidence } from "../store/moves.ts";
import { configDifference } from "./move-config.ts";
import {
  done, isRecord, raise, sameJson, sayOnce, sha256, stableText, waiting, who,
  type HandoffStep, type HandoffWorld,
} from "./move-handoff.ts";
import { moveNotice, noteDigestOf } from "./move-note.ts";
import { profileDifference, profileOf } from "./move-profile.ts";

/**
 * THE DESTINATION'S SERVE: the one call that releases a moved agent's gate (`serveMove`), made only from what THIS runner actually loaded.
 *
 * The store compares, by equality, what the destination asserts it loaded (the agent, runner, machine and placement generation activation
 * set, the registry digest, its profile and capabilities, the import's generation and manifest digest) with what it holds, and the digest with
 * the hub's receipt of the registry it wrote. This module is what makes that assertion TRUE before it is made:
 * - the registry file is read ONCE (`loaded`: its digest and the registry parsed from those very bytes, or nothing if the file changed while
 *   it was read), and it is the receipt's digest, byte for byte, or the serve waits (`registry-stale`): a copy that fell behind, a hub that
 *   has not written yet, a file edited since the receipt (the hub refreshes the receipt then, and the next look serves);
 * - that registry puts the agent on THIS runner, and a loop for the agent is running here (`serving`), on a registry the runner has itself
 *   measured current (the runner serves nothing from a stale copy);
 * - the profile the registry gives the agent and the capabilities of the engine, read fresh now, are what the preflight recorded.
 * Nothing is asserted that was not read in this look, and nothing here releases anything: the store decides, and any block stops it.
 *
 * ONE BLOCK AT A TIME AND NEVER A LOOP. A refusal that is a fact of this side (a profile that changed since the preflight, say) is this side's
 * block `serve_*` with the fingerprint of what was read; it stays while the same facts are read (`blocked`, no call), and is cleared only when
 * the facts changed (the registry digest, the profile, the engine's capabilities), so a notification of the block itself never makes the next
 * look write it again. An activated move cannot be withdrawn: the owner's way out of a `serve_*` block is to restore what the preflight
 * recorded (the registry, the engine) and let the facts change.
 */

/** The block codes this side sets at serve and clears itself. */
export const SERVE_CODES: ReadonlySet<string> = new Set([
  "serve_binding_mismatch", "serve_profile_mismatch", "serve_capabilities_changed", "serve_loaded_mismatch", "serve_placement_changed",
  "serve_import_unavailable", "serve_loaded_invalid", "serve_config_changed", "serve_config_unverifiable",
]);

/** What a serve needs beyond the handoff's world: the registry as loaded, whether the agent's loop is up, and the person's language. */
export interface ServeWorld extends HandoffWorld {
  /** The registry file read once: the digest of its bytes and the registry parsed from them. Null when unreadable or when it changed while read. */
  loaded(): { digest: string; registry: Registry } | null;
  /** A loop for the agent is running on this runner, on a registry this runner measured current. */
  serving(agent: string): boolean;
  language(person: string): "en" | "ru";
}

const BLOCKS: Record<string, string> = {
  "profile-mismatch": "serve_profile_mismatch", "loaded-mismatch": "serve_loaded_mismatch", "placement-changed": "serve_placement_changed",
  "import-unavailable": "serve_import_unavailable", "loaded-invalid": "serve_loaded_invalid",
};

export async function serveDestination(w: ServeWorld, id: string): Promise<HandoffStep> {
  const move = await readMove(w.store, id);
  if (!move) return waiting("unknown-move");
  if (move.dest_runner !== w.runner || move.dest_machine !== w.machine) return waiting("not-destination");
  if (move.stage === "active") return done("active");
  if (move.stage !== "registry_written") return waiting(`stage:${move.stage}`);
  const receipt = move.registry_receipt;
  if (!receipt || !move.dest_facts || !move.manifest || move.dest_generation === null) return waiting("receipt-missing");

  // ANOTHER PARTY'S BLOCK stops it and is never touched; this side's own stands while the facts it was set for stand. The store's own
  // `topic_not_active` is the one block that is not waited out here: it clears itself INSIDE `serveMove` once the topic is active again.
  const block = move.block;
  const storeNote = block !== null && block.by === "store" && block.code === "topic_not_active";
  if (block && !storeNote && !(block.by === "dest" && SERVE_CODES.has(block.code))) return waiting("blocked", { by: block.by, code: block.code });

  const seen = w.loaded();
  if (!seen) return waiting("registry-unreadable", { owed: "local" });
  // THE DIGEST OF WHAT WAS LOADED IS THE RECEIPT'S, or nothing is asserted: the store compares them and answers `registry-stale` otherwise.
  if (seen.digest !== receipt.digest) return waiting("registry-stale", { owed: "local", loaded: seen.digest.slice(0, 16), receipt: String(receipt.digest).slice(0, 16) });
  const entry = agentsFor(seen.registry, { runner: w.runner }).find(one => one.id === move.agent);
  const profile = profileOf(seen.registry, move.agent);
  const build = await w.build(move.agent);
  // THE EFFECTIVE CONFIGURATION the move sealed is read again from the registry just loaded, as a launch here would read it. A launch's
  // inputs are no longer compared by the preflight alone: whatever changed since the import (a file edited, an import appearing) is refused
  // here, by section name, and clears when the facts change. A manifest that sealed none (an older one) has nothing to compare, unless the destination
  // recorded its configuration for the move (`dest_facts.effective`): then nothing was sealed that it could be compared with, and that is refused (`not-sealed`).
  const sealed = move.manifest.config;
  const unsealed = sealed === undefined && isRecord(move.dest_facts.effective);
  const config = sealed !== undefined && w.effectiveConfig ? w.effectiveConfig(move, seen.registry) : undefined;

  const fingerprint = sha256(stableText({ digest: seen.digest, profile, capabilities: build?.capabilities ?? null, present: entry !== undefined, config: config ?? null }));
  if (block && !storeNote) {
    if (isRecord(block.detail) && block.detail.fp === fingerprint) return waiting("blocked", { by: "dest", code: block.code });
    await unblockMove(w.store, id, who(w), block.code);
  }
  if (!entry || !profile) return raise(w, id, "serve_binding_mismatch", { why: !entry ? "agent-not-on-this-runner" : "profile-unreadable", fp: fingerprint });
  if (!w.serving(move.agent)) return waiting("agent-not-serving", { owed: "local" });
  if (!build) return waiting("build-unreadable", { owed: "local" });
  const differs = profileDifference(profile, move.dest_facts.profile);
  if (differs.length > 0) return raise(w, id, "serve_profile_mismatch", { sections: differs.slice(0, 16), fp: fingerprint });
  if (!sameJson(build.capabilities, move.dest_facts.capabilities)) {
    return raise(w, id, "serve_capabilities_changed", { recorded: String((move.dest_facts.capabilities as { version?: unknown }).version ?? "unknown"), now: build.version, fp: fingerprint });
  }
  if (unsealed) return raise(w, id, "serve_config_unverifiable", { reason: "not-sealed", fp: fingerprint });
  if (sealed !== undefined) {
    const why = !w.effectiveConfig ? "no-verifier" : !config ? "registry" : "unverifiable" in config ? config.unverifiable : null;
    if (why !== null) return raise(w, id, "serve_config_unverifiable", { reason: why, fp: fingerprint });
    const changed = configDifference(sealed, config);
    if (changed.length > 0) return raise(w, id, "serve_config_changed", { sections: changed.slice(0, 16), fp: fingerprint });
  }

  const loaded: LoadedEvidence = {
    agent: move.agent, runner: w.runner, machine: w.machine, placement_generation: move.dest_generation, digest: seen.digest,
    profile, capabilities: build.capabilities, imported: { generation: move.import_generation, manifest_digest: move.manifest.digest },
  };
  const answer = await serveMove(w.store, id, who(w), loaded, { digest: noteDigestOf(move) }, moveNotice(move, w.language(move.person)));
  switch (answer) {
    case "active":
      await w.say("move.served", { move: id, generation: move.import_generation, digest: seen.digest.slice(0, 16) });
      return done("active");
    case "replay":
      return done("active");
    case "registry-stale":
      return waiting("registry-stale", { owed: "local" });
    case "profile-mismatch": case "loaded-mismatch": case "placement-changed": case "import-unavailable": case "loaded-invalid":
      // The store compared what was read with what it holds and they differ: this side's block, with the facts it was read from.
      await sayOnce(w, `serve-refused:${id}:${answer}:${fingerprint}`, "move.serve-refused", { move: id, answer });
      return raise(w, id, BLOCKS[answer], { answer, fp: fingerprint });
    default:
      // `blocked` (a block appeared since the look), `topic-not-active`, `stage`, `terminal`, `not-destination`, `unknown-move`: nothing was released.
      return waiting(answer);
  }
}
