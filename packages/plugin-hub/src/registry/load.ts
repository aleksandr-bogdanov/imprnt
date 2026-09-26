import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isUnspecified } from "../net/address.ts";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";
import { scheduleSeconds } from "../os/diff.ts";
import {
  artifactsNotBoolean,
  boardArtifactsPort,
  boardBindMissing,
  boardBindNotAddress,
  boardBindWide,
  boardPort,
  enabledNotBoolean,
  enabledOnBoard,
  enabledOnHub,
} from "../door/lines.ts";

/**
 * The registry is the only place a setting lives. Every setting the code reads
 * is declared here, the loader refuses a file that does not carry a declared
 * required one, and an accessor refuses a key nothing declared. Nothing in this
 * module reads the environment or the command line, at call time or at import
 * time: a value that is not in the file does not exist.
 */
export interface SettingField {
  key: string;
  type: "integer" | "string" | "boolean" | "array";
  what: string;
  required?: boolean;
}

const ROLLOUT_DEFAULTS: Record<string, number> = {
  "door.media_max_bytes": 20971520,
  "door.delivery_retry_seconds": 30,
  "door.delivery_max_attempts": 5,
  "door.read_retry_seconds": 30,
  "door.read_timeout_seconds": 60,
  "door.read_notice_after_seconds": 300,
  "runner.task_retry_seconds": 30,
};

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "hub.tick_seconds",
    type: "integer",
    what: "how often the hub re-reads the registry and acts on what changed",
  },
  {
    key: "hub.store_url",
    type: "string",
    what: "where the one store is, with no user: a process supplies its own role",
    required: false,
  },
  {
    key: "hub.state_dir",
    type: "string",
    what: "the directory the chat logs are written under",
    required: false,
  },
  // Where each store role's password file is, which every box masks.
  // Absent, it is `secrets` under hub.state_dir.
  {
    key: "hub.secrets_dir",
    type: "string",
    what: "the directory holding each store role's password, which no agent's box can read",
    required: false,
  },
  {
    key: "hub.tail_hours",
    type: "integer",
    what: "how many hours of the chat log a spawned session is fed",
    required: false,
  },
  {
    key: "hub.tail_tokens",
    type: "integer",
    what: "the size of that tail, one number for the household",
    required: false,
  },
  {
    key: "hub.claim_lease_seconds",
    type: "integer",
    what: "how long a runner's claim on a message stands before another may take it",
    required: false,
  },
  {
    key: "hub.restart_delay_seconds",
    type: "integer",
    what: "how long the operating system waits before starting a dead piece again",
    required: false,
  },
  {
    key: "hub.give_up_after",
    type: "integer",
    what: "how many starts inside the window before systemd stops trying",
    required: false,
  },
  {
    key: "hub.give_up_window_seconds",
    type: "integer",
    what: "the window those starts are counted in",
    required: false,
  },
  {
    key: "hub.job_grace_seconds",
    type: "integer",
    what: "how late a scheduled job's own success stamp may be before it is reported",
    required: false,
  },
  {
    key: "hub.silent_runner_hours",
    type: "integer",
    what: "how long a runner may be off the store with no work before it is reported",
    required: false,
  },
  // How long a runner waits before it tries a refused credential again.
  // L10 rule 3: "the runners retry on their own on a fixed interval", and v2's
  // was a fixed five minutes. It is a retry cadence and not a window threshold,
  // so SPEC section 6's "a window threshold in code" does not reach it.
  {
    key: "hub.outage_retry_seconds",
    type: "integer",
    what: "how long a runner waits before it tries a credential that refused a turn again",
    required: false,
  },
  // Which binary files a harvested note is a HOUSEHOLD FACT and not a
  // thing for code to guess: one box's is a package build, another's predates
  // the `vault` verb, and the monorepo's own runs under bun with no build step.
  // The hub cannot import core (the plugin contract), so the apply is a child
  // process and the command is a setting, read with a fallback the way
  // `hub.job_grace_seconds` already is.
  {
    key: "hub.imprnt",
    type: "string",
    what: "the command the runner spawns to file a harvested note",
    required: false,
  },
  // The household's recognizer and the three knobs the door's transcription
  // step reads. Every one of them is read ONLY when `voice.recognizer` names a
  // table this file defines, which is what keeps a setting nothing reads out of
  // a file whose household never installed the component.
  //
  // They sit HERE and not at the head of the list on purpose: a shipped check
  // deletes the FIRST declared field's line from the example file and requires
  // the load to be refused, which only a required field can do.
  {
    key: "voice.recognizer",
    type: "string",
    what: "which of the declared recognizers this household transcribes voice notes with",
    required: false,
  },
  {
    key: "voice.retry_seconds",
    type: "integer",
    what: "how long a voice note waits before the door tries the recognizer again",
    required: false,
  },
  {
    key: "voice.give_up_hours",
    type: "integer",
    what: "how long a voice note waits for its own text before the door says it could not",
    required: false,
  },
  {
    key: "voice.chunk_deadline_seconds",
    type: "integer",
    what: "how long one piece of a voice note may take before the door abandons that request",
    required: false,
  },
  // Where the store's own process writes its pid, and what the
  // machine's service manager calls it. Every standard install writes a pid
  // file, so the hub reads that rather than guessing at a process tree, and the
  // install script writes these two once per box. They go at the END of the
  // list on purpose: a shipped check deletes the FIRST declared
  // field's line from the example file and requires the load to be refused,
  // which only a required field can do.
  {
    key: "store.pid_file",
    type: "string",
    what: "the file the store's postmaster writes its pid into, whose first line the hub reads",
    required: false,
  },
  {
    key: "store.unit",
    type: "string",
    what: "what this machine's service manager calls the store, for a person to look up",
    required: false,
  },
  ...Object.keys(ROLLOUT_DEFAULTS).map(key => ({ key, type: "integer" as const, what: key, required: false })),
  { key: "hub.cutover_batch", type: "string", what: "the reviewed migration batch", required: false },
  { key: "install.admin_argv", type: "array", what: "the explicit database administrator command", required: false },
];

/**
 * The shape of an agent id: lower case letters and digits in runs joined by
 * single hyphens.
 *
 * AN AGENT ID IS A FOLDER NAME. The chat log is kept under
 * `<state_dir>/<person>/chatlog/<agent id>/` and a session under
 * `<state_dir>/<person>/sessions/<agent id>/`, so an id with a separator or a
 * pair of dots in it is a path into somebody else's history. One predicate
 * refuses a slash, a backslash, a dot, a space and a capital together, which is
 * the rule the zone's mount name already has for the same reason.
 */
export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

export class RegistryRefused extends Error {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly reason: string;

  constructor(file: string, line: number, key: string, reason: string) {
    super(`${file} line ${line}: ${reason}`);
    this.name = "RegistryRefused";
    this.file = file;
    this.line = line;
    this.key = key;
    this.reason = reason;
  }
}

export class UnknownSetting extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `${key} is not a setting. The settings are ${SETTING_FIELDS.map((f) => f.key).join(", ")}. ` +
        `A value that is not in the registry does not exist.`,
    );
    this.name = "UnknownSetting";
    this.key = key;
  }
}

/**
 * The kinds every file may carry, as an ARRAY rather than a literal inside the
 * condition that reads it, so adding one is a line here and nothing else.
 *
 * `transcriber` is deliberately not among them: it is the one kind a file may
 * carry only while the household names a recognizer that runs here, so the
 * condition below adds it for such a file and for no other.
 */
export const RUN_KINDS = ["hub", "door", "runner", "sync", "board", "backup"] as const;

/**
 * What a runner admits when its entry says nothing: how many children at once,
 * and how many megabytes they may hold between them. Read by the runner's
 * admission, by the unit render that sizes the runner's cgroup around them, and
 * by `check`, so the three never disagree about what an absent key means.
 */
export const DEFAULT_MAX_ACTIVE_CHILDREN = 4;
export const DEFAULT_CHILD_MEMORY_BUDGET_MB = 2048;

/**
 * The three commands an off-box copy runs, and the four placeholders they may
 * carry.
 *
 * The job fills a placeholder into the argument it appears in and every
 * argument stays one argument, so a destination with a space or a semicolon in
 * it arrives whole and nothing is ever read by a shell. `{staging}` is the
 * directory the copy is assembled in and `{destination}` is the entry's own
 * string. `{path}` and `{out}` exist only for the read-back: the file being
 * read back, relative to the copy, and the scratch file it is read into.
 */
export const BACKUP_ARGVS = ["dump_argv", "upload_argv", "readback_argv"] as const;
export const BACKUP_PLACEHOLDERS = ["{staging}", "{destination}", "{path}", "{out}"] as const;

/** A password written into a command line, which every process on the box can read. */
const PASSWORD_LITERAL = /password\s*=|:\/\/[^/\s]*:[^/\s]*@/i;

/**
 * The kinds a household may not hold down with `enabled = false`.
 *
 * Neither could be started again from where it was stopped. The hub is what
 * reads this file on its tick and starts what the file says should be running,
 * and it renders itself without anything that would bring it back at the next
 * boot, so a stopped hub is a household with nothing left to start anything.
 * The board is the page a person would press start on. Taking either down is
 * removing its entry, which is a deliberate edit rather than a field, and the
 * page shows no stop on their rows for the same reason.
 */
export const NEVER_STOPPED = ["hub", "board"] as const;

export interface RunEntry {
  id: string;
  kind: string;
  schedule: string;
  memory_limit_mb: number;
  /**
   * Which machine runs this entry. A file that declares fewer than two
   * machines needs no `machine` anywhere and every entry belongs to the one the
   * asking process names, so this carries the single machine's id there and the
   * empty string when the file declares none at all.
   */
  machine: string;
  /** The limit the RUNNER enforces on its model child, not its own. */
  child_memory_limit_mb?: number;
  max_active_children?: number;
  child_memory_budget_mb?: number;
  repositories?: string[];
  /** A door's bot token file. Every agent's box masks it. */
  token_file?: string;
  /**
   * The two a door entry may carry, both optional, and an entry that names
   * neither reads back exactly as it does today.
   *
   * `guild` is the Discord server a channel NAME is resolved against, and a
   * door without one still takes a channel id. `default_preset` is the preset
   * an agent adopted through this door is created with, and an adopt is refused
   * when the entry names none, because a new agent has to run as something.
   */
  guild?: string;
  default_preset?: string;
  /**
   * A board's one specific listening address.
   *
   * Binding to this machine's own tailnet address is what makes a board
   * reachable on the tailnet and nowhere else. Nothing here can check that the
   * address belongs to one, so what the loader refuses is the shape: a
   * wildcard, an empty string, and a name.
   */
  bind?: string;
  /**
   * The port, carried by the two kinds that are reached at one: a board on the
   * address above, and a `kind = "transcriber"` entry on loopback, which is
   * where the door beside it posts.
   */
  port?: number;
  /**
   * The second port a board serves a person's artifacts on.
   *
   * It is a SEPARATE port because what it serves is written by an agent, and a
   * page an agent wrote, served from the port the acts are on, would be the
   * board's own origin in a browser: same origin, so its script may read every
   * page and its form may press every button. A port of its own is a different
   * origin and the browser refuses it that. Absent means no artifact is served
   * at all, which is what a household that has not asked for the route gets.
   */
  artifacts_port?: number;
  /**
   * The recognizer's other two. `residency` says whether the model is held
   * between notes or dropped after `idle_seconds` of quiet, and only the one
   * that drops it has an idle window anything reads.
   */
  residency?: string;
  idle_seconds?: number;
  /**
   * An off-box copy's three commands and where they send it. The destination
   * is a string the commands receive and nothing here reads, which is what
   * keeps every provider out of the code.
   */
  dump_argv?: string[];
  upload_argv?: string[];
  readback_argv?: string[];
  destination?: string;
  /**
   * Whether the hub keeps this entry running. Absent means it does.
   *
   * It lives in the FILE because a hold kept anywhere else would be undone by
   * the hub's own next tick, which starts whatever the file says should be
   * running.
   */
  enabled?: boolean;
}

