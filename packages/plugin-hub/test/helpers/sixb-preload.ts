// Test infrastructure: the six protected windows, run byte-unchanged against a
// registry that carries every shape dispatch, the shared zone and the off-box
// copy add.
//
// LOADED ONLY BY `bun test --preload`, never imported. A window builds its
// registry through `stageHub`, which renders it through `writeRegistry`, so this
// replaces that one function for the run it is preloaded into and for nothing
// else: no window file and no shared helper is edited, and an ordinary suite run
// never loads it.
//
// WHAT IS LAID OVER EACH WINDOW'S OWN SPEC, and why each piece is safe to lay
// over a file the window wrote for its own reasons:
//
// - A `[zone]` table. No window declares a vault, so the household rule asks
//   nothing more of the file, and a zone with no checkout is what a household
//   that has declared one and not provisioned it yet looks like.
// - A job-only agent on the runner the window measures, so that runner starts
//   one more agent loop, with its own work waiter, and has to stay as quiet as
//   the window says it does. When the file implies its entries that is the
//   first agent's runner. When the window spells out its `[[run]]` list it is
//   the runner entry no agent names yet, because the one window that does this
//   (the silence window) moves its first agent onto that runner by rewriting
//   the file's text afterwards, and that is the runner it then measures. With
//   no such entry it is the last runner the list names, so the file loads.
// - An hourly `backup` entry with its three commands, on the first declared
//   machine, which nothing in a window runs.
// - `guild` and `default_preset` on every door entry.
//
// The `[[run]]` list a window leaves to be implied is read back off the file the
// real writer renders and passed through again explicitly, so those entries
// render byte for byte as they did and only the new keys and the new entry are
// added.
//
// When `HUB_SIXB_RECORD` names a file, every registry this writes is appended to
// it as one JSON line, so the run that preloaded this can prove afterwards that
// every window really loaded a file carrying all four shapes.

import { mock } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as original from "./registry.ts";
import type { AgentSpec, RegistrySpec, RunSpec } from "./registry.ts";

const realWrite = original.writeRegistry;

export const SIXB_JOB_ONLY = "p1-batch";
export const SIXB_BACKUP = "backup-hourly";

function implied(spec: RegistrySpec): RunSpec[] {
  const scratch = mkdtempSync(join(tmpdir(), "hub-sixb-implied-"));
  try {
    const parsed = Bun.TOML.parse(readFileSync(realWrite(scratch, spec), "utf8")) as { run?: RunSpec[] };
    return parsed.run ?? [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function overlay(spec: RegistrySpec): RegistrySpec {
  const agents = spec.agents ?? [];
  const run = spec.run ?? implied(spec);
  const first = agents[0];
  const runners = run.filter((entry) => entry.kind === "runner").map((entry) => entry.id);
  const unnamed = runners.find((id) => !agents.some((one) => one.runner === id));
  const jobOnly: AgentSpec[] = first && !agents.some((one) => one.id === SIXB_JOB_ONLY)
    ? [{
        id: SIXB_JOB_ONLY,
        person: first.person,
        preset: first.preset,
        runner: spec.run ? unnamed ?? runners[runners.length - 1] ?? first.runner : first.runner,
      }]
    : [];
  const stateDir = String(spec.hub?.state_dir ?? tmpdir());
  return {
    ...spec,
    zone: spec.zone ?? { mount: "shared", remote: "origin", url: `file://${join(stateDir, "zone.git")}` },
    agents: [...agents, ...jobOnly],
    run: [
      ...run.map((entry) => entry.kind === "door"
        ? { ...entry, guild: entry.guild ?? "2000000000", default_preset: entry.default_preset ?? first?.preset ?? "daily" }
        : entry),
      ...(run.some((entry) => entry.kind === "backup") ? [] : [{
        id: SIXB_BACKUP,
        kind: "backup",
        ...(spec.machines?.[0]?.id ? { machine: spec.machines[0].id } : {}),
        schedule: "hourly",
        memory_limit_mb: 256,
        destination: "mac:hub-copies",
        dump_argv: ["/usr/bin/env", "pg_dump", "hub"],
        upload_argv: ["/usr/bin/rsync", "-a", "{staging}/", "{destination}"],
        readback_argv: ["/usr/bin/rsync", "{destination}/{path}", "{out}"],
      }]),
    ],
  };
}

mock.module("./registry.ts", () => ({
  ...original,
  writeRegistry(dir: string, spec: RegistrySpec): string {
    const file = realWrite(dir, overlay(spec));
    const record = process.env.HUB_SIXB_RECORD;
    if (record) appendFileSync(record, JSON.stringify({ file, text: readFileSync(file, "utf8") }) + "\n");
    return file;
  },
}));
