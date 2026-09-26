// Test infrastructure: a scratch registry file.
//
// Every door and every runner reads its settings from a registry file, so a
// check that starts one needs a real file naming the throwaway cluster and a
// temporary state dir. `writeRegistry` renders one and returns its path.
//
// The file it writes is a file `loadRegistry` accepts: `hub.tick_seconds` is
// set and every `[[run]]` entry carries an id, a kind, a schedule and a
// positive memory limit.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PresetSpec {
  adapter?: string;
  model?: string;
  provider?: string;
  effort?: string;
  paid?: string;
  /** Which declared credential this preset's loop reads its login from. */
  credential?: string;
  /** The three window thresholds, percent, on a `paid = "plan"` preset. */
  window_pause_at?: number;
  window_notice_at?: number;
  window_hold_at?: number;
  /** Anything else, so a refusal check can plant a forbidden key. */
  [key: string]: string | number | undefined;
}

/**
 * An agent. `chat` and `door` are OPTIONAL together: an agent that names
 * neither has no chat at all and exists only to be given jobs, and an agent
 * that names one without the other is a shape a refusal check plants
 * deliberately.
 */
export interface AgentSpec {
  id: string;
  person: string;
  preset: string;
  chat?: string;
  door?: string;
  runner: string;
  [key: string]: string | number | undefined;
}

export interface RateSpec {
  model: string;
  from: string;
  input_per_m: number;
  cached_per_m: number;
  output_per_m: number;
  currency: string;
}

export interface RunSpec {
  id: string;
  kind: string;
  schedule?: string;
  memory_limit_mb?: number;
  platform?: string;
  person?: string;
  token_file?: string;
  /** Which machine runs this entry. Absent is legal below two machines. */
  machine?: string;
  /** The limit the RUNNER enforces on its model child, not its own. */
  child_memory_limit_mb?: number;
  /** The one specific address a board listens on. */
  bind?: string;
  /**
   * The port, and the two kinds that carry one carry it for their own reason: a
   * board is reached there on the address above, and a `kind = "transcriber"`
   * entry is reached there on loopback by the door beside it.
   */
  port?: number;
  /** The second port a board serves artifacts on, which is their own origin. */
  artifacts_port?: number;
  /** Whether the hub keeps this entry running. Absent means it does. */
  enabled?: boolean;
  /**
   * The recognizer's other two. `residency` says whether the model is held or
   * dropped between notes, and `idle_seconds` is the window the dropping one
   * waits. Each renders nothing when the spec names none.
   */
  residency?: string;
  idle_seconds?: number;
  /** The three argvs an off-box copy runs, each a list of plain arguments. */
  dump_argv?: string[];
  upload_argv?: string[];
  readback_argv?: string[];
  /** Where the copy goes. The argvs receive it and code never parses it. */
  destination?: string;
  /** The Discord server a door resolves a channel name against. */
  guild?: string;
  /** The preset an agent adopted through this door is created with. */
  default_preset?: string;
  /** The declared repository ids a `kind = "sync"` entry keeps in step. */
  repositories?: string[];
  /**
   * A watch's own: where it reads, whose chat it writes into (`person` above
   * and this agent), the key it reads with, the organisation and the query it
   * asks, and the three counts its digest is cut by.
   */
  source?: string;
  agent?: string;
  credential?: string;
  org?: string;
  query?: string;
  min_events?: number;
  notify_events?: number;
  reminder_days?: number;
}

/**
 * One recognizer the household may name. Every field is optional so a check can
 * render a table with one deliberately missing, and the index signature admits
 * a key the loader has no rule about so a check can prove that novelty alone is
 * not what gets refused.
 */
export interface RecognizerSpec {
  provider?: string;
  model?: string;
  runtime?: string;
  credential?: string;
  chunk_seconds?: number;
  [key: string]: string | number | undefined;
}

/** A machine the household has. `os` is in the file, never process.platform. */
export interface MachineSpec {
  id: string;
  os?: string;
  /** This machine's own paths, where they differ from the `[hub]` table's. */
  state_dir?: string;
  secrets_dir?: string;
  store_url?: string;
  [key: string]: string | number | undefined;
}

/** Where a person or a credential is on one machine, keyed by machine id. */
export type PlacementSpec = Record<string, Record<string, string | undefined>>;