/**
 * One recognizer this household declares, with its defaults not yet filled in.
 *
 * `runtime` is the local provider's own directory and is null on a cloud one;
 * `credential` is the cloud provider's key file and is null on a local one.
 * Each is refused on the other, because a value nothing reads is forbidden.
 */
export interface RecognizerEntry {
  name: string;
  provider: string;
  model: string;
  runtime: string | null;
  credential: string | null;
  chunk_seconds: number;
}

/**
 * A machine the household has. `os` is in the file, never process.platform.
 *
 * The three optional paths are this machine's own where they differ from the
 * `[hub]` table's: a spoke keeps its state and its role passwords on its own
 * disk and reaches the one store over the tailnet rather than on loopback. A
 * process loaded for this machine (`loadRegistry(file, { machine })`) reads
 * them through `readSetting` as if the `[hub]` table said so, so nothing below
 * the loader knows a machine can differ. Spread only where the file carries
 * them.
 */
export interface MachineEntry {
  id: string;
  os: string;
  state_dir?: string;
  secrets_dir?: string;
  store_url?: string;
  imprnt?: string;
}

/**
 * The `[hub]` keys a `[[machines]]` entry may carry its own value for. The
 * three directories and addresses are paths on that machine's disk or its
 * route to the store, and `imprnt` is the command that files a note there,
 * which is a build of its own on every box.
 */
export const MACHINE_SETTINGS = ["state_dir", "secrets_dir", "store_url", "imprnt"] as const;

/**
 * A person's paths on one machine, from `[[people]].on.<machine>`.
 *
 * A vault checkout does not sit at the same path on every machine, so a person
 * whose agents run on a spoke says here where their tree and vault are there,
 * and where their instruction files are when they name any. The loader
 * replaces the entry's own values with these when it loads the file for that
 * machine, and every reader below it sees one person with one tree, as it
 * always did.
 */
export interface PersonPlacement {
  tree: string;
  vault?: string;
  filing_rules?: string;
  mcp?: string;
  settings?: string;
  instructions?: string[];
}

/** The four files a person may name, each checked readable where their agents run. */
export const PERSON_FILE_KEYS = ["filing_rules", "mcp", "settings", "instructions"] as const;

/** A credential's file on one machine, from `[[credentials]].on.<machine>`. */
export interface CredentialPlacement {
  file: string;
}

/** A repository's checkout on one machine, from `[[repositories]].on.<machine>`. */
export interface RepositoryPlacement {
  path: string;
  remote?: string;
}

/**
 * Which entries carry a placement for the machine a registry was loaded for,
 * by id. Empty for the file as written. `check` on a machine opens the
 * credentials placed there and the ones that machine's agents use, and never
 * a bot token that lives on the hub machine alone.
 */
export interface Placed {
  people: string[];
  credentials: string[];
  repositories: string[];
}

/**
 * A person and the tree that is the tenancy boundary.
 *
 * The five clock and harvest fields are OPTIONAL and are spread onto the entry
 * only when the file carries them, exactly the way `child_memory_limit_mb` is
 * spread onto a `RunEntry`. `test/registry-machines.test.ts` asserts that
 * `listPeople` on a file that sets none returns rows carrying `id` and `tree`
 * and nothing else, so an entry that always carried five more keys would turn
 * that check red.
 */
export interface PersonEntry {
  id: string;
  tree: string;
  /** The four stamp clocks, this person's own, in seconds. */
  acked_seconds?: number;
  started_seconds?: number;
  answered_seconds?: number;
  delivered_seconds?: number;
  /**
   * How long this person waits for a voice note's own text, seconds.
   *
   * It is deliberately NOT one of the four above: `thresholdsFor` answers
   * exactly the four clocks L6 names, and two shipped checks compare that
   * answer whole, so the fifth clock is its own accessor.
   */
  transcribed_seconds?: number;
  /** The language this person reads the door's own lines in. */
  language?: string;
  /**
   * The harvest, this person's own, and the same spread-never-set rule.
   *
   * `harvester` names the preset a slice of their chats is read under, and its
   * ABSENCE means this person's chats are not harvested at all: `check` says
   * `harvest-undeclared` and the hub runs, because a household that has not
   * chosen a harvester is not a household whose file is broken.
   *
   * `vault` names the directory holding `vault/` and `raw/`, which is what
   * `imprnt init` scaffolds and what the apply is pointed at.
   */
  harvester?: string;
  vault?: string;
  harvest_quiet_minutes?: number;
  harvest_min_messages?: number;
  harvest_report?: boolean;
  /**
   * Whether the board serves what an agent built for this person.
   *
   * Absent means NOT served, so a household that adds a second person does not
   * publish their pages by adding them to the file. Widening what the household
   * exposes is one deliberate line here.
   */
  artifacts?: boolean;
  allowed_senders?: Record<string, string[]>;
  history_harvest_after?: string;
  filing_rules?: string;
  /**
   * What every agent of this person starts with, unless the agent names its
   * own. `instructions` is the list of files an ordinary launch appends to the
   * system prompt, and its absence means the vault's own `CLAUDE.md` and
   * `CLAUDE.local.md`, each when it exists. `mcp` and `settings` stand in for
   * an agent that declares none, so an agent made from a chat, which carries
   * only its id, person, preset, chat, door and runner, starts complete.
   */
  instructions?: string[];
  mcp?: string;
  settings?: string;
}

/**
 * A credential this household runs on: one owner, one place, and every
 * agent that uses it points at that file (L10 rule 1).
 */
export interface CredentialEntry {
  id: string;
  kind: string;
  file: string;
  owner: string;
}

const MACHINE_OS = ["linux", "macos"];

/** How a preset is paid for, and there is no third way. */
export const PAID_KINDS = ["plan", "key"] as const;

/** The four credential kinds this hub knows how to open. */
export const CREDENTIAL_KINDS = ["claude-login", "telegram", "discord", "api-key"] as const;

/** The two recognizer providers this hub speaks: one that runs here, one dialled. */
export const RECOGNIZER_PROVIDERS = ["sherpa-onnx", "deepgram"] as const;

/**
 * Whether the recognizer holds its model between notes or drops it.
 *
 * `resident` is the default and the ruling behind it is measured: a voice note
 * arrives exactly when the machine is busiest, so an allocation demanded at a
 * peak is worse than the same memory held predictably. `idle-unload` exists for
 * a machine where that memory cannot be assumed affordable, and the household
 * that sets it accepts the wait on the first note after a quiet spell.
 */
export const RESIDENCY_KINDS = ["resident", "idle-unload"] as const;

/**
 * What a household that names a recognizer and nothing else gets.
 *
 * CHOSEN, not measured, every one of them. `chunk_seconds` at 60 is the piece
 * size the decode was sized against, `chunk_deadline_seconds` at 120 is twice
 * that and nothing has measured a 60 second piece taking longer, `idle_seconds`
 * at 600 is the quiet spell the dropping residency waits out, and
 * `retry_seconds` at 300 is the same cadence a refused credential already
 * retries on. The first live week measures them.
 */
export const VOICE_DEFAULTS = {
  retry_seconds: 300,
  give_up_hours: 24,
  chunk_deadline_seconds: 120,
  chunk_seconds: 60,
  idle_seconds: 600,
  residency: "resident",
} as const;

/**
 * How long a person waits for a voice note's own text before the door says it
 * is still working, seconds.
 *
 * CHOSEN: it covers the measured 10.7 second model reload plus a five minute
 * note at the extrapolated tenth of realtime. The first live week measures it.
 */
export const TRANSCRIBED_DEFAULT_SECONDS = 120;

/** The two languages this household speaks. */
export const LANGUAGES = ["en", "ru"] as const;

/** The four clocks a person's own file may override, one at a time. */
const STAMP_THRESHOLD_KEYS = [
  "acked_seconds",
  "started_seconds",
  "answered_seconds",
  "delivered_seconds",
] as const;

/**
 * L6's own four numbers, called defaults by the ruling itself, so a
 * default in code is allowed HERE and forbidden for the window.
 */
export const STAMP_THRESHOLD_DEFAULTS = {
  acked_seconds: 30,
  started_seconds: 60,
  answered_seconds: 900,
  delivered_seconds: 60,
} as const;

export const DEFAULT_LANGUAGE = "en";

/**
 * What a person who names only a harvester is harvested on.
 *
 * L19's own words: "Defaults ship per model so a plan login can run a strong
 * model on every slice and a per-token key runs a cheaper preset with a larger
 * minimum slice." So the minimum slice is derived from the HARVESTER preset's
 * `paid` and never from the agent's, because the cost the ruling is talking
 * about is the harvest's own. 20 is L19's second cost figure, the size at which
 * a per-token harvest is worth paying for.
 *
 * A default in code is allowed here and forbidden for the window, and
 * the two are different questions: L10's Forbidden names a window threshold and
 * names no harvest knob, while L19's Forbidden is a harvest cost that cannot be
 * changed in the registry, which a default the file overrides is not. The four
 * stamp thresholds rest on the same argument.
 */
export const HARVEST_DEFAULTS = {
  quiet_minutes: 30,
  report: true,
  min_messages: { plan: 1, key: 20 },
} as const;

/** The three window thresholds, percent, on a `paid = "plan"` preset. */
const WINDOW_KEYS = ["window_pause_at", "window_notice_at", "window_hold_at"] as const;

/** The five, alphabetical, which is the order the derived id hashes them in. */
export const PRESET_KEYS = ["adapter", "effort", "model", "paid", "provider"] as const;

/** The five settings a preset is, and the only ones its id is derived from. */
export interface PresetEntry {
  adapter: string;
  effort: string;
  model: string;
  paid: string;
  provider: string;
}

export interface RepositoryEntry {
  id: string;
  person: string;
  path: string;
  remote: string;
  branch: string;
  required?: boolean;
  /** Set on the one entry per person that is their checkout of the shared zone. */
  zone?: boolean;
  /**
   * The ssh command the sync fetches and pushes this repository with, such as
   * one naming a deploy key. It is passed on git's command line, because the
   * same key inside the repository's own config is refused there: an agent
   * can write that file, and the registry is the owner's hand.
   */
  ssh_command?: string;
}

/**
 * The household's shared zone, declared once.
 *
 * `mount` is the folder name every vault carries the zone under, `remote` is the
 * git remote NAME every checkout wears, which is what `runSync` asks `git
 * remote` for, and `url` is what a clone reads. The name and the url are two
 * fields because they are two different strings, which keeps the loader's
 * comparison against a repository's own `remote` a plain string test.
 */
export interface ZoneEntry {
  mount: string;
  remote: string;
  url: string;
}

export interface AgentEntry {
  fragment?: string;
  settings?: string;
  mcp?: string;
  tools?: string[];
  mode?: "resident" | "on-demand";
  sleeping?: boolean;
  idle_seconds?: number;
  id: string;
  person: string;
  preset: string;
  /**
   * The chat this agent answers in, and the door that carries it. BOTH OR
   * NEITHER: an agent with neither exists only to take jobs, and its entry
   * declaring no chat is what makes its empty tail a fact rather than a gap.
   */
  chat?: string;
  door?: string;
  runner: string;
}

/** An agent that answers in a chat, which is every agent a door serves. */
export type ChatAgent = AgentEntry & { chat: string; door: string };

export interface RateEntry {
  model: string;
  from: string;
  input_per_m: number;
  cached_per_m: number;
  output_per_m: number;
  currency: string;
}

