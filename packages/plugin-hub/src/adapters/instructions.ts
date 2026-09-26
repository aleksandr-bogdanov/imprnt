import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
 * Read one instruction file, after proving the agent may read it. The runner
 * reads these files outside the box and copies them into the agent's prompt,
 * so a file the box hides from the agent (a credential, a token, the hub's
 * secrets, another person's tree or state) must never be read here either.
 * An agent can write its own vault's instruction files, so without this an
 * import line would be a way around every mask. The check is on the resolved
 * path, so a symlink into a hidden place is refused like the place itself.
 */
function readable(file: string, forbidden: string[], from?: string): string {
  const said = from ? `${file} (imported by ${from})` : file;
  let real: string;
  try {
    real = realpathSync(file);
    if (!statSync(real).isFile()) throw new Error();
    accessSync(real, constants.R_OK);
  } catch { throw new Error(`instructions-unreadable: ${said}`); }
  if (forbidden.some(path => real === path || real.startsWith(`${path}/`))) {
    throw new Error(`instructions-forbidden: ${said} is a place this agent may not read`);
  }
  try { return readFileSync(real, "utf8"); } catch { throw new Error(`instructions-unreadable: ${said}`); }
}

/** Every hidden path as the file system names it, so a symlinked parent cannot slip past the prefix test. */
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
 * One instruction file with its `@path` imports expanded the way Claude Code
 * expands them, relative paths against the importing file's directory and `~`
 * against `home`, a file already included anywhere in this prompt included
 * once, nothing inside a fenced code block or an inline code span.
 *
 * A line that is only `@<path>` is replaced by that file's content, and one
 * that cannot be read is refused rather than dropped: a rule that silently
 * goes missing is the exact failure this assembly exists to prevent. An `@`
 * inside a sentence is also an import when it names a file that exists, and
 * the file's content follows the line. One that names no file is left as
 * text, because a sentence can mention `@someone` and that is not an import,
 * which is also how Claude Code treats it. A chain deeper than `IMPORT_DEPTH`
 * is refused. Every file read is recorded in `reads`, because the box has to
 * let the CLI's launch reach it.
 */
export function expandInstructions(file: string, options: { home?: string; seen: Set<string>; reads: string[]; forbidden: string[] },
  depth = 0, from?: string): string {
  const text = readable(file, options.forbidden, from);
  options.seen.add(realpathSync(file));
  options.reads.push(file);
  let fenced = false;
  const out: string[] = [];
  const include = (path: string) => {
    if (depth + 1 > IMPORT_DEPTH) throw new Error(`instructions-import-too-deep: ${path} (imported by ${file})`);
    let again = false;
    try { again = options.seen.has(realpathSync(path)); } catch { /* refused inside, naming the importer */ }
    if (!again) out.push(expandInstructions(path, options, depth + 1, file).replace(/\n$/, ""));
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    const whole = line.match(/^\s*@(\S+)\s*$/);
    if (whole) { include(importPath(whole[1], file, options.home)); continue; }
    out.push(line);
    const prose = line.replace(/`[^`]*`/g, " ");
    for (const found of prose.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const target = found[1].replace(/[.,;:!?)\]"']+$/, "");
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
export function assemblePrompt(input: { files: string[]; fragment?: string; home?: string; forbidden?: string[] }) {
  const reads: string[] = [];
  const seen = new Set<string>();
  const forbidden = canonical(input.forbidden ?? []);
  const parts = [LOOP_PREAMBLE.trimEnd()];
  for (const file of input.files) {
    let real: string | null = null;
    try { real = realpathSync(file); } catch { /* readable() below names it */ }
    if (real && seen.has(real)) continue;
    parts.push(expandInstructions(file, { home: input.home, seen, reads, forbidden }).trimEnd());
  }
  if (input.fragment) {
    parts.push(readable(input.fragment, forbidden).trimEnd());
    reads.push(input.fragment);
  }
  return { text: parts.join("\n\n") + "\n", reads };
}