/** A person and the tree that is their boundary. */
export interface PersonSpec {
  id: string;
  tree?: string;
  /** The language this person reads the door's own lines in. */
  language?: string;
  /** The four stamp thresholds, seconds, this person's own. */
  acked_seconds?: number;
  started_seconds?: number;
  answered_seconds?: number;
  delivered_seconds?: number;
  /** How long this person waits for a voice note's own text, seconds. */
  transcribed_seconds?: number;
  /**
   * The five harvest fields, this person's own. Each one is OPTIONAL and
   * renders nothing when the spec names none, so a spec written without them
   * produces the file it produces today, byte for byte.
   *
   * `harvest_report` is why the index signature below admits a boolean. It was
   * `string | number | undefined`, so `harvest_report = false` could not be
   * rendered at all and a check that asked for one would have asserted against
   * a file that said nothing.
   */
  harvester?: string;
  vault?: string;
  harvest_quiet_minutes?: number;
  harvest_min_messages?: number;
  harvest_report?: boolean;
  /** This person's tree and vault on a machine that is not the hub's. */
  on?: PlacementSpec;
  [key: string]: string | number | boolean | PlacementSpec | undefined;
}

/**
 * A credential this household has: one owner, one place, and every agent
 * that uses it points at that file.
 */
export interface CredentialSpec {
  id: string;
  kind?: string;
  file?: string;
  owner?: string;
  /** The macOS keychain item a claude-login is kept in, by service name. */
  keychain?: string;
  /** This credential's file and source on a machine that is not the hub's. */
  on?: PlacementSpec;
  [key: string]: string | number | PlacementSpec | undefined;
}

/**
 * The `[store]` section: where Postgres's own pid file is, and what
 * the machine's service manager calls it. Both are written by the install
 * script and read by the hub, so a check that plants one needs the file to
 * carry it.
 */
export interface StoreSpec {
  pid_file?: string;
  unit?: string;
  [key: string]: string | number | undefined;
}

/**
 * The household's shared zone: the folder name every vault carries it under,
 * the git remote NAME every checkout wears, and the URL a clone reads. The
 * index signature is there so a refusal check can render a field deliberately
 * missing or deliberately of the wrong type.
 */
export interface ZoneSpec {
  mount?: string;
  remote?: string;
  url?: string;
  [key: string]: string | number | boolean | undefined;
}

/** One declared repository. `zone` marks a person's checkout of the zone. */
export interface RepositorySpec {
  id?: string;
  person?: string;
  path?: string;
  remote?: string;
  branch?: string;
  required?: boolean;
  zone?: boolean;
  [key: string]: string | number | boolean | undefined;
}

/** The seven a repository entry renders first, in the order the file reads in. */
const REPOSITORY_KEYS = ["id", "person", "path", "remote", "branch", "required", "zone"] as const;

export interface RegistrySpec {
  hub?: Record<string, string | number>;
  store?: StoreSpec;
  /** The `[voice]` table: which recognizer the household names, and its knobs. */
  voice?: Record<string, string | number>;
  /** One `[recognizers.<name>]` table each. */
  recognizers?: Record<string, RecognizerSpec>;
  presets?: Record<string, PresetSpec>;
  agents?: AgentSpec[];
  rates?: RateSpec[];
  run?: RunSpec[];
  machines?: MachineSpec[];
  people?: PersonSpec[];
  credentials?: CredentialSpec[];
  /** The `[zone]` table, absent unless a check asks for one. */
  zone?: ZoneSpec;
  /** The `[[repositories]]` entries, absent unless a check asks for them. */
  repositories?: RepositorySpec[];
}

const HUB_DEFAULTS: Record<string, string | number> = {
  tick_seconds: 5,
  tail_hours: 24,
  tail_tokens: 8000,
  claim_lease_seconds: 300,
};

/**
 * One TOML value.
 *
 * A number renders bare, a string renders JSON-quoted, and a BOOLEAN renders as
 * TOML's own bare words `true` and `false`. The boolean branch is written out
 * rather than left to `String` or to `JSON.stringify` landing on the right
 * answer by accident: the `harvest_report` is the first false a check
 * ever asks this helper to write, and a quoted `"false"` is a string the loader
 * would refuse.
 *
 * A LIST renders as a TOML array of quoted strings, written out for the same
 * reason: an argv left to `String` renders as one comma-joined string, which is
 * the wrong shape and one the loader reads as a single argument.
 */
