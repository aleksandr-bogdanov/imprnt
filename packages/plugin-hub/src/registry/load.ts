import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { ADAPTERS } from "../adapters/index.ts";

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
    key: "hub.shared_zone",
    type: "string",
    what: "the one zone every person's box can read, and there is no second one",
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
}

/** A machine the household has. `os` is in the file, never process.platform. */
export interface MachineEntry {
  id: string;
  os: string;
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
  allowed_senders?: Record<string, string[]>;
  history_harvest_after?: string;
  filing_rules?: string;
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

/** The three credential kinds this hub knows how to open. */
export const CREDENTIAL_KINDS = ["claude-login", "telegram", "discord"] as const;

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
  chat: string;
  door: string;
  runner: string;
}

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
 */
function indexLines(text: string): Map<string, number> {
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
 * The key a reader asks for, with any command-line decoration taken off: a
 * leading dash run and anything glued on after an `=`. The spelling is all that
 * is stripped. The value that came with it is dropped on the floor and the
 * registry's own value is what is read, which is the whole point.
 */
function settingKey(key: string): string {
  return String(key).trim().replace(/^-+/, "").split("=")[0].trim();
}

export function loadRegistry(file: string): Registry {
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
    if ((admin as string[]).some(arg => /password\s*=|:\/\/[^/\s]*:[^/\s]*@/i.test(arg)))
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
    machines.push({ id, os });
  });
  const declared = new Set(machines.map((machine) => machine.id));
  // The backward compatibility rule: `machine` becomes required, by name, only
  // once the file declares two or more. Below that there is nothing to be
  // ambiguous about, and every entry belongs to the one machine that asks.
  const namesAMachine = machines.length >= 2;

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

    if (!["hub", "door", "runner", "sync"].includes(entry.kind as string))
      refuse(`${at}.kind`, here, `unsupported-run-kind: ${entry.kind}`);

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

    entries.push({
      id,
      kind: entry.kind as string,
      schedule: entry.schedule as string,
      memory_limit_mb: limit,
      machine: typeof machine === "string" && machine !== "" ? machine : (machines[0]?.id ?? ""),
      ...Object.fromEntries(["max_active_children", "child_memory_budget_mb", "repositories", "token_file"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      ...(childLimit === undefined ? {} : { child_memory_limit_mb: childLimit }),
    });
  });

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
    if (entry.filing_rules !== undefined) readable(entry.filing_rules, `${where}.filing_rules`);
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
      ...Object.fromEntries(["filing_rules", "history_harvest_after", "allowed_senders"]
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
    };

    // Spread, never set: a file that carries none of the ten leaves an entry
    // of exactly `id` and `tree`, which is the shape a shipped check asserts.
    people.push({
      id: id as string,
      tree,
      ...clocks,
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
        `${id} is a ${describe(kind)}, and the three kinds this hub opens are ` +
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
    const named = table.credential;
    if (named === undefined || named === null) {
      continue;
    }
    if (typeof named !== "string" || !declaredCredential.has(named)) {
      refuse(
        `presets.${name}.credential`,
        lines.get(`presets.${name}`) ?? 0,
        `${name} reads its login from ${describe(named)}, which no [[credentials]] ` +
          `entry declares`,
      );
    }
  }

  const agents: AgentEntry[] = [];
  ((parsed.agents ?? []) as Record<string, unknown>[]).forEach((entry, nth) => {
    const where = `agents[${nth}]`;
    const here = lines.get(`${where}.id`) ?? lines.get(where) ?? 0;
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
    agents.push({
      ...Object.fromEntries(["fragment", "settings", "mcp", "tools", "mode", "sleeping", "idle_seconds"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
      id: entry.id as string,
      person: entry.person as string,
      preset: entry.preset as string,
      chat: entry.chat as string,
      door: entry.door as string,
      runner: entry.runner as string,
    });
  });

  // A door that serves an agent has to say which platform it speaks, whose it is
  // and where its credential lives, because that is all the hub is ever told
  // about it. A door nobody points at is on the list and serves nobody yet.
  const served = new Set(agents.map((agent) => agent.door));
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
    repositories.push(entry as unknown as RepositoryEntry);
  }
  entries.forEach((entry, nth) => {
    for (const id of entry.repositories ?? []) {
      if (!repositories.some(r => r.id === id)) refuse(`run[${nth}].repositories`, 0, "repository is undeclared");
    }
  });

  return new Registry(
    file,
    parsed,
    entries,
    presets,
    agents,
    rates,
    machines,
    people,
    credentials,
    repositories,
  );
}

export function readSetting(registry: unknown, key: string): unknown {
  const it = loaded(registry, "readSetting");
  const name = settingKey(key);
  const field = SETTING_FIELDS.find((f) => f.key === name);
  if (!field) throw new UnknownSetting(key);
  return valueAt(it.data, name) ?? ROLLOUT_DEFAULTS[name];
}
