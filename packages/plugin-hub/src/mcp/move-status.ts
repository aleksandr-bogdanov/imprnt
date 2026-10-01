import { HUB_CODES } from "../hub/moves.ts";
import { EXPORT_CODES } from "../runner/move-export.ts";
import { PREFLIGHT_CODES } from "../runner/move-import.ts";
import { BLOCK as DRAIN_BLOCK } from "../runner/move.ts";
import { SERVE_CODES } from "../runner/move-serve.ts";

/**
 * What a move's block means to the owner: the stable family a block code belongs to, and who can clear it. Pure: it reads no
 * store and says no sentence (`door/move-lines.ts` does), so the words can change without any block changing its family.
 *
 * A BLOCK IS A NOTE ON THE STAGE AND NEVER A RELEASE. The move keeps its gate and its stage under every one of them. Each side clears
 * only the block it set, once its own reason is gone, and the owner has no acknowledgement that clears one: the owner's own ways out
 * are to withdraw (before activation) and, for an archived chat, to reopen it. A family therefore says WHO clears it and never that
 * anything will fix itself.
 *
 * HOW A CODE IS CLASSIFIED, in order: by membership in the sets the runtime and the hub export for what they raise, and by the two
 * codes the store writes itself; then by the prefix the sides name their codes with; then by who set it. A code nobody has
 * classified is `other`, which is still a named family with its own words, so a new code is never silent and never wrong: it is
 * worded generally until it is added here. The codes the destination's `scope_unsupported` carries as its reason
 * (`SCOPE_REASONS`) are families of that block and are named here so a reason read off a block's detail lands in the same place.
 */

export const MOVE_FAMILIES = [
  "owner_unknown", "archived", "source_unproven", "destination_setup", "engine_session", "workspace_not_carried", "registry", "loaded_mismatch", "other",
] as const;
export type MoveFamily = (typeof MOVE_FAMILIES)[number];

/** Who can clear a family: only a withdrawal, a reopen of the chat, or the side that raised it once its reason is gone. */
export type MoveClearedBy = "withdraw" | "reopen" | "side";

export const CLEARED_BY: Record<MoveFamily, MoveClearedBy> = {
  owner_unknown: "withdraw",
  archived: "reopen",
  source_unproven: "side",
  destination_setup: "side",
  engine_session: "side",
  workspace_not_carried: "side",
  registry: "side",
  loaded_mismatch: "side",
  other: "side",
};

/** The two codes the store writes on a move itself, for a condition it validated. */
export const STORE_CODES: Readonly<Record<string, MoveFamily>> = {
  drain_owner_unknown: "owner_unknown",
  topic_not_active: "archived",
};

/** The reasons the source's `scope_unsupported` block carries (`runner/move-scope.ts`): none of the move's own code is carried by a native move. */
export const SCOPE_REASONS: ReadonlySet<string> = new Set(["agent_not_in_registry", "workspace_carriage_required", "dependency_unverified"]);

/** Codes of the source's export that are about the agent's configuration and not about the engine's session. */
const SOURCE_PROFILE_CODES: ReadonlySet<string> = new Set(["profile_unverified", "profile_mismatch", "source_profile_unbound"]);

const SCOPE_UNPROVEN = "scope_unproven";
const SCOPE_UNSUPPORTED = "scope_unsupported";

export interface BlockLike { code: string; by?: "source" | "dest" | "hub" | "store" | string }

/** The family of one block. Total: every block lands in one, `other` last. */
export function moveFamilyOf(block: BlockLike): MoveFamily {
  const code = block.code;
  if (Object.hasOwn(STORE_CODES, code)) return STORE_CODES[code];
  if (code === DRAIN_BLOCK || code === SCOPE_UNPROVEN) return "source_unproven";
  if (code === SCOPE_UNSUPPORTED || SCOPE_REASONS.has(code)) return "workspace_not_carried";
  if (SOURCE_PROFILE_CODES.has(code)) return "destination_setup";
  if (HUB_CODES.has(code)) return "registry";
  if (SERVE_CODES.has(code)) return "loaded_mismatch";
  // The adapter's and the engine's own refusals (`native_*`) wherever they were raised, then the destination's preflight.
  if (code.startsWith("native_")) return "engine_session";
  if (PREFLIGHT_CODES.has(code) || code.startsWith("dest_")) return "destination_setup";
  if (EXPORT_CODES.has(code)) return "source_unproven";
  if (code.startsWith("registry_")) return "registry";
  if (code.startsWith("serve_")) return "loaded_mismatch";
  switch (block.by) {
    case "hub": return "registry";
    case "dest": return "destination_setup";
    case "source": return "source_unproven";
    default: return "other";
  }
}
