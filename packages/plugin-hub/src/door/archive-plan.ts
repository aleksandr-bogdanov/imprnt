import type { ChannelInfo, ChannelOverwrite } from "./platform.ts";

/**
 * What archiving a chat changes in Discord, worked out exactly, and what undoing it means. PURE:
 * nothing here reads a channel or asks for a change, so what a channel was and what it should be
 * are values a check can hold up next to each other.
 *
 * TWO CHANGES, and only two: the channel goes into the configured archive category, and the
 * roles the door names are denied writing in it. The overwrite is a pair of bit sets, and only
 * the bits of `READONLY_MASK` are ever touched, so whatever else somebody allowed or denied a
 * role on that channel is left alone. Everything the change replaced is recorded in the plan (the
 * category it was in, the exact entry each role had), so a reopen puts back what the archive
 * changed and nothing it did not.
 *
 * A REOPEN WILL NOT OVERWRITE SOMEBODY ELSE'S EDIT. The channel is put back only where it still
 * shows exactly what the archive made; where it shows anything else (moved elsewhere, a role's
 * permissions edited since) it is left as it is and the difference is reported. That is the
 * meaning of "detect external conflicting edits", and it is asked once, here.
 */

/**
 * The permission bits that make a channel read only for a role: SEND_MESSAGES (1 << 11),
 * CREATE_PUBLIC_THREADS (1 << 35), CREATE_PRIVATE_THREADS (1 << 36) and SEND_MESSAGES_IN_THREADS
 * (1 << 38). Reactions are left alone, so the history can still be reacted to. Bit positions are
 * from Discord's permissions reference and are what live validation has to confirm.
 */
export const READONLY_MASK: bigint = (1n << 11n) | (1n << 35n) | (1n << 36n) | (1n << 38n);

export interface RolePlan {
  id: string;
  /** The entry the role had, exactly, or null when it had none. */
  prior: ChannelOverwrite | null;
  /** The entry the archive made. */
  applied: ChannelOverwrite;
  /** False when the role already could not write there, so there is nothing of this archive's to undo. */
  changed: boolean;
}

/**
 * A `type` and not an `interface` on purpose: the plan is stored as a JSON object
 * (`recordChannel` takes `Record<string, unknown>`), and only a type alias of an object type is
 * assignable to that. An interface has no implicit index signature and would need a cast.
 */
export type ArchivePlan = {
  /** The category the chat was in before, or null for none. Meaningful only when `prior_parent_known`. */
  prior_parent: string | null;
  /** False when nothing recorded where the chat was before it was found in the archive category. */
  prior_parent_known: boolean;
  apply_parent: string;
  roles: RolePlan[];
  mask: string;
};

const big = (value: string): bigint => {
  try { return BigInt(value); } catch { return 0n; }
};

/** Two entries are the same when they are about the same thing and allow and deny the same bits. */
export function sameOverwrite(a: ChannelOverwrite | null | undefined, b: ChannelOverwrite | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.type === b.type && big(a.allow) === big(b.allow) && big(a.deny) === big(b.deny);
}

const entryOf = (channel: ChannelInfo, role: string): ChannelOverwrite | null =>
  channel.permission_overwrites.find(one => one.id === role && one.type === 0) ?? null;

/**
 * The plan for archiving `channel`. `observedFrom` is where the chat was last seen before it was
 * found in the archive category, for a chat somebody else moved there: it is the only source of a
 * prior category when the chat is already in it, and without one the prior category is not known.
 */
export function planArchive(channel: ChannelInfo, config: { category: string; readonlyRoles: readonly string[] },
  observedFrom?: string | null): ArchivePlan {
  const inside = channel.parent_id === config.category;
  const roles: RolePlan[] = config.readonlyRoles.map(id => {
    const prior = entryOf(channel, id);
    const applied: ChannelOverwrite = {
      id, type: 0,
      allow: (big(prior?.allow ?? "0") & ~READONLY_MASK).toString(),
      deny: (big(prior?.deny ?? "0") | READONLY_MASK).toString(),
    };
    return { id, prior, applied, changed: !sameOverwrite(prior, applied) };
  });
  return {
    prior_parent: inside ? (observedFrom ?? null) : channel.parent_id,
    prior_parent_known: !inside || observedFrom !== undefined,
    apply_parent: config.category,
    roles,
    mask: READONLY_MASK.toString(),
  };
}

/** The overwrites the channel should have after the plan: every other entry as it is, the planned roles as planned. */
export function withArchived(current: readonly ChannelOverwrite[], plan: ArchivePlan): ChannelOverwrite[] {
  const planned = new Map(plan.roles.map(role => [role.id, role.applied]));
  const kept = current.filter(one => !(one.type === 0 && planned.has(one.id)));
  return [...kept, ...planned.values()];
}

/** Whether the channel shows exactly what the archive makes: in the category, and each role denied as planned. */
export function showsArchived(channel: ChannelInfo, plan: ArchivePlan): boolean {
  return channel.parent_id === plan.apply_parent && plan.roles.every(role => sameOverwrite(entryOf(channel, role.id), role.applied));
}

/** Whether the channel shows exactly what it was before: nothing of the archive is on it. */
export function showsPrior(channel: ChannelInfo, plan: ArchivePlan): boolean {
  return (!plan.prior_parent_known || channel.parent_id === plan.prior_parent)
    && plan.roles.every(role => sameOverwrite(entryOf(channel, role.id), role.prior));
}

export type Left = "category" | "permissions";

export interface RestorePlan {
  /** Set only when the chat is to be moved back. */
  parent_id?: string | null;
  /** The whole list the channel is to have, set only when a role's entry is to change. */
  overwrites?: ChannelOverwrite[];
  /** What was found changed by somebody else, and is left as it is. */
  left: Left[];
  /** Nothing is asked of the platform. */
  nothing: boolean;
}

/**
 * What putting the channel back means now. `moveParent` is false when the category was changed by
 * somebody else (a person moved the chat out of the archive category), which is the reopen already
 * and is never a conflict.
 */
export function planRestore(channel: ChannelInfo, archive: ArchivePlan, options: { moveParent: boolean }): RestorePlan {
  const left = new Set<Left>();
  const out: RestorePlan = { left: [], nothing: true };
  if (options.moveParent) {
    if (channel.parent_id === archive.apply_parent) {
      if (archive.prior_parent_known) out.parent_id = archive.prior_parent;
      else left.add("category");
    } else if (!(archive.prior_parent_known && channel.parent_id === archive.prior_parent)) {
      left.add("category");
    }
  }
  let overwrites = [...channel.permission_overwrites];
  let touched = false;
  for (const role of archive.roles) {
    if (!role.changed) continue;
    const now = entryOf(channel, role.id);
    if (sameOverwrite(now, role.applied)) {
      overwrites = overwrites.filter(one => !(one.type === 0 && one.id === role.id));
      if (role.prior) overwrites.push(role.prior);
      touched = true;
    } else if (!(now === null && role.prior === null) && !sameOverwrite(now, role.prior)) {
      left.add("permissions");
    }
  }
  if (touched) out.overwrites = overwrites;
  out.left = [...left];
  out.nothing = out.parent_id === undefined && out.overwrites === undefined;
  return out;
}
