// Test infrastructure: a registry file that looks like a person wrote it.
//
// The registry is hand-edited and hand-promoted, so the writer's whole promise
// is that everything a person put in the file survives an edit of one line.
// This fixture is deliberately awkward, because a file whose keys are already
// in the loader's order and whose lines carry no notes would agree with a
// writer that rewrote it from the parse.
//
// What it carries, and why each one is here:
//   - a header comment and a comment above two entries
//   - a comment INSIDE an entry, between two of its keys
//   - an inline table value (`allowed_senders`)
//   - keys in an order that is not the loader's
//   - two blank lines in one place and one in another
//   - no trailing newline at all
//   - the `[[run]]` entries AFTER the agents, so removing the last agent has a
//     header of ANOTHER table below it. A block bound written as "up to the
//     next entry of my own table" eats every run entry there, and a fixture
//     whose agents came last would never show it.
//
// The people are "the owner" and "the second person" and the chat ids are digit
// strings, because this repository is public.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HandWritten {
  /** The file on disk. */
  file: string;
  /** Its bytes, which a later diff compares against. */
  bytes: string;
}

/**
 * Write the file and hand back its bytes.
 *
 * `stateDir` is what `[hub] state_dir` says, so a door started against this
 * file writes its chat logs somewhere a check owns.
 */
export function handWrittenRegistry(dir: string, options: { stateDir?: string; storeUrl?: string } = {}): HandWritten {
  const stateDir = options.stateDir ?? dir;
  const storeUrl = options.storeUrl ?? "postgres://127.0.0.1:1/unused";
  const text = [
    "# The household, by hand. The comments are the only notes anybody has about",
    "# why any of this is the way it is, so they matter as much as the keys.",
    "",
    "[hub]",
    "tick_seconds = 1",
    `state_dir = ${JSON.stringify(stateDir)}`,
    `store_url = ${JSON.stringify(storeUrl)}`,
    "",
    "[[machines]]",
    'id = "pi"',
    `os = ${JSON.stringify(process.platform === "darwin" ? "macos" : "linux")}`,
    "",
    "# the owner",
    "[[people]]",
    'id = "p1"',
    `tree = ${JSON.stringify(join(stateDir, "p1"))}`,
    'allowed_senders = { door-fake = ["the-owner"] }',
    'language = "en"',
    "",
    "# the second person, who reads Russian",
    "[[people]]",
    'id = "p2"',
    `tree = ${JSON.stringify(join(stateDir, "p2"))}`,
    'allowed_senders = { door-fake = ["the-second-person"] }',
    'language = "ru"',
    "",
    "[presets.daily]",
    'adapter = "a-scripted-adapter"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "key"',
    "",
    "",
    "# the lair, the one that is always on",
    "[[agents]]",
    'person = "p1"',
    'id = "p1-lair"',
    'preset = "daily"',
    'chat = "1000000001"',
    'door = "door-fake"',
    'runner = "runner-pi"',
    "",
    "# the second person's lair",
    "[[agents]]",
    'id = "p2-lair"',
    'person = "p2"',
    "# this chat was made again after the first one was deleted",
    'chat = "2000000001"',
    'door = "door-fake"',
    'preset = "daily"',
    'runner = "runner-pi"',
    "",
    "[[agents]]",
    'id = "p1-batch"',
    'person = "p1"',
    'preset = "daily"',
    'runner = "runner-pi"',
    "",
    "# one bot for the household",
    "[[run]]",
    'id = "door-fake"',
    'kind = "door"',
    'platform = "fake"',
    'person = "p1"',
    'machine = "pi"',
    'token_file = "/dev/null"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "# the runner beside it",
    "[[run]]",
    'id = "runner-pi"',
    'kind = "runner"',
    'machine = "pi"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
  ].join("\n");
  const file = join(dir, "hand-written.toml");
  writeFileSync(file, text, { encoding: "utf8", mode: 0o640 });
  return { file, bytes: text };
}

/**
 * The lines that differ between two versions of a file, as a person reading a
 * diff would count them: which lines are gone and which are new.
 *
 * It is here rather than in a check because every primitive is asserted the
 * same way, and a diff written out four times would be four chances to compare
 * the wrong halves.
 */
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const was = before.split("\n");
  const now = after.split("\n");
  // The common head and the common tail are the untouched bytes, and what is
  // left between them is the whole of the change.
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  return {
    removed: was.slice(head, was.length - tail),
    added: now.slice(head, now.length - tail),
  };
}
