import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HARD_RULES, HARD_SHAPES, LANES, NOTIFY_RULES, NOTIFY_SHAPES, type WatchSpec } from "./evaluate.ts";

/**
 * The spec: ONE file per hunt, human-edited, validated on every read.
 *
 *   <specs folder>/<id>.json
 *
 *   {
 *     "id": "de__32gb-ddr5-6000", "source": "kleinanzeigen", "owner": "p1-lair",
 *     "lane": "digest",
 *     "target": { "query": "32gb ddr5 6000", "location": "" },
 *     "hard": { "max_price": 260, "exclude": ["laptop"], "wanted_ad": false, "rental_ad": false },
 *     "notify": { "price_at_or_under": 260 },
 *     "soft": ["a 2x16 kit only, not 1x32"],
 *     "note": "why this watch exists", "added": "2026-07-14T21:27:53.667Z"
 *   }
 *
 * `hard` keys are the closed enum in `evaluate.ts`, each with a typed value.
 * An unknown key or a wrong shape REFUSES THE FILE, and a refused spec does
 * not run: a hard constraint can never be prose, because prose is judgment and
 * a drop is never judgment. `notify` is the closed predicate set. `soft` is
 * strings code never reads: they ride verbatim into the triage batch for the
 * master to weigh. `lane` says what a spec may emit: `tripwire` may only
 * notify, so a tripwire spec with no `notify` block is refused, and `digest`
 * may triage.
 *
 * `owner` is the agent whose chat receives this spec's notify hits and tell
 * verdicts. It is checked against the registry by the caller, which hands in
 * the rule, because the file cannot know which agents exist.
 *
 * The seen set is NOT in the spec. A human edits the file and a timer that
 * stamped it would conflict on every edit, so it is a state sheet.
 */

export const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
export const SPEC_KEYS = ["id", "source", "owner", "lane", "target", "hard", "notify", "soft", "note", "added", "updated", "paused"] as const;

export type OwnerRule = (owner: string) => string | null;

function shapeProblem(shape: string, v: unknown): string | null {
  switch (shape) {
    case "number": return typeof v === "number" && Number.isFinite(v) ? null : "must be a finite number";
    case "number|null": return v === null || (typeof v === "number" && Number.isFinite(v)) ? null : "must be a finite number or null";
    case "string[]": return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "") ? null : "must be an array of non-empty strings";
    case "boolean": return typeof v === "boolean" ? null : "must be true or false";
    case "true": return v === true ? null : "must be true";
    case "private|commercial": return v === "private" || v === "commercial" ? null : 'must be "private" or "commercial"';
    default: return `unknown shape ${shape}`;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * What a target may say, per source. A kleinanzeigen search is a query with
 * an optional place and radius; the message box is not read by this version,
 * so a spec asking for it is refused rather than run as nothing. mydealz is a
 * query, and `page:hot` / `page:new` name the two front pages. vstdeals is an
 * interest term over the firehose, or one tracked product's price page.
 */
export function targetProblems(source: string, target: unknown): string[] {
  if (!isObject(target)) return ["target must be an object"];
  const p: string[] = [];
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(target)) if (!keys.includes(key)) p.push(`target.${key} is not a key of a ${source} target: the keys are ${keys.join(", ")}`);
  };
  switch (source) {
    case "kleinanzeigen":
      if (target.inbox !== undefined) { p.push("target.inbox: the message box is not read by this version"); break; }
      allowed(["query", "location", "radius_km"]);
      if (!nonempty(target.query)) p.push("target.query must be a non-empty string");
      if (target.location !== undefined && typeof target.location !== "string") p.push("target.location must be a string");
      if (target.radius_km !== undefined && !(typeof target.radius_km === "number" && Number.isFinite(target.radius_km) && target.radius_km > 0)) {
        p.push("target.radius_km must be a number above zero");
      }
      break;
    case "mydealz":
      allowed(["query"]);
      if (!nonempty(target.query)) p.push("target.query must be a non-empty string");
      else if (String(target.query).startsWith("page:") && !["page:hot", "page:new"].includes(String(target.query))) {
        p.push('target.query names a page that is not "page:hot" or "page:new"');
      }
      break;
    case "vstdeals":
      if (target.kind === "interest") {
        allowed(["kind", "term"]);
        if (!nonempty(target.term)) p.push("target.term must be a non-empty string on an interest spec");
      } else if (target.kind === "track") {
        allowed(["kind", "slug", "name", "url"]);
        for (const key of ["slug", "name", "url"]) if (!nonempty(target[key])) p.push(`target.${key} must be a non-empty string on a track spec`);
        if (nonempty(target.url) && !/^https:\/\//.test(target.url)) p.push("target.url must be an https link");
      } else {
        p.push(`target.kind ${JSON.stringify(target.kind ?? null)} is not "interest" or "track"`);
      }
      break;
    default:
      p.push(`source ${JSON.stringify(source)} is not a source this hub hunts on`);
  }
  return p;
}

