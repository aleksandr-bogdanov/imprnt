// The result crossing, its cause turned off, and the store's refusal to run
// without that.
//
// An outage claim was seen reading back a row that was not
// its own, and the store went from one connection to eight on that finding with
// no reproducer. It came back at four
// connections as a diary append that came back with no `seq`. The investigation
// that followed reproduced it on demand, and this file holds the fix.
//
// THE MECHANISM, read from Bun 1.3.14's Postgres client and then measured here.
// The client keeps one queue per connection and hands every answer to the
// oldest statement in that queue. A statement the connection has never prepared
// stays queued until nothing else is in flight. A statement the connection has
// already prepared is written at once, whatever is queued ahead of it. So on a
// busy connection the prepared statement overtakes the new one, the server
// answers in the order the statements were written, and the new statement is
// handed the other one's answer while the other one is never answered at all.
// The new statement itself is then dropped without ever reaching the server, so
// its caller believes a write that never happened, and the write that did
// happen has nobody waiting for it. A wider pool does not prevent it: the pool
// only doubles up on a busy connection once every connection is busy, so four
// and eight connections crossed the same way at a higher load.
//
// THE FIX. That overtaking is the client's automatic pipelining, and
// BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 turns it off, but only from the
// environment a process is STARTED with. Set from inside a running process it
// changes nothing. So every process that opens a store is started with it (the
// rendered units, the `imprnt hub` launcher and the package's test script), and
// `openStore` refuses a process that was not, by name, before it connects.
//
// WHAT EACH CHECK HOLDS.
//   1. The refusal: absent or anything but 1, the store is refused by name.
//   2. With the switch, which this suite's own process is started with, the
//      burst that crossed every time crosses 0 times in N.
//   3. Without the switch, in a child process started without it, the same
//      burst still crosses, beside the old control where the claim was prepared
//      first and nothing crosses. This is what fails if a new Bun stops
//      crossing, or if the switch's name changes and check 2 starts crossing
//      again, so the fix is never kept on after its reason is gone or silently
//      lost while its reason remains.
//   4. Through `openStore`'s own pool with every connection busy, a claim new
//      to the store and one diary append per connection each get their own
//      answer, and every later statement answers.
//   5. Every place that starts a store-opening process hands it the switch.
//
// WHAT DOES NOT HELP, measured on the way here. `prepare: false` stops the
// pipelining and then sends a jsonb parameter as the text "[object Object]", so
// every diary append fails.
//
// WHEN TO RUN IT AGAIN. `test/bun-version.test.ts` pins Bun, and the commit
// that moves that pin is where check 3 says whether the crossing is still there.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, freshDatabase, seam, until, hubPath, type Cluster } from "./helpers/cluster.ts";
import {
  NO_ANSWER,
  answered,
  backendsOf,
  burst,
  burstOnOneConnection,
  closeNow,
  sinceOf,
  warmAppend,
  type BurstResult,
  type ClaimAnswer,
  type StoreLike,
} from "./helpers/crossing.ts";
import { parsePlistDict, plutilJson, canonical } from "./helpers/plist.ts";

let cluster: Cluster;

const SLOW = 90_000;

const SWITCH = "BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING";

/** Bursts with the switch on, each on a fresh connection. The crossing was 15 of 15 without it. */
const ROUNDS = 10;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** The environment this process has, with the switch taken out. */
function withoutSwitch(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== SWITCH) env[key] = value;
  return env;
}

/** What the claim and the append in a burst each answered, for a failure message. */
function told(got: BurstResult): string {
  return `claim answered ${JSON.stringify(got.claim)}, appends answered ${JSON.stringify(got.appends)}`;
}

async function claimOnDisk(observer: SQL, id: string): Promise<unknown[]> {
  return (await observer`select data from state_row where sheet = 'outage' and id = ${id}`) as unknown[];
}

async function appendsOnDisk(observer: SQL, subject: string): Promise<number> {
  const [row] = (await observer`select count(*)::int as n from ledger_event where subject = ${subject} and kind = 'diary'`) as {
    n: number;
  }[];
  return row.n;
}

