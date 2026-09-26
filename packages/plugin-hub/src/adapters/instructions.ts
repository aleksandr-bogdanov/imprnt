import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { listPeople } from "../registry/entries.ts";
import type { PersonEntry } from "../registry/load.ts";

/**
 * What the code itself tells every ordinary loop about the system it runs in.
 *
 * A loop launches with Claude Code's own instruction discovery switched off,
 * so nothing else says how an answer reaches the person, where the vault is or
 * how work moves between agents. It is written here, next to the launch that
 * makes it true, so it cannot describe a machine that no longer exists.
 */
export const LOOP_PREAMBLE = `# How this agent runs

You are one agent of a household hub. Messages reach you from a chat, or as a job another agent handed you.

- Your reply to a message IS the answer the person reads. The hub posts it into the chat for you. There is no separate send tool and nothing else to call to deliver it.
- When the message is a job from another agent, your reply is the report that goes back to that agent. Write it so it stands on its own.
- The person's vault is at \`$IMPRNT_VAULT\`. Look things up with \`imprnt recall <keywords>\` before answering from memory.
- Run \`imprnt context\` before filing anything, so a note lands in the right folder with the right links.
- The person can hand work to another agent with \`/dispatch <agent> <task>\` typed in their chat.
- Everything below this section is the person's own standing instructions, then this agent's own.
`;

/** How many imports deep a chain may go, the limit Claude Code keeps itself. */
export const IMPORT_DEPTH = 5;

/** The person this agent belongs to, or none when the file cannot say (the capability probe has no file). */
export function personOf(registry: unknown, id: string): PersonEntry | undefined {
  try { return listPeople(registry).find(one => one.id === id); } catch { return undefined; }
}

/**
 * The directory holding the person's `vault/` and `raw/`: the one they
 * declared, or their tree when they declared none. `IMPRNT_VAULT` and the
 * default instruction files are both read from here, so an agent is never told
 * one vault and handed another's rules.
 */
export function vaultRootOf(person: PersonEntry | undefined, tree: string): string {
  return person?.vault ?? tree;
}

/**
 * The person's instruction files: the list they declared, or the vault's own
 * `CLAUDE.md` and `CLAUDE.local.md`, each only when it is there. A declared
 * file is never skipped, because the loader already proved it readable.
 */
export function instructionFiles(person: PersonEntry | undefined, root: string): string[] {
  if (person?.instructions) return [...person.instructions];
  return ["CLAUDE.md", "CLAUDE.local.md"].map(name => join(root, name)).filter(file => existsSync(file));
}

/**
 * Where instruction text may come from. The runner reads these files outside
 * the box and copies them into the agent's prompt, and an agent can write its
 * own vault's instruction files, so a reach wider than the vault would be a
 * way around every mask the box sets. So an import may only name a file
 * inside `inside`, the person's own vault, and never one in `forbidden` (a
 * secret, a login, another person's tree or state), even when that sits
 * inside the vault. `trusted` are the files the registry names by hand, which
 * no agent can move, and they may live anywhere that is not forbidden.
 */
interface Scope { inside: string[]; forbidden: string[]; trusted: Set<string> }

const under = (path: string, roots: string[]) => roots.some(root => path === root || path.startsWith(`${root}/`));

/**
 * Read one instruction file after proving the agent may read it. The check is
 * on the resolved path, so a symlink is judged by where it lands. The file is
 * opened once and the opened file is then checked again against a fresh
 * resolution, so a file swapped for a link between the check and the read is
 * refused rather than read.
 */
function readable(file: string, scope: Scope, from?: string): string {
  const said = from ? `${file} (imported by ${from})` : file;
  const allowed = (real: string) => {
    if (under(real, scope.forbidden) || (!scope.trusted.has(file) && !under(real, scope.inside))) {
      throw new Error(`instructions-forbidden: ${said} is a place this agent may not read`);
    }
  };
  let real: string;
  try { real = realpathSync(file); } catch { throw new Error(`instructions-unreadable: ${said}`); }
  allowed(real);
  let fd: number;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Error(`instructions-unreadable: ${said}`); }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`instructions-unreadable: ${said}`);
    let now: string;
    try { now = realpathSync(file); } catch { throw new Error(`instructions-changed: ${said} moved while it was being read`); }
    allowed(now);
    const current = statSync(now);
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(`instructions-changed: ${said} moved while it was being read`);
    // Linux names the object behind the descriptor, which settles it even if
    // a directory above the file was swapped and swapped back.
    if (process.platform === "linux") allowed(readlinkSync(`/proc/self/fd/${fd}`));
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Every path as the file system names it, so a symlinked parent cannot slip past the prefix test. */
function canonical(paths: string[]): string[] {
  return [...new Set(paths.filter(path => path !== "").flatMap(path => {
    const plain = resolve(path);
    try { return [plain, realpathSync(plain)]; } catch { return [plain]; }
  }))];
}

