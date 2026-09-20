// A recovery command is addressed to the machinery, so it is
// never in a harvest slice.
//
// The door logs `/recover <agent>` and `/восстановить <agent>` under the
// person's registry id (a person's line names the person), which is exactly
// what the slice keeps. Fed back to the harvester, the command reads as
// something the household said. The slice drops it by the SAME rule the door
// uses to recognise one, so a line the door treated as a command is never
// harvested and a line the door passed to the agent always is.
//
// The control in both checks is an ordinary line the person typed, which must
// still be in the slice.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { chatLogFile, chatLogLines } from "./helpers/hub-fixture.ts";
import { chat, message } from "./helpers/rollout-ingress.ts";
import { rolloutStage } from "./helpers/rollout-stage.ts";
import { runDoor } from "../src/door/run.ts";
import { readSlice } from "../src/harvest/slice.ts";

const PERSON = "p1";
const AGENT = "p1-lair";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

test("a recovery command the door logged is not in the harvest slice, and an ordinary line the person typed still is", async () => {
  const it = await rolloutStage(cluster, "telegram");
  let door: Awaited<ReturnType<typeof runDoor>> | undefined;
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform });
    it.edge.batch([
      message("1", "synthetic person codeword"),
      message("2", `/recover ${AGENT}`),
      message("3", `/восстановить ${AGENT}`),
    ], "4");
    await until("the door logged the ordinary line and both recovery commands", () => {
      const logged = new Set((chatLogLines(it.stateDir, PERSON, AGENT) as { id?: string }[]).map((line) => line.id));
      return logged.has(`telegram:${chat}:1`) && logged.has(`recover:telegram:${chat}:2`) && logged.has(`recover:telegram:${chat}:3`);
    }, 30_000, () => JSON.stringify(chatLogLines(it.stateDir, PERSON, AGENT)));
    // Both commands are in the log as the person's own lines, which is the
    // precondition: the slice would keep them on the speaker rule alone.
    const logged = chatLogLines(it.stateDir, PERSON, AGENT);
    for (const text of [`/recover ${AGENT}`, `/восстановить ${AGENT}`]) {
      expect(logged.find((line) => line.text === text)?.from).toBe(PERSON);
    }

    const slice = await readSlice({ stateDir: it.stateDir, person: PERSON, agent: AGENT, from: null, until: new Date().toISOString() });
    const texts = slice.map((line) => line.text);
    expect(texts, "a recovery command is not something the person said").not.toContain(`/recover ${AGENT}`);
    expect(texts, "nor is its Russian twin").not.toContain(`/восстановить ${AGENT}`);
    expect(texts, "control: the ordinary line is still in the slice").toContain("synthetic person codeword");
  } finally {
    await door?.stop();
    await it.stop();
  }
}, 90_000);

test("the slice drops exactly the lines the door treats as recovery commands and keeps the ones it passes to the agent", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hub-slice-recover-"));
  try {
    const plant = (at: string, text: string) => {
      const file = chatLogFile({ stateDir, person: PERSON, agent: AGENT, at: new Date(at) });
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ at, direction: "in", from: PERSON, text }) + "\n", "utf8");
    };
    // Commands, by the door's rule: the verb at the very start, any case,
    // followed by whitespace or by nothing.
    const commands = [`/recover ${AGENT}`, `/RECOVER ${AGENT}`, "/recover", `/восстановить ${AGENT}`];
    // Messages, by the same rule: the door hands every one of these to the agent.
    const messages = ["the wifi password is on the router", "please /recover it later", "/recovered the file myself"];
    [...commands, ...messages].forEach((text, nth) =>
      plant(`2026-09-16T09:0${nth}:00.000Z`, text));

    const slice = await readSlice({ stateDir, person: PERSON, agent: AGENT, from: null, until: "2026-09-16T12:00:00.000Z" });
    expect(slice.map((line) => line.text)).toEqual(messages);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
