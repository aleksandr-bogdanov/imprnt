// One household names ONE recognizer, and the transcriber is an ordinary entry.
//
// SPEC §6 and L14: "All settings live in one file, the registry... Anything not
// in that file is not a setting. It does not exist." SPEC §6's Forbidden
// carries "a setting nothing in production reads" and "a quiet default on a bad
// value", which is why every `voice.*` key is read only when a recognizer is
// named and why every bad shape below is refused by name and by line. L4 adds
// "a long-running piece with no measured peak is forbidden", which reaches the
// transcriber through the shipped `memory_limit_mb` refusal and not a new one.
//
// THE RECOGNIZER IS ONE PER HOUSEHOLD. There is no per-person field and no
// consent line, so `voiceFor` takes no person at all and a `[[people]]` entry
// that named one would be a key nothing reads. Both halves are asserted below.
//
// Pure. No Postgres and no operating system, because the registry is a file and
// the loader is a file loader. Nothing here starts a door, a runner or a
// cluster of agents, so none of the six protected windows is reachable from it.
//
// EVERY REFUSAL CARRIES A CONTROL. A loader that refused every voice-shaped
// file would pass all eleven refusals and fail the controls at the end.
//
// No path below is a real path and no id is a real id.
//
// Red reason: behaviour absent. `loadRegistry` parses no `[voice]` table and
// refuses `kind = "transcriber"` outright as an unsupported run kind, and
// `voiceFor`, `transcriberFor` and `transcribedSecondsFor` do not exist.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";

let dir: string;

function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-voice-"));
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

function insertAfter(lines: string[], text: string, added: string, nth = 1): string[] {
  const out = [...lines];
  out.splice(lineOf(lines, text, nth), 0, added);
  return out;
}

function refusalOf(file: string): RegistryRefused {
  try {
    loadRegistry(file);
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

const MODEL = "a-model-directory-name";
const RUNTIME = "/var/lib/imprnt-hub/voice";

/** The example block of the contract, in a file that carries what it needs. */
function goodLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[voice]",
    'recognizer = "local"',
    "retry_seconds = 300",
    "give_up_hours = 24",
    "chunk_deadline_seconds = 120",
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[machines]]",
    'id = "mac"',
    'os = "macos"',
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    "transcribed_seconds = 90",
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
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
    "",
    "[recognizers.local]",
    'provider = "sherpa-onnx"',
    `model = "${MODEL}"`,
    `runtime = "${RUNTIME}"`,
    "chunk_seconds = 60",
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "1000000001"',
    'door = "door-pi"',
    'runner = "runner-pi"',
    "",
    "[[run]]",
    'id = "door-pi"',
    'kind = "door"',
    'machine = "pi"',
    'platform = "telegram"',
    'person = "p1"',
    'token_file = "/etc/imprnt-hub/telegram.token"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "[[run]]",
    'id = "runner-pi"',
    'kind = "runner"',
    'machine = "pi"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
    "",
    "[[run]]",
    'id = "transcriber"',
    'kind = "transcriber"',
    'machine = "pi"',
    'schedule = "always"',
    "memory_limit_mb = 2048",
    "port = 8798",
    'residency = "resident"',
  ];
}

/**
 * The same household on a cloud recognizer: a credential of the fourth kind, no
 * runtime directory, and no transcriber entry anywhere, because nothing of ours
 * runs and an entry nothing reads is refused.
 */
function cloudLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[voice]",
    'recognizer = "cloud"',
    "retry_seconds = 300",
    "give_up_hours = 24",
    "chunk_deadline_seconds = 120",
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[machines]]",
    'id = "mac"',
    'os = "macos"',
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    "",
    "[[credentials]]",
    'id = "cloud-key"',
    'kind = "api-key"',
    'file = "/etc/imprnt-hub/recognizer.key"',
    'owner = "household"',
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
    "",
    "[recognizers.cloud]",
    'provider = "deepgram"',
    `model = "${MODEL}"`,
    'credential = "cloud-key"',
    "chunk_seconds = 60",
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "1000000001"',
    'door = "door-pi"',
    'runner = "runner-pi"',
    "",
    "[[run]]",
    'id = "door-pi"',
    'kind = "door"',
    'machine = "pi"',
    'platform = "telegram"',
    'person = "p1"',
    'token_file = "/etc/imprnt-hub/telegram.token"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "[[run]]",
    'id = "runner-pi"',
    'kind = "runner"',
    'machine = "pi"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
  ];
}