/** Where an `@` names a file: from HOME for `~`, otherwise absolute or relative to the importing file. */
function importPath(target: string, file: string, home?: string): string {
  if (target === "~" || target.startsWith("~/")) {
    if (!home) throw new Error(`instructions-unreadable: ${target} (imported by ${file}, and there is no HOME)`);
    return join(home, target.slice(1));
  }
  return isAbsolute(target) ? target : resolve(dirname(file), target);
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * A code fence opens on three or more backticks or tildes and closes only on
 * the same character, at least as many times, with nothing after it. A
 * three-backtick example inside a four-tilde block is text, not the end.
 */
function fence(line: string, open: { char: string; length: number } | null) {
  const found = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!found) return open;
  const [run, rest] = [found[1], found[2]];
  if (!open) return { char: run[0], length: run.length };
  return run[0] === open.char && run.length >= open.length && rest.trim() === "" ? null : open;
}

/**
 * One instruction file with its `@path` imports expanded the way Claude Code
 * expands them, relative paths against the importing file's directory and `~`
 * against `home`, a file already included anywhere in this prompt included
 * once, nothing inside a fenced code block or an inline code span.
 *
 * A line that is only `@<path>` is replaced by that file's content, and one
 * that cannot be read is refused rather than dropped: a rule that silently
 * goes missing is the exact failure this assembly exists to prevent. An `@`
 * inside a sentence, after a space or an opening bracket or quote, is also an
 * import when it names a file that exists, and the file's content follows the
 * line. One that names no file is left as text, because a sentence can
 * mention `@someone` and that is not an import, which is also how Claude Code
 * treats it. A chain deeper than `IMPORT_DEPTH` is refused. Every file read is
 * recorded in `reads`, because the box has to let the CLI's launch reach it.
 */
export function expandInstructions(file: string, options: { home?: string; seen: Set<string>; reads: string[]; scope: Scope },
  depth = 0, from?: string): string {
  const text = readable(file, options.scope, from);
  options.seen.add(realpathSync(file));
  options.reads.push(file);
  let open: { char: string; length: number } | null = null;
  const out: string[] = [];
  const include = (path: string) => {
    if (depth + 1 > IMPORT_DEPTH) throw new Error(`instructions-import-too-deep: ${path} (imported by ${file})`);
    let again = false;
    try { again = options.seen.has(realpathSync(path)); } catch { /* refused inside, naming the importer */ }
    if (!again) out.push(expandInstructions(path, options, depth + 1, file).replace(/\n$/, ""));
  };
  for (const line of text.split("\n")) {
    const was = open;
    open = fence(line, open);
    if (was || open) { out.push(line); continue; }
    const whole = line.match(/^\s*@(\S+)\s*$/);
    if (whole) { include(importPath(whole[1], file, options.home)); continue; }
    out.push(line);
    const prose = line.replace(/`[^`]*`/g, " ");
    for (const found of prose.matchAll(/(?:^|[\s(\[{"'<])@([^\s`)\]}>"']+)/g)) {
      const target = found[1].replace(/[.,;:!?]+$/, "");
      if (target === "") continue;
      let path: string;
      try { path = importPath(target, file, options.home); } catch { continue; }
      if (isFile(path)) include(path);
    }
  }
  return out.join("\n");
}

/**
 * The whole appended prompt of an ordinary launch: the code's own section,
 * then the person's instruction files with their imports expanded, then the
 * agent's own fragment. The fragment is read as it is, because the converter
 * already refuses an import inside one.
 */
export function assemblePrompt(input: { files: string[]; fragment?: string; home?: string; inside: string[];
  forbidden?: string[]; trusted?: string[] }) {
  const reads: string[] = [];
  const seen = new Set<string>();
  const scope: Scope = { inside: canonical(input.inside), forbidden: canonical(input.forbidden ?? []),
    trusted: new Set([...(input.trusted ?? []), ...(input.fragment ? [input.fragment] : [])]) };
  const parts = [LOOP_PREAMBLE.trimEnd()];
  for (const file of input.files) {
    let real: string | null = null;
    try { real = realpathSync(file); } catch { /* readable() below names it */ }
    if (real && seen.has(real)) continue;
    parts.push(expandInstructions(file, { home: input.home, seen, reads, scope }).trimEnd());
  }
  if (input.fragment) {
    parts.push(readable(input.fragment, scope).trimEnd());
    reads.push(input.fragment);
  }
  return { text: parts.join("\n\n") + "\n", reads };
}
