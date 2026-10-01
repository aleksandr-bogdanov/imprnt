import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DEFAULT_INSTRUCTION_FILES, vaultRootOf } from "../adapters/instructions.ts";
import { boxContextFor } from "../box/index.ts";
import { listAgents, listPeople } from "../registry/entries.ts";
import { exportGenerationOf, type MoveRow } from "../store/moves.ts";
import { errnoOf } from "../transfer/workspace.ts";
import type { Registry } from "../registry/load.ts";
import type { ScopeProof, ScopeRefusal } from "./move-handoff.ts";
import { RECHECK, signatureOf, workspacePlanOf, workspaceShapeOf } from "./move-workspace.ts";

/**
 * WHAT A MOVE CARRIES AND WHAT IT ONLY VERIFIES, and the dependencies it refuses to leave behind unproven.
 *
 * The move CARRIES one thing: the engine's own session (the transcript of the native session, nothing else in its directory). A conversation of
 * an agent whose person declares repositories, a vault or a shared-zone checkout depends on files that this move does not carry, and it does
 * not pretend to. Where every declared repository is kept in step by the hub's own sync on BOTH machines, the move VERIFIES them (`move-workspace.ts`):
 * clean and on one exact commit at the source, clean and at exactly that commit at the destination, each under the sync's lock, with what stays
 * behind (ignored files, credential-shaped untracked ones) counted. The configuration the launch reads is compared too (`move-config.ts`). Anything
 * that cannot be verified is refused here, BEFORE anything is read, stored or released (`scope_unsupported` of the source), and never a proof
 * that "nothing else is needed" that nobody established.
 *
 * THE RULE, from the registry and from a look at THIS machine's own files (metadata only: names, never a file's content):
 * - the agent must be in the registry, of the person the move names;
 * - the person's declared repositories are planned (`workspacePlanOf`): each listed by an enabled sync entry of both machines, at most 16, a
 *   vault covered by one of them, a checkout inside another provably a separate one. A repository the sync of either machine does not keep in
 *   step is `repository_unsynced`, and a vault nothing covers is `dependency_unverified` naming `vault`. The registry is the way out;
 * - THE PERSON'S OWN TREE is looked at, because the registry says nothing about what is in it. Its top-level entries are listed (names only,
 *   bounded) and each must be covered: the hub's own `sessions` and `chatlog` directories where the tree is the person's state root, the
 *   default instruction files (their content is part of the compared configuration), or something whose real path lies inside a planned
 *   repository. Any other entry is local content nothing carries or verifies (`workspace_carriage_required`, with the count and never a
 *   name); a tree that cannot be looked at is `dependency_unverified` naming `tree`.
 * A person that clears all of these gets the proof below, which says exactly that and nothing more: `native+workspace` when repositories are
 * verified, `native-only` when none is declared.
 *
 * WHAT THIS DOES NOT DO: carry any file. Ignored files, untracked credential-shaped files and everything outside a planned repository stay on the
 * source's machine, and the move says so by name instead of pretending.
 *
 * THE LOOK IS INJECTABLE (`ScopeFs`) so that a test can stand for any state of a tree without writing one; the default reads the real file
 * system, and it is what the runner calls. `generation` binds the proof to the drain it was asked for, as `exportSource` requires.
 */

/** What is at a path, from metadata alone. `names` is bounded (`LISTING_LIMIT`) and `more` says there were others. */
export type Look =
  | { kind: "absent" }
  | { kind: "file" }
  | { kind: "directory"; names: string[]; more: boolean }
  | { kind: "unreadable" };

export interface ScopeFs {
  /** What `path` is, following links as a launch does. Never a file's content. A throw is `unreadable`. */
  look(path: string): Look;
  /** The real path of `path`, or null when it has none. Absent, nothing is known to lie inside a repository. */
  real?(path: string): string | null;
}

/** How many names of one directory are listed: past it the rest is not looked at and is counted as content. */
export const LISTING_LIMIT = 256;