export class Registry {
  readonly file: string;
  readonly data: Record<string, unknown>;
  readonly run: RunEntry[];
  readonly presets: Record<string, PresetEntry>;
  readonly agents: AgentEntry[];
  readonly rates: RateEntry[];
  readonly machines: MachineEntry[];
  readonly people: PersonEntry[];
  readonly credentials: CredentialEntry[];

  constructor(
    file: string,
    data: Record<string, unknown>,
    run: RunEntry[],
    presets: Record<string, PresetEntry> = {},
    agents: AgentEntry[] = [],
    rates: RateEntry[] = [],
    machines: MachineEntry[] = [],
    people: PersonEntry[] = [],
    credentials: CredentialEntry[] = [],
    readonly repositories: RepositoryEntry[] = [],
    readonly recognizers: Record<string, RecognizerEntry> = {},
    readonly zone: ZoneEntry | null = null,
    /**
     * The machine this registry was loaded FOR, or null for the file as
     * written. A view for a machine carries that machine's own state, secrets
     * and store settings in `data.hub`, its people's trees and vaults there,
     * and its credentials' files there. Every other field is the file's.
     */
    readonly machine: string | null = null,
    readonly placed: Placed = { people: [], credentials: [], repositories: [] },
  ) {
    this.file = file;
    this.data = data;
    this.run = run;
    this.presets = presets;
    this.agents = agents;
    this.rates = rates;
    this.machines = machines;
    this.people = people;
    this.credentials = credentials;
  }
}

/**
 * The registry a reader was handed, checked once. Three modules read a loaded
 * registry and each one has to refuse anything else, so the check lives here
 * with the class rather than being written out at every door.
 */
export function loaded(registry: unknown, who: string): Registry {
  if (!(registry instanceof Registry)) {
    throw new TypeError(
      `${who} reads a registry loaded by loadRegistry, and this is ${typeof registry}`,
    );
  }
  return registry;
}

/**
 * Line of every key in the file, by its path: `hub.tick_seconds`, `run[1].id`.
 * The scan tracks the table header it is under, because `id` and
 * `memory_limit_mb` repeat in every entry and a refusal has to name the one a
 * human is looking for.
 *
 * Exported because the writer changes the line a refusal would point at, and
 * two scans of the same file could disagree about which line a key is on.
 */
export function indexLines(text: string): Map<string, number> {
  const index = new Map<string, number>();
  const seen = new Map<string, number>();
  let table = "";
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const array = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    if (array) {
      const name = array[1];
      const nth = seen.get(name) ?? 0;
      seen.set(name, nth + 1);
      table = `${name}[${nth}]`;
      index.set(table, i + 1);
      return;
    }
    const header = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (header) {
      table = header[1];
      index.set(table, i + 1);
      return;
    }
    const pair = /^"?([A-Za-z0-9_.\-]+)"?\s*=/.exec(line);
    if (pair) index.set(table === "" ? pair[1] : `${table}.${pair[1]}`, i + 1);
  });
  return index;
}

function valueAt(data: Record<string, unknown>, key: string): unknown {
  let here: unknown = data;
  for (const step of key.split(".")) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[step];
  }
  return here;
}

function typeOfValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * The same value with no quotes around a string, for the sentences that already
 * name the key they are about, where `"0.0.0.0"` reads as part of the address.
 */
