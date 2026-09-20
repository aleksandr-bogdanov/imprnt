// LIVE. A real model decodes real speech through the real door, in both
// languages.
//
// This is the ONE place a real recognizer appears. It lives in `live/` for the
// reason every other live check does: it needs something no automated run has.
// Here that is the runtime with its virtual environment, the weights, and two
// real clips of somebody speaking, none of which is in the repository.
// `bunfig.toml` puts the test root at `test`, so `bun test` never reaches this,
// and `bun run test:live` is what runs it.
//
// WHAT IT NEEDS, AND IT REFUSES RATHER THAN PASSING WITHOUT IT:
//   IMPRNT_VOICE_RUNTIME  the household's runtime directory, holding a
//                         venv/bin/python with the recognizer installed in it
//                         and the weights in a directory beside it
//   IMPRNT_VOICE_MODEL    the model directory's name under that runtime
//   IMPRNT_VOICE_CLIP_EN  a few seconds of English speech, any ffmpeg-readable file
//   IMPRNT_VOICE_CLIP_RU  the same in Russian, one of the two longer than the
//                         chunk length below so a real cut is really made
// A check that quietly passed when its inputs were absent would be proving
// nothing at all, which is the difference between opt-in and decorative.
//
// TWO THINGS ARE DELIBERATELY NOT ASSERTED, said here so nobody adds them:
//   - WHAT THE TRANSCRIPT SAYS. The model's Russian quality is unquantified and
//     a check that bound the words would fail for an accent.
//   - HOW LONG THE DECODE TOOK, as a bound. That is the box's, not the build's.
// Both are PRINTED instead, because the numbers are what the first real week is
// supposed to produce.
//
// Bounded at 420 s, the bound every shipped live check carries, and sized
// against the measurements behind this phase: a cold model load of about 15 s
// on the small box and 1.4 s on this Mac, and roughly a tenth of realtime per
// chunk after that.
//
// Red reason: the runtime is absent, so there is no venv to start the real
// server from and no weights for it to load. It refuses on the first line.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, hubPath, until, type Cluster } from "../test/helpers/cluster.ts";
import { rolloutStage } from "../test/helpers/rollout-stage.ts";
import { superStore } from "../test/helpers/hub-fixture.ts";
import { observe } from "../test/helpers/rollout-runner.ts";
import { message } from "../test/helpers/rollout-ingress.ts";
import { chatLogLines } from "../test/helpers/hub-fixture.ts";
import { runDoor } from "../src/door/run.ts";
import { runRunner } from "../src/runner/run.ts";
import { runHub } from "../src/hub/run.ts";
import { serviceOs } from "../test/helpers/rollout-service.ts";

const SLOW = 420_000;
/** Short, so one of the two clips really is cut in two and a gap is visible. */
const CHUNK_SECONDS = 5;
/** What `--fake` answers. A transcript equal to this means the run used the stub. */
const FAKE_TEXT = "the quick brown fox jumps over the lazy dog";

let cluster: Cluster;

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") {
    throw new Error(
      `${name} is not set: this check needs a real runtime, a real model and two real clips, ` +
        "and it refuses to run rather than passing without them",
    );
  }
  return value;
}