export const realScopeFs: ScopeFs = {
  look(path) {
    try {
      const found = statSync(path);
      if (found.isFile()) return { kind: "file" };
      if (!found.isDirectory()) return { kind: "unreadable" };
      const listed = readdirSync(path);
      return { kind: "directory", names: listed.slice(0, LISTING_LIMIT), more: listed.length > LISTING_LIMIT };
    } catch (error) {
      return errnoOf(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
    }
  },
  real(path) {
    try { return realpathSync(path); } catch { return null; }
  },
};

/**
 * The directories of a person's state root the hub itself writes and that are no dependency of this conversation: `sessions` (each
 * conversation's own native session, carried by the move that moves it) and `chatlog` (a door's file view of messages the store holds). They
 * are skipped ONLY where the tree is the state root. Everything else a state root can hold (an `inbox` of attachments a message may refer to,
 * a `watch` folder, `harvest` stages) is not listed here and so counts as content.
 */
const HUB_STATE = new Set(["sessions", "chatlog"]);

/**
 * The default instruction files an ordinary launch of `agentId` would read HERE, by name, or null when that cannot be told. The names the
 * launch itself uses (`DEFAULT_INSTRUCTION_FILES`) at the root it uses (`vaultRootOf` of the box's tree), judged as `existsSync` judges them
 * (anything at the path is a file the launch tries to read, a directory included). Empty when the person names its own list and for the triage
 * master, which reads none. The content is never read here (`move-config.ts` compares it).
 */
export function defaultInstructionsOf(registry: Registry, agentId: string, fs: ScopeFs = realScopeFs): string[] | null {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent) return null;
  const person = listPeople(registry).find(one => one.id === agent.person);
  if (agent.role === "triage" || person?.instructions !== undefined) return [];
  const tree = boxContextFor(registry, agentId).tree;
  if (tree === "") return null;
  const root = vaultRootOf(person, tree);
  return DEFAULT_INSTRUCTION_FILES.filter(name => fs.look(join(root, name)).kind !== "absent");
}

/**
 * The files whose content the compared configuration is made of and that the registry names or the launch looks for by name (settings, MCP,
 * fragment, the person's instruction list, the default instruction files), by stat: one comparable text. A file EDITED changes it; a file that an
 * instruction file imports is not named here, so while any such file exists a bounded re-look is part of the text (`RECHECK`, as for a worktree).
 */
function configShapeOf(registry: Registry, agentId: string, now: number): string | null {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent || agent.role === "triage") return null;
  const person = listPeople(registry).find(one => one.id === agent.person);
  const tree = boxContextFor(registry, agentId).tree;
  const defaults = person?.instructions !== undefined || tree === "" ? [] : DEFAULT_INSTRUCTION_FILES.map(name => join(vaultRootOf(person, tree), name));
  const files = [agent.settings, agent.mcp, agent.fragment, person?.settings, person?.mcp, ...(person?.instructions ?? []), ...defaults]
    .filter((one): one is string => typeof one === "string" && one !== "");
  const signatures = files.map(signatureOf);
  return JSON.stringify({ signatures, ...(signatures.some(one => one !== "-") ? { at: Math.floor(now / RECHECK.ms) } : {}) });
}

/**
 * What `scopeOf` and `defaultInstructionsOf` look at on this machine, and what a refusal made from them waits on, as one comparable text: the
 * default instruction files that exist, the top level of the person's tree (names, bounded, never a content), the stat of the configuration
 * files, and the stat of the person's checkouts with a bounded re-look (`workspaceShapeOf`). The text stays in this process and is only
 * compared with itself later: a refusal made from these is looked at again when it changes, which is all this says. Nothing is hashed, no git
 * and no engine is started.
 */
export function localShapeOf(registry: Registry, agentId: string, fs: ScopeFs = realScopeFs, now: number = Date.now()): string {
  const tree = boxContextFor(registry, agentId).tree;
  const seen = tree === "" ? null : fs.look(tree);
  const agent = listAgents(registry).find(one => one.id === agentId);
  return JSON.stringify({
    instructions: defaultInstructionsOf(registry, agentId, fs),
    tree: seen === null ? null : seen.kind === "directory" ? { names: [...seen.names].sort(), more: seen.more } : seen.kind,
    config: configShapeOf(registry, agentId, now),
    workspace: agent ? workspaceShapeOf(registry, agent.person, now) : null,
  });
}

