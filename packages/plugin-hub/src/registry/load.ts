import { readFileSync } from "node:fs";

/**
 * The registry is the only place a setting lives. Every setting the code reads
 * is declared here, the loader refuses a file that does not carry a declared
 * required one, and an accessor refuses a key nothing declared. Nothing in this
 * module reads the environment or the command line, at call time or at import
 * time: a value that is not in the file does not exist.
 */
export interface SettingField {
  key: string;
  type: "integer" | "string" | "boolean";
  what: string;
  required?: boolean;
}

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
  // 03b item 2. Where the store's own process writes its pid, and what the
  // machine's service manager calls it. Every standard install writes a pid
  // file, so the hub reads that rather than guessing at a process tree, and the
  // install script writes these two once per box. They go at the END of the
  // list on purpose: RUN-06's negative direction deletes the FIRST declared
  // field's line from the shipped example and requires the load to be refused,
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
   * D-76. Which machine runs this entry. A file that declares fewer than two
   * machines needs no `machine` anywhere and every entry belongs to the one the
   * asking process names, so this carries the single machine's id there and the
   * empty string when the file declares none at all.
   */
  machine: string;
  /** D-81. The limit the RUNNER enforces on its model child, not its own. */
  child_memory_limit_mb?: number;
}

/** D-76. A machine the household has. `os` is in the file, never process.platform. */
export interface MachineEntry {
  id: string;
  os: string;
}

/** D-93. A person and the tree that is the tenancy boundary. */
export interface PersonEntry {
  id: string;
  tree: string;
}

const MACHINE_OS = ["linux", "macos"];

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

export interface AgentEntry {
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

  constructor(
    file: string,
    data: Record<string, unknown>,
    run: RunEntry[],
    presets: Record<string, PresetEntry> = {},
    agents: AgentEntry[] = [],
    rates: RateEntry[] = [],
    machines: MachineEntry[] = [],
    people: PersonEntry[] = [],
  ) {
    this.file = file;
    this.data = data;
    this.run = run;
    this.presets = presets;
    this.agents = agents;
    this.rates = rates;
    this.machines = machines;
    this.people = people;
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

  // D-76. The machines come first, so an entry naming a machine whose `os` is
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

    // D-81. The CHILD's limit, which is not the entry's own `memory_limit_mb`.
    // A child that could never be watched cannot be configured.
    //
    // 03b item 5. Asked of EVERY runner entry, whether or not the file declares
    // its machines. BUILD-NOTES 1 made the rule conditional because phase 1
    // fixtures carried runner entries without the field and an unconditional
    // one turned two green checks red on contact. Every fixture in the
    // repository carries it now, so the tolerance has nothing left to protect,
    // and a file with no `[[machines]]` table is exactly the file a household
    // starts with.
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
      ...(childLimit === undefined ? {} : { child_memory_limit_mb: childLimit }),
    });
  });

  const refuse = (key: string, fallback: number, reason: string): never => {
    throw new RegistryRefused(file, lines.get(key) ?? fallback, key, reason);
  };

  const presets: Record<string, PresetEntry> = {};
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
    presets[name] = {
      adapter: table.adapter as string,
      effort: table.effort as string,
      model: table.model as string,
      paid: table.paid as string,
      provider: table.provider as string,
    };
  }

  // D-93. A person is a registry entry and its tree is the boundary. Two with
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
    people.push({ id: id as string, tree: typeof entry.tree === "string" ? entry.tree : "" });
  });
  const knownPerson = new Set(people.map((person) => person.id));

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
    if (!((entry.preset as string) in presets)) {
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
    agents.push({
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

  return new Registry(file, parsed, entries, presets, agents, rates, machines, people);
}

export function readSetting(registry: unknown, key: string): unknown {
  const it = loaded(registry, "readSetting");
  const name = settingKey(key);
  const field = SETTING_FIELDS.find((f) => f.key === name);
  if (!field) throw new UnknownSetting(key);
  return valueAt(it.data, name);
}
