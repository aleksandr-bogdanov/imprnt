// Every setting lives in the registry file, and nowhere else.
//
// SPEC §6: "every setting the code reads has a field in the file." L14: "All
// settings live in one file, the registry, plus one folder of watch files...
// Anything not in that file or folder is not a setting. It does not exist." Its
// Forbidden list carries "a behaviour switch on the command line or in an
// environment variable".
//
// The criterion quantifies over code that does not exist yet, so the probe is
// the mechanism that makes it true, not a census of readers. Two test names
// carry [partial] for that reason. No source file is grepped, because a grep is
// not a behaviour and cannot fail for the right reason.
//
// These three checks touch no Postgres, on purpose. The registry is a file and
// the loader is a file loader, so a database would add a dependency without
// adding a probe. Everything the hub stores is still in the one Postgres.
//
// The forbidden-override check runs the loader in a `bun` process of its own,
// with the environment and the argument list poisoned before that process
// starts. An in-process check cannot prove it: it has been shown that a
// helper module imported before the overrides are planted can snapshot the
// environment, and busting the cache of the root module would not catch it.

import { test, expect, afterEach } from "bun:test";
import { seam, hubPath } from "./helpers/cluster.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const savedEnv: Record<string, string | undefined> = {};
const savedArgv = [...process.argv];

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  process.argv = [...savedArgv];
});

async function scratch(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-registry-"));
  const file = join(dir, "registry.toml");
  await Bun.write(file, body);
  return file;
}

const SHIPPED = "src/registry/registry.example.toml";

// The cutover field is optional in the shipped bootstrap example.
async function supportedExample(): Promise<string> {
  return (await Bun.file(hubPath(SHIPPED)).text())
    .replace("[hub]", '[hub]\ncutover_batch = "fixture-batch"');
}

interface OutOfProcess {
  ok: boolean;
  argv: string[];
  key?: string;
  value?: unknown;
  error?: string;
}

/**
 * Read one setting through the real loader in a `bun` process of its own, with
 * `env` and the extra arguments in place BEFORE that process starts. Nothing of
 * the hub is imported here, so nothing can have snapshotted anything.
 */
