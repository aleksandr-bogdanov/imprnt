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

function readable(file: string, from?: string): string {
  const said = from ? `${file} (imported by ${from})` : file;
  try {
    if (!statSync(file).isFile()) throw new Error();
    accessSync(file, constants.R_OK);
    return readFileSync(file, "utf8");
  } catch { throw new Error(`instructions-unreadable: ${said}`); }
}

/**
 * One instruction file with its `@path` imports expanded the way Claude Code
 * expands them. A line that is only `@<path>` becomes that file's content, a
 * relative path resolves against the importing file's directory and `~`
 * against `home`, and a file already included anywhere in this prompt is
 * included once. Lines inside a fenced code block are text, never imports.
 *
 * An import that cannot be read, or a chain deeper than `IMPORT_DEPTH`, is
 * refused rather than dropped: a rule that silently goes missing is the exact
 * failure this assembly exists to prevent. Every file read is recorded in
 * `reads`, because the box has to let the CLI's launch reach it.
 */
export function expandInstructions(file: string, options: { home?: string; seen: Set<string>; reads: string[] },
  depth = 0, from?: string): string {
  const text = readable(file, from);
  const real = realpathSync(file);
  options.seen.add(real);
  options.reads.push(file);
  let fenced = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const named = fenced ? null : line.match(/^\s*@(\S+)\s*$/);
    if (!named) { out.push(line); continue; }
    const target = named[1];
    let path: string;
    if (target === "~" || target.startsWith("~/")) {
      if (!options.home) throw new Error(`instructions-unreadable: ${target} (imported by ${file}, and there is no HOME)`);
      path = join(options.home, target.slice(1));
    } else path = isAbsolute(target) ? target : resolve(dirname(file), target);
    if (depth + 1 > IMPORT_DEPTH) throw new Error(`instructions-import-too-deep: ${path} (imported by ${file})`);
    let again = false;
    try { again = options.seen.has(realpathSync(path)); } catch { /* refused just below, naming the importer */ }
    if (again) continue;
    out.push(expandInstructions(path, options, depth + 1, file).replace(/\n$/, ""));
  }
  return out.join("\n");
}

/**
 * The whole appended prompt of an ordinary launch: the code's own section,
 * then the person's instruction files with their imports expanded, then the
 * agent's own fragment. The fragment is read as it is, because the converter
 * already refuses an import inside one.
 */
export function assemblePrompt(input: { files: string[]; fragment?: string; home?: string }) {
  const reads: string[] = [];
  const seen = new Set<string>();
  const parts = [LOOP_PREAMBLE.trimEnd()];
  for (const file of input.files) {
    let real: string | null = null;
    try { real = realpathSync(file); } catch { /* readable() below names it */ }
    if (real && seen.has(real)) continue;
    parts.push(expandInstructions(file, { home: input.home, seen, reads }).trimEnd());
  }
  if (input.fragment) {
    parts.push(readable(input.fragment).trimEnd());
    reads.push(input.fragment);
  }
  return { text: parts.join("\n\n") + "\n", reads };
}
