import { safeValue } from "../door/lines.ts";
// Bare when nothing in the path is special to a POSIX shell, single-quoted
// otherwise, a quote inside closed, escaped and reopened: the one quoting the
// commands `check` builds already use. The page escapes it for HTML on top.
import { shellWord } from "../os/diff.ts";

/**
 * What a page prints where a value came from somewhere the board does not
 * write: a cause another process recorded, a command `check` left, a number of
 * bytes. Pure, so a page can be checked without a server.
 *
 * A CAUSE IS ONE PLAIN LINE. A driver's error, a JSON body a service answered
 * with and a stack trace are all things a process records, and none of them is
 * a sentence a person can act on: they carry statement text, absolute paths and
 * the internals of whatever threw. What a page shows instead is the closed
 * code the recorder already gave it when there is one, the closed cause the
 * shipped vocabulary has for the family when there is not, and otherwise the
 * first line, sanitized and cut short. The raw detail stays in the journal of
 * the process that recorded it.
 */

/** A code some step already chose: `recovery-target-stopped`, `enabled-not-for-this-kind`, `retry`. */
const CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** The families of a store or driver failure, whose text is statement internals rather than a reason. */
const DRIVER =
  /\b(?:duplicate key|violates|syntax error at|deadlock detected|could not serialize|(?:relation|column|role|database|function|schema|type) "[^"]*" does not exist|SQLSTATE|PostgresError|connection (?:refused|terminated|closed|reset)|server closed the connection)\b/i;

/** A Node error code at the head of a message, which is followed by a path more often than not. */
const ERRNO = /^E[A-Z]{2,}\b/;

/** How long a cause may run before it is cut. A card is a sentence, never a paragraph. */
const LIMIT = 160;

function cut(text: string): string {
  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text;
}

/** The cause a parsed JSON body names, or the closed fallback when it names none. */
function fromBody(body: unknown, depth: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const key of ["cause", "code", "reason", "error", "message"]) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") return plain(value, depth + 1);
      if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
        return plain((value as { message: string }).message, depth + 1);
      }
    }
  }
  return "operation failed";
}