async function readSettingOutOfProcess(
  env: Record<string, string>,
  extraArgv: string[],
): Promise<OutOfProcess> {
  const file = await scratch(await supportedExample());
  const script = `
    import { loadRegistry, readSetting, SETTING_FIELDS } from ${JSON.stringify(hubPath("src/registry/load.ts"))};
    const key = SETTING_FIELDS.find(f => f.type === "integer" || f.type === "number").key;
    console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2), key, value: readSetting(loadRegistry(${JSON.stringify(file)}), key) }));
  `;
  const scriptFile = join(dirname(file), "read-setting.ts");
  await Bun.write(scriptFile, script);
  const proc = Bun.spawn([process.execPath, scriptFile, ...extraArgv], {
    cwd: hubPath("."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  await rm(dirname(file), { recursive: true, force: true });

  const line = out.trim().split("\n").filter(Boolean).pop();
  if (!line) {
    throw new Error(
      `the loader subprocess printed nothing. stderr: ${err.trim().slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(line) as OutOfProcess;
  if (!parsed.ok) throw new Error(parsed.error ?? "the loader subprocess failed");
  return parsed;
}

test("[partial] RUN-06 every setting the code reads has a field in the file: the declared set and the shipped file are bound in both directions, and a key the code never declared is refused (SPEC §6, L14)", async () => {
  const { loadRegistry, readSetting, SETTING_FIELDS, UnknownSetting } =
    await seam("src/registry/load.ts");
  expect(typeof loadRegistry).toBe("function");
  expect(typeof readSetting).toBe("function");

  const fields = SETTING_FIELDS as { key: string; type: string }[];
  expect(Array.isArray(fields)).toBe(true);
  expect(fields.length).toBeGreaterThan(0);

  // Direction one: every setting the code declares it reads resolves from the
  // shipped file.
  const file = await scratch(await supportedExample());
  const registry = (loadRegistry as Function)(file);
  await rm(dirname(file), { recursive: true, force: true });
  for (const field of fields) {
    const value = (readSetting as Function)(registry, field.key);
    expect(value).toBeDefined();
    expect(Array.isArray(value) ? "array" : typeof value).toBe(field.type === "integer" ? "number" : field.type);
  }

  // Direction two, the negative. Take the shipped file, delete the line
  // carrying one declared field, and the load must be refused. Without this a
  // one-field catalogue satisfies the check while the file drifts away from it,
  // which is the hole a reader named.
  const shipped = await supportedExample();
  const leaf = fields[0].key.split(".").pop()!;
  const lines = shipped.split("\n");
  const drop = lines.findIndex((l) => new RegExp(`^\\s*${leaf}\\s*=`).test(l));
  expect(drop).toBeGreaterThanOrEqual(0);
  const maimed = await scratch(lines.filter((_, i) => i !== drop).join("\n"));

  let missing: unknown;
  try {
    (loadRegistry as Function)(maimed);
  } catch (err) {
    missing = err;
  }
  expect(missing).toBeDefined();
  expect(String((missing as Error).message)).toContain(leaf);
  await rm(dirname(maimed), { recursive: true, force: true });

  // And a reader that invented a setting fails at run time rather than getting
  // a quiet default, which is what "it does not exist" means in practice.
  let refusal: unknown;
  try {
    (readSetting as Function)(registry, "hub.invented_by_an_agent");
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(UnknownSetting as Function);
});

test("[partial] RUN-06 a file missing a declared setting is refused and the refusal names the key (SPEC §6, L14)", async () => {
  const { loadRegistry, SETTING_FIELDS, RegistryRefused } = await seam(
    "src/registry/load.ts",
  );
  expect(typeof loadRegistry).toBe("function");

  const fields = SETTING_FIELDS as { key: string; required?: boolean }[];
  const required = fields.find((f) => f.required !== false);
  expect(required).toBeDefined();

  // A registry with a run entry but none of the declared settings.
  const file = await scratch(
    [
      "[[run]]",
      'id = "door-telegram"',
      'kind = "door"',
      'schedule = "always"',
      "memory_limit_mb = 256",
      "",
    ].join("\n"),
  );

  let refusal: unknown;
  try {
    (loadRegistry as Function)(file);
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(RegistryRefused as Function);
  expect((refusal as { key: string }).key).toBe(required!.key);
  expect(String((refusal as Error).message)).toContain(required!.key);

  await rm(dirname(file), { recursive: true, force: true });
});

test("RUN-07 no behaviour switch on the command line or in an environment variable: the loader runs in a process whose environment and arguments were poisoned before it started, and still reads the file's value (SPEC §6 Forbidden, L14)", async () => {
  // Nothing of the hub is imported by this test process. An in-process check
  // cannot prove this honestly: the loader, or any helper it imports, can read
  // process.env once at import time, and busting the cache of the root module
  // does not help because an earlier helper keeps its snapshot. A separate
  // process has no such history.
  const clean = await readSettingOutOfProcess({}, []);
  expect(clean.ok).toBe(true);
  const key = clean.key!;
  const fromFile = clean.value as number;
  expect(typeof fromFile).toBe("number");

  const override = fromFile + 4242;

  // Every environment-variable name and argument spelling a reader might
  // plausibly reach for, so the check does not pass because the implementation
  // picked a different convention than the one the test guessed.
  const flat = key.toUpperCase().replace(/[.\-]/g, "_");
  const leaf = key.split(".").pop()!;
  const last = leaf.toUpperCase().replace(/-/g, "_");
  const env: Record<string, string> = {};
  for (const name of [flat, `HUB_${flat}`, last, `HUB_${last}`]) {
    env[name] = String(override);
  }

  const poisonedArgv = [
    `--${key}=${override}`,
    `--${key}`,
    String(override),
    `--${leaf}=${override}`,
    `--${leaf.replace(/_/g, "-")}=${override}`,
  ];
  const poisoned = await readSettingOutOfProcess(env, poisonedArgv);

  expect(poisoned.ok).toBe(true);
  expect(poisoned.argv).toEqual(poisonedArgv);
  // The file's value, not the environment's and not the command line's.
  expect(poisoned.value).toBe(fromFile);
});
