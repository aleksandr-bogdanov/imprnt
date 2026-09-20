// The transcriber is the one non-bun program the hub renders, and every knob of
// it is an argument. (SPEC §6, L4, D-97, D-75, D-194, D-195)
//
// Four bun entry points and one Python server. The renderer learns nothing
// about Python: the argv arrives as a value, so both flavours render one shape
// and the transcriber's interpreter is not a branch inside either of them. The
// fallback is today's expression, so every shipped render is byte-identical and
// no shipped render check moves.
//
// NO BEHAVIOUR SWITCH REACHES IT THROUGH THE ENVIRONMENT. Every knob the
// recognizer has was an environment variable in the system this replaces, and
// SPEC section 6 forbids exactly that. The unit carries the two store variables
// every unit carries and nothing else, so an operator reading the file sees the
// whole of what the process will do.
//
// LAUNCHD ENFORCES NO MEMORY LIMIT AND THE CHECK SAYS SO. A transcriber on a
// Mac carries `memory_limit_mb` in the registry, the hub records its reading,
// and the plist holds nothing back. That is the same honesty a stock Pi already
// needs, where a systemd `MemoryMax` is inert because the firmware leaves the
// memory cgroup off. The household's real lever is the reading `check`
// compares against the limit.
//
// Which of the six protected windows this could reach: none. A render is pure,
// and the native half installs a unit of its own under a random-suffixed id,
// which is the shipped pattern for exactly that reason.
//
// Red reason: behaviour absent. `programForKind` refuses the transcriber kind,
// `transcriberArgv` does not exist, and `RenderContext` has no `argv`.
//
// WHICH ASSERTIONS ARE GREEN FROM THE FIRST RUN, said here rather than
// discovered: the byte-identity case below and the control at the bottom. The
// first is green before the render context carries an argv at all, because a
// field the renderer ignores changes nothing, and it becomes a real assertion
// the moment the renderer reads one. The second is the loader's refusal, which
// was already bound.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startCluster, seam, hubPath, until, type Cluster } from "./helpers/cluster.ts";
import { serviceFixture, serviceOs, renderContext } from "./helpers/rollout-service.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { writeRegistry } from "./helpers/registry.ts";
import { systemd } from "../src/os/systemd.ts";
import { launchd } from "../src/os/launchd.ts";
import { loadRegistry, type RunEntry } from "../src/registry/load.ts";
import { listRunEntries, transcriberFor, voiceFor } from "../src/registry/entries.ts";
import { STARTED_WITH } from "../src/store/connect.ts";
import type { RenderContext, UnitFile } from "../src/os/types.ts";
import { runHub } from "../src/hub/run.ts";

const SLOW = 120_000;
const EXAMPLE = "src/registry/registry.example.toml";
const SERVER = "tools/transcribe-server.py";

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  announceGate(gate, "the transcriber's unit installed through the real manager");
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
  } finally {
    if (gate.ok) {
      const after = (await fixture.listWatched()).sort();
      if (JSON.stringify(after) !== JSON.stringify(foreignBefore)) {
        throw new Error(
          `this file disturbed the box: watch-prefix units were\n${foreignBefore.join(", ")}\nand are now\n${after.join(", ")}`,
        );
      }
    }
    if (cluster) await cluster.stop();
  }
});

