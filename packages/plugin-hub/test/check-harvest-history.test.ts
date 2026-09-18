// D-171, D-181, D-160. Imported history that the registry excludes from harvest
// is not work a harvest is late on.
//
// 6a imports old chat logs for both people and harvests only the second
// person's. The owner's are excluded by `history_harvest_after`, and every
// harvest path honours it: the door's quiet and backstop triggers, the runner's
// slice and the one-off catch-up all start from `historyHarvestFrom`. `check`
// measured from the bare watermark instead, so after a cutover the owner's
// imported lines read as unharvested and `harvest-stale` stayed red for up to
// the thirty days a first slice reaches back, for something working as the
// procedure intends.
//
// The control pair: the same ancient lines for a person with NO bound are still
// a finding, and a real line after the bound that has outlived the allowance is
// still a finding that counts that one line and not the excluded ones.
//
// Red reason: behaviour absent. `readHarvestState` reads the slice from the
// watermark alone, so the owner's excluded history is reported as stale.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  chatLogFile,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

const RUNNER_PI = "runner-pi";
const DAY = 86_400;

function plant(it: StagedHub, args: { person: string; agent: string; at: Date; text: string }): void {
  const file = chatLogFile({ stateDir: it.stateDir, person: args.person, agent: args.agent, at: args.at });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify({ at: args.at.toISOString(), direction: "in", from: args.person, text: args.text }) + "\n",
    "utf8",
  );
}

test(
  "D-181 harvest-stale does not count imported history before a person's history_harvest_after bound, and a line after the bound past the allowance is still reported as exactly that one line (D-160, D-171)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const now = new Date();
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    // The freeze bound three days back. The allowance for both people is 30
    // minutes plus the daily backstop, so a line two days old is past it.
    const bound = ago(3 * DAY);

    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [
        {
          id: PERSON,
          language: "en",
          harvester: "daily",
          vault: "/var/lib/imprnt-hub/p1/vault-project",
          harvest_quiet_minutes: 30,
          history_harvest_after: bound.toISOString(),
        },
        {
          id: PERSON2,
          language: "en",
          harvester: "daily",
          vault: "/var/lib/imprnt-hub/p2/vault-project",
          harvest_quiet_minutes: 30,
        },
      ],
      agents: [{ id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER_PI }],
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) => (agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent)),
      }),
    });
    const store = await superStore(cluster, it.db);
    try {
      const stale = async (): Promise<Finding[]> =>
        ((await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: fakeProber({}),
          now,
        })) as Finding[]).filter((one) => one.kind === "harvest-stale");

      // The imported history: three lines each, all before the bound, and no
      // watermark for either chat, which is the state right after a cutover.
      for (const back of [6 * DAY, 5 * DAY, 4 * DAY]) {
        plant(it, { person: PERSON, agent: AGENT, at: ago(back), text: "imported and excluded" });
        plant(it, { person: PERSON2, agent: AGENT2, at: ago(back), text: "imported and not excluded" });
      }

      const first = await stale();
      // THE CONTROL. The same history for a person with no bound is waiting to
      // be harvested, so a build that silenced every chat fails here.
      const p2 = first.find((one) => one.subject === `${PERSON2}/${AGENT2}`);
      expect(p2, "a person with no history bound still has a stale chat").toBeDefined();
      expect(p2!.says).toContain("3 line(s)");
      // THE FIX. The owner's excluded history is not a harvest that is late.
      expect(
        first.map((one) => one.subject),
        "the owner's excluded imported history is not reported as unharvested",
      ).not.toContain(`${PERSON}/${AGENT}`);

      // A REAL line after the bound, past the allowance, is still reported,
      // and it is reported as the one line a harvest would take.
      const real = ago(2 * DAY);
      plant(it, { person: PERSON, agent: AGENT, at: real, text: "said after the cutover" });
      const second = await stale();
      const p1 = second.find((one) => one.subject === `${PERSON}/${AGENT}`);
      expect(p1, "a line after the bound past the allowance is still a finding").toBeDefined();
      expect(p1!.id).toBe(`pi/harvest-stale:${PERSON}/${AGENT}`);
      expect(p1!.says).toContain("1 line(s)");
      expect(p1!.says).toContain(real.toISOString());
    } finally {
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  90_000,
);
