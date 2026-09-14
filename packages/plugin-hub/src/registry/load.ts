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
}

export class Registry {
  readonly file: string;
  readonly data: Record<string, unknown>;
  readonly run: RunEntry[];

  constructor(file: string, data: Record<string, unknown>, run: RunEntry[]) {
    this.file = file;
    this.data = data;
    this.run = run;
  }
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

    entries.push({
      id,
      kind: entry.kind as string,
      schedule: entry.schedule as string,
      memory_limit_mb: limit,
    });
  });

  return new Registry(file, parsed, entries);
}

export function readSetting(registry: unknown, key: string): unknown {
  if (!(registry instanceof Registry)) {
    throw new TypeError(
      `readSetting reads a registry loaded by loadRegistry, and this is ${typeof registry}`,
    );
  }
  const name = settingKey(key);
  const field = SETTING_FIELDS.find((f) => f.key === name);
  if (!field) throw new UnknownSetting(key);
  return valueAt(registry.data, name);
}
