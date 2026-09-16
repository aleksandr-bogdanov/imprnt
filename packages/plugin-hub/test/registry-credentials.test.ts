// RUN-16. A credential has one owner and one place, and the file says where.
//
// SPEC §6 and L10 rule 1: "A credential has one owner and one place. The owner
// is the household or one person. It lives in exactly one file, and every agent
// that uses it points at that file." SPEC §6's Forbidden carries "a quiet
// default on a bad value".
//
// Pure. No Postgres and no operating system.
//
// THE UNDECLARED CONTROL IS LOAD-BEARING. A `paid = "plan"` preset that names
// no credential LOADS, because undeclared is a `check` finding and never a
// refusal (D-111, bound in test/check-credentials.test.ts). Every shipped
// fixture is such a file, so a loader that refused one would take the whole
// suite down with it. Bound here rather than discovered in the build round.
//
// No path below is a real path and no id is a real id: every credential file is
// a placeholder under a scratch directory, and nothing in this file writes a
// token of any kind.
//
// Red reason: behaviour absent. `parsed.credentials` is never read, so every
// bad file loads with no complaint and none of the four accessors exists.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";

let dir: string;

function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-credentials-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function lineOf(lines: string[], text: string, nth = 1): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === text && ++seen === nth) return i + 1;
  }
  throw new Error(`the fixture has no ${nth} occurrence of ${JSON.stringify(text)}`);
}

function replace(lines: string[], text: string, withText: string, nth = 1): string[] {
  const out = [...lines];
  out[lineOf(lines, text, nth) - 1] = withText;
  return out;
}

function drop(lines: string[], text: string, nth = 1): string[] {
  return replace(lines, text, "# this line was removed by the check", nth);
}

function refusalOf(file: string): RegistryRefused {
  try {
    loadRegistry(file);
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

/** The three kinds this hub has, one credential each, and an agent using one. */
function goodLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    "",
    "[[credentials]]",
    'id = "household-claude"',
    'kind = "claude-login"',
    'file = "/var/lib/imprnt-hub/credentials/claude.json"',
    'owner = "household"',
    "",
    "[[credentials]]",
    'id = "telegram-bot"',
    'kind = "telegram"',
    'file = "/etc/imprnt-hub/telegram.token"',
    'owner = "household"',
    "",
    "[[credentials]]",
    'id = "discord-bot"',
    'kind = "discord"',
    'file = "/etc/imprnt-hub/discord.token"',
    'owner = "p1"',
    "",
    "[presets.daily]",
    'adapter = "an-adapter"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "plan"',
    "window_pause_at = 85",
    "window_notice_at = 95",
    "window_hold_at = 100",
    'credential = "household-claude"',
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "1000000001"',
    'door = "door-fake"',
    'runner = "runner-pi"',
  ];
}