function value(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((one) => JSON.stringify(one)).join(", ")}]`;
  if (typeof v === "boolean") return v ? "true" : "false";
  // A plain object renders as an INLINE table, on the entry's own line, which
  // is the one shape a per-machine placement (`on = { mac = { ... } }`) takes
  // in a file the line editor can still find entries in.
  if (v !== null && typeof v === "object") {
    const pairs = Object.entries(v as Record<string, unknown>)
      .filter(([, one]) => one !== undefined)
      .map(([key, one]) => `${key} = ${value(one)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

function table(lines: string[], entries: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(entries)) {
    if (raw === undefined) continue;
    lines.push(`${key} = ${value(raw)}`);
  }
}

/**
 * `child_memory_limit_mb` is required on every `kind = "runner"` entry, by
 * name. Every implied runner carries one, so
 * a shipped check does not fail on contact with that refusal.
 * The loader tolerates a key it has no rule about, exactly as it
 * tolerates the newer fields, so the file still loads unchanged.
 */
const DEFAULT_CHILD_LIMIT_MB = 2048;

/**
 * The three window thresholds are required on every `paid = "plan"`
 * preset, by name. Every plan preset this helper renders
 * carries them, for the reason above: without it every check that
 * stages a hub turns red the moment the loader requires them, and that is a
 * fixture problem wearing a production failure's clothes. Today's loader
 * tolerates a key it has no rule about, so the file still loads unchanged.
 *
 * The numbers are v2's own, which is what `src/registry/registry.example.toml`
 * ships. A check that is ABOUT the thresholds says its own, and `test/runner-window.test.ts`
 * deliberately says numbers that are not these, so a build carrying v2's in
 * code passes nothing there.
 *
 * A `paid = "key"` preset carries NONE, because the loader refuses them there,
 * and a spec that names a field explicitly as `undefined` gets none either, so
 * a check can render a plan preset with a field missing on purpose.
 */
const DEFAULT_WINDOW: Record<string, number> = {
  window_pause_at: 85,
  window_notice_at: 95,
  window_hold_at: 100,
};

/** The `[[run]]` entries the agents imply, when the spec names none itself. */
function impliedRun(agents: AgentSpec[]): RunSpec[] {
  const out: RunSpec[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    // An agent naming no door has no chat, so there is no door to imply for it
    // and inventing one would render an entry with no id at all.
    if (agent.door && !seen.has(agent.door)) {
      seen.add(agent.door);
      out.push({
        id: agent.door,
        kind: "door",
        platform: "fake",
        person: agent.person,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      });
    }
    if (!seen.has(agent.runner)) {
      seen.add(agent.runner);
      out.push({
        id: agent.runner,
        kind: "runner",
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: DEFAULT_CHILD_LIMIT_MB,
      });
    }
  }
  if (out.length === 0) {
    out.push({
      id: "door-fake",
      kind: "door",
      platform: "fake",
      person: "p1",
      token_file: "/dev/null",
      schedule: "always",
      memory_limit_mb: 192,
    });
    out.push({
      id: "runner-test",
      kind: "runner",
      schedule: "always",
      memory_limit_mb: 512,
      child_memory_limit_mb: DEFAULT_CHILD_LIMIT_MB,
    });
  }
  return out;
}

