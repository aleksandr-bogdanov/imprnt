// The unit naming rule, and both flavours rendered from one registry.
//
// SPEC §6: "the installer generates systemd unit files from the list". L13: "one
// list of what runs, and the service manager runs it". D7: the two kinds of
// process. Two prefixes, one for what the hub RENDERS (`imprnt-hub-`) and
// one for what it WATCHES (`imprnt-`), because the hub box's live v2 owns
// `imprnt-board.service` and the shipped example registry has an entry whose id
// is `board`.
//
// PURE, BOTH PLATFORMS, NO GATE. `render` takes everything it needs in its
// context, so both flavours are rendered from one registry on whichever box this
// runs, and the Mac and the hub box assert the same thing. Nothing here touches
// a manager, writes a file or spawns a process.
//
// THE NUMBERS ARE DELIBERATELY ODD. `restart_delay_seconds = 3`,
// `give_up_after = 7`, `give_up_window_seconds = 411`, `memory_limit_mb = 321`.
// A renderer that hard-coded systemd's or launchd's own defaults would pass
// against 1, 5, 300 and 512 and fails against these.
//
// Red reason: import missing, src/os/names.ts, src/os/systemd.ts,
// src/os/launchd.ts.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, hubPath } from "./helpers/cluster.ts";
import { canonical, parsePlistDict, plutilJson, type PlistValue } from "./helpers/plist.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

/** The four name shapes the live v2 on the hub box owns. */
const LIVE_V2_NAMES = [
  "imprnt-board.service",
  "imprnt-transcribe.service",
  "imprnt-artifacts.service",
  "imprnt-nats.service",
  "imprnt-watch@bikes.service",
];

const RESTART_DELAY = 3;
const GIVE_UP_AFTER = 7;
const GIVE_UP_WINDOW = 411;
const MEMORY_MB = 321;

function stage(): { dir: string; registryFile: string; unitDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hub-render-"));
  const unitDir = join(dir, "units");
  const spec: RegistrySpec = {
    hub: {
      store_url: "postgres://127.0.0.1:5432/hub",
      state_dir: dir,
      restart_delay_seconds: RESTART_DELAY,
      give_up_after: GIVE_UP_AFTER,
      give_up_window_seconds: GIVE_UP_WINDOW,
    },
    machines: [
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ],
    people: [
      { id: "p1", tree: join(dir, "p1") },
      { id: "p2", tree: join(dir, "p2") },
    ],
    presets: {
      daily: {
        adapter: "scripted",
        model: "a-model-name",
        provider: "a-provider",
        effort: "medium",
        paid: "plan",
      },
    },
    agents: [
      {
        id: "p1-lair",
        person: "p1",
        preset: "daily",
        chat: "0000000000",
        door: "door-fake",
        runner: "runner-pi",
      },
    ],
    run: [
      {
        id: "door-fake",
        kind: "door",
        machine: "pi",
        platform: "fake",
        person: "p1",
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: "runner-pi",
        kind: "runner",
        machine: "pi",
        schedule: "always",
        memory_limit_mb: MEMORY_MB,
        child_memory_limit_mb: 512,
      },
      { id: "watch-bikes", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "every 30m", memory_limit_mb: 128 },
      { id: "backup", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "hourly", memory_limit_mb: 256 },
      { id: "transcriber", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "on demand", memory_limit_mb: 1024 },
      // The collision fence's own subject: an entry id that renders to a live
      // v2 unit name under the WATCH prefix and must not under the RENDER one.
      { id: "board", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "always", memory_limit_mb: 256 },
    ],
  };
  return { dir, registryFile: writeRegistry(dir, spec), unitDir };
}

// ---------------------------------------------------------------------------
// The two readers this check asserts through.
//
// THE OLD SHAPE WAS A SUBSTRING MATCH AND THAT IS WHAT THE SECOND SEAT CAUGHT:
// `MemoryMax=321garbage` contains "321", so a renderer that emitted it passed a
// check that asked whether the line CONTAINED the configured number. Neither
// manager reads a substring. systemd parses `Key=Value` into a typed setting
// and refuses the unit when the value is not one, and launchd reads a typed
// property list and never starts a job whose plist it cannot parse. So both
// halves below parse first and assert VALUES, and every parser here throws by
// name rather than returning zero.
// ---------------------------------------------------------------------------

/** A systemd unit as sections of `Key=Value`, or a throw naming the bad line. */
function unitSections(text: string): Map<string, [string, string][]> {
  const sections = new Map<string, [string, string][]>();
  let current: string | null = null;
  // systemd's own line continuation, joined before anything is read, so a
  // renderer that wraps a long ExecStart is not called malformed.
  const joined = text.replace(/\\\n\s*/g, " ");
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line.trim());
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === null) {
      throw new Error(`the rendered unit has a line before any section: ${line}`);
    }
    const cut = line.indexOf("=");
    if (cut <= 0) {
      throw new Error(`the rendered unit has a line that is neither a section nor Key=Value: ${line}`);
    }
    sections.get(current)!.push([line.slice(0, cut).trim(), line.slice(cut + 1)]);
  }
  return sections;
}