test(
  "RUN-15 RUN-13 the household names one recognizer and one transcriber, and every bad shape refuses the file by name and by line (SPEC §6, L4, L14)",
  async () => {
    // -------------------------------------------------------------------
    // The recognizer tables themselves.
    // -------------------------------------------------------------------
    // 1. a provider outside the two this hub knows.
    {
      const lines = replace(goodLines(), 'provider = "sherpa-onnx"', 'provider = "whisper-cpp"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("recognizers.local.provider");
      expect(refusal.line).toBe(lineOf(lines, 'provider = "whisper-cpp"'));
      expect(refusal.reason).toContain("whisper-cpp");
      expect(refusal.reason).toContain("sherpa-onnx");
      expect(refusal.reason).toContain("deepgram");
    }

    // 2. a cloud recognizer carrying a runtime directory. There is no process
    //    of ours on this household, so there is nothing for it to name.
    {
      const lines = insertAfter(cloudLines(), `model = "${MODEL}"`, `runtime = "${RUNTIME}"`);
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("recognizers.cloud.runtime");
      expect(refusal.line).toBe(lineOf(lines, `runtime = "${RUNTIME}"`));
      expect(refusal.reason).toContain("runtime");
    }

    // 3. a local recognizer carrying a credential. Nothing is dialled, so there
    //    is no key to read.
    {
      const lines = insertAfter(goodLines(), `model = "${MODEL}"`, 'credential = "cloud-key"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("recognizers.local.credential");
      expect(refusal.line).toBe(lineOf(lines, 'credential = "cloud-key"'));
      expect(refusal.reason).toContain("credential");
    }

    // 4. the household names a recognizer this file does not define.
    {
      const lines = replace(goodLines(), 'recognizer = "local"', 'recognizer = "nowhere"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("voice.recognizer");
      expect(refusal.line).toBe(lineOf(lines, 'recognizer = "nowhere"'));
      expect(refusal.reason).toContain("nowhere");
    }

    // -------------------------------------------------------------------
    // The transcriber entry.
    // -------------------------------------------------------------------
    // 5. a local recognizer and a door on a machine with no transcriber entry.
    //    A piece that could never be reached cannot be configured, which is the
    //    sentence `child_memory_limit_mb` already carries.
    {
      const whole = goodLines();
      const lines = whole.slice(0, lineOf(whole, 'id = "transcriber"') - 2);
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[0].machine");
      expect(refusal.line).toBe(lineOf(lines, 'machine = "pi"', 1));
      expect(refusal.reason).toContain("door-pi");
      expect(refusal.reason).toContain("pi");
    }

    // 6. a transcriber entry while the household's recognizer is a cloud one.
    {
      const lines = [
        ...cloudLines(),
        "",
        "[[run]]",
        'id = "transcriber"',
        'kind = "transcriber"',
        'machine = "pi"',
        'schedule = "always"',
        "memory_limit_mb = 2048",
        "port = 8798",
      ];
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].kind");
      expect(refusal.line).toBe(lineOf(lines, 'kind = "transcriber"'));
      expect(refusal.reason).toContain("transcriber");
    }

    // 7. a transcriber entry while the file carries no [voice] table at all.
    //    That is "a setting nothing in production reads", read as a process
    //    nothing in production reaches.
    {
      const whole = goodLines();
      const lines = whole
        .filter(
          (line) =>
            ![
              "[voice]",
              'recognizer = "local"',
              "retry_seconds = 300",
              "give_up_hours = 24",
              "chunk_deadline_seconds = 120",
              "[recognizers.local]",
              'provider = "sherpa-onnx"',
              `model = "${MODEL}"`,
              `runtime = "${RUNTIME}"`,
              "chunk_seconds = 60",
            ].includes(line),
        );
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].kind");
      expect(refusal.line).toBe(lineOf(lines, 'kind = "transcriber"'));
      expect(refusal.reason).toContain("transcriber");
    }

    // 8. a resident transcriber carrying an idle window nothing would read.
    {
      const lines = insertAfter(goodLines(), 'residency = "resident"', "idle_seconds = 5");
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].idle_seconds");
      expect(refusal.line).toBe(lineOf(lines, "idle_seconds = 5"));
      expect(refusal.reason).toContain("idle_seconds");
    }

    // 8's control: idle-unload with no idle_seconds LOADS, and the default is
    // the one the contract names.
    {
      const lines = replace(goodLines(), 'residency = "resident"', 'residency = "idle-unload"');
      expect(loadRegistry(write(lines))).toBeDefined();
    }

    // 9. a residency outside the two.
    {
      const lines = replace(goodLines(), 'residency = "resident"', 'residency = "sometimes"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].residency");
      expect(refusal.line).toBe(lineOf(lines, 'residency = "sometimes"'));
      expect(refusal.reason).toContain("resident");
      expect(refusal.reason).toContain("idle-unload");
    }

    // The port, one assertion per value, never as a group: the door posts to
    // 127.0.0.1:<port>, so an entry without one could never be reached.
    {
      const lines = drop(goodLines(), "port = 8798");
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].port");
      expect(refusal.line).toBe(lineOf(lines, 'id = "transcriber"'));
      expect(refusal.reason).toContain("port");
    }
    for (const bad of ["port = 0", "port = -1", "port = 1.5", 'port = "8798"']) {
      const lines = replace(goodLines(), "port = 8798", bad);
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].port");
      expect(refusal.line).toBe(lineOf(lines, bad));
      expect(refusal.reason).toContain("port");
    }

    // -------------------------------------------------------------------
    // Settings under [voice] are read only when a recognizer is named, so a
    // table without one carries settings nothing in production reaches.
    // -------------------------------------------------------------------
    {
      const lines = drop(goodLines(), 'recognizer = "local"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("voice.recognizer");
      expect(refusal.line).toBe(lineOf(lines, "[voice]"));
      expect(refusal.reason).toContain("recognizer");
    }

    // -------------------------------------------------------------------
    // (h) the transcriber is an ORDINARY entry, so L4's measured peak reaches
    //     it through the shipped refusal and not a new one.
    // -------------------------------------------------------------------
    {
      const lines = drop(goodLines(), "memory_limit_mb = 2048");
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toBe("run[2].memory_limit_mb");
      expect(refusal.line).toBe(lineOf(lines, 'id = "transcriber"'));
      expect(refusal.reason).toContain("memory_limit_mb");
    }

    // -------------------------------------------------------------------
    // The controls, without which this is a check on a loader that refuses
    // everything.
    // -------------------------------------------------------------------
    const {
      voiceFor,
      transcriberFor,
      transcribedSecondsFor,
      thresholdsFor,
      listPeople,
      listCredentials,
    } = await seam("src/registry/entries.ts");
    expect(typeof voiceFor).toBe("function");
    expect(typeof transcriberFor).toBe("function");
    expect(typeof transcribedSecondsFor).toBe("function");
    const {
      RECOGNIZER_PROVIDERS,
      RESIDENCY_KINDS,
      CREDENTIAL_KINDS,
      VOICE_DEFAULTS,
      TRANSCRIBED_DEFAULT_SECONDS,
      STAMP_THRESHOLD_DEFAULTS,
    } = await seam("src/registry/load.ts");

    // (a) the whole shape loads and reads back, as one object.
    const base = goodLines();
    const good = loadRegistry(write(base));
    expect((voiceFor as Function)(good)).toEqual({
      recognizer: "local",
      provider: "sherpa-onnx",
      model: MODEL,
      runtime: RUNTIME,
      credential: null,
      chunk_seconds: 60,
      retry_seconds: 300,
      give_up_hours: 24,
      chunk_deadline_seconds: 120,
    });
    const onPi = (transcriberFor as Function)(good, "pi");
    expect(onPi.id).toBe("transcriber");
    expect(onPi.port).toBe(8798);
    expect(onPi.residency).toBe("resident");
    expect(onPi.memory_limit_mb).toBe(2048);
    // A machine with no transcriber entry has none.
    expect((transcriberFor as Function)(good, "mac")).toBeNull();

    // (b) a cloud recognizer loads with no transcriber entry anywhere, and the
    //     fourth credential kind is declarable and reads back whole.
    {
      const cloud = loadRegistry(write(cloudLines()));
      expect((voiceFor as Function)(cloud)).toEqual({
        recognizer: "cloud",
        provider: "deepgram",
        model: MODEL,
        runtime: null,
        credential: "cloud-key",
        // Nothing on that table says otherwise, so the default stands.
        chunk_seconds: 60,
        retry_seconds: 300,
        give_up_hours: 24,
        chunk_deadline_seconds: 120,
      });
      expect((transcriberFor as Function)(cloud, "pi")).toBeNull();
      expect((transcriberFor as Function)(cloud, "mac")).toBeNull();
      expect((listCredentials as Function)(cloud)).toEqual([
        {
          id: "cloud-key",
          kind: "api-key",
          file: "/etc/imprnt-hub/recognizer.key",
          owner: "household",
        },
      ]);
      expect([...(CREDENTIAL_KINDS as readonly string[])]).toEqual([
        "claude-login",
        "telegram",
        "discord",
        "api-key",
      ]);
    }

    // (c) the absence tolerance, which is what keeps every shipped check green.
    {
      const silent = loadRegistry(
        write([
          "[hub]",
          "tick_seconds = 5",
          "",
          "[[people]]",
          'id = "p1"',
          'tree = "/var/lib/imprnt-hub/p1"',
          "",
          "[[people]]",
          'id = "p2"',
          'tree = "/var/lib/imprnt-hub/p2"',
        ]),
      );
      expect((voiceFor as Function)(silent)).toBeNull();
      for (const machine of ["pi", "mac", "anything"]) {
        expect((transcriberFor as Function)(silent, machine)).toBeNull();
      }
      // The clause that matters: a people-less-of-voice file's rows gain no
      // keys, which a shipped check compares whole.
      expect((listPeople as Function)(silent)).toEqual([
        { id: "p1", tree: "/var/lib/imprnt-hub/p1" },
        { id: "p2", tree: "/var/lib/imprnt-hub/p2" },
      ]);
    }

    // (d) residency absent is resident, and the two constants are whole.
    {
      const lines = drop(goodLines(), 'residency = "resident"');
      const defaulted = loadRegistry(write(lines));
      expect((transcriberFor as Function)(defaulted, "pi").residency).toBe("resident");
      expect([...(RESIDENCY_KINDS as readonly string[])]).toEqual(["resident", "idle-unload"]);
      expect([...(RECOGNIZER_PROVIDERS as readonly string[])]).toEqual([
        "sherpa-onnx",
        "deepgram",
      ]);
      expect(VOICE_DEFAULTS).toEqual({
        retry_seconds: 300,
        give_up_hours: 24,
        chunk_deadline_seconds: 120,
        chunk_seconds: 60,
        idle_seconds: 600,
        residency: "resident",
      });
    }

    // (e) chunk_seconds = 0 LOADS on both providers: zero is the big-machine
    //     switch, and not a bad value. Everything below it is refused.
    {
      const local = replace(goodLines(), "chunk_seconds = 60", "chunk_seconds = 0");
      expect((voiceFor as Function)(loadRegistry(write(local))).chunk_seconds).toBe(0);
      const cloud = replace(cloudLines(), "chunk_seconds = 60", "chunk_seconds = 0");
      expect((voiceFor as Function)(loadRegistry(write(cloud))).chunk_seconds).toBe(0);
      for (const bad of ["chunk_seconds = -1", "chunk_seconds = 1.5"]) {
        const lines = replace(goodLines(), "chunk_seconds = 60", bad);
        const refusal = refusalOf(write(lines));
        expect(refusal.key).toBe("recognizers.local.chunk_seconds");
        expect(refusal.line).toBe(lineOf(lines, bad));
        expect(refusal.reason).toContain("chunk_seconds");
      }
    }

    // (f) ONE RECOGNIZER PER HOUSEHOLD, written as a shape. `voiceFor` takes no
    //     person, and a [[people]] entry that named one would be a key nothing
    //     reads: the loader tolerates it, as it always has, and no accessor
    //     hands it back.
    {
      expect((voiceFor as Function).length).toBe(1);
      const lines = insertAfter(goodLines(), "transcribed_seconds = 90", 'recognizer = "local"');
      const tolerant = loadRegistry(write(lines));
      const [first] = (listPeople as Function)(tolerant);
      expect(Object.keys(first).sort()).toEqual(["id", "transcribed_seconds", "tree"]);
      expect(first.recognizer).toBeUndefined();
    }

    // (g) the sixth person field, and the four clocks left exactly as they are.
    {
      expect(TRANSCRIBED_DEFAULT_SECONDS).toBe(120);
      expect((transcribedSecondsFor as Function)(good, "p1")).toBe(90);
      expect((transcribedSecondsFor as Function)(good, "p2")).toBe(120);
      expect((transcribedSecondsFor as Function)(good, "nobody")).toBe(120);
      const two = replace(goodLines(), "transcribed_seconds = 90", "transcribed_seconds = 45");
      const other = loadRegistry(write(insertAfter(two, 'tree = "/var/lib/imprnt-hub/p2"', "transcribed_seconds = 61")));
      expect((transcribedSecondsFor as Function)(other, "p1")).toBe(45);
      expect((transcribedSecondsFor as Function)(other, "p2")).toBe(61);

      for (const bad of [
        "transcribed_seconds = 0",
        "transcribed_seconds = -1",
        "transcribed_seconds = 1.5",
        'transcribed_seconds = "soon"',
      ]) {
        const lines = replace(goodLines(), "transcribed_seconds = 90", bad);
        const refusal = refusalOf(write(lines));
        expect(refusal.key).toBe("people[0].transcribed_seconds");
        expect(refusal.line).toBe(lineOf(lines, bad));
        expect(refusal.reason).toContain("transcribed_seconds");
      }

      // The fifth clock is its own accessor, and the four are untouched.
      expect((thresholdsFor as Function)(good, "p1")).toEqual({
        acked_seconds: 30,
        started_seconds: 60,
        answered_seconds: 900,
        delivered_seconds: 60,
      });
      expect(STAMP_THRESHOLD_DEFAULTS).toEqual({
        acked_seconds: 30,
        started_seconds: 60,
        answered_seconds: 900,
        delivered_seconds: 60,
      });
    }

    // The control on the controls: the whole file, every field set, loads with
    // no refusal at all and every value read back is what the file said. A
    // build that refused every voice-shaped file passes all eleven refusals and
    // fails here.
    {
      const whole = loadRegistry(write(goodLines()));
      expect((voiceFor as Function)(whole).recognizer).toBe("local");
      expect((transcriberFor as Function)(whole, "pi").schedule).toBe("always");
      expect((transcribedSecondsFor as Function)(whole, "p1")).toBe(90);
      expect(whole.run.map((entry: { id: string }) => entry.id)).toEqual([
        "door-pi",
        "runner-pi",
        "transcriber",
      ]);
    }
  },
);