function file(name: string): string {
  const path = required(name);
  if (!existsSync(path)) throw new Error(`${name} names ${path}, and there is no such file`);
  return path;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

for (const language of ["en", "ru"] as const) {
  test(
    `RUN-15 a real ${language} voice note is decoded by the real recognizer, answered by the agent, and leaves its own provenance beside the audio`,
    async () => {
      const runtime = required("IMPRNT_VOICE_RUNTIME");
      const model = required("IMPRNT_VOICE_MODEL");
      const python = join(runtime, "venv", "bin", "python");
      if (!existsSync(python)) {
        throw new Error(
          `${python} is not there: the runtime needs a virtual environment at venv/ with ` +
            "the recognizer installed in it",
        );
      }
      if (!existsSync(join(runtime, model))) {
        throw new Error(`${join(runtime, model)} is not there: the weights are not in the runtime`);
      }
      const clip = file(language === "en" ? "IMPRNT_VOICE_CLIP_EN" : "IMPRNT_VOICE_CLIP_RU");
      const audio = new Uint8Array(readFileSync(clip));

      // The real server, on a port nothing else has, started the way the unit
      // starts it: every knob an argument and nothing read from the environment.
      const port = 18000 + Math.floor(Math.random() * 2000);
      const server = Bun.spawn(
        [
          python,
          hubPath("tools/transcribe-server.py"),
          "--port",
          String(port),
          "--runtime",
          runtime,
          "--model",
          model,
          "--warm",
          "--idle-s",
          "0",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const it = await rolloutStage(cluster, "telegram", {
        voice: { port, chunk_seconds: CHUNK_SECONDS, model },
        people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
      });
      // The runtime the stage wrote is its own scratch dir, and this check needs
      // the real one.
      writeFileSync(
        it.registryFile,
        readFileSync(it.registryFile, "utf8").replace(
          new RegExp(`^runtime = .*$`, "m"),
          `runtime = ${JSON.stringify(runtime)}`,
        ),
      );

      let door: Awaited<ReturnType<typeof runDoor>> | undefined;
      let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
      let hub: Awaited<ReturnType<typeof runHub>> | undefined;
      const store = await superStore(cluster, it.db);
      try {
        await until(
          "the real recognizer answered its health path",
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
            } catch {
              return false;
            }
          },
          120_000,
          () => `the server is ${server.killed ? "gone" : "still starting"}`,
        );

        it.edge.file("voice", audio);
        door = await runDoor({
          door: "door-fake",
          registryFile: it.registryFile,
          platform: it.edge.platform,
        });
        runner = await runRunner({
          runner: "runner-pi",
          registryFile: it.registryFile,
          adapters: { [it.adapterName]: it.scripted.adapter },
        });

        const began = Date.now();
        it.edge.batch(
          [
            {
              ...message("1", ""),
              media: [
                {
                  kind: "voice" as const,
                  remote_id: "voice",
                  name: `note.${language}`,
                  mime: "audio/ogg",
                  bytes: audio.length,
                  caption: null,
                },
              ],
            },
          ],
          "1",
        );

        // 1. The note lands, is transcribed by the real recognizer, and is
        //    answered like any other message.
        expect(
          await observe(async () => (await it.read.inbound()).length === 1, 60_000),
        ).toBe(true);
        const id = (await it.read.inbound())[0].id;
        expect(
          await observe(
            async () => (await it.read.inbound())[0].media_state === "done",
            360_000,
          ),
          "RUN-15 the real model answered inside the bound",
        ).toBe(true);
        const elapsedMs = Date.now() - began;
        const row = (await it.read.inbound())[0];
        const path = row.body.match(/\(voice ([^)]+)\)/)![1];
        const transcript = row.body.split("\n").slice(1).join("\n").trim();

        // 2. Words came back, and they are not the stub's sentence, which is
        //    what catches a run that reached `--fake` by accident.
        expect(transcript.length, "RUN-15 the real model returned words").toBeGreaterThan(0);
        expect(transcript).not.toBe(FAKE_TEXT);

        const stamps = ["received", "acked", "started", "answered", "delivered"];
        expect(
          await observe(
            async () => (await it.read.ledger({ subject: id })).some((e) => e.kind === "delivered"),
            120_000,
          ),
        ).toBe(true);
        expect(
          (await it.read.ledger({ subject: id }))
            .filter((e) => stamps.includes(e.kind))
            .map((e) => e.kind),
          "RUN-15 all five stamps, in order",
        ).toEqual(stamps);
        const lines = chatLogLines(it.stateDir, "p1", "p1-lair").filter(
          (one) => one.direction === "in" && one.text.startsWith("(voice "),
        );
        expect(lines, "RUN-15 one log line for the one note").toHaveLength(1);

        // 5. The provenance is the server's own numbers, beside the audio.
        const [source] = (await it.read.sql("select source from inbound where id = $1", [id])) as {
          source: { media: Record<string, unknown>[] };
        }[];
        const media = source.source.media[0];
        expect(media.recognizer).toBe("local");
        expect(Number(media.audio_s)).toBeGreaterThan(0);
        expect(Number(media.decode_ms)).toBeGreaterThan(0);
        expect(Number(media.chunks)).toBeGreaterThan(0);
        expect(existsSync(String(media.transcript_path))).toBe(true);
        expect(String(media.transcript_path).startsWith(path.slice(0, path.lastIndexOf("/")))).toBe(
          true,
        );

        // 4. A clip longer than the chunk length really is cut, and the pieces
        //    cover it end to end with no hole.
        const chunkFile = JSON.parse(readFileSync(String(media.transcript_path), "utf8")) as {
          recognizer: string;
          chunk_seconds: number;
          chunks: { n: number; from_s: number; to_s: number; state: string }[];
        };
        expect(chunkFile.chunk_seconds).toBe(CHUNK_SECONDS);
        const pieces = [...chunkFile.chunks].sort((a, b) => a.n - b.n);
        expect(pieces.length).toBe(Number(media.chunks));
        for (const piece of pieces) expect(["done", "empty"]).toContain(piece.state);
        let reached = 0;
        for (const piece of pieces) {
          expect(Math.abs(piece.from_s - reached)).toBeLessThan(0.05);
          reached = piece.to_s;
        }
        expect(Math.abs(reached - Number(media.audio_s))).toBeLessThan(0.5);
        if (Number(media.audio_s) > CHUNK_SECONDS) {
          expect(pieces.length, "RUN-15 a clip past the chunk length is really cut").toBeGreaterThan(1);
        }

        // 7. Success is a real note. No ping, no job stamp, one sheet row.
        const health = (await it.read.sql(
          "select data from state_row where sheet = 'voice_health' and id = 'local'",
        )) as { data: Record<string, unknown> }[];
        expect(health.length).toBe(1);
        expect(health[0].data.last_ok_at).not.toBeNull();
        expect(health[0].data.since).toBeNull();

        // 6. And the real process has a measured peak on record, written by the
        //    hub on its own tick rather than planted by this check.
        const os = serviceOs(it.stateDir, process.platform === "darwin" ? "launchd" : "systemd", [
          "door-fake",
          "runner-pi",
          "transcriber",
        ]);
        hub = await runHub({ registryFile: it.registryFile, machine: "pi", os: os.os });
        const peak = await observe(async () => {
          const rows = (await it.read.sql(
            "select data from state_row where sheet = 'memory_peak' and id = 'transcriber'",
          )) as { data: Record<string, unknown> }[];
          return rows.length === 1 && Number(rows[0].data.bytes) > 1024 * 1024;
        }, 60_000);
        expect(peak, "L4 a long-running piece has a measured peak on record").toBe(true);
        const measured = (await it.read.sql(
          "select data from state_row where sheet = 'memory_peak' and id = 'transcriber'",
        )) as { data: Record<string, unknown> }[];

        // 3. The numbers the first real week is supposed to produce.
        process.stderr.write(
          `live decode [${language}] audio ${Number(media.audio_s).toFixed(2)} s, ` +
            `chunks ${pieces.length}, decode ${Number(media.decode_ms)} ms, ` +
            `door to done ${elapsedMs} ms, ` +
            `peak ${(Number(measured[0].data.bytes) / (1024 * 1024)).toFixed(0)} MB, ` +
            `clip ${statSync(clip).size} bytes\n`,
        );
      } finally {
        await hub?.stop();
        await runner?.stop();
        await door?.stop();
        await store.close().catch(() => {});
        server.kill();
        await server.exited;
        // The stage's own scratch dir goes with it. The runtime and the clips
        // are the household's and are never touched.
        await it.stop();
      }
    },
    SLOW,
  );
}