/** Every value for a key, whichever section it sits in. */
function unitValues(sections: Map<string, [string, string][]>, key: string): string[] {
  const out: string[] = [];
  for (const entries of sections.values()) {
    for (const [name, value] of entries) if (name === key) out.push(value);
  }
  return out;
}

/** The one value for a key, or a throw. A key written twice is a real defect. */
function unitValue(sections: Map<string, [string, string][]>, key: string): string {
  const found = unitValues(sections, key);
  if (found.length !== 1) {
    throw new Error(`the rendered unit carries ${found.length} ${key} lines and exactly one is wanted`);
  }
  return found[0];
}

/** systemd's own time syntax, parsed WHOLE. `3garbage` throws, it is not 3. */
function systemdSeconds(value: string): number {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const units: [RegExp, number][] = [
    [/^(us|usec)$/, 1e-6],
    [/^(ms|msec)$/, 1e-3],
    [/^(s|sec|second|seconds)$/, 1],
    [/^(m|min|minute|minutes)$/, 60],
    [/^(h|hr|hour|hours)$/, 3600],
    [/^(d|day|days)$/, 86400],
  ];
  let total = 0;
  let rest = text;
  let read = 0;
  while (rest !== "") {
    const part = /^\s*(\d+)\s*([A-Za-z]+)\s*/.exec(rest);
    if (!part) throw new Error(`"${value}" is not a systemd time span`);
    const size = units.find(([shape]) => shape.test(part[2]))?.[1];
    if (size === undefined) throw new Error(`"${value}" carries a time unit systemd has no rule for: ${part[2]}`);
    total += Number(part[1]) * size;
    rest = rest.slice(part[0].length);
    read += 1;
  }
  if (read === 0) throw new Error(`"${value}" is not a systemd time span`);
  return total;
}

/** systemd's own size syntax, parsed WHOLE, in bytes. `321garbage` throws. */
function systemdBytes(value: string): number {
  const text = value.trim();
  const found = /^(\d+)([KMGT])?$/.exec(text);
  if (!found) throw new Error(`"${value}" is not a systemd size`);
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[found[2] ?? ""] ?? 1;
  return Number(found[1]) * scale;
}

