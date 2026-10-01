import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_INSTRUCTION_FILES, vaultRootOf } from "../adapters/instructions.ts";
import { boxContextFor } from "../box/index.ts";
import { listAgents, listPeople, listRepositories, zoneRepositoryFor } from "../registry/entries.ts";
import { exportGenerationOf, type MoveRow } from "../store/moves.ts";
import { errnoOf } from "../transfer/workspace.ts";
import type { Registry } from "../registry/load.ts";
import type { ScopeProof, ScopeRefusal } from "./move-handoff.ts";

/**
 * WHAT A NATIVE MOVE CARRIES, and the dependencies it refuses to leave behind unproven.
 *
 * The move carries ONE thing: the engine's own session (the transcript of the native session, nothing else in its directory). A conversation
 * of an agent whose person declares a repository, a vault or a shared-zone checkout may depend on files that this move does not carry. A
 * repository's working copy can hold files the agent edited and never committed, or a checkout at a revision the other machine does not have;
 * the transfer library can carry such a working copy (`transfer/repos.ts`, `transfer/materialize.ts`), but nothing in the hub yet says which
 * repositories a conversation depends on, snapshots them into the move's bounded blobs, verifies them at the destination under the same
 * receipt discipline, or clears them at a withdrawal. A vault and the zone travel by the hub's git sync (`sync/run.ts`), which commits what
 * the agents filed and pushes and pulls it on a schedule, in its own process, and which nothing here awaits, bounds or reads back: a
 * periodic sync that has not run, has not finished or has stopped on a rebase it could not resolve leaves the destination without what the
 * conversation filed, and nothing in the registry or in a note says otherwise. Each of those is therefore a refusal, made BEFORE anything is
 * read, stored or released (`scope_unsupported` of the source), and never a proof that "nothing else is needed" that nobody established.
 *
 * THE RULE, from the registry and from a look at THIS machine's own files (metadata only: names, never a file's content):
 * - the agent must be in the registry, of the person the move names;
 * - the person declares no repository other than the zone checkout (`workspace_carriage_required`, naming the repositories);
 * - the person declares no vault and no zone checkout (`dependency_unverified`, naming `vault` and/or `zone`). There is no owner acknowledgement
 *   of either: the refusal clears only when the registry no longer declares the dependency (or, later, when a module that snapshots or
 *   awaits the sync and verifies the result at the destination exists and answers with a proof; this file does not guess that module's shape);
 * - THE PERSON'S OWN TREE is looked at, because an absent declaration says nothing about what is in it. A person that declares no vault works
 *   in its tree (`vaultRootOf`), the launch binds it writable (`boxContextFor`'s `tree`), and nothing syncs or carries it. Its top-level
 *   entries are listed (names only, bounded): none, or none but the hub's own `sessions` and `chatlog` directories where the tree is the
 *   person's state root, is the only answer that passes. Any other entry is local content this move does not carry
 *   (`workspace_carriage_required`, with the count and never a name); a tree that cannot be looked at is `dependency_unverified` naming `tree`;
 * - THE DEFAULT INSTRUCTION FILES (`CLAUDE.md`, `CLAUDE.local.md` of the vault root, which an ordinary launch appends to the agent's system
 *   prompt when the person names no list) are part of what the agent runs under, and nothing compares their content between machines (the
 *   profile holds names, and never a digest of a file). One that exists here is `dependency_unverified` naming `instruction:<name>`, and one
 *   that exists at the destination is the destination's own refusal (`defaultInstructionsOf`, asked by its preflight). Their content is never
 *   read, hashed or exported by this file. The triage master's launch reads no instruction file, so neither is asked about it.
 * A person that clears all of these gets the proof below, which says exactly that and nothing more.
 *
 * WHAT THIS DOES NOT DO: carry any of it. A conversation whose person has a repository, a vault, a zone checkout, a tree with files in it or
 * a default instruction file is not moved by this runtime; that is the workspace slice's, and the move says so by name instead of pretending.
 * The content of the files the agent's configuration points at is the profile's gate (`move-profile.ts`), not this file's.
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
 * (anything at the path is a file the launch tries to read, a directory included). Empty when the person names its own list (the profile holds
 * that as `person.instructions`) and for the triage master, which reads none. The content is never read.
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
 * What `scopeOf` and `defaultInstructionsOf` look at on this machine, as one comparable text: the default instruction files that exist and the top
 * level of the person's tree (names, bounded, never a content; the text stays in this process and is only compared with itself later). A refusal
 * made from these is looked at again when it changes, which is all this says: whether the refusal still holds is those functions' answer.
 */