function describeBare(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * The key a reader asks for, with any command-line decoration taken off: a
 * leading dash run and anything glued on after an `=`. The spelling is all that
 * is stripped. The value that came with it is dropped on the floor and the
 * registry's own value is what is read, which is the whole point.
 */
function settingKey(key: string): string {
  return String(key).trim().replace(/^-+/, "").split("=")[0].trim();
}

/**
 * Which machine a registry is loaded for.
 *
 * A process that knows which machine it runs on (a runner and a hub by their
 * own entry, `check`, `status` and `install` by their argument) loads the file
 * for that machine, and the paths that differ per machine come back resolved:
 * `hub.state_dir`, `hub.secrets_dir` and `hub.store_url` from the machine's own
 * entry, every person's `tree` and `vault` from their `on.<machine>` table, and
 * every credential's `file` and `keychain` from theirs. Nothing below the loader
 * asks which machine it is on. An empty or absent machine loads the file as
 * written, which is the hub machine's view.
 */
export interface RegistryView {
  machine?: string;
}

export function loadRegistry(file: string, view: RegistryView = {}): Registry {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RegistryRefused(file, 0, "", `the registry cannot be read: ${(error as Error).message}`);
  }

  const lines = indexLines(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    const said = String((error as Error).message);
    const at = /line (\d+)/i.exec(said);
    throw new RegistryRefused(file, at ? Number(at[1]) : 0, "", `this is not readable TOML: ${said}`);
  }

  const refuse = (key: string, fallback: number, reason: string): never => {
    throw new RegistryRefused(file, lines.get(key) ?? fallback, key, reason);
  };
  const positive = (value: unknown, key: string) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      refuse(key, 0, `${key} must be a positive integer`);
  };
  const strings = (value: unknown, key: string, empty = true) => {
    if (!Array.isArray(value) || (!empty && value.length === 0) ||
        value.some(v => typeof v !== "string" || v.trim() === ""))
      refuse(key, 0, `${key} must contain nonempty strings`);
  };
  const readable = (value: unknown, key: string) => {
    if (typeof value !== "string" || !isAbsolute(value))
      refuse(key, 0, `${key} must be an absolute readable file`);
    try {
      if (!statSync(value as string).isFile()) throw new Error();
      accessSync(value as string, constants.R_OK);
    } catch { refuse(key, 0, `${key} must be an absolute readable file`); }
  };
  for (const key of Object.keys(ROLLOUT_DEFAULTS)) {
    const value = valueAt(parsed, key);
    if (value !== undefined) positive(value, key);
  }
  const batch = valueAt(parsed, "hub.cutover_batch");
  if (batch !== undefined && (typeof batch !== "string" || !/^[A-Za-z0-9_-]+$/.test(batch)))
    refuse("hub.cutover_batch", 0, "hub.cutover_batch must be a nonempty batch ID");
  const admin = valueAt(parsed, "install.admin_argv");
  if (admin !== undefined) {
    strings(admin, "install.admin_argv", false);
    if ((admin as string[]).some(arg => PASSWORD_LITERAL.test(arg)))
      refuse("install.admin_argv", 0, "install.admin_argv must not contain password literals");
  }

  for (const field of SETTING_FIELDS) {
    const value = valueAt(parsed, field.key);
    const table = field.key.split(".").slice(0, -1).join(".");
    if (value === undefined || value === null) {
      if (field.required === false) continue;
      throw new RegistryRefused(
        file,
        lines.get(field.key) ?? lines.get(table) ?? 0,
        field.key,
        `the registry does not set ${field.key}, which the hub reads (${field.what})`,
      );
    }
    if (typeOfValue(value) !== field.type) {
      throw new RegistryRefused(
        file,
        lines.get(field.key) ?? lines.get(table) ?? 0,
        field.key,
        `${field.key} must be ${field.type}, and this is ${describe(value)}`,
      );
    }
  }

  // The machines come first, so an entry naming a machine whose `os` is
  // outside the two is refused at the declaration rather than at the entry.
  const machines: MachineEntry[] = [];
  ((parsed.machines ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const at = `machines[${nth}]`;
    const here = lines.get(`${at}.id`) ?? lines.get(at) ?? 0;
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      throw new RegistryRefused(
        file,
        here,
        `${at}.id`,
        `this machine has no id, and an entry says which machine runs it by name`,
      );
    }
    const os = entry.os;
    if (typeof os !== "string" || !MACHINE_OS.includes(os)) {
      throw new RegistryRefused(
        file,
        lines.get(`${at}.os`) ?? here,
        `${at}.os`,
        `${id} runs ${describe(os)}, and the two this hub knows are ${MACHINE_OS.join(" and ")}`,
      );
    }
    // This machine's own paths, each refused by key and line when it is there
    // and wrong. A relative directory is a different directory in every
    // working directory a unit starts in, and a store url carrying a user or a
    // password is a role decided by the file rather than by the process, which
    // is what `hub.store_url` already forbids.
    const own: Partial<Record<(typeof MACHINE_SETTINGS)[number], string>> = {};
    for (const key of MACHINE_SETTINGS) {
      const value = entry[key];
      if (value === undefined || value === null) continue;
      const atKey = lines.get(`${at}.${key}`) ?? here;
      if (typeof value !== "string" || value === "") {
        refuse(`${at}.${key}`, atKey, `${id} has ${key} ${describe(value)}, and it is a nonempty string`);
      }
      if (key === "imprnt") {
        // A command, which may be a bare word the unit's PATH resolves.
        own[key] = value as string;
        continue;
      }
      if (key === "store_url") {
        let url: URL;
        try {
          url = new URL(value as string);
        } catch {
          return refuse(`${at}.${key}`, atKey, `${id} has store_url ${describe(value)}, which is not a url`);
        }
        if (url.username !== "" || url.password !== "") {
          refuse(`${at}.${key}`, atKey,
            `${id} has a store_url carrying a user or a password, and a process supplies its own role and reads its own password file`);
        }
      } else if (!isAbsolute(value as string)) {
        refuse(`${at}.${key}`, atKey,
          `${id} has ${key} ${describe(value)}, and it must be an absolute path: a relative one is a different directory in every directory a unit starts in`);
      }
      own[key] = value as string;
    }
    machines.push({ id, os, ...own });
  });
  const declared = new Set(machines.map((machine) => machine.id));
  /** The machine this file is being read for, or null for the file as written. */
  const viewed = view.machine === undefined || view.machine === "" ? null : view.machine;
  if (viewed !== null && declared.size > 0 && !declared.has(viewed)) {
    throw new RegistryRefused(file, lines.get("machines[0]") ?? 0, "machines",
      `this process is for the machine ${describe(viewed)}, which no [[machines]] entry declares`);
  }
  /**
   * One `on` table, read the same way on a person and on a credential: a
   * table keyed by a declared machine id, each value a table of exactly the
   * keys the caller names. Anything else is refused by key and line, because
   * a placement that loaded and applied to no machine would be a spoke that
   * silently kept the hub machine's paths.
   */
  const placements = <T>(entry: Record<string, unknown>, where: string, here: number, id: unknown,
    keys: readonly string[], read: (table: Record<string, unknown>, machine: string, atTable: number) => T,
  ): Record<string, T> => {
    const on = entry.on;
    const out: Record<string, T> = {};
    if (on === undefined || on === null) return out;
    const atOn = lines.get(`${where}.on`) ?? here;
    if (typeof on !== "object" || Array.isArray(on)) {
      refuse(`${where}.on`, atOn, `${id} has on ${describe(on)}, and it is a table keyed by machine id`);
    }
    for (const [machine, table] of Object.entries(on as Record<string, unknown>)) {
      if (!declared.has(machine)) {
        refuse(`${where}.on.${machine}`, atOn,
          `${id} says where it is on ${describe(machine)}, which no [[machines]] entry declares`);
      }
      if (table === null || typeof table !== "object" || Array.isArray(table)) {
        refuse(`${where}.on.${machine}`, atOn, `${id} on ${machine} is ${describe(table)}, and it is a table of ${keys.join(" and ")}`);
      }
      for (const key of Object.keys(table as Record<string, unknown>)) {
        if (!keys.includes(key)) {
          refuse(`${where}.on.${machine}.${key}`, atOn,
            `${id} on ${machine} carries ${key}, and the keys a placement may carry are ${keys.join(" and ")}`);
        }
      }
      out[machine] = read(table as Record<string, unknown>, machine, atOn);
    }
    return out;
  };
  // The backward compatibility rule: `machine` becomes required, by name, only
  // once the file declares two or more. Below that there is nothing to be
  // ambiguous about, and every entry belongs to the one machine that asks.
  const namesAMachine = machines.length >= 2;

  // The recognizers come before the entries, because whether `transcriber` is a
  // kind this file may carry at all turns on which provider the household
  // names. A recognizer may also name a credential, and that reference is
  // checked further down beside the presets' own, once the credentials are
  // parsed.
  const recognizers: Record<string, RecognizerEntry> = Object.create(null);
  for (const [name, table] of Object.entries(
    (parsed.recognizers ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const where = `recognizers.${name}`;
    const here = lines.get(where) ?? 0;
    const provider = table.provider;
    if (
      typeof provider !== "string" ||
      !(RECOGNIZER_PROVIDERS as readonly string[]).includes(provider)
    ) {
      refuse(
        `${where}.provider`,
        here,
        `${name} is a ${describe(provider)} recognizer, and the two this hub ` +
          `knows are ${RECOGNIZER_PROVIDERS.join(" and ")}`,
      );
    }
    const model = table.model;
    if (typeof model !== "string" || model === "") {
      refuse(
        `${where}.model`,
        here,
        `${name} names no model, and a recognizer is a provider and the model it runs`,
      );
    }
    // The local provider runs a process of ours on this machine, so it names
    // the directory that process lives in and dials nothing. The cloud one
    // dials a provider, so it names a key file and has no directory at all.
    // Each field is refused on the other side, because a value nothing reads is
    // forbidden.
    const runs = provider === "sherpa-onnx";
    const runtime = table.runtime;
    if (runs) {
      if (typeof runtime !== "string" || !isAbsolute(runtime)) {
        refuse(
          `${where}.runtime`,
          here,
          `${name} runs on this machine and has runtime ${describe(runtime)}, and it ` +
            `must be the absolute directory holding the recognizer's own files`,
        );
      }
    } else if (runtime !== undefined && runtime !== null) {
      refuse(
        `${where}.runtime`,
        here,
        `${name} is a cloud recognizer and carries a runtime directory, and no ` +
          `process of ours runs for it, so there is nothing for that path to name`,
      );
    }
    const credential = table.credential;
    if (runs) {
      if (credential !== undefined && credential !== null) {
        refuse(
          `${where}.credential`,
          here,
          `${name} runs on this machine and carries a credential, and a local ` +
            `recognizer dials nobody, so there is no key for it to read`,
        );
      }
    } else if (typeof credential !== "string" || credential === "") {
      refuse(
        `${where}.credential`,
        here,
        `${name} is a cloud recognizer and names no credential, and its key is ` +
          `read from the file a [[credentials]] entry names at the moment of use`,
      );
    }
    // Zero is the big-machine switch and not a bad value: it means the whole
    // note goes out as one request, uncut.
    const chunk = table.chunk_seconds;
    if (
      chunk !== undefined &&
      chunk !== null &&
      (typeof chunk !== "number" || !Number.isInteger(chunk) || chunk < 0)
    ) {
      refuse(
        `${where}.chunk_seconds`,
        here,
        `${name} has chunk_seconds ${describe(chunk)}, and it is a whole number of ` +
          `seconds from zero up, where zero means the note is sent in one piece`,
      );
    }
    recognizers[name] = {
      name,
      provider: provider as string,
      model: model as string,
      runtime: runs ? (runtime as string) : null,
      credential: runs ? null : (credential as string),
      chunk_seconds: typeof chunk === "number" ? chunk : VOICE_DEFAULTS.chunk_seconds,
    };
  }

  // Every setting under [voice] is read only when a recognizer is named, so a
  // table without one holds settings nothing in production would ever reach.
  const named = valueAt(parsed, "voice.recognizer");
  if (parsed.voice !== undefined && parsed.voice !== null && (named === undefined || named === null)) {
    refuse(
      "voice.recognizer",
      lines.get("voice") ?? 0,
      `this file carries a [voice] table and names no recognizer, and every ` +
        `setting under it is read only when one is named`,
    );
  }
  if (typeof named === "string" && !Object.hasOwn(recognizers, named)) {
    refuse(
      "voice.recognizer",
      lines.get("voice") ?? 0,
      `this household transcribes with ${describe(named)}, and this file defines ` +
        `no recognizer by that name`,
    );
  }
  const household = typeof named === "string" ? recognizers[named] : null;

  const raw = parsed.run;
  const entries: RunEntry[] = [];
  const claimed = new Map<string, number>();
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new RegistryRefused(file, lines.get("run") ?? 0, "run", "run must be a list of entries");
  }
  (raw as Record<string, unknown>[] | undefined)?.forEach((entry, nth) => {
    const at = `run[${nth}]`;
    const here = lines.get(`${at}.id`) ?? lines.get(at) ?? 0;
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      throw new RegistryRefused(file, here, `${at}.id`, `this entry has no id, and the hub runs a list of named things`);
    }
    const already = claimed.get(id);
    if (already !== undefined) {
      throw new RegistryRefused(
        file,
        here,
        `${at}.id`,
        `${id} is already an entry of this registry, on line ${already}. The list holds one entry per id`,
      );
    }
    claimed.set(id, here);

    for (const field of ["kind", "schedule"] as const) {
      const value = entry[field];
      if (typeof value !== "string" || value === "") {
        throw new RegistryRefused(
          file,
          lines.get(`${at}.${field}`) ?? here,
          `${at}.${field}`,
          `${id} has no ${field}, and nothing runs without one`,
        );
      }
    }

    for (const key of ["max_active_children", "child_memory_budget_mb"]) {
      if (entry[key] !== undefined) positive(entry[key], `${at}.${key}`);
    }
    if (entry.kind === "sync") strings(entry.repositories, `${at}.repositories`, false);
    const limit = entry.memory_limit_mb;
    if (limit === undefined || limit === null) {
      throw new RegistryRefused(
        file,
        here,
        `${at}.memory_limit_mb`,
        `${id} has no memory_limit_mb, and every piece the hub runs carries one`,
      );
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
      throw new RegistryRefused(
        file,
        lines.get(`${at}.memory_limit_mb`) ?? here,
        `${at}.memory_limit_mb`,
        `${id} has memory_limit_mb ${describe(limit)}, and it must be a whole number of megabytes above zero`,
      );
    }

    // `transcriber` is a kind a file may carry only while the household names a
    // recognizer that RUNS here. A cloud recognizer is dialled by the door
    // itself and an absent one means the component is not installed, so in
    // either file the process is one nothing in production would ever reach,
    // and a piece that could never be reached cannot be configured.
    const kinds: string[] = [...RUN_KINDS];
    if (household?.provider === "sherpa-onnx") kinds.push("transcriber");
    if (!kinds.includes(entry.kind as string)) {
      refuse(
        `${at}.kind`,
        here,
        `unsupported-run-kind: ${entry.kind}` +
          (entry.kind === "transcriber"
            ? `. This household transcribes ${
                household === null
                  ? "with no recognizer at all"
                  : `with ${household.name}, which is dialled rather than run here`
              }, so nothing would ever read the process`
            : ""),
      );
    }

    // Whether the hub keeps a piece running is asked of EVERY entry, and it is
    // spread onto the entry only when the file carries it, so a file that says
    // nothing produces the entry it produces today.
    if (entry.enabled !== undefined && entry.enabled !== null && typeof entry.enabled !== "boolean") {
      refuse(
        `${at}.enabled`,
        here,
        enabledNotBoolean("en", { id, value: describeBare(entry.enabled) }),
      );
    }
    if (entry.enabled === false && (NEVER_STOPPED as readonly string[]).includes(entry.kind as string)) {
      refuse(
        `${at}.enabled`,
        here,
        entry.kind === "hub" ? enabledOnHub("en", { id }) : enabledOnBoard("en", { id }),
      );
    }

    // The address and the port, asked of a BOARD entry and of nothing else.
    // The loader tolerates either key on another kind the way it tolerates any
    // key it has no rule about.
    if (entry.kind === "board") {
      const bind = entry.bind;
      if (bind === undefined || bind === null || bind === "") {
        refuse(`${at}.bind`, here, boardBindMissing("en", { id }));
      } else if (typeof bind !== "string") {
        refuse(`${at}.bind`, here, boardBindNotAddress("en", { id, bind: describeBare(bind) }));
      } else if (isUnspecified(bind)) {
        // EVERY SPELLING OF EVERY INTERFACE. `0.0.0.0` and `::` are what a
        // person writes, and `::0`, `0:0:0:0:0:0:0:0` and `::ffff:0.0.0.0` are
        // those same two addresses said differently, so the comparison is on
        // the address. The file's OWN words go into the sentence, because what
        // an operator has to find and change is what they wrote.
        refuse(`${at}.bind`, here, boardBindWide("en", { id, bind }));
      } else if (isIP(bind) === 0) {
        // A NAME IS REFUSED WHERE AN ADDRESS IS NOT. A name resolves at bind
        // time to whatever the resolver answers, which can be a wildcard by
        // another route, so a file that read as one specific address would end
        // up serving every interface the box has. Nothing here validates a
        // RANGE: a loader that did would carry a behaviour constant it cannot
        // verify and would refuse a household that reaches its board another
        // way.
        refuse(`${at}.bind`, here, boardBindNotAddress("en", { id, bind }));
      }
      const port = entry.port;
      if (
        port === undefined ||
        port === null ||
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        refuse(`${at}.port`, here, boardPort("en", { id, value: describeBare(port) }));
      }
      // The artifacts port is optional, and a file that names none serves no
      // artifact. Where it is named it is a port of its own: the same port
      // would put an agent's own pages on the origin the acts are on.
      const shows = entry.artifacts_port;
      if (
        shows !== undefined &&
        shows !== null &&
        (typeof shows !== "number" ||
          !Number.isInteger(shows) ||
          shows < 1 ||
          shows > 65535 ||
          shows === port)
      ) {
        refuse(`${at}.artifacts_port`, here, boardArtifactsPort("en", { id, value: describeBare(shows) }));
      }
    }

    const machine = entry.machine;
    if (machine === undefined || machine === null || machine === "") {
      if (namesAMachine) {
        throw new RegistryRefused(
          file,
          here,
          `${at}.machine`,
          `${id} says no machine, and this file declares ${machines.length}, so nothing would ever run it`,
        );
      }
    } else if (typeof machine !== "string" || (declared.size > 0 && !declared.has(machine))) {
      throw new RegistryRefused(
        file,
        lines.get(`${at}.machine`) ?? here,
        `${at}.machine`,
        `${id} runs on ${describe(machine)}, which no [[machines]] entry declares`,
      );
    }

    // The CHILD's limit, which is not the entry's own `memory_limit_mb`.
    // A child that could never be watched cannot be configured.
    //
    // Asked of EVERY runner entry, whether or not the file declares
    // its machines. Making it conditional on the machines table would let a
    // runner entry without the field through, and a file with no
    // `[[machines]]` table is exactly the file a household starts with.
    let childLimit: number | undefined;
    if (entry.kind === "runner") {
      const asked = entry.child_memory_limit_mb;
      if (asked === undefined || asked === null) {
        throw new RegistryRefused(
          file,
          here,
          `${at}.child_memory_limit_mb`,
          `${id} is a runner with no child_memory_limit_mb, and every child it spawns is watched against one`,
        );
      }
      if (
        asked !== undefined &&
        asked !== null &&
        (typeof asked !== "number" || !Number.isInteger(asked) || asked <= 0)
      ) {
        throw new RegistryRefused(
          file,
          lines.get(`${at}.child_memory_limit_mb`) ?? here,
          `${at}.child_memory_limit_mb`,
          `${id} has child_memory_limit_mb ${describe(asked)}, and it must be a whole number of megabytes above zero`,
        );
      }
      childLimit = typeof asked === "number" ? asked : undefined;
    }

    // A door's two optional fields. A value of the wrong type is refused by
    // name here, and whether `default_preset` names a preset this file defines
    // is asked once the presets are parsed, further down.
    for (const field of ["guild", "default_preset"] as const) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (entry.kind !== "door") {
        refuse(`${at}.${field}`, lines.get(`${at}.${field}`) ?? here,
          `${id} is a ${entry.kind} and carries ${field}, which only a door reads`);
      }
      if (typeof value !== "string" || value.trim() === "") {
        refuse(`${at}.${field}`, lines.get(`${at}.${field}`) ?? here,
          `${id} has ${field} ${describe(value)}, and it must be a nonempty string`);
      }
    }

    // The transcriber's own three. The door posts to 127.0.0.1:<port>, so an
    // entry without one could never be reached at all.
    if (entry.kind === "transcriber") {
      const port = entry.port;
      if (
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new RegistryRefused(
          file,
          lines.get(`${at}.port`) ?? here,
          `${at}.port`,
          `${id} has port ${describe(port)}, and the door reaches it on loopback, ` +
            `so it must be a whole number from 1 to 65535`,
        );
      }
      const residency = entry.residency ?? VOICE_DEFAULTS.residency;
      if (!(RESIDENCY_KINDS as readonly string[]).includes(residency as string)) {
        throw new RegistryRefused(
          file,
          lines.get(`${at}.residency`) ?? here,
          `${at}.residency`,
          `${id} has residency ${describe(residency)}, and the two this hub has ` +
            `are ${RESIDENCY_KINDS.join(" and ")}`,
        );
      }
      const idle = entry.idle_seconds;
      const says = idle !== undefined && idle !== null;
      if (residency === "resident" && says) {
        throw new RegistryRefused(
          file,
          lines.get(`${at}.idle_seconds`) ?? here,
          `${at}.idle_seconds`,
          `${id} is resident and carries idle_seconds, and a resident recognizer ` +
            `never lets its model go, so it has no idle window to read`,
        );
      }
      if (says) positive(idle, `${at}.idle_seconds`);
    }

    // The off-box copy's own rules. Each of its three commands is held to what
    // `install.admin_argv` is held to, the other command in this file that runs
    // with authority, plus two more: no path relative to wherever the process
    // happens to start, and no placeholder the job would not fill in, because
    // one it does not know would be passed through as a literal.
    if (entry.kind === "backup") {
      if (scheduleSeconds(String(entry.schedule)) === null) {
        refuse(`${at}.schedule`, here,
          `${id} is a backup with schedule ${describe(entry.schedule)}, and a copy runs on a cadence such as hourly ` +
            `or every 30m: one that never stops, or that nobody starts, is not an hourly copy`);
      }
      for (const key of BACKUP_ARGVS) {
        const where = `${at}.${key}`;
        const argv = entry[key];
        if (argv === undefined || argv === null) {
          refuse(where, here, `${id} is a backup with no ${key}, and the copy runs exactly the three commands the file names`);
        }
        strings(argv, where, false);
        const args = argv as string[];
        if (args.some(arg => PASSWORD_LITERAL.test(arg))) refuse(where, here, `${where} must not contain password literals`);
        const relative = args.find((arg, n) => arg === "." || arg === ".." || arg.startsWith("./") ||
          arg.startsWith("../") || (n === 0 && arg.includes("/") && !isAbsolute(arg)));
        if (relative !== undefined) {
          refuse(where, here,
            `${where} names ${describe(relative)}, a relative path, which is a different file in every directory a process starts in`);
        }
        for (const token of args.flatMap(arg => arg.match(/\{[A-Za-z_]+\}/g) ?? [])) {
          if (!(BACKUP_PLACEHOLDERS as readonly string[]).includes(token)) {
            refuse(where, here,
              `${where} carries ${token}, and the four placeholders are ${BACKUP_PLACEHOLDERS.slice(0, 3).join(", ")} and ${BACKUP_PLACEHOLDERS[3]}`);
          }
          if (key !== "readback_argv" && (token === "{path}" || token === "{out}")) {
            refuse(where, here, `${where} carries ${token}, which names the one file a read-back reads and means nothing here`);
          }
          // A read-back through the copy on this box compares that copy with
          // itself, so it would say every copy landed.
          if (key === "readback_argv" && token === "{staging}") {
            refuse(where, here, `${where} reads {staging}, which is the copy on this box, so it would match whatever the upload did`);
          }
        }
      }
      // THE DESTINATION IS NOT PARSED. It is a value the commands receive and
      // the code never interprets, so a loader that checked its shape would be
      // naming a provider. A nonempty string is all it has to be.
      const destination = entry.destination;
      if (destination === undefined || destination === null) {
        refuse(`${at}.destination`, here, `${id} is a backup with no destination, and a copy has to go somewhere`);
      }
      if (typeof destination !== "string" || destination.trim() === "") {
        refuse(`${at}.destination`, here, `${id} has destination ${describe(destination)}, and it must be a nonempty string`);
      }
    }

    entries.push({
      id,
      kind: entry.kind as string,
      schedule: entry.schedule as string,
      memory_limit_mb: limit,
      machine: typeof machine === "string" && machine !== "" ? machine : (machines[0]?.id ?? ""),
      ...Object.fromEntries(["max_active_children", "child_memory_budget_mb", "repositories", "token_file", "enabled"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      // The fields that belong to ONE kind, carried onto that kind's row and
      // IGNORED on every other, the way the loader has always tolerated a key
      // it has no rule about. A board is reached at an address and a port, the
      // recognizer at a port on loopback plus the two knobs that say how long
      // it holds its model, a door names the server a channel name is
      // resolved against and the preset it adopts agents with, and a backup
      // carries its three commands and where they send the copy. Carrying any of
      // them onto another kind's row would put a field on it that nothing reads
      // and that a reader would have to explain.
      ...Object.fromEntries((entry.kind === "board" ? ["bind", "port", "artifacts_port"]
        : entry.kind === "transcriber" ? ["port", "residency", "idle_seconds"]
        : entry.kind === "door" ? ["guild", "default_preset"]
        : entry.kind === "backup" ? ["destination", ...BACKUP_ARGVS] : [])
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      ...(childLimit === undefined ? {} : { child_memory_limit_mb: childLimit }),
    });
  });

  // A door on a machine with no transcriber entry could never transcribe, and
  // a piece that could never be reached cannot be configured. Asked once, after
  // every entry is parsed, because it is a question about the whole set.
  if (household?.provider === "sherpa-onnx") {
    const transcribes = new Set(
      entries.filter((entry) => entry.kind === "transcriber").map((entry) => entry.machine),
    );
    const orphan = entries.findIndex(
      (entry) => entry.kind === "door" && !transcribes.has(entry.machine),
    );
    if (orphan >= 0) {
      const door = entries[orphan];
      refuse(
        `run[${orphan}].machine`,
        lines.get(`run[${orphan}].id`) ?? 0,
        `${door.id} is a door on ${door.machine === "" ? "the one machine this file has" : door.machine}, ` +
          `and this household transcribes with ${household.name}, which runs beside the door. ` +
          `That machine carries no [[run]] entry of kind transcriber, so this door could never transcribe`,
      );
    }
  }

  const presets: Record<string, PresetEntry> = Object.create(null);
  for (const [name, table] of Object.entries(
    (parsed.presets ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const where = `presets.${name}`;
    const here = lines.get(where) ?? 0;
    if (table.id !== undefined) {
      refuse(
        `${where}.id`,
        here,
        `${name} carries an id, and a preset id is derived from its five settings, never typed`,
      );
    }
    for (const field of PRESET_KEYS) {
      if (typeof table[field] !== "string" || table[field] === "") {
        refuse(
          `${where}.${field}`,
          here,
          `${name} has no ${field}, and a preset is the five settings its id is derived from`,
        );
      }
    }
    // `paid` is a closed set of two, because everything below turns on
    // which of them it is and a third value would read as a quiet default.
    const paid = table.paid as string;
    if (!(PAID_KINDS as readonly string[]).includes(paid)) {
      refuse(
        `${where}.paid`,
        here,
        `${name} is paid for by ${describe(paid)}, and the two this hub has are ` +
          `${PAID_KINDS.join(" and ")}`,
      );
    }

    // The window thresholds are settings on the preset, never code
    // (L10 rule 4), so a plan preset carries all three or the file is refused,
    // and a key preset carrying one is refused by name: "an agent on a
    // per-token key has no window", and a setting nothing reads is forbidden.
    //
    // THERE IS NO FALLBACK ANYWHERE IN CODE. v2's 85/95/100 ship in
    // src/registry/registry.example.toml, which is where a shipped default
    // belongs: a code fallback would be a window threshold in code for every
    // household that never writes the file.
    const window: Record<string, number> = {};
    for (const field of WINDOW_KEYS) {
      const value = table[field];
      const said = value !== undefined && value !== null;
      if (paid === "key") {
        if (said) {
          refuse(
            `${where}.${field}`,
            here,
            `${name} is paid for by a per-token key and carries ${field}, and an ` +
              `agent on a key has no window, so nothing in production would ever read it`,
          );
        }
        continue;
      }
      if (!said) {
        refuse(
          `${where}.${field}`,
          here,
          `${name} is on a plan and has no ${field}, and the window thresholds are ` +
            `settings on the preset rather than numbers in code`,
        );
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
        refuse(
          `${where}.${field}`,
          here,
          `${name} has ${field} ${describe(value)}, and it must be a whole percent ` +
            `from 1 to 100`,
        );
      }
      window[field] = value as number;
    }
    // A file that said hold at 50 and pause at 90 would pause nothing and hold
    // everything with no complaint, and a quiet default is forbidden.
    if (
      paid === "plan" &&
      !(
        window.window_pause_at <= window.window_notice_at &&
        window.window_notice_at <= window.window_hold_at
      )
    ) {
      refuse(
        `${where}.window_hold_at`,
        here,
        `${name} says pause at ${window.window_pause_at}, notice at ` +
          `${window.window_notice_at} and hold at ${window.window_hold_at}, and the ` +
          `three must rise: pause_at <= notice_at <= hold_at`,
      );
    }

    presets[name] = {
      adapter: table.adapter as string,
      effort: table.effort as string,
      model: table.model as string,
      paid: table.paid as string,
      provider: table.provider as string,
    };
  }

  // A person is a registry entry and its tree is the boundary. Two with
  // one id is the same refusal a duplicate [[run]] id already carries.
  const people: PersonEntry[] = [];
  const peopleAt = new Map<string, number>();
  /** Where each person's tree and vault are on each machine that says so. */
  const peopleOn = new Map<string, Record<string, PersonPlacement>>();
  ((parsed.people ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const where = `people[${nth}]`;
    const here = lines.get(`${where}.id`) ?? lines.get(where) ?? 0;
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      refuse(`${where}.id`, here, `this person has no id, and an agent names its person by id`);
    }
    const already = peopleAt.get(id as string);
    if (already !== undefined) {
      refuse(
        `${where}.id`,
        here,
        `${id} is already a person of this registry, on line ${already}. The boundary is the person, and one id is one person`,
      );
    }
    peopleAt.set(id as string, here);

    // The four clocks and the language, each OPTIONAL, each refused by
    // name and by line when it is there and wrong. A clock that runs out at
    // once is a clock nobody set, so zero is refused with everything below it.
    const clocks: Partial<Record<(typeof STAMP_THRESHOLD_KEYS)[number], number>> = {};
    for (const field of STAMP_THRESHOLD_KEYS) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        refuse(
          `${where}.${field}`,
          here,
          `${id} has ${field} ${describe(value)}, and a clock is a whole number of ` +
            `seconds above zero`,
        );
      }
      clocks[field] = value as number;
    }
    // The fifth clock, this person's own, kept OUT of the four above on
    // purpose: `thresholdsFor` answers exactly the four clocks the ruling
    // names, and two shipped checks compare that answer whole.
    const spoken = entry.transcribed_seconds;
    if (spoken !== undefined && spoken !== null) {
      if (typeof spoken !== "number" || !Number.isInteger(spoken) || spoken <= 0) {
        refuse(
          `${where}.transcribed_seconds`,
          lines.get(`${where}.transcribed_seconds`) ?? here,
          `${id} has transcribed_seconds ${describe(spoken)}, and a clock is a whole ` +
            `number of seconds above zero`,
        );
      }
    }
    const speaks = entry.language;
    if (speaks !== undefined && speaks !== null) {
      if (typeof speaks !== "string" || !(LANGUAGES as readonly string[]).includes(speaks)) {
        refuse(
          `${where}.language`,
          here,
          `${id} reads ${describe(speaks)}, and the two languages this hub speaks ` +
            `are ${LANGUAGES.join(" and ")}`,
        );
      }
    }

    // The harvest, this person's own. Five more optional
    // fields on the same spread-never-set rule, and seven refusals that each
    // name their key and their line. A key the file does not carry has no line
    // of its own, so its refusal names the line of the entry it belongs to,
    // which is the convention every absent-key refusal above already uses.
    const tree = typeof entry.tree === "string" ? entry.tree : "";
    const harvester = entry.harvester;
    const vault = entry.vault;
    const namesHarvester = harvester !== undefined && harvester !== null;
    const namesVault = vault !== undefined && vault !== null;
    if (namesHarvester) {
      if (typeof harvester !== "string" || !Object.hasOwn(presets, harvester)) {
        refuse(
          `${where}.harvester`,
          here,
          `${id} is harvested by ${describe(harvester)}, which this file defines no ` +
            `preset for, and nothing can harvest through a preset that is not there`,
        );
      }
      // A harvester requires a vault; a vault can also supply filing rules
      // without enabling harvest.
      if (!namesVault) {
        refuse(
          `${where}.vault`,
          here,
          `${id} is harvested by ${harvester} and names no vault, and a harvested ` +
            `note is filed into the directory holding vault/ and raw/`,
        );
      }
    }
    if (namesVault) {
      const atVault = lines.get(`${where}.vault`) ?? here;
      if (typeof vault !== "string" || vault === "" || !isAbsolute(vault)) {
        refuse(
          `${where}.vault`,
          atVault,
          `${id} has vault ${describe(vault)}, and it must be an absolute path: a ` +
            `relative one is a different vault in every directory a process starts in`,
        );
      }
      // CONTAINMENT IS CHECKED AND EXISTENCE IS NOT. Whether a path
      // exists is a question about a MACHINE and one file loads on three of
      // them, while whether one path lies inside another is string arithmetic
      // decidable from the file alone. It matters concretely: the harvester's
      // session runs in the agent's own box, the box fences the person's tree
      // (L7), and a vault outside it is a vault the loop cannot read, so every
      // person link the model wrote would be an orphan and nobody would be told.
      // A person with no tree has no box, so their agents cannot start at all
      // (`check` says so as `agent-unboxed`), and may name any absolute path.
      if (tree !== "") {
        const inside = resolve(vault as string);
        const fence = resolve(tree);
        if (inside !== fence && !inside.startsWith(fence + sep)) {
          refuse(
            `${where}.vault`,
            atVault,
            `${id} has vault ${describe(vault)}, which is outside their tree ${tree}, ` +
              `and the box the harvester's session runs in fences that tree`,
          );
        }
      }
    }
    for (const field of ["harvest_quiet_minutes", "harvest_min_messages"] as const) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        refuse(
          `${where}.${field}`,
          lines.get(`${where}.${field}`) ?? here,
          `${id} has ${field} ${describe(value)}, and it is a whole number above ` +
            `zero: a quiet period of zero is a chat that is always quiet and a ` +
            `minimum of zero is a slice of nothing`,
        );
      }
    }
    const reports = entry.harvest_report;
    if (reports !== undefined && reports !== null && typeof reports !== "boolean") {
      refuse(
        `${where}.harvest_report`,
        lines.get(`${where}.harvest_report`) ?? here,
        `${id} has harvest_report ${describe(reports)}, and whether a line comes ` +
          `back is a true or a false`,
      );
    }
    const shows = entry.artifacts;
    if (shows !== undefined && shows !== null && typeof shows !== "boolean") {
      refuse(
        `${where}.artifacts`,
        lines.get(`${where}.artifacts`) ?? here,
        artifactsNotBoolean("en", { id, value: describeBare(shows) }),
      );
    }
    // Where this person is on a machine that is not the hub's: the same two
    // rules the entry's own tree and vault get, applied per machine. A
    // placement names a tree, because it is the box's fence there, and it
    // names a vault whenever the entry does, because a harvest on that machine
    // files into it and an agent there is told where its vault is.
    // WHETHER THIS PERSON'S FILES ARE CHECKED READABLE HERE. The four files a
    // person may name are read by a launch, and a launch happens on the
    // machine an agent's runner is on. So they are checked on the view of a
    // machine one of this person's agents runs on, and on the file as written
    // when it declares fewer than two machines, which is the one machine
    // there is. A file with two machines read as written is a door's, a
    // board's or a sync's read, none of which opens these files, and a Pi path
    // checked on the Mac would refuse the Mac's copy of the file whole.
    const runsHere = viewed === null
      ? machines.length < 2
      : ((parsed.agents ?? []) as Record<string, unknown>[]).some((agent) =>
          agent && agent.person === id && entries.find((one) => one.id === agent.runner)?.machine === viewed);
    const readableHere = (value: unknown, key: string) => {
      if (runsHere) readable(value, key);
      else if (typeof value !== "string" || !isAbsolute(value)) refuse(key, 0, `${key} must be an absolute readable file`);
    };
    peopleOn.set(id as string, placements<PersonPlacement>(entry, where, here, id, ["tree", "vault", ...PERSON_FILE_KEYS],
      (table, machine, atOn) => {
        // The files this person names on that machine, checked readable only
        // where they will be read: on the view of that very machine.
        const files: Partial<PersonPlacement> = {};
        for (const key of PERSON_FILE_KEYS) {
          const value = table[key];
          if (value === undefined || value === null) continue;
          const atKey = `${where}.on.${machine}.${key}`;
          if (key === "instructions") {
            strings(value, atKey);
            (value as string[]).forEach((one, n) => {
              if (machine === viewed) readableHere(one, `${atKey}[${n}]`);
              else if (!isAbsolute(one)) refuse(`${atKey}[${n}]`, atOn, `${atKey}[${n}] must be an absolute readable file`);
            });
            files.instructions = [...(value as string[])];
            continue;
          }
          if (machine === viewed) readableHere(value, atKey);
          else if (typeof value !== "string" || !isAbsolute(value)) refuse(atKey, atOn, `${atKey} must be an absolute readable file`);
          files[key] = value as string;
        }
        const there = table.tree;
        if (typeof there !== "string" || there === "" || !isAbsolute(there)) {
          refuse(`${where}.on.${machine}.tree`, atOn,
            `${id} on ${machine} has tree ${describe(there)}, and it must be an absolute path: it is the box's fence on that machine`);
        }
        const kept = table.vault;
        if (kept === undefined || kept === null) {
          if (namesVault) {
            refuse(`${where}.on.${machine}.vault`, atOn,
              `${id} names a vault and says none on ${machine}, and an agent on that machine files into a vault that is there`);
          }
          return { tree: there as string, ...files };
        }
        if (typeof kept !== "string" || kept === "" || !isAbsolute(kept)) {
          refuse(`${where}.on.${machine}.vault`, atOn,
            `${id} on ${machine} has vault ${describe(kept)}, and it must be an absolute path`);
        }
        const inside = resolve(kept as string);
        const fence = resolve(there as string);
        if (inside !== fence && !inside.startsWith(fence + sep)) {
          refuse(`${where}.on.${machine}.vault`, atOn,
            `${id} on ${machine} has vault ${describe(kept)}, which is outside their tree ${there} there, and the box fences that tree`);
        }
        return { tree: there as string, vault: kept as string, ...files };
      }));
    // The entry's own files stand on every machine without a placement for
    // them, so they are checked readable here unless this view's machine
    // places that very key.
    const placedHere = viewed === null ? undefined : peopleOn.get(id as string)?.[viewed];
    if (entry.filing_rules !== undefined && placedHere?.filing_rules === undefined) readableHere(entry.filing_rules, `${where}.filing_rules`);
    for (const key of ["mcp", "settings"] as const) {
      if (entry[key] !== undefined && placedHere?.[key] === undefined) readableHere(entry[key], `${where}.${key}`);
    }
    if (entry.instructions !== undefined) {
      strings(entry.instructions, `${where}.instructions`);
      if (placedHere?.instructions === undefined) {
        (entry.instructions as string[]).forEach((file, n) => readableHere(file, `${where}.instructions[${n}]`));
      }
    }
    if (entry.history_harvest_after !== undefined &&
        (typeof entry.history_harvest_after !== "string" ||
         !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(entry.history_harvest_after) ||
         !Number.isFinite(Date.parse(entry.history_harvest_after))))
      refuse(`${where}.history_harvest_after`, here, "history_harvest_after must be a UTC instant");
    if (entry.allowed_senders !== undefined) {
      if (!entry.allowed_senders || typeof entry.allowed_senders !== "object" || Array.isArray(entry.allowed_senders))
        refuse(`${where}.allowed_senders`, here, "allowed_senders must be a door table");
      for (const [door, senders] of Object.entries(entry.allowed_senders as Record<string, unknown>)) {
        if (!entries.some(e => e.id === door && e.kind === "door") &&
            !(Array.isArray(parsed.agents) && parsed.agents.some(a => a && a.door === door && a.person === entry.id)))
          refuse(`${where}.allowed_senders`, here, "allowed_senders names an undeclared door");
        strings(senders, `${where}.allowed_senders`);
      }
    }
    const harvest: Record<string, unknown> = {
      ...Object.fromEntries(["filing_rules", "history_harvest_after", "allowed_senders", "instructions", "mcp", "settings"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      ...(namesHarvester ? { harvester: harvester as string } : {}),
      ...(namesVault ? { vault: vault as string } : {}),
      ...(typeof entry.harvest_quiet_minutes === "number"
        ? { harvest_quiet_minutes: entry.harvest_quiet_minutes }
        : {}),
      ...(typeof entry.harvest_min_messages === "number"
        ? { harvest_min_messages: entry.harvest_min_messages }
        : {}),
      ...(typeof reports === "boolean" ? { harvest_report: reports } : {}),
      // Spread, never set, like every optional field above: a check binds the
      // shape of a person who declares none of them.
      ...(typeof shows === "boolean" ? { artifacts: shows } : {}),
    };

    // Spread, never set: a file that carries none of the ten leaves an entry
    // of exactly `id` and `tree`, which is the shape a shipped check asserts.
    people.push({
      id: id as string,
      tree,
      ...clocks,
      ...(typeof spoken === "number" ? { transcribed_seconds: spoken } : {}),
      ...(typeof speaks === "string" ? { language: speaks } : {}),
      ...harvest,
    });
  });
  const knownPerson = new Set(people.map((person) => person.id));

  // Every credential this household runs on, named here so a preset can
  // point at one and so `check` can open every one of them. A door's
  // `token_file` stays exactly as it is and is treated as a credential without
  // being an entry, so a file that declares no credentials still loads.
  const credentials: CredentialEntry[] = [];
  const credentialAt = new Map<string, number>();
  /** Where each credential is on each machine that says so. */
  const credentialsOn = new Map<string, Record<string, CredentialPlacement>>();
  ((parsed.credentials ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const where = `credentials[${nth}]`;
    const here = lines.get(`${where}.id`) ?? lines.get(where) ?? 0;
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      refuse(`${where}.id`, here, `this credential has no id, and a preset names its login by id`);
    }
    const already = credentialAt.get(id as string);
    if (already !== undefined) {
      refuse(
        `${where}.id`,
        here,
        `${id} is already a credential of this registry, on line ${already}. A ` +
          `credential has one owner and ONE place`,
      );
    }
    credentialAt.set(id as string, here);

    const kind = entry.kind;
    if (typeof kind !== "string" || !(CREDENTIAL_KINDS as readonly string[]).includes(kind)) {
      refuse(
        `${where}.kind`,
        here,
        `${id} is a ${describe(kind)}, and the four kinds this hub opens are ` +
          `${CREDENTIAL_KINDS.join(", ")}`,
      );
    }
    const at = entry.file;
    if (typeof at !== "string" || at === "") {
      refuse(`${where}.file`, here, `${id} names no file, and a credential lives in exactly one`);
    }
    const owner = entry.owner;
    if (typeof owner !== "string" || owner === "") {
      refuse(
        `${where}.owner`,
        here,
        `${id} names no owner, and the owner is the household or one person`,
      );
    }
    // Asked only of a file that declares people at all, the same tolerance a
    // people-less file gets everywhere else: whether a person is declared
    // is a question this file may not be answering yet.
    if (knownPerson.size > 0 && owner !== "household" && !knownPerson.has(owner as string)) {
      refuse(
        `${where}.owner`,
        here,
        `${id} is owned by ${describe(owner)}, which is neither the household nor a ` +
          `person this file declares`,
      );
    }

    // Where this credential's file is on a machine that is not the hub's. A
    // model login there is a file login made for that machine's runner, never
    // a copy of another machine's: a refresh token is single use, and a copy
    // that refreshes kills the login it was copied from.
    credentialsOn.set(id as string, placements<CredentialPlacement>(entry, where, here, id, ["file"],
      (table, machine, atOn) => {
        const there = table.file;
        if (typeof there !== "string" || there === "" || !isAbsolute(there)) {
          refuse(`${where}.on.${machine}.file`, atOn,
            `${id} on ${machine} has file ${describe(there)}, and it must be an absolute path`);
        }
        return { file: there as string };
      }));

    credentials.push({
      id: id as string,
      kind: kind as string,
      file: at as string,
      owner: owner as string,
    });
  });

  // A preset points at its login by id, and a typo is otherwise an agent
  // reading a login nobody owns. Fake adapters may omit a credential;
  // production presets are checked after the structural references below.
  const declaredCredential = new Set(credentials.map((one) => one.id));
  for (const [name, table] of Object.entries(
    (parsed.presets ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const points = table.credential;
    if (points === undefined || points === null) {
      continue;
    }
    if (typeof points !== "string" || !declaredCredential.has(points)) {
      refuse(
        `presets.${name}.credential`,
        lines.get(`presets.${name}`) ?? 0,
        `${name} reads its login from ${describe(points)}, which no [[credentials]] ` +
          `entry declares`,
      );
    }
  }
  // A cloud recognizer points at its key by id, for the same reason a preset
  // does: a typo is otherwise a request signed with a key nobody owns.
  for (const [name, table] of Object.entries(recognizers)) {
    if (table.credential === null || declaredCredential.has(table.credential)) continue;
    refuse(
      `recognizers.${name}.credential`,
      lines.get(`recognizers.${name}`) ?? 0,
      `${name} reads its key from ${describe(table.credential)}, which no ` +
        `[[credentials]] entry declares`,
    );
  }

  const agents: AgentEntry[] = [];
  const agentAt = new Map<string, number>();
  ((parsed.agents ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const where = `agents[${nth}]`;
    const here = lines.get(`${where}.id`) ?? lines.get(where) ?? 0;
    if (!isAgentId(entry.id)) {
      refuse(
        `${where}.id`,
        here,
        `this agent's id is ${describe(entry.id)}, and an agent id is lower case letters and digits joined by ` +
          `single hyphens: it names the folder its chat log and its sessions are kept in, so an id that can ` +
          `leave that folder is refused here`,
      );
    }
    const already = agentAt.get(entry.id as string);
    if (already !== undefined) {
      refuse(
        `${where}.id`,
        here,
        `${entry.id} is already an agent of this registry, on line ${already}. One id is one agent, ` +
          `and two would share one chat log and one set of sessions`,
      );
    }
    agentAt.set(entry.id as string, here);
    // The tail is one size for the household. A key the loader ignored quietly
    // would look like it worked and change nothing.
    for (const own of ["tail_hours", "tail_tokens"]) {
      if (entry[own] !== undefined) {
        refuse(
          `${where}.${own}`,
          here,
          `${entry.id} sets its own ${own}, and the tail is one size for the household, under [hub]`,
        );
      }
    }
    if (!(typeof entry.preset === "string" && Object.hasOwn(presets, entry.preset))) {
      refuse(
        `${where}.preset`,
        here,
        `${entry.id} names the preset ${entry.preset}, which this file does not define`,
      );
    }
    // Asked only of a file that declares people at all, which is the same
    // tolerance the machine field has and for the same reason.
    if (knownPerson.size > 0 && !knownPerson.has(entry.person as string)) {
      refuse(
        `${where}.person`,
        here,
        `${entry.id} names the person ${entry.person}, which this file does not declare`,
      );
    }
    for (const key of ["fragment", "settings", "mcp"]) {
      if (entry[key] !== undefined) readable(entry[key], `${where}.${key}`);
    }
    if (entry.tools !== undefined) {
      strings(entry.tools, `${where}.tools`);
      if (new Set(entry.tools as string[]).size !== (entry.tools as string[]).length)
        refuse(`${where}.tools`, here, "tools must be unique");
    }
    if (entry.mode !== undefined && !["resident", "on-demand"].includes(entry.mode as string))
      refuse(`${where}.mode`, here, "mode must be resident or on-demand");
    if (entry.sleeping !== undefined && typeof entry.sleeping !== "boolean")
      refuse(`${where}.sleeping`, here, "sleeping must be boolean");
    if (entry.idle_seconds !== undefined) positive(entry.idle_seconds, `${where}.idle_seconds`);
    // A chat and the door that carries it come as a pair. With neither, the
    // agent exists only to take jobs and its empty tail is what the file says.
    // With one of them, the file has half an agent: a chat no door reads, or a
    // door with nowhere to post, and either would be served silently wrong.
    for (const [said, missing] of [["chat", "door"], ["door", "chat"]] as const) {
      if (entry[said] !== undefined && entry[missing] === undefined) {
        refuse(
          `${where}.${missing}`,
          here,
          `${entry.id} names a ${said} and no ${missing}, and an agent carries both or neither: ` +
            `both to answer in a chat, neither to take jobs alone`,
        );
      }
    }
    agents.push({
      ...Object.fromEntries(["fragment", "settings", "mcp", "tools", "mode", "sleeping", "idle_seconds", "chat", "door"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      id: entry.id as string,
      person: entry.person as string,
      preset: entry.preset as string,
      runner: entry.runner as string,
    });
  });

  // The preset a door adopts an agent with, checked against the presets this
  // file defines. Asked of EVERY door entry and not only of one that serves an
  // agent, because the first agent a door ever gets is the one an adopt
  // creates, and a preset nobody declared would be found at that moment.
  entries.forEach((entry, nth) => {
    if (entry.kind !== "door" || entry.default_preset === undefined) return;
    if (!Object.hasOwn(presets, entry.default_preset)) {
      refuse(
        `run[${nth}].default_preset`,
        lines.get(`run[${nth}].default_preset`) ?? lines.get(`run[${nth}].id`) ?? 0,
        `${entry.id} adopts agents with the preset ${entry.default_preset}, which this file does not define`,
      );
    }
  });

  // A door that serves an agent has to say which platform it speaks, whose it is
  // and where its credential lives, because that is all the hub is ever told
  // about it. A door nobody points at is on the list and serves nobody yet. An
  // agent that takes jobs alone points at no door, so it adds none to the set.
  const served = new Set(agents.flatMap((agent) => agent.door === undefined ? [] : [agent.door]));
  entries.forEach((entry, nth) => {
    if (entry.kind !== "door" || !served.has(entry.id)) return;
    const where = `run[${nth}]`;
    const here = lines.get(`${where}.id`) ?? 0;
    for (const field of ["platform", "person", "token_file"] as const) {
      const value = (parsed.run as Record<string, unknown>[])[nth][field];
      if (typeof value !== "string" || value === "") {
        refuse(
          `${where}.${field}`,
          here,
          `${entry.id} serves an agent and has no ${field}, and a door is a platform, a person and a token file`,
        );
      }
    }
    // Telegram's `getUpdates` offset confirms every update
    // below it for the whole BOT, not for one chat, and Telegram refuses a
    // second long poll on a bot while one is open. The door keeps one cursor
    // per chat and runs one reader per agent, so a second agent on a Telegram
    // door acknowledges the first one's messages without accepting them.
    // Serving both would take one reader per bot with one cursor for every
    // chat, which is not the cursor the door keeps, so the file is refused.
    // Discord's cursor is a per-channel snowflake and stays legal there.
    if ((parsed.run as Record<string, unknown>[])[nth].platform !== "telegram") return;
    const readers = ((parsed.agents ?? []) as Record<string, unknown>[])
      .map((agent, index) => ({ agent, index }))
      .filter(({ agent }) => agent.door === entry.id);
    if (readers.length < 2) return;
    const [kept, extra] = readers;
    refuse(
      `agents[${extra.index}].door`,
      lines.get(`agents[${extra.index}].door`) ?? lines.get(`agents[${extra.index}]`) ?? here,
      `${entry.id} is a Telegram door and ${kept.agent.id} already reads it (chat ${kept.agent.chat}), ` +
        `so ${extra.agent.id} (chat ${extra.agent.chat}) cannot: Telegram confirms updates for the whole bot, ` +
        `so one Telegram door serves one agent in one chat. Give ${extra.agent.id} its own bot and door`,
    );
  });

  const rates: RateEntry[] = [];
  ((parsed.rates ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const where = `rates[${nth}]`;
    if (typeof entry.from !== "string" || Number.isNaN(Date.parse(entry.from))) {
      refuse(
        `${where}.from`,
        lines.get(where) ?? 0,
        `this rate row is dated ${describe(entry.from)}, and a price is knowable only from a row that says when it started`,
      );
    }
    rates.push(entry as unknown as RateEntry);
  });

  for (const [name, table] of Object.entries(
    (parsed.presets ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    if (Object.hasOwn(ADAPTERS, String(table.adapter)) && table.credential === undefined)
      refuse(`presets.${name}.credential`, lines.get(`presets.${name}`) ?? 0,
        "production presets require a declared credential");
  }

  const repositories: RepositoryEntry[] = [];
  /** Where each repository's checkout is on each machine that says so. */
  const repositoriesOn = new Map<string, Record<string, RepositoryPlacement>>();
  if (parsed.repositories !== undefined && !Array.isArray(parsed.repositories))
    refuse("repositories", 0, "repositories must be a list");
  for (const [nth, entry] of ((parsed.repositories ?? []) as Record<string, unknown>[]).entries()) {
    const where = `repositories[${nth}]`;
    for (const key of ["id", "person", "path", "remote", "branch"]) {
      if (typeof entry[key] !== "string" || (entry[key] as string).trim() === "")
        refuse(`${where}.${key}`, 0, `${key} must be a nonempty string`);
    }
    if (!knownPerson.has(entry.person as string)) refuse(`${where}.person`, 0, "repository person is undeclared");
    if (!isAbsolute(entry.path as string)) refuse(`${where}.path`, 0, "repository path must be absolute");
    if (repositories.some(r => r.id === entry.id)) refuse(`${where}.id`, 0, "repository id is duplicated");
    if (entry.required !== undefined && typeof entry.required !== "boolean")
      refuse(`${where}.required`, 0, "required must be boolean");
    if (entry.zone !== undefined && typeof entry.zone !== "boolean")
      refuse(`${where}.zone`, 0, "zone marks a checkout of the shared zone and is a true or a false");
    if (entry.ssh_command !== undefined && (typeof entry.ssh_command !== "string" || entry.ssh_command.trim() === ""))
      refuse(`${where}.ssh_command`, 0, "ssh_command is the command the sync runs ssh as, a nonempty string");
    // Where this checkout is on a machine that is not the hub's, so a sync
    // there keeps the vault checkout there in step with its remote.
    repositoriesOn.set(entry.id as string, placements<RepositoryPlacement>(entry, where, lines.get(where) ?? 0, entry.id, ["path", "remote"],
      (table, machine, atOn) => {
        const there = table.path;
        if (typeof there !== "string" || there === "" || !isAbsolute(there)) {
          refuse(`${where}.on.${machine}.path`, atOn, `${entry.id} on ${machine} has path ${describe(there)}, and it must be an absolute path`);
        }
        const remote = table.remote;
        if (remote !== undefined && remote !== null && (typeof remote !== "string" || remote.trim() === "")) {
          refuse(`${where}.on.${machine}.remote`, atOn, `${entry.id} on ${machine} has remote ${describe(remote)}, and it is a git remote name`);
        }
        return { path: there as string, ...(typeof remote === "string" ? { remote } : {}) };
      }));
    const { on: _on, ...kept } = entry;
    repositories.push(kept as unknown as RepositoryEntry);
  }

  // THE SHARED ZONE, declared ONCE for the household: one remote, checked out
  // inside every vault under the same folder name. It is read after the people
  // and after the repositories because two of its rules need a person's vault
  // and a repository's own path, and neither is known before here.
  let zone: ZoneEntry | null = null;
  const declaredZone = parsed.zone;
  if (declaredZone !== undefined && declaredZone !== null) {
    if (typeof declaredZone !== "object" || Array.isArray(declaredZone))
      refuse("zone", 0, "zone is one table for the household, naming its mount, its remote and its url");
    const table = declaredZone as Record<string, unknown>;
    const here = lines.get("zone") ?? 0;
    const text = (key: string, what: string): string => {
      const value = table[key];
      if (typeof value !== "string" || value.trim() === "")
        refuse(`zone.${key}`, here, `zone.${key} is ${what}, and this is ${describe(value)}`);
      return value as string;
    };
    const mount = text("mount", "the folder name every vault carries the shared zone under");
    // ONE FOLDER NAME, joined onto a vault path, so anything that could leave
    // that folder is a path traversal wearing a folder's clothes. Kebab-case in
    // one predicate refuses a slash, a backslash, a dot, a pair of dots and a
    // space together, and a separator test for this platform would let the
    // other platform's through.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(mount))
      refuse("zone.mount", here,
        `the zone mounts at ${describe(mount)}, and a mount is one folder name in lower case letters, ` +
        `digits and single hyphens: it is joined onto a vault path, so a name that can leave that folder is refused here`);
    const remote = text("remote", "the git remote name every zone checkout wears");
    const url = text("url", "the url a clone of the shared zone reads, and a zone nothing can clone is a zone nothing provisions");
    zone = { mount, remote, url };
  }

  const zoneOfPerson = new Map<string, number>();
  /** The first zone checkout, whose branch every other one has to share. */
  let zoneBranch: { branch: string; line: number } | null = null;
  for (const one of repositories.filter((one) => one.zone === true)) {
    const nth = repositories.indexOf(one);
    const where = `repositories[${nth}]`;
    const at = lines.get(`${where}.id`) ?? lines.get(where) ?? 0;
    if (!zone)
      refuse(`${where}.zone`, at, `${one.id} is marked as a checkout of the shared zone and this file declares no [zone] table`);
    const already = zoneOfPerson.get(one.person);
    if (already !== undefined)
      refuse(`${where}.zone`, at,
        `${one.person} already has a zone checkout, declared on line ${already}, and one shared zone is one checkout per person`);
    zoneOfPerson.set(one.person, at);
    const vault = people.find((who) => who.id === one.person)?.vault;
    if (!vault)
      refuse(`${where}.person`, at,
        `${one.person} declares no vault, and a zone checkout is the mount inside a vault, so there is no path for this entry to be at`);
    // EQUALITY on the resolved paths, never a prefix test: a prefix accepts the
    // vault itself and every sibling of the mount beside it.
    const wants = resolve(join(vault as string, "vault", zone!.mount));
    if (resolve(one.path) !== wants)
      refuse(`${where}.path`, at,
        `${one.id} is at ${describe(one.path)}, and the mount ${zone!.mount} puts ${one.person}'s zone checkout at ${wants}`);
    if (one.remote !== zone!.remote)
      refuse(`${where}.remote`, at,
        `${one.id} pulls from the remote ${describe(one.remote)}, and every checkout of the shared zone wears ${describe(zone!.remote)}`);
    // The same two rules on every machine the checkout is placed on, against
    // the person's vault THERE: the mount is one folder name inside the vault
    // wherever the vault is.
    for (const [machine, there] of Object.entries(repositoriesOn.get(one.id) ?? {})) {
      const vaultThere = peopleOn.get(one.person)?.[machine]?.vault ?? vault;
      const wantsThere = resolve(join(vaultThere as string, "vault", zone!.mount));
      if (resolve(there.path) !== wantsThere)
        refuse(`${where}.on.${machine}.path`, lines.get(`${where}.on`) ?? at,
          `${one.id} on ${machine} is at ${describe(there.path)}, and the mount ${zone!.mount} puts ${one.person}'s zone checkout there at ${wantsThere}`);
      if (there.remote !== undefined && there.remote !== zone!.remote)
        refuse(`${where}.on.${machine}.remote`, lines.get(`${where}.on`) ?? at,
          `${one.id} on ${machine} pulls from the remote ${describe(there.remote)}, and every checkout of the shared zone wears ${describe(zone!.remote)}`);
    }
    // ONE ZONE IS ONE BRANCH. Each checkout is synced and verified against the
    // branch its own entry names, so two that name different branches of the
    // one remote pass every check while neither person sees what the other
    // shares.
    if (zoneBranch === null) zoneBranch = { branch: one.branch, line: lines.get(`${where}.branch`) ?? at };
    else if (one.branch !== zoneBranch.branch)
      refuse(`${where}.branch`, at,
        `${one.id} is on the branch ${describe(one.branch)}, and the zone checkout on line ${zoneBranch.line} is on ` +
        `${describe(zoneBranch.branch)}: one shared zone is one branch, or the two people never see each other's notes`);
  }

  // A SHARED ZONE BELONGS TO THE WHOLE HOUSEHOLD. Once the file declares one,
  // every person who keeps a vault carries exactly one checkout of it, and a
  // file that gave the zone to some of them is refused here. The refusal names
  // the PERSON, because the entry a reader has to add is that person's, and the
  // zone table is correct as written. Read as a warning instead, the household
  // would keep running with one person's zone quietly not there, and nobody
  // would learn until a shared note could not be read.
  if (zone) {
    for (const [nth, who] of people.entries()) {
      if (!who.vault || zoneOfPerson.has(who.id)) continue;
      const wants = resolve(join(who.vault, "vault", zone.mount));
      refuse(`people[${nth}].vault`, lines.get(`people[${nth}]`) ?? 0,
        `${who.id} keeps a vault and has no checkout of the shared zone, and one shared zone is one ` +
        `checkout in every vault: add a [[repositories]] entry for ${who.id} at ${wants}, marked ` +
        `zone = true and pulling from the remote ${describe(zone.remote)}`);
    }
  }

  entries.forEach((entry, nth) => {
    for (const id of entry.repositories ?? []) {
      if (!repositories.some(r => r.id === id)) refuse(`run[${nth}].repositories`, 0, "repository is undeclared");
    }
  });

  // The file as written is the hub machine's view. For any other machine the
  // three per-machine settings, every person's placement and every
  // credential's placement replace what the file says at the top, so nothing
  // below the loader ever asks which machine it is on. The rest of the file is
  // the same object either way.
  const machine = viewed;
  if (machine === null) {
    return new Registry(file, parsed, entries, presets, agents, rates, machines, people, credentials, repositories, recognizers, zone);
  }
  const own = machines.find((one) => one.id === machine);
  const hub = { ...((parsed.hub ?? {}) as Record<string, unknown>) };
  for (const key of MACHINE_SETTINGS) {
    const value = own?.[key];
    if (value !== undefined) hub[key] = value;
  }
  // A machine that names a state directory of its own keeps its secrets under
  // it too, unless it names those as well: the hub machine's secrets directory
  // is a path on the hub machine's disk.
  if (own?.state_dir !== undefined && own.secrets_dir === undefined) delete hub.secrets_dir;
  const placed: Placed = { people: [], credentials: [], repositories: [] };
  const placedPeople = people.map((person) => {
    const there = peopleOn.get(person.id)?.[machine];
    if (!there) return person;
    placed.people.push(person.id);
    const { vault: _vault, ...rest } = person;
    // The tree and the vault are replaced whole. A file the placement names
    // replaces the entry's, and one it does not name stays the entry's.
    return { ...rest, tree: there.tree, ...(there.vault === undefined ? {} : { vault: there.vault }),
      ...Object.fromEntries(PERSON_FILE_KEYS.filter((key) => there[key] !== undefined).map((key) => [key, there[key]])) };
  });
  const placedCredentials = credentials.map((credential) => {
    const there = credentialsOn.get(credential.id)?.[machine];
    if (!there) return credential;
    placed.credentials.push(credential.id);
    return { ...credential, file: there.file };
  });
  const placedRepositories = repositories.map((repository) => {
    const there = repositoriesOn.get(repository.id)?.[machine];
    if (!there) return repository;
    placed.repositories.push(repository.id);
    return { ...repository, path: there.path, ...(there.remote === undefined ? {} : { remote: there.remote }) };
  });
  return new Registry(file, { ...parsed, hub }, entries, presets, agents, rates, machines, placedPeople, placedCredentials,
    placedRepositories, recognizers, zone, machine, placed);
}

/**
 * Which machine a `[[run]]` entry is on, read off the file with no rule
 * checked, so a process can ask for its own machine's view before it loads
 * the file for real. The empty string when the file, the entry or the field is
 * not there, which loads the file as written.
 */
export function entryMachine(file: string, entryId: string): string {
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as { run?: { id?: unknown; machine?: unknown }[] };
    const found = (parsed.run ?? []).find((one) => one && one.id === entryId);
    return typeof found?.machine === "string" ? found.machine : "";
  } catch {
    return "";
  }
}

/**
 * The file's own bytes, hashed, so two machines can say whether they run the
 * same registry: a spoke reads a copy, and a copy that fell behind serves the
 * wrong agents.
 */
export function registryDigest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readSetting(registry: unknown, key: string): unknown {
  const it = loaded(registry, "readSetting");
  const name = settingKey(key);
  const field = SETTING_FIELDS.find((f) => f.key === name);
  if (!field) throw new UnknownSetting(key);
  return valueAt(it.data, name) ?? ROLLOUT_DEFAULTS[name];
}