function renderRegistry(spec: RegistrySpec): string {
  const lines: string[] = ["# a scratch registry written by a check", ""];

  lines.push("[hub]");
  // A machine reaching the store by its own route makes the file a set of
  // copies, and the loader then requires the machine whose copy is the one.
  // A spec that names none gets the first machine, which is the hub's in
  // every two-machine stage, so a spec written before the field existed
  // renders the file it always did unless it routes a machine on its own.
  const routed = (spec.machines ?? []).some((one) => one.store_url !== undefined);
  const authority = routed && spec.hub?.store_machine === undefined ? { store_machine: spec.machines![0].id } : {};
  table(lines, { ...HUB_DEFAULTS, ...authority, ...(spec.hub ?? {}) });
  lines.push("");

  if (spec.store) {
    lines.push("[store]");
    table(lines, spec.store as Record<string, unknown>);
    lines.push("");
  }

  // The household's recognizer, where the shipped example carries it. An
  // absent section renders NOTHING, so a spec that names no voice field
  // produces the same file it produces today, byte for byte.
  if (spec.voice) {
    lines.push("[voice]");
    table(lines, spec.voice as Record<string, unknown>);
    lines.push("");
  }

  if (spec.zone) {
    lines.push("[zone]");
    table(lines, spec.zone as Record<string, unknown>);
    lines.push("");
  }

  // An absent section renders NOTHING, so a spec that names no machines and no
  // people produces the same file it produces today and no earlier check sees a
  // different registry.
  for (const machine of spec.machines ?? []) {
    lines.push("[[machines]]");
    table(lines, machine as Record<string, unknown>);
    lines.push("");
  }

  for (const person of spec.people ?? []) {
    lines.push("[[people]]");
    table(lines, person as Record<string, unknown>);
    lines.push("");
  }

  for (const credential of spec.credentials ?? []) {
    lines.push("[[credentials]]");
    table(lines, credential as Record<string, unknown>);
    lines.push("");
  }

  // After the credentials, which is where the shipped example carries them.
  // The seven keys are named in order and anything else the spec set follows,
  // so a check can plant a field the loader has no rule about.
  for (const repository of spec.repositories ?? []) {
    lines.push("[[repositories]]");
    table(lines, {
      ...Object.fromEntries(REPOSITORY_KEYS.map((key) => [key, repository[key]])),
      ...Object.fromEntries(
        Object.entries(repository).filter(([key]) => !(REPOSITORY_KEYS as readonly string[]).includes(key)),
      ),
    });
    lines.push("");
  }

  for (const [name, preset] of Object.entries(spec.presets ?? {})) {
    lines.push(`[presets.${name}]`);
    const window: Record<string, number> = {};
    if (preset.paid === "plan") {
      for (const [key, number] of Object.entries(DEFAULT_WINDOW)) {
        if (!(key in preset)) window[key] = number;
      }
    }
    table(lines, { ...(preset as Record<string, unknown>), ...window });
    lines.push("");
  }

  // After the presets, which is where the shipped example carries them: a
  // recognizer may name a credential, and the credential tables are above.
  for (const [name, recognizer] of Object.entries(spec.recognizers ?? {})) {
    lines.push(`[recognizers.${name}]`);
    table(lines, recognizer as Record<string, unknown>);
    lines.push("");
  }

  for (const agent of spec.agents ?? []) {
    lines.push("[[agents]]");
    table(lines, agent as Record<string, unknown>);
    lines.push("");
  }

  for (const rate of spec.rates ?? []) {
    lines.push("[[rates]]");
    table(lines, rate as unknown as Record<string, unknown>);
    lines.push("");
  }

  // This call renders the keys it is HANDED and nothing else, so a field added
  // to `RunSpec` alone is a field no rendered file ever carries and a check
  // that planted it would assert against a registry it never wrote. An absent
  // field still renders nothing, which is what keeps a spec that names none of
  // these byte-identical to the file it produced before they existed.
  for (const entry of spec.run ?? impliedRun(spec.agents ?? [])) {
    lines.push("[[run]]");
    table(lines, {
      id: entry.id,
      kind: entry.kind,
      machine: entry.machine,
      platform: entry.platform,
      person: entry.person,
      token_file: entry.token_file,
      schedule: entry.schedule ?? "always",
      memory_limit_mb: entry.memory_limit_mb ?? 256,
      child_memory_limit_mb: entry.child_memory_limit_mb,
      bind: entry.bind,
      port: entry.port,
      artifacts_port: entry.artifacts_port,
      enabled: entry.enabled,
      residency: entry.residency,
      idle_seconds: entry.idle_seconds,
      guild: entry.guild,
      default_preset: entry.default_preset,
      destination: entry.destination,
      dump_argv: entry.dump_argv,
      upload_argv: entry.upload_argv,
      readback_argv: entry.readback_argv,
      repositories: entry.repositories,
      source: entry.source,
      agent: entry.agent,
      credential: entry.credential,
      org: entry.org,
      query: entry.query,
      min_events: entry.min_events,
      notify_events: entry.notify_events,
      reminder_days: entry.reminder_days,
    });
    lines.push("");
  }

  return lines.join("\n");
}

export function writeRegistry(dir: string, spec: RegistrySpec): string {
  const file = join(dir, "registry.toml");
  writeFileSync(file, renderRegistry(spec), "utf8");
  return file;
}