test(
  "the store refuses to open in a process started without Bun's pipelining switch, by name, and the refusal says what to set: with BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING absent or anything but 1 the store is refused before it connects, and with it at 1 the same store opens and answers",
  async () => {
    const { openStore, PipeliningRefused } = await seam("src/store/connect.ts");
    expect(typeof openStore).toBe("function");
    expect(typeof PipeliningRefused, "connect.ts names its refusal").toBe("function");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);
    const application = "pipelining-refused";
    const started = process.env[SWITCH];
    // The guard reads the environment when `openStore` is called, so this one
    // process can play both. Bun itself reads it only at the start, which is
    // what checks 2 and 3 are about, and nothing here pretends otherwise.
    const openedWith = async (value: string | undefined) => {
      if (value === undefined) delete process.env[SWITCH];
      else process.env[SWITCH] = value;
      try {
        return await (openStore as Function)({ url: `${cluster.url(db)}?application_name=${application}` }).then(
          async (store: { close(): Promise<void> }) => {
            await store.close();
            return null;
          },
          (error: unknown) => error,
        );
      } finally {
        if (started === undefined) delete process.env[SWITCH];
        else process.env[SWITCH] = started;
      }
    };
    try {
      for (const value of [undefined, "", "0", "true"]) {
        const refusal = await openedWith(value);
        expect(refusal, `with the variable ${value === undefined ? "absent" : `set to "${value}"`}`).toBeInstanceOf(
          PipeliningRefused as Function,
        );
        expect((refusal as Error).name).toBe("PipeliningRefused");
        // The operator reads this line in a journal or a terminal, so it names
        // the variable and the value exactly and says it is read at start.
        expect((refusal as Error).message).toContain(`${SWITCH}=1`);
        expect((refusal as Error).message).toMatch(/start/);
        expect((refusal as Error).message.includes("\n"), "one line, because the command prints the first").toBe(false);
      }
      // Refused before it connected: the server never saw this process.
      const [seen] = (await observer`select count(*)::int as n from pg_stat_activity where application_name = ${application}`) as {
        n: number;
      }[];
      expect(seen.n, "a refused store opened no connection").toBe(0);

      // The control. The same store, the variable at 1, opens and answers.
      process.env[SWITCH] = "1";
      try {
        const store = (await (openStore as Function)({ url: cluster.url(db) })) as { sql: SQL; close(): Promise<void> };
        try {
          const [row] = (await store.sql`select 41 + 1 as n`) as { n: number }[];
          expect(row.n).toBe(42);
        } finally {
          await store.close();
        }
      } finally {
        if (started === undefined) delete process.env[SWITCH];
        else process.env[SWITCH] = started;
      }
    } finally {
      await observer.close();
    }
  },
  SLOW,
);

test(
  `with the switch this process was started with, the burst that crossed every time does not cross: ${ROUNDS} bursts on a fresh Bun connection each, a claim new to that connection written while a statement is in flight and a diary append written after it, and every claim reads back its own row, every append answers with its seq, and the server holds both`,
  async () => {
    // The package's test script starts the suite with the switch. `bun test`
    // on its own does not, and then this check would only measure that.
    expect(process.env[SWITCH], `the suite is started by \`bun run test\`, which sets ${SWITCH}=1`).toBe("1");
    const { storeUrlAs } = await seam("src/store/connect.ts");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);
    const crossed: string[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const application = `crossing-switch-${round}`;
        const claimId = `switch-${round}`;
        const got = await burstOnOneConnection({
          storeUrl: (storeUrlAs as Function)(cluster.url(db), cluster.superuser, application),
          url: cluster.url(db),
          observer,
          application,
          claimId,
        });
        const own =
          got.claim !== NO_ANSWER &&
          (got.claim as ClaimAnswer).mine === true &&
          JSON.stringify((got.claim as ClaimAnswer).data) === JSON.stringify({ since: sinceOf(claimId) }) &&
          typeof got.appends[0] === "number";
        const onDisk = (await claimOnDisk(observer, claimId)).length === 1 && (await appendsOnDisk(observer, `${claimId}-agent-0`)) === 1;
        // One crossing already fails the check, and a crossed statement costs
        // the whole answer bound before it reads as missing, so the loop stops
        // at the first.
        if (!own || !onDisk) {
          crossed.push(`round ${round + 1} of ${ROUNDS}: ${told(got)}, both rows on disk: ${onDisk}`);
          break;
        }
      }
      expect(
        crossed,
        `A burst crossed with ${SWITCH}=1. If the child in the next check still crosses, ` +
          `the switch no longer turns this Bun's pipelining off, and its name is the first thing to check.`,
      ).toEqual([]);
    } finally {
      await observer.close();
    }
  },
  SLOW,
);