/** The `ExecStart` argv of a systemd unit, as the words it was rendered from. */
function execStart(text: string): string[] {
  const line = text.split("\n").find((one) => one.startsWith("ExecStart="))!;
  return (line.slice("ExecStart=".length).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((word) =>
    word.startsWith('"') ? (JSON.parse(word) as string) : word,
  );
}

/** The `ProgramArguments` array of a plist, in order. */
function programArguments(text: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)![1];
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((found) =>
    found[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  );
}

/** The argv of a rendered entry, whichever flavour rendered it. */
function argvOf(files: UnitFile[], flavour: "systemd" | "launchd"): string[] {
  const text = files.find((file) => file.path.endsWith(flavour === "systemd" ? ".service" : ".plist"))!.text;
  return flavour === "systemd" ? execStart(text) : programArguments(text);
}

/** Every rendered file's text, joined, so an absence can be asserted over all of it. */
function allText(files: UnitFile[]): string {
  return files.map((file) => file.text).join("\n");
}

function context(over: Partial<RenderContext> & { entryScript: string; registryFile: string }): RenderContext {
  return {
    machine: "pi",
    execPath: process.execPath,
    stateDir: "/tmp/a-state-dir",
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
    ...over,
  };
}

test(
  "D-195 the transcriber's program is the one the hub renders that is not a bun entry point, and its whole argv comes off the registry in the order the server's own parser pins (SPEC §6, D-198)",
  async () => {
    const { programForKind, transcriberArgv } = await seam("src/hub/program.ts");
    expect(typeof transcriberArgv).toBe("function");

    // 1. The one non-bun program, absolute, and it is really there.
    const program = (programForKind as Function)("transcriber") as string;
    expect(resolve(program)).toBe(hubPath(SERVER));
    expect(existsSync(program)).toBe(true);
    // The four bun kinds are unchanged and still their own entry points.
    for (const kind of ["hub", "door", "runner", "sync"]) {
      expect(resolve((programForKind as Function)(kind) as string)).toBe(
        hubPath(`src/entry/${kind}.ts`),
      );
    }

    // 2. The argv over the shipped example, computed here from what that file
    //    says rather than from a constant, element by element and in order,
    //    because the order is the contract with the server's own parser.
    const registry = loadRegistry(hubPath(EXAMPLE));
    const voice = voiceFor(registry)!;
    const entry = transcriberFor(registry, "pi")!;
    expect(voice.provider).toBe("sherpa-onnx");
    expect(entry.residency).toBe("resident");
    expect((transcriberArgv as Function)(registry, entry)).toEqual([
      `${voice.runtime}/venv/bin/python`,
      hubPath(SERVER),
      "--port",
      String(entry.port),
      "--runtime",
      String(voice.runtime),
      "--model",
      voice.model,
      "--warm",
      "--idle-s",
      "0",
    ]);
  },
  SLOW,
);

test(
  "D-194 both residencies render one shape: the resident is started warm and never lets go, the other drops the model after its own window, and each is a resident unit the manager keeps alive (SPEC §6, L4, D-97)",
  async () => {
    const { transcriberArgv } = await seam("src/hub/program.ts");
    const { programForKind } = await seam("src/hub/program.ts");
    const f = await serviceFixture(cluster);
    try {
      const runtime = join(f.dir, "voice-runtime");
      const registryFile = join(f.dir, "residency.toml");
      const write = (residency?: string, idleSeconds?: number) => {
        writeRegistry(f.dir, {
          hub: { store_url: "postgres://127.0.0.1:1/x", state_dir: f.dir, tick_seconds: 5 },
          machines: [{ id: "pi", os: "linux" }],
          people: [{ id: "p1", tree: join(f.dir, "p1") }],
          presets: {},
          agents: [],
          voice: { recognizer: "local" },
          recognizers: { local: { provider: "sherpa-onnx", model: "a-speech-model-directory", runtime } },
          run: [
            {
              id: "transcriber",
              kind: "transcriber",
              machine: "pi",
              schedule: "always",
              memory_limit_mb: 2048,
              port: 8798,
              residency,
              idle_seconds: idleSeconds,
            },
          ],
        });
        writeFileSync(registryFile, readFileSync(join(f.dir, "registry.toml"), "utf8"));
        return loadRegistry(registryFile);
      };

      for (const [residency, idleSeconds, tail] of [
        [undefined, undefined, ["--warm", "--idle-s", "0"]],
        ["idle-unload", 5, ["--idle-s", "5"]],
      ] as [string | undefined, number | undefined, string[]][]) {
        const registry = write(residency, idleSeconds);
        const entry = transcriberFor(registry, "pi")!;
        const argv = (transcriberArgv as Function)(registry, entry) as string[];
        // 3. The two values D-194 has, and nothing else is renderable.
        expect(argv.slice(-tail.length)).toEqual(tail);
        if (residency === "idle-unload") expect(argv).not.toContain("--warm");

        const ctx = context({
          entryScript: (programForKind as Function)("transcriber") as string,
          registryFile,
          argv,
        });
        const unitDir = join(f.dir, `units-${crypto.randomUUID()}`);
        mkdirSync(unitDir);
        const linux = systemd({ unitDir }).render(entry as RunEntry, ctx);
        const mac = launchd({ unitDir }).render(entry as RunEntry, ctx);

        // 8. The name is v3's, never the one the system this replaces owns.
        expect(linux[0].path.endsWith("imprnt-hub-transcriber.service")).toBe(true);
        expect(mac[0].path.endsWith("imprnt-hub-transcriber.plist")).toBe(true);
        expect(allText(linux)).not.toContain("imprnt-transcribe");

        // The argv reaches both renderers whole.
        expect(argvOf(linux, "systemd")).toEqual(argv);
        expect(argvOf(mac, "launchd")).toEqual(argv);

        // 4. Both residencies are resident units: the manager keeps them alive
        //    and brings them back, which is what puts a peak on record for each.
        expect(allText(linux)).toContain("Restart=always");
        expect(allText(linux)).toContain("[Install]");
        expect(allText(linux)).toContain("WantedBy=default.target");
        expect(allText(mac)).toContain("<key>KeepAlive</key>");
        expect(allText(mac)).toContain("<key>RunAtLoad</key>");

        // 5. No behaviour switch through the environment, in either flavour,
        //    and the two store variables every unit carries are still there, so
        //    a build that special-cased this unit's environment is caught
        //    either way.
        expect(allText(linux)).not.toContain("TRANSCRIBE_");
        expect(allText(mac)).not.toContain("TRANSCRIBE_");
        for (const [name, value] of Object.entries(STARTED_WITH)) {
          expect(allText(linux)).toContain(`${name}=${value}`);
          expect(allText(mac)).toContain(`<key>${name}</key>`);
          expect(allText(mac)).toContain(`<string>${value}</string>`);
        }

        // 6. The limit systemd can hold, and launchd's honest absence of one.
        expect(allText(linux)).toContain(`MemoryMax=${entry.memory_limit_mb}M`);
        expect(allText(mac)).not.toContain("Memory");

        // 7. No ping and no socket, for any registry. The keep-warm the system
        //    this replaces shipped has no job on the resident value and would
        //    defeat the unload on the other, and socket-activated exit is not
        //    shipped, so neither shape is rendered at all.
        for (const files of [linux, mac]) {
          expect(files.some((file) => file.path.includes("ping"))).toBe(false);
          expect(files.some((file) => file.path.endsWith(".socket"))).toBe(false);
          expect(allText(files)).not.toContain("ping");
        }
      }
    } finally {
      await f.stop();
    }
  },
  SLOW,
);

test(
  "D-195 the argv is an optional value and its absence is today's expression, so every shipped kind renders what it renders now in both flavours (SPEC §6)",
  async () => {
    const { programForKind } = await seam("src/hub/program.ts");
    const f = await serviceFixture(cluster);
    try {
      for (const flavour of ["systemd", "launchd"] as const) {
        const unitDir = join(f.dir, `units-${flavour}-${crypto.randomUUID()}`);
        mkdirSync(unitDir);
        const renderer = flavour === "systemd" ? systemd({ unitDir }) : launchd({ unitDir });
        for (const entry of f.entries()) {
          const script = (programForKind as Function)(entry.kind) as string;
          const base = renderContext(f, script);
          // 9. ARGV ABSENT renders exactly what ARGV SET TO THE FALLBACK
          //    renders, which is what `ctx.argv ?? <today's expression>` buys
          //    and what keeps every shipped render check where it is.
          const fallback = [process.execPath, "run", script, f.registryFile, entry.id];
          const without = renderer.render(entry, base);
          const with_ = renderer.render(entry, { ...base, argv: fallback });
          expect(without.map((file) => [file.path, file.text])).toEqual(
            with_.map((file) => [file.path, file.text]),
          );
          expect(argvOf(without, flavour)).toEqual(fallback);
        }
      }
    } finally {
      await f.stop();
    }
  },
  SLOW,
);

test(
  "D-195 a unit installed by hand and a unit the hub writes on its own tick cannot differ, because one function answers both (SPEC §6, ROLL-01)",
  async () => {
    const { runInstall } = await seam("src/install/run.ts");
    const f = await serviceFixture(cluster);
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      // A runtime whose interpreter is real and harmless, so the native half
      // below installs a unit that sleeps rather than one that dies in a loop.
      const runtime = join(f.dir, "voice-runtime");
      mkdirSync(join(runtime, "venv", "bin"), { recursive: true });
      writeFileSync(join(runtime, "venv", "bin", "python"), "#!/bin/sh\nexec sleep 600\n", "utf8");
      chmodSync(join(runtime, "venv", "bin", "python"), 0o755);

      const text = readFileSync(f.registryFile, "utf8");
      writeFileSync(
        f.registryFile,
        `${text.trimEnd()}\n\n[voice]\nrecognizer = "local"\n\n[recognizers.local]\nprovider = "sherpa-onnx"\nmodel = "a-speech-model-directory"\nruntime = ${JSON.stringify(runtime)}\n\n[[run]]\nid = "transcriber"\nkind = "transcriber"\nmachine = ${JSON.stringify(f.machine)}\nschedule = "always"\nmemory_limit_mb = 2048\nport = 8798\n`,
      );
      const owned = [...Object.values(f.ids), "transcriber"];
      const flavour = process.platform === "darwin" ? "launchd" : "systemd";

      // 11. The installer's own bytes for the transcriber.
      const byHand = serviceOs(f.dir, flavour, owned);
      await (runInstall as Function)({
        registryFile: f.registryFile,
        stage: "services",
        target: f.ids.hub,
        os: byHand.os,
      });
      const installed = byHand.files.find((file) => file.path.includes("imprnt-hub-transcriber."))!;
      expect(installed).toBeDefined();
      expect(installed.text).toContain(join(runtime, "venv", "bin", "python"));
      expect(installed.text).toContain(hubPath(SERVER));

      // ... and the hub's own, written on its tick from its own context.
      const byHub = serviceOs(f.dir, flavour, owned);
      hub = await runHub({ registryFile: f.registryFile, machine: f.machine, os: byHub.os });
      await until(
        "the hub wrote the transcriber's unit on its own tick",
        () => byHub.files.some((file) => file.path.includes("imprnt-hub-transcriber.")),
        30_000,
        () => byHub.files.map((file) => file.path).join(", "),
      );
      const ticked = byHub.files.find((file) => file.path.includes("imprnt-hub-transcriber."))!;
      expect(ticked.text).toBe(installed.text);
    } finally {
      await hub?.stop();
      await f.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `D-97 the transcriber's unit installs through the real manager, carries its argv where an operator reads it, and leaves nothing behind${gateSuffix(gate)}`,
  async () => {
    const { programForKind, transcriberArgv } = await seam("src/hub/program.ts");
    const machine = thisMachine();
    const entryId = fixture.entryId("transcriber");
    const unitDir = fixture.unitDir();
    const f = await serviceFixture(cluster);
    const seamOf = process.platform === "darwin" ? launchd({ unitDir }) : systemd({ unitDir });
    let installed = false;
    try {
      const runtime = join(f.dir, "voice-runtime");
      mkdirSync(join(runtime, "venv", "bin"), { recursive: true });
      writeFileSync(join(runtime, "venv", "bin", "python"), "#!/bin/sh\nexec sleep 600\n", "utf8");
      chmodSync(join(runtime, "venv", "bin", "python"), 0o755);

      const registryFile = writeRegistry(f.dir, {
        hub: { store_url: "postgres://127.0.0.1:1/x", state_dir: f.dir, tick_seconds: 5 },
        machines: [machine],
        people: [{ id: "p1", tree: join(f.dir, "p1") }],
        presets: {},
        agents: [],
        voice: { recognizer: "local" },
        recognizers: { local: { provider: "sherpa-onnx", model: "a-speech-model-directory", runtime } },
        run: [
          {
            id: entryId,
            kind: "transcriber",
            machine: machine.id,
            schedule: "always",
            memory_limit_mb: 2048,
            port: 8798,
          },
        ],
      });
      const registry = loadRegistry(registryFile);
      const entry = listRunEntries(registry).find((one) => one.id === entryId)!;
      const argv = (transcriberArgv as Function)(registry, transcriberFor(registry, machine.id)!) as string[];
      const files = seamOf.render(entry, context({
        machine: machine.id,
        entryScript: (programForKind as Function)("transcriber") as string,
        registryFile,
        argv,
      }));
      await seamOf.install(files);
      installed = true;

      // What an operator reads is the whole command line, from the manager's
      // own record on Linux and from the file the manager loaded on a Mac.
      const read =
        process.platform === "darwin"
          ? readFileSync(join(unitDir, `imprnt-hub-${entryId}.plist`), "utf8")
          : Bun.spawnSync(["systemctl", "--user", "cat", `imprnt-hub-${entryId}.service`], {
              stdout: "pipe",
              stderr: "pipe",
            }).stdout.toString();
      for (const word of argv) expect(read).toContain(word);
      expect(read).not.toContain("TRANSCRIBE_");

      await seamOf.remove(entryId);
      installed = false;
      expect(existsSync(join(unitDir, `imprnt-hub-${entryId}.service`))).toBe(false);
      expect(existsSync(join(unitDir, `imprnt-hub-${entryId}.plist`))).toBe(false);
      expect(await seamOf.show(entryId)).toBeNull();
    } finally {
      if (installed) await seamOf.remove(entryId).catch(() => {});
      await f.stop();
    }
  },
  SLOW,
);

test(
  "D-195 a household that names no recognizer that runs here has no transcriber entry to render, and the file says so by line (SPEC §6, D-200)",
  async () => {
    const f = await serviceFixture(cluster);
    try {
      // THE CONTROL on every render above: the loader refuses such a file, so
      // there is no empty render to mistake for a household that opted out.
      const text = readFileSync(f.registryFile, "utf8");
      const broken = join(f.dir, "no-recognizer.toml");
      writeFileSync(
        broken,
        `${text.trimEnd()}\n\n[[run]]\nid = "transcriber"\nkind = "transcriber"\nmachine = ${JSON.stringify(f.machine)}\nschedule = "always"\nmemory_limit_mb = 2048\nport = 8798\n`,
      );
      expect(() => loadRegistry(broken)).toThrow(/transcriber/);
      // And the file that names none renders no transcriber at all.
      expect(listRunEntries(loadRegistry(f.registryFile)).some((one) => one.kind === "transcriber")).toBe(
        false,
      );
    } finally {
      await f.stop();
    }
  },
  SLOW,
);