/**
 * Every problem, not the first, so a hand-edited file is fixed in one round.
 * `source` is the folder the file sits in, which is the source that will run
 * it, and `owner` is the registry's rule for who may own a spec.
 */
export function specProblems(spec: unknown, source: string, owner: OwnerRule): string[] {
  const p: string[] = [];
  if (!isObject(spec)) return ["not a JSON object"];
  if (typeof spec.id !== "string" || !ID_RE.test(spec.id)) p.push(`id ${JSON.stringify(spec.id ?? null)} is not ${ID_RE.source}`);
  if (spec.source !== source) p.push(`source ${JSON.stringify(spec.source ?? null)} filed under ${source}/`);
  if (!nonempty(spec.owner)) p.push(`owner ${JSON.stringify(spec.owner ?? null)} is not an agent id`);
  else {
    const said = owner(spec.owner);
    if (said !== null) p.push(said);
  }
  if (!(LANES as readonly unknown[]).includes(spec.lane)) p.push(`lane ${JSON.stringify(spec.lane ?? null)} is not one of ${LANES.join(", ")}`);
  p.push(...targetProblems(source, spec.target));

  const hard = spec.hard ?? {};
  if (!isObject(hard)) p.push("hard must be an object");
  else {
    for (const key of Object.keys(hard)) {
      if (key === "min_events") { p.push("hard.min_events is a Sentry rule and is not read by a hunt"); continue; }
      if (!(HARD_RULES as readonly string[]).includes(key)) {
        p.push(`hard.${key} is not a rule: the closed set is ${HARD_RULES.join(", ")}. A constraint that is not one of these is judgment, and judgment is a soft rule`);
        continue;
      }
      if (hard[key] === null) continue;
      const bad = shapeProblem(HARD_SHAPES[key as keyof typeof HARD_SHAPES], hard[key]);
      if (bad) p.push(`hard.${key} ${bad}`);
    }
  }
  if (spec.notify != null) {
    if (!isObject(spec.notify)) p.push("notify must be an object");
    else {
      const keys = Object.keys(spec.notify);
      if (keys.length === 0) p.push("notify is empty: name a predicate or remove the block");
      for (const key of keys) {
        if (!(NOTIFY_RULES as readonly string[]).includes(key)) { p.push(`notify.${key} is not a predicate: the closed set is ${NOTIFY_RULES.join(", ")}`); continue; }
        const bad = shapeProblem(NOTIFY_SHAPES[key as keyof typeof NOTIFY_SHAPES], spec.notify[key]);
        if (bad) p.push(`notify.${key} ${bad}`);
      }
    }
  }
  if (spec.lane === "tripwire" && spec.notify == null) {
    p.push("a tripwire spec needs a notify block: the tripwire lane may only notify, and with nothing to notify on it could only ever triage");
  }
  if (spec.soft != null && !(Array.isArray(spec.soft) && spec.soft.every((s) => typeof s === "string"))) p.push("soft must be an array of strings");
  for (const key of ["note", "added", "updated"]) {
    if (spec[key] != null && typeof spec[key] !== "string") p.push(`${key} must be a string`);
  }
  if (spec.paused != null && typeof spec.paused !== "boolean") p.push("paused must be true or false");
  for (const key of Object.keys(spec)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) p.push(`unknown key "${key}"`);
  }
  return p;
}

export interface RefusedSpec {
  file: string;
  id?: string;
  problems: string[];
}

export interface LoadedSpecs {
  ok: WatchSpec[];
  refused: RefusedSpec[];
  /** Paused specs, by id, skipped in silence. */
  paused: string[];
}

/**
 * Every spec of one source's folder, split into the ones that run and the
 * ones refused with why. A refused spec never runs and is reported, never
 * skipped in silence: a typo in a ceiling that turned a watch off invisibly is
 * the exact failure the closed enum exists to prevent. A folder that is not
 * there is a source with no hunts, which is not an error.
 */
export function loadSpecs(dir: string, source: string, options: { lane?: string | null; owner: OwnerRule }): LoadedSpecs {
  const out: LoadedSpecs = { ok: [], refused: [], paused: [] };
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    let spec: unknown;
    try {
      spec = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      out.refused.push({ file, problems: [`not JSON: ${(error as Error).message}`] });
      continue;
    }
    const problems = specProblems(spec, source, options.owner);
    const id = isObject(spec) && typeof spec.id === "string" ? spec.id : undefined;
    if (problems.length === 0 && id !== basename(file, ".json")) problems.push(`id "${id}" does not match the filename ${file}`);
    if (problems.length > 0) {
      out.refused.push({ file, ...(id === undefined ? {} : { id }), problems });
      continue;
    }
    const it = spec as WatchSpec;
    if (it.paused === true) { out.paused.push(it.id); continue; }
    if (options.lane && it.lane !== options.lane) continue;
    out.ok.push({ ...it, hard: it.hard ?? {} });
  }
  return out;
}