/** An `ExecStart=` value as the argv systemd would run, quotes honoured. */
function execArgv(value: string): string[] {
  const out: string[] = [];
  let at = 0;
  const text = value.trim();
  while (at < text.length) {
    while (text[at] === " " || text[at] === "\t") at += 1;
    if (at >= text.length) break;
    if (text[at] === '"' || text[at] === "'") {
      const quote = text[at];
      const end = text.indexOf(quote, at + 1);
      if (end < 0) throw new Error(`ExecStart has an unclosed quote: ${value}`);
      out.push(text.slice(at + 1, end));
      at = end + 1;
      continue;
    }
    let end = at;
    while (end < text.length && text[end] !== " " && text[end] !== "\t") end += 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/** The typed tree of a rendered plist, and Apple's own parser agreeing on a Mac. */
async function plistOf(text: string): Promise<Record<string, PlistValue>> {
  const mine = parsePlistDict(text);
  const apple = await plutilJson(text);
  if (apple !== null) {
    expect(canonical(mine)).toEqual(canonical(apple));
  }
  return mine;
}

test(
  "RUN-02 every unit the hub renders is named under imprnt-hub-, which no unit of the live v2 can be, and the watch prefix imprnt- still sees one; and both flavours render from one registry on whichever box this runs (SPEC §6, L13, D7, D-75, D-94, D-96, D-97)",
  async () => {
    const { UNIT_PREFIX, SCAN_PREFIX, unitName, timerName, entryIdOf, isOurs, isWatched } =
      await seam("src/os/names.ts");
    expect(typeof unitName).toBe("function");
    expect(typeof entryIdOf).toBe("function");
    expect(typeof isOurs).toBe("function");
    expect(typeof isWatched).toBe("function");
    expect(typeof timerName).toBe("function");
    const { systemd } = await seam("src/os/systemd.ts");
    expect(typeof systemd).toBe("function");
    const { launchd } = await seam("src/os/launchd.ts");
    expect(typeof launchd).toBe("function");
    const { wantedState } = await seam("src/os/diff.ts");
    expect(typeof wantedState).toBe("function");

    const name = unitName as (id: string) => string;
    const idOf = entryIdOf as (unit: string) => string | null;
    const ours = isOurs as (unit: string) => boolean;
    const watched = isWatched as (unit: string) => boolean;

    const it = stage();
    try {
      // --- the two prefixes, and the fence between them -------------------
      expect(typeof UNIT_PREFIX).toBe("string");
      expect(typeof SCAN_PREFIX).toBe("string");
      expect(UNIT_PREFIX as string).toBe("imprnt-hub-");
      expect(SCAN_PREFIX as string).toBe("imprnt-");
      expect((UNIT_PREFIX as string).startsWith(SCAN_PREFIX as string)).toBe(true);
      expect((UNIT_PREFIX as string).length).toBeGreaterThan((SCAN_PREFIX as string).length);

      const registry = loadRegistry(it.registryFile);
      const entries = listRunEntries(registry);
      const example = listRunEntries(loadRegistry(hubPath("src/registry/registry.example.toml")));
      const everyId = [...new Set([...entries, ...example].map((e) => e.id))];
      expect(everyId).toContain("board");

      for (const id of everyId) {
        expect(name(id).startsWith(UNIT_PREFIX as string)).toBe(true);
        expect(idOf(name(id))).toBe(id);
        expect(ours(name(id))).toBe(true);
        expect(watched(name(id))).toBe(true);
        // THE FENCE. A rendered name is never the scan prefix plus the id, so
        // it can never be a name the live v2 already owns.
        expect(name(id)).not.toBe(`${SCAN_PREFIX as string}${id}`);
      }
      // Said once more by name, because this is the collision that would have
      // stopped a live v2 unit on the hub box.
      expect(name("board")).not.toBe("imprnt-board");
      expect(name("board")).toBe("imprnt-hub-board");

      // The other direction: a v2 unit is WATCHED and is never OURS, so it is
      // reported and never touched (L13).
      for (const v2 of LIVE_V2_NAMES) {
        expect(watched(v2)).toBe(true);
        expect(ours(v2)).toBe(false);
        expect(idOf(v2)).toBeNull();
      }
      expect(watched("postgresql.service")).toBe(false);
      expect(ours("postgresql.service")).toBe(false);

      // --- the three wanted states ---------------------------------
      const state = wantedState as (entry: unknown) => string;
      const entryOf = (id: string) => entries.find((e) => e.id === id)!;
      expect(state(entryOf("runner-pi"))).toBe("running");
      expect(state(entryOf("watch-bikes"))).toBe("scheduled");
      expect(state(entryOf("backup"))).toBe("scheduled");
      expect(state(entryOf("transcriber"))).toBe("loaded");

      // --- rendering, both flavours, from the one registry ----------------
      const ctx = {
        machine: "pi",
        execPath: "/opt/homebrew/bin/bun",
        entryScript: hubPath("src/entry/runner.ts"),
        registryFile: it.registryFile,
        restartDelaySeconds: RESTART_DELAY,
        giveUpAfter: GIVE_UP_AFTER,
        giveUpWindowSeconds: GIVE_UP_WINDOW,
      };
      const linux = (systemd as Function)({ unitDir: it.unitDir }) as {
        flavour: string;
        render(entry: unknown, ctx: unknown): { path: string; text: string }[];
      };
      const mac = (launchd as Function)({ unitDir: it.unitDir }) as {
        flavour: string;
        render(entry: unknown, ctx: unknown): { path: string; text: string }[];
      };
      expect(linux.flavour).toBe("systemd");
      expect(mac.flavour).toBe("launchd");

      const runner = entryOf("runner-pi");
      const unitFiles = linux.render(runner, ctx);
      expect(unitFiles.length).toBe(1);
      const service = unitFiles[0];
      expect(service.path.endsWith(`${name("runner-pi")}.service`)).toBe(true);
      const unit = service.text;
      // PARSED, not searched. A unit systemd cannot read is a unit that never
      // runs, so the whole file goes through the reader before one value of it
      // is asserted.
      const sections = unitSections(unit);

      // ExecStart is the five things the context carried, in order, as the
      // ARGV systemd would run. A renderer that discovered the interpreter or
      // the script itself would not be pure, and one that appended an argument
      // of its own fails the exact list rather than passing a substring match.
      expect(execArgv(unitValue(sections, "ExecStart"))).toEqual([
        ctx.execPath,
        "run",
        ctx.entryScript,
        ctx.registryFile,
        "runner-pi",
      ]);

      expect(unitValue(sections, "Restart").trim()).toBe("always");
      expect(systemdSeconds(unitValue(sections, "RestartSec"))).toBe(RESTART_DELAY);
      expect(unitValue(sections, "StartLimitBurst").trim()).toBe(String(GIVE_UP_AFTER));
      expect(systemdSeconds(unitValue(sections, "StartLimitIntervalSec"))).toBe(GIVE_UP_WINDOW);
      // THE VALUE, in bytes, not a substring of the line. `MemoryMax=321garbage`
      // and `MemoryMax=321K` are both caught here and neither was before.
      expect(systemdBytes(unitValue(sections, "MemoryMax"))).toBe(MEMORY_MB * 1024 * 1024);
      // WantedBy earns its place only in [Install]: anywhere else and
      // `systemctl --user enable` has nothing to link, so the unit never comes
      // back after a reboot.
      expect((sections.get("Install") ?? []).map(([k, v]) => `${k}=${v.trim()}`)).toContain(
        "WantedBy=default.target",
      );

      const plists = mac.render(runner, ctx);
      expect(plists.length).toBe(1);
      const plist = plists[0].text;
      expect(plists[0].path.endsWith(`${name("runner-pi")}.plist`)).toBe(true);
      // PARSED by this check's own reader AND, on a Mac, by Apple's `plutil`
      // over the same bytes, with the two asserted to agree. A plist launchd
      // cannot read is a job that never starts.
      const job = await plistOf(plist);
      expect(job.Label).toBe(name("runner-pi"));
      expect(job.ProgramArguments).toEqual([
        ctx.execPath,
        "run",
        ctx.entryScript,
        ctx.registryFile,
        "runner-pi",
      ]);
      expect(job.KeepAlive).toBe(true);
      // Measured: a KeepAlive job is back 0.33 s after a kill with
      // ThrottleInterval 1 and 9.14 s with the key absent, because launchd's
      // own default throttle is 10 s. Check 6 asserts the restart inside the
      // RENDERED value, so a renderer that dropped this key would make that
      // check wait out a default it never asked for. The typed assertion is
      // what makes `<string>1</string>` fail, which launchd ignores.
      expect(job.ThrottleInterval).toBe(RESTART_DELAY);
      expect(typeof job.ThrottleInterval).toBe("number");

      // --- the give-up asymmetry, asserted in BOTH directions ------
      // launchd never gives up, so it has no equivalent of StartLimit* and the
      // Mac carries `check`'s crash-loop finding instead (D7, check 23).
      for (const key of Object.keys(job)) {
        expect(key).not.toContain("StartLimit");
        expect(key).not.toContain("GiveUp");
      }
      expect(Object.values(job)).not.toContain(GIVE_UP_WINDOW);
      expect(Object.values(job)).not.toContain(GIVE_UP_AFTER);
      expect(unitValues(sections, "StartLimitBurst").length).toBe(1);
      expect(unitValues(sections, "StartLimitIntervalSec").length).toBe(1);

      // --- a scheduled entry: two files on systemd, one plist on launchd ---
      const watcher = entryOf("watch-bikes");
      const scheduled = linux.render(watcher, { ...ctx, entryScript: hubPath("src/entry/hub.ts") });
      expect(scheduled.length).toBe(2);
      const timer = scheduled.find((f) => f.path.endsWith(".timer"));
      const timerService = scheduled.find((f) => f.path.endsWith(".service"));
      expect(timer).toBeDefined();
      expect(timerService).toBeDefined();
      expect(timer!.path.endsWith(`${(timerName as Function)("watch-bikes")}`)).toBe(true);
      const timerSections = unitSections(timer!.text);
      expect(systemdSeconds(unitValue(timerSections, "OnUnitActiveSec"))).toBe(1800);
      // A scheduled service is started by its timer, so it does not want to be
      // running on its own.
      expect(unitValues(unitSections(timerService!.text), "Restart").map((v) => v.trim())).not.toContain(
        "always",
      );

      const scheduledPlists = mac.render(watcher, { ...ctx, entryScript: hubPath("src/entry/hub.ts") });
      expect(scheduledPlists.length).toBe(1);
      const cadence = await plistOf(scheduledPlists[0].text);
      expect(cadence.StartInterval).toBe(1800);
      expect(typeof cadence.StartInterval).toBe("number");
      expect(cadence.KeepAlive ?? false).toBe(false);

      // --- and `on demand` wants to be LOADED, so neither flavour keeps it
      //     alive. Without this the transcriber is restarted forever.
      const onDemand = entryOf("transcriber");
      const idleUnit = unitSections(linux.render(onDemand, ctx)[0].text);
      expect(unitValues(idleUnit, "Restart").map((v) => v.trim())).not.toContain("always");
      const idlePlist = await plistOf(mac.render(onDemand, ctx)[0].text);
      expect(idlePlist.KeepAlive ?? false).toBe(false);
      // ABSENT, not zero. A plist carrying StartInterval at all is a plist
      // claiming a schedule, and launchd reads `<integer>0</integer>` as a
      // degenerate repeating one rather than as "no cadence". The on-demand
      // entry's contract is that it carries none, so the key must not be there.
      expect(idlePlist.StartInterval).toBeUndefined();
    } finally {
      rmSync(it.dir, { recursive: true, force: true });
    }
  },
  30_000,
);