/** What the person's tree holds that nothing carries or verifies: its state absent, empty, or the count of what is there. Null: it cannot be looked at. */
type Tree = { state: "absent" | "empty" | "hub-state" } | { state: "content"; entries: number; capped: boolean } | null;

const within = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
};

/**
 * `reported` are the default instruction files, whose content the compared configuration covers: they are not counted. `roots` are the planned
 * repositories' paths: an entry whose real path lies inside one is covered by that repository's own verification (the files git ignores in it
 * are counted there and are not carried). A file of a default name that is NOT reported (the person names its own list, or the agent is the
 * triage master) is an ordinary entry here.
 */
function treeOf(registry: Registry, agentId: string, fs: ScopeFs, reported: readonly string[], roots: readonly string[]): Tree {
  const box = boxContextFor(registry, agentId);
  if (box.tree === "") return null;
  const seen = fs.look(box.tree);
  if (seen.kind === "absent") return { state: "absent" };
  if (seen.kind !== "directory") return null;
  // An absent state root proves nothing about who owns the tree: only a defined, non-empty one that IS the tree does.
  const stateRoot = box.stateRoot;
  const hubOwned = typeof stateRoot === "string" && stateRoot !== "" && resolve(stateRoot) === resolve(box.tree);
  const real = roots.map(root => fs.real?.(root)).filter((one): one is string => typeof one === "string");
  const covered = (name: string): boolean => {
    const at = real.length === 0 ? null : fs.real?.(join(box.tree, name)) ?? null;
    return at !== null && real.some(root => within(root, at));
  };
  const others = seen.names.filter(name => !(hubOwned && HUB_STATE.has(name)) && !reported.includes(name) && !covered(name));
  if (others.length > 0 || seen.more) return { state: "content", entries: others.length, capped: seen.more };
  return { state: hubOwned && seen.names.some(name => HUB_STATE.has(name)) ? "hub-state" : "empty" };
}

const SAYS: Record<"absent" | "empty" | "hub-state", string> = {
  absent: "is absent", empty: "is empty", "hub-state": "holds only the hub's own session and chat-log directories",
};

export function scopeOf(registry: Registry, move: MoveRow, fs: ScopeFs = realScopeFs): ScopeProof | ScopeRefusal | null {
  const generation = exportGenerationOf(move);
  if (generation === null) return null;
  const agent = listAgents(registry).find(one => one.id === move.agent);
  if (!agent || agent.person !== move.person) return { refused: "agent_not_in_registry" };
  const look = workspacePlanOf(registry, agent.person, { source: move.source_machine, dest: move.dest_machine });
  if (look.kind === "refused") return { refused: look.refused, ...(look.detail ? { detail: look.detail } : {}) };
  const repositories = look.kind === "plan" ? look.plan.repos : [];

  // The default instruction files are named by the compared configuration, so they are not a refusal of their own: only the tree's other entries are looked at here.
  const instructions = defaultInstructionsOf(registry, agent.id, fs);
  const tree = treeOf(registry, agent.id, fs, instructions ?? [], repositories.map(one => one.path));
  if (tree !== null && tree.state === "content") {
    return { refused: "workspace_carriage_required", detail: { local_tree: { entries: tree.entries, ...(tree.capped ? { capped: true } : {}) } } };
  }
  if (tree === null) return { refused: "dependency_unverified", detail: { dependencies: ["tree"] } };
  // The basis is kept in the sealed manifest and `scopeProven` refuses one over 256 characters: no path, no name of anything found.
  return {
    move: move.id, conversation: move.conversation_id, agent: move.agent, generation, carries: repositories.length > 0 ? "native+workspace" : "native-only",
    basis: repositories.length > 0
      ? `registry and local look: ${repositories.length} repositories synced on both machines are verified at the handoff, not carried; the tree outside them ${SAYS[tree.state]}; only the transcript is carried`
      : `registry and local look: no repository, vault or shared-zone checkout is declared, the person's tree ${SAYS[tree.state]}; only the session's transcript is carried`,
  };
}