export function localShapeOf(registry: Registry, agentId: string, fs: ScopeFs = realScopeFs): string {
  const tree = boxContextFor(registry, agentId).tree;
  const seen = tree === "" ? null : fs.look(tree);
  return JSON.stringify({
    instructions: defaultInstructionsOf(registry, agentId, fs),
    tree: seen === null ? null : seen.kind === "directory" ? { names: [...seen.names].sort(), more: seen.more } : seen.kind,
  });
}

/** What the person's tree holds that nothing carries: its state absent, empty, or the count of what is there. Null: it cannot be looked at. */
type Tree = { state: "absent" | "empty" | "hub-state" } | { state: "content"; entries: number; capped: boolean } | null;

/**
 * `reported` are the default instruction files this look already names on their own (`defaultInstructionsOf`): they are not counted twice. A
 * file of that name that is NOT reported (the person names its own list, or the agent is the triage master) is an ordinary entry here.
 */
function treeOf(registry: Registry, agentId: string, fs: ScopeFs, reported: readonly string[]): Tree {
  const box = boxContextFor(registry, agentId);
  if (box.tree === "") return null;
  const seen = fs.look(box.tree);
  if (seen.kind === "absent") return { state: "absent" };
  if (seen.kind !== "directory") return null;
  // An absent state root proves nothing about who owns the tree: only a defined, non-empty one that IS the tree does.
  const stateRoot = box.stateRoot;
  const hubOwned = typeof stateRoot === "string" && stateRoot !== "" && resolve(stateRoot) === resolve(box.tree);
  const others = seen.names.filter(name => !(hubOwned && HUB_STATE.has(name)) && !reported.includes(name));
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
  const repositories = listRepositories(registry).filter(one => one.person === agent.person && one.zone !== true);
  const person = listPeople(registry).find(one => one.id === agent.person);
  const synced = [
    ...(typeof person?.vault === "string" && person.vault !== "" ? ["vault"] : []),
    ...(zoneRepositoryFor(registry, agent.person) !== null ? ["zone"] : []),
  ];
  if (repositories.length > 0) {
    return {
      refused: "workspace_carriage_required",
      detail: { repositories: repositories.map(one => one.id).sort().slice(0, 8), count: repositories.length, ...(synced.length > 0 ? { dependencies: synced } : {}) },
    };
  }
  if (synced.length > 0) return { refused: "dependency_unverified", detail: { dependencies: synced } };

  // Nothing is declared, which proves nothing about what is there: the tree and the default instruction files are looked at, here, now.
  const instructions = defaultInstructionsOf(registry, agent.id, fs);
  const tree = treeOf(registry, agent.id, fs, instructions ?? []);
  const unverified = [...(tree === null ? ["tree"] : []), ...(instructions === null ? ["instructions"] : instructions.map(name => `instruction:${name}`))];
  if (tree !== null && tree.state === "content") {
    return {
      refused: "workspace_carriage_required",
      detail: { local_tree: { entries: tree.entries, ...(tree.capped ? { capped: true } : {}) }, ...(unverified.length > 0 ? { dependencies: unverified } : {}) },
    };
  }
  if (tree === null || unverified.length > 0) return { refused: "dependency_unverified", detail: { dependencies: unverified } };
  // The basis is kept in the sealed manifest and `scopeProven` refuses one over 256 characters: no path, no name of anything found.
  return {
    move: move.id, conversation: move.conversation_id, agent: move.agent, generation, carries: "native-only",
    basis: `registry and local look: no repository, vault or shared-zone checkout is declared, the person's tree ${SAYS[tree.state]}, ` +
      `${agent.role === "triage" ? "the launch reads no instruction file" : "no default instruction file exists"}; only the session's transcript is carried`,
  };
}