test(
  "without the switch, in a process started without it, the same burst still crosses: the claim new to the connection is told it won with no columns and never reaches the server, the append written after it is never answered although its row is on disk, and the control with the claim prepared first answers both, so the switch is still what stands between the store and a wrong answer",
  async () => {
    const { storeUrlAs } = await seam("src/store/connect.ts");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);
    const child = async (claimId: string, prepared: boolean) => {
      const application = `crossing-bare-${claimId}`;
      const proc = Bun.spawn(
        [
          process.execPath,
          hubPath("test/helpers/crossing-child.ts"),
          cluster.url(db),
          (storeUrlAs as Function)(cluster.url(db), cluster.superuser, application),
          application,
          claimId,
          prepared ? "yes" : "no",
        ],
        { env: withoutSwitch(), stdout: "pipe", stderr: "pipe" },
      );
      // Past the lost statement's whole answer bound, and the close after it.
      const timer = setTimeout(() => proc.kill(9), 60_000);
      try {
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        const said = JSON.parse(out.trim().split("\n").pop() || "{}") as {
          switch?: string | null;
          result?: BurstResult;
          error?: string;
        };
        if (!said.result) throw new Error(`the crossing child answered nothing usable.\nstdout: ${out}\nstderr: ${err}`);
        // The child really ran without it, or this proves nothing.
        expect(said.switch, "the child was started without the switch").toBeNull();
        return said.result;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      // The control first. The claim ran once on this connection, so the burst
      // writes prepared statements in order and each gets its own answer.
      const control = await child("control", true);
      expect(control.claim, `the control's claim: ${told(control)}`).not.toBe(NO_ANSWER);
      expect((control.claim as ClaimAnswer).data, "the control's claim reads back its own row").toEqual({ since: sinceOf("control") });
      expect(typeof control.appends[0], "the control's diary append answers with its seq").toBe("number");

      // The crossing. Identical, except the claim is new to this connection.
      const got = await child("crossed", false);
      const described =
        `${told(got)}. If both are right, this Bun no longer crosses without ${SWITCH}=1, and the switch, ` +
        `the refusal in connect.ts and the pool size can all be revisited.`;
      expect(got.claim, described).not.toBe(NO_ANSWER);
      // The symptom: `claimed.data.since` read as undefined. The
      // claim is told it won, with the append's answer read against its own
      // columns, which it has none of yet.
      expect((got.claim as ClaimAnswer).mine, described).toBe(true);
      expect((got.claim as ClaimAnswer).data, described).toBeUndefined();
      expect(got.appends[0], described).toBe(NO_ANSWER);
      // And the server agrees about who really ran. The claim was never
      // written to it at all, and the append's row is on disk although its
      // caller never heard back.
      expect(await claimOnDisk(observer, "crossed"), "the claim that was told it won never reached the server").toEqual([]);
      expect(await appendsOnDisk(observer, "crossed-agent-0"), "the append nobody answered is on disk").toBe(1);
    } finally {
      await observer.close();
    }
  },
  SLOW,
);

test(
  "through openStore's own pool with every connection held busy, a claim new to the store and one diary append per connection each get their own answer, and every later claim and append answers with its own row",
  async () => {
    const { openStore, storeUrlAs } = await seam("src/store/connect.ts");
    const { claimRow } = await seam("src/records/statesheet.ts");
    const { appendEntry } = await seam("src/records/diary.ts");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);
    const application = "crossing-store";

    const store = (await (openStore as Function)({
      url: (storeUrlAs as Function)(cluster.url(db), cluster.superuser, application),
    })) as StoreLike;
    try {
      // The pool's width as the server sees it, once it has stopped growing.
      let width = 0;
      let steady = 0;
      await until(
        "the store's connections to settle",
        async () => {
          const now = (await backendsOf(observer, application)).total;
          steady = now > 0 && now === width ? steady + 1 : 0;
          width = now;
          return steady >= 3;
        },
        5_000,
      );

      await warmAppend(store, width);
      const got = await burst({ store, observer, application, width, claimId: "burst" });
      const later: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        const claim = await answered(
          (claimRow as Function)(store, "outage", `after-${round}`, { since: `round-${round}` }) as Promise<ClaimAnswer>,
        );
        later.push(claim === NO_ANSWER ? NO_ANSWER : claim.data);
        later.push(
          await answered(
            (appendEntry as Function)(store, { stream: "probe", subject: "after", kind: "diary", actor: "runner" }) as Promise<number>,
          ),
        );
      }
      const described =
        `With ${width} connection(s), the burst answered ${JSON.stringify(got)} and the statements after it ` +
        `answered ${JSON.stringify(later)}.`;
      expect((got.claim as ClaimAnswer).data, described).toEqual({ since: sinceOf("burst") });
      for (const [i, seq] of got.appends.entries()) {
        expect(typeof seq, described).toBe("number");
        expect(await appendsOnDisk(observer, `burst-agent-${i}`), described).toBe(1);
      }
      expect(new Set(got.appends).size, `every append got its own seq. ${described}`).toBe(width);
      for (let round = 0; round < 3; round++) {
        expect(later[round * 2], described).toEqual({ since: `round-${round}` });
        expect(typeof later[round * 2 + 1], described).toBe("number");
      }
    } finally {
      await closeNow(store.sql);
      await observer.close();
    }
  },
  SLOW,
);