function plain(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const error = value as { name?: unknown; step?: unknown; message?: unknown };
    // The registry editor names the step that refused, which is a closed list
    // of its own; its message names the file, which is a path on this box.
    if (error.name === "RegistryEditRefused" && typeof error.step === "string") return `registry-edit-${error.step}`;
    if (value instanceof Error || typeof error.message === "string") return plain(String(error.message ?? ""), depth);
    return depth > 3 ? "operation failed" : fromBody(value, depth);
  }
  const text = String(value).trim();
  if (text === "") return "";
  if (depth <= 3 && /^[{[]/.test(text)) {
    try {
      return fromBody(JSON.parse(text), depth);
    } catch {
      // Not a body after all, and it is read as text below.
    }
  }
  const first = text.split(/\r?\n/, 1)[0].trim().replace(/^(?:[A-Za-z]*Error):\s*/, "");
  if (CODE.test(first)) return first;
  if (/permission denied|\bEACCES\b|\bEPERM\b/i.test(first)) return "access denied";
  if (DRIVER.test(first) || ERRNO.test(first)) return "operation failed";
  return cut(safeValue(first));
}

/** A recorded cause as one plain line, or the empty string for none. */
export function plainCause(value: unknown): string {
  return plain(value, 0);
}

/**
 * What a refusal code on the `control` sheet means, as words. The codes are
 * the closed list `requestRecovery` throws (`CONTROL_REFUSALS`) and the one the
 * board's own stop and start refuse with; a code nobody wrote words for is
 * printed as the code, never guessed at.
 */
const REQUEST_CAUSE: Record<string, string> = {
  "recovery-target-stopped": "the target is stopped in the registry, so nothing restarts it",
  "invalid-recovery-target": "the registry declares no such target",
  "recovery-not-authorized": "the place it was asked from may not ask for that target",
  "invalid-recovery-source": "it was asked from somewhere that may not ask",
  "enabled-not-for-this-kind": "this kind of entry is never stopped or started from the board",
};

/** A request's recorded cause as words: the closed codes said as sentences, anything else as `plainCause` says it. */
export function requestCause(value: unknown): string {
  const plain = plainCause(value);
  return REQUEST_CAUSE[plain] ?? plain;
}

/**
 * What a blocked agent's `agent_health` cause means, as words. The codes are
 * the closed list the runner writes with `status: "blocked"`; the row's own
 * remedy is printed beneath, so these say only what is wrong.
 */
const AGENT_CAUSE: Record<string, string> = {
  "configured-engine-unavailable": "the engine it is set to use is not available on its runner",
  "conversation.engine-mismatch": "its conversation was started on another engine than the one it is set to use",
};

/** An agent health cause as words: the closed codes said as sentences, anything else as `plainCause` says it. */
export function agentCause(value: unknown): string {
  const plain = plainCause(value);
  return AGENT_CAUSE[plain] ?? AGENT_CAUSE[String(value ?? "").trim()] ?? plain;
}

/**
 * The few words a folded machine line says about a finding on it, by kind.
 * Only the kinds about a piece a machine runs; any other kind is said as "a
 * finding", because the summary is a pointer to the finding and never a second
 * wording of it.
 */
const FINDING_GIST: Record<string, string> = {
  "memory-over-limit": "over its memory limit",
  "peak-missing": "has no memory peak recorded",
  "unit-missing": "not running as the registry wants",
  "unit-not-stopped": "still up though stopped in the registry",
  "unit-extra": "loaded with no registry entry",
  "unit-file-orphaned": "a unit file no entry declares",
  "crash-loop": "restarting in a loop",
  "registry-stale": "has a registry copy that is not the current one",
  "registry-unseen": "has not said which registry it runs",
};

/** A kind's few words on a row already headed by its subject, or the kind's own name when it has none. */
export function kindGist(kind: string): string {
  return FINDING_GIST[kind] ?? kind;
}

/** `runner-home over its memory limit`, or `a finding about runner-home` for a kind with no gist. */
export function findingGist(finding: { kind: string; subject: string }): string {
  const gist = FINDING_GIST[finding.kind];
  return gist === undefined ? `a finding about ${finding.subject}` : `${finding.subject} ${gist}`;
}

/**
 * A sentence `check` wrote, as one line.
 *
 * NOT TRANSLATED AND NOT JUDGED: a finding is printed in its own words, and
 * only what is not a sentence at all is reduced. A body that is JSON is read
 * for the cause it names, and a stack under the first line is dropped.
 */
export function plainLine(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/^[{[]/.test(text)) return plainCause(text);
  return text.split(/\r?\n/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/** The placeholder `check` writes where a command takes the registry file. */
export const REGISTRY_PLACEHOLDER = "<registry>";

/**
 * What the board knows about where a `check` command can run: this machine and
 * its own registry file, every declared machine, the registry file each
 * machine's hub reported running with, and whether the household has more
 * than one route to the store (then `recover` must be told which machine it is
 * on).
 */
export interface CommandPlaces {
  here: string;
  registryFile: string;
  machines: string[];
  /** The registry file each machine's hub wrote beside its digest, by machine. */
  files?: Record<string, string>;
  routesDiffer?: boolean;
}

/**
 * A finding's fix as a page shows it: the sentence around a command, the
 * command to copy, and the machine it is to be run on.
 *
 * `text` is the ONLY part that is ever put in a copy box, and it is either the
 * whole fix (when the whole fix is a command) or one `imprnt hub` command the
 * fix carries inside a sentence. `lead` and `tail` are the sentence's own
 * words, never a command. `unavailable` is said instead of a command that
 * names a file this board does not know.
 */
export interface FilledCommand {
  lead: string;
  text: string;
  tail: string;
  /** The machine a person runs it on, or "" for a household of one machine. */
  on: string;
  unavailable: string;
}

/** The programs a fix that is a whole command starts with: what `check` and the OS seam write. */
const PROGRAMS = ["imprnt", "systemctl", "launchctl", "loginctl", "rm"];

/**
 * A fix as shell words, or null when it is not one: an unmatched quote. The
 * single and double quotes are kept in the word, because nothing here runs it;
 * all this decides is where one word ends. An unquoted `;` is a word of its
 * own, the separator between two commands.
 */
function shellWords(text: string): { word: string; bare: string }[] | null {
  const out: { word: string; bare: string }[] = [];
  let word = "";
  let bare = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (word !== "") out.push({ word, bare });
    word = "";
    bare = "";
  };
  for (const char of text) {
    // A backslash outside single quotes takes the next character literally,
    // which is how `shellWord` closes, escapes and reopens a quote in a path.
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      word += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      word += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word += char;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      continue;
    }
    if (char === ";") {
      flush();
      out.push({ word: ";", bare: ";" });
      continue;
    }
    word += char;
    bare += char;
  }
  if (quote !== null || escaped) return null;
  flush();
  return out;
}

/**
 * Whether a whole fix is a command and nothing else: one or more commands
 * joined by `;`, each starting with a program `check` writes commands for, and
 * no unquoted word ending in the punctuation a sentence puts after a word
 * (`imprnt hub check, then look at ...` is a sentence). Every unquoted word is
 * made of the characters a path, a flag or an id is made of, or is the
 * placeholder itself.
 */
function wholeCommand(fix: string): boolean {
  const words = shellWords(fix.trim());
  if (words === null || words.length === 0) return false;
  let start = true;
  for (const { word, bare } of words) {
    if (word === ";") {
      if (start) return false;
      start = true;
      continue;
    }
    if (start && !PROGRAMS.includes(word)) return false;
    start = false;
    if (word === REGISTRY_PLACEHOLDER) continue;
    if (/[,:.]$/.test(word)) return false;
    if (!/^[A-Za-z0-9_@%+=:,./~$-]*$/.test(bare)) return false;
  }
  return !start;
}

/**
 * The fix split into the sentence's words and the one command it carries,
 * read off the TEMPLATE `check` wrote, with the placeholder still a single
 * word, before any file is filled in. So a registry path with spaces, a quote,
 * a comma or a semicolon in it is never what decides where the command ends.
 *
 * A fix that is a whole command is that command. Otherwise the only command
 * taken out of a sentence is `imprnt hub <verb> <registry>` followed by the
 * arguments that verb takes, each a machine the file declares or a
 * `<kind>:<id>` target, and it ends at the first word that is neither. Nothing
 * else in a sentence is ever read as a command: a fix in words alone is shown
 * as words.
 */
export function splitFix(fix: string, machines: string[]): { lead: string; command: string; tail: string } {
  const text = fix.trim();
  if (wholeCommand(text)) return { lead: "", command: text, tail: "" };
  const at = /(^|\s)imprnt hub [a-z]+ <registry>/.exec(text);
  if (at === null) return { lead: text, command: "", tail: "" };
  const start = at.index + at[1].length;
  let end = start + at[0].length - at[1].length;
  const isArgument = (word: string) => machines.includes(word) || /^(?:agent|door|run):[A-Za-z0-9_./-]+$/.test(word);
  for (;;) {
    const next = /^ (\S+)/.exec(text.slice(end));
    if (next === null) break;
    const word = next[1].replace(/[;,.]+$/, "");
    if (!isArgument(word)) break;
    end += 1 + word.length;
    if (word !== next[1]) break;
  }
  const lead = text.slice(0, start).trim().replace(/:$/, "").trim();
  // The word "there" right after a command placed on another machine is said
  // by the machine the page names, and the punctuation after it is the
  // sentence's join; the rest is the sentence's own words.
  const tail = text.slice(end).replace(/^\s*there\b/, "").replace(/^[\s;,.]+/, "").trim();
  return { lead, command: text.slice(start, end), tail };
}

/** A sentence that names the placeholder, said as the words it stands for. */
function inWords(text: string): string {
  return text.replaceAll(REGISTRY_PLACEHOLDER, "the registry file");
}

/**
 * A `check` fix as a page shows it: the command it carries with every registry
 * placeholder filled in with a file that exists on the machine the command
 * runs on, that machine named, and the sentence around it kept as words.
 *
 * WHICH MACHINE THE COMMAND RUNS ON decides what goes in.
 *   `recover` writes one control row into the shared store, and the hub that
 *   runs the target carries it out wherever that is, so it runs HERE, with this
 *   board's own file and, in a household with more than one route to the
 *   store, this machine named last as the command requires.
 *   Any other verb runs on the machine named right after the placeholder
 *   (`imprnt hub status <registry> mac`), or else the machine whose `check`
 *   wrote the finding.
 * The file is this board's own for this machine, and for another machine the
 * file that machine's hub reported running with. A machine whose hub has not
 * reported one has NO command shown, and one plain sentence says why: the file
 * is never guessed from this machine's, read off a unit layout, or left as a
 * placeholder.
 */
export function fillCommand(fix: string, found: string, places: CommandPlaces): FilledCommand {
  const split = splitFix(fix, places.machines);
  const lead = inWords(split.lead);
  // Under a command the sentence goes on as its own line, so the `and` that
  // joined it to the command reads as `then`; no line starts with `and`.
  const tail = inWords(split.tail).replace(/^and\s+/, "then ");
  // With no command between them the two halves are one sentence again.
  const joined = (): string => {
    const after = inWords(split.tail);
    if (lead === "" || after === "") return lead + after;
    if (/[.;,]$/.test(lead)) return `${lead} ${after}`;
    return /^and\b/.test(after) ? `${lead}, ${after}` : `${lead}. ${after}`;
  };
  const placed = (on: string) => (places.machines.length <= 1 ? "" : on);
  if (split.command === "") return { lead, text: "", tail, on: "", unavailable: "" };
  if (!split.command.includes(REGISTRY_PLACEHOLDER)) return { lead, text: split.command, tail, on: placed(found), unavailable: "" };
  const parts = split.command.split(REGISTRY_PLACEHOLDER);
  let out = parts[0];
  let on = found;
  for (let i = 1; i < parts.length; i++) {
    const recover = /\bimprnt hub recover $/.test(out);
    // The word right after, up to any punctuation a sentence puts after it.
    const next = /^ ([A-Za-z0-9_-]+)/.exec(parts[i])?.[1] ?? "";
    const named = places.machines.includes(next) ? next : "";
    const where = recover ? places.here : named !== "" ? named : found === "" ? places.here : found;
    on = where;
    let rest = parts[i];
    if (where === places.here || where === "") {
      out += shellWord(places.registryFile);
    } else if (places.files?.[where]) {
      out += shellWord(places.files[where]);
    } else {
      // Nothing true can be filled in, so no command is offered rather than
      // one with a hole or a guess in it.
      return {
        lead: joined(), text: "", tail: "", on: placed(where),
        unavailable: `no command is shown: the hub on ${where} has not reported which registry file it runs with.`,
      };
    }
    if (recover && places.routesDiffer) {
      // `recover <registry> <kind>:<id> [machine]`: name this machine when the
      // command did not, because a household with two routes refuses without.
      const target = /^ ((?:agent|door|run):[^\s:;]+)(?: ([A-Za-z0-9_-]+))?/.exec(rest);
      if (target && !(target[2] !== undefined && places.machines.includes(target[2]))) {
        rest = ` ${target[1]} ${places.here}${rest.slice(1 + target[1].length)}`;
      }
    }
    out += rest;
  }
  return { lead, text: out, tail, on: placed(on), unavailable: "" };
}

/** The command text alone, for a caller that does not show where it runs. */
export function withRegistry(fix: string, args: { found: string } & CommandPlaces): string {
  return fillCommand(fix, args.found, args).text;
}

/**
 * Bytes as MiB, the unit `memory_limit_mb` is enforced in (the limit times
 * 1024 times 1024), so a reading and its limit read in one unit.
 *
 * NOTHING IS NOT ZERO. An absent reading is null and the page prints its
 * nothing mark; a zero is a measurement and prints as one.
 */
export function mib(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return null;
  const value = Number(bytes) / (1024 * 1024);
  if (value === 0) return "0 MiB";
  if (value < 0.1) return "<0.1 MiB";
  return `${value.toFixed(1)} MiB`;
}