test("RUN-16 a credential has one owner and one place and the file says where: two entries with one id, a missing id, a missing file, a kind outside the three and an owner nobody declares are each refused by name and by line, and a plan preset that names none still loads (SPEC §6, L10 rule 1, L14)", async () => {
  const base = goodLines();

  // --- 1. two entries with one id, the way a duplicate [[run]] id and a
  //     duplicate [[people]] id already refuse. One id is one credential, or
  //     "one place" means nothing.
  {
    const lines = replace(base, 'id = "telegram-bot"', 'id = "household-claude"');
    const refusal = refusalOf(write(lines));
    expect(refusal).toBeInstanceOf(RegistryRefused);
    expect(refusal.key).toContain("credentials[1]");
    expect(refusal.key).toContain("id");
    expect(refusal.line).toBe(lineOf(base, 'id = "telegram-bot"'));
    expect(refusal.reason).toContain("household-claude");
    expect(String(refusal.message)).toContain(String(refusal.line));
  }

  // --- 2. an entry with no id, and one with no file. An entry a preset cannot
  //     name, and an entry that names no place.
  {
    const lines = drop(base, 'id = "discord-bot"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("credentials[2]");
    expect(refusal.key).toContain("id");
  }
  {
    const lines = drop(base, 'file = "/etc/imprnt-hub/telegram.token"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("credentials[1]");
    expect(refusal.key).toContain("file");
  }

  // --- 3. a kind outside the three, and the refusal lists them, because a
  //     person reading it has to know what to write.
  {
    const lines = replace(base, 'kind = "telegram"', 'kind = "signal"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe("credentials[1].kind");
    expect(refusal.line).toBe(lineOf(lines, 'kind = "signal"'));
    expect(refusal.reason).toContain("claude-login");
    expect(refusal.reason).toContain("telegram");
    expect(refusal.reason).toContain("discord");
  }

  // --- 4. an owner that is neither the household nor a declared person.
  {
    const lines = replace(base, 'owner = "p1"', 'owner = "p9"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe("credentials[2].owner");
    expect(refusal.line).toBe(lineOf(lines, 'owner = "p9"'));
    expect(refusal.reason).toContain("p9");
  }

  // --- 4's own control: the SAME owner in a file that declares NO people at
  //     all still loads. That is D-93's tolerance applied here for the same
  //     reason: whether a person is declared is a question this file may not
  //     be answering yet, and a loader that made it unconditional would refuse
  //     files that run today.
  {
    const lines = drop(
      drop(drop(replace(base, 'owner = "p1"', 'owner = "p9"'), "[[people]]"), 'id = "p1"'),
      'tree = "/var/lib/imprnt-hub/p1"',
    );
    expect(loadRegistry(write(lines))).toBeDefined();
  }

  // --- 5. a preset naming a credential the file does not declare. A typo is
  //     otherwise an agent reading a login nobody owns.
  {
    const lines = replace(
      base,
      'credential = "household-claude"',
      'credential = "household-clause"',
    );
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe("presets.daily.credential");
    expect(refusal.line).toBe(lineOf(lines, 'credential = "household-clause"'));
    expect(refusal.reason).toContain("household-clause");
  }

  // --- control (a): the good file loads and every field comes back, in FILE
  //     order, so a build that sorted them or dropped `owner` fails.
  const { listCredentials, credentialFor, credentialOf } = await seam(
    "src/registry/entries.ts",
  );
  expect(typeof listCredentials).toBe("function");
  expect(typeof credentialFor).toBe("function");
  expect(typeof credentialOf).toBe("function");

  const registry = loadRegistry(write(base));
  expect((listCredentials as Function)(registry)).toEqual([
    {
      id: "household-claude",
      kind: "claude-login",
      file: "/var/lib/imprnt-hub/credentials/claude.json",
      owner: "household",
    },
    {
      id: "telegram-bot",
      kind: "telegram",
      file: "/etc/imprnt-hub/telegram.token",
      owner: "household",
    },
    {
      id: "discord-bot",
      kind: "discord",
      file: "/etc/imprnt-hub/discord.token",
      owner: "p1",
    },
  ]);
  expect((credentialFor as Function)(registry, "household-claude")).toEqual({
    id: "household-claude",
    kind: "claude-login",
    file: "/var/lib/imprnt-hub/credentials/claude.json",
    owner: "household",
  });
  expect((credentialFor as Function)(registry, "nobody")).toBeNull();
  // The agent's own credential is the one its preset names.
  expect((credentialOf as Function)(registry, "p1-lair")).toBe("household-claude");

  // --- control (b): D-111's ruling, and the one every shipped fixture rests
  //     on. A plan preset naming NO credential loads, and the outage key falls
  //     back to the preset's own name, which is what keeps the one-notice
  //     arithmetic sound for a household that has not written the table yet.
  const { credentialOfPreset } = await seam("src/registry/presets.ts");
  expect(typeof credentialOfPreset).toBe("function");
  const undeclared = loadRegistry(write(drop(base, 'credential = "household-claude"')));
  expect((credentialOfPreset as Function)(undeclared, "daily")).toBeNull();
  expect((credentialOf as Function)(undeclared, "p1-lair")).toBe("preset:daily");

  // --- control (c): an unrelated extra key on a credential still loads, so
  //     what is refused is a bad entry and not novelty.
  {
    const lines = [...base];
    lines.splice(lineOf(base, 'owner = "household"'), 0, 'note = "the one in the hall"');
    expect(loadRegistry(write(lines))).toBeDefined();
  }

  // --- control (d): a file with no credentials table at all loads, and the
  //     list is empty rather than absent.
  {
    const bare = loadRegistry(write(["[hub]", "tick_seconds = 5"]));
    expect((listCredentials as Function)(bare)).toEqual([]);
  }
});