test(
  "every place that starts a process which opens a store starts it with the switch: the systemd and launchd units rendered for a hub, a door, a runner and a scheduled sync each carry it, and the launcher behind `imprnt hub` hands it to the command it starts even when the shell that ran it had none",
  async () => {
    const { STARTED_WITH } = await seam("src/store/connect.ts");
    expect(STARTED_WITH, "connect.ts says what a process must be started with").toEqual({ [SWITCH]: "1" });
    const { systemd } = await seam("src/os/systemd.ts");
    const { launchd } = await seam("src/os/launchd.ts");
    const { programForKind } = await seam("src/hub/program.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-switch-"));
    try {
      const linux = (systemd as Function)({ unitDir: dir }) as { render(entry: unknown, ctx: unknown): { path: string; text: string }[] };
      const mac = (launchd as Function)({ unitDir: dir }) as { render(entry: unknown, ctx: unknown): { path: string; text: string }[] };
      const entries = [
        { id: "hub-pi", kind: "hub", schedule: "always" },
        { id: "door-p1", kind: "door", schedule: "always" },
        { id: "runner-pi", kind: "runner", schedule: "always" },
        { id: "sync-pi", kind: "sync", schedule: "every 30m" },
      ].map((one) => ({ ...one, machine: "pi", memory_limit_mb: 128 }));
      for (const entry of entries) {
        const ctx = {
          machine: "pi",
          execPath: process.execPath,
          entryScript: (programForKind as Function)(entry.kind),
          registryFile: join(dir, "registry.toml"),
          stateDir: dir,
          restartDelaySeconds: 1,
          giveUpAfter: 5,
          giveUpWindowSeconds: 300,
        };
        // systemd: the service that runs the program carries it in [Service],
        // read the way systemd reads it, one `Environment=` assignment a line.
        const service = linux.render(entry, ctx).find((file) => file.path.endsWith(".service"))!;
        let section = "";
        const environment: string[] = [];
        for (const line of service.text.split("\n")) {
          const header = /^\[(\w+)\]$/.exec(line.trim());
          if (header) section = header[1];
          else if (section === "Service" && line.startsWith("Environment=")) environment.push(line.slice("Environment=".length).replace(/^"(.*)"$/, "$1"));
        }
        expect(environment, `${entry.kind}'s systemd service`).toContain(`${SWITCH}=1`);
        // launchd: the job's own environment, parsed, and agreed by plutil on a Mac.
        const plist = mac.render(entry, ctx)[0].text;
        const job = parsePlistDict(plist);
        const apple = await plutilJson(plist);
        if (apple !== null) expect(canonical(job)).toEqual(canonical(apple));
        expect(job.EnvironmentVariables, `${entry.kind}'s launchd job`).toEqual({ [SWITCH]: "1" });
      }

      // The launcher. A `bun` fronted on PATH records what it was started
      // with, and the shell that runs `imprnt hub` has no switch at all.
      const bin = join(dir, "bin");
      const seen = join(dir, "seen");
      mkdirSync(bin);
      writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s' "\${${SWITCH}-unset}" > '${seen}'\n`, { mode: 0o755 });
      const node = Bun.which("node");
      expect(node, "node runs the launcher, the way core dispatch runs it").not.toBeNull();
      const launched = Bun.spawnSync([node!, hubPath("hub.mjs"), "status"], {
        env: { ...withoutSwitch(), PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      expect(launched.exitCode, launched.stderr.toString()).toBe(0);
      expect(readFileSync(seen, "utf8"), "what the command behind `imprnt hub` was started with").toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  SLOW,
);
