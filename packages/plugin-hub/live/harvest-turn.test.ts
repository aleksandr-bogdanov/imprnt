// LIVE. The real loop reads a real slice in a real vault and the real `imprnt`
// files what came back.
//
// SPEC §4: "a separate model reads a chat and files what was worth keeping
// through the normal ingest path", and "a fresh session, no chat context, given
// exactly the log slice and the vault's filing rules". ROADMAP criterion 2:
// "Every harvest turn carries its preset ID and tokens." L19.
//
// This is the ONE place in phase 5 where a real model appears at all. It lives
// in `live/` for the reason phase 2 gave: it needs the Claude Code login and no
// automated run may depend on one. `bunfig.toml` sets the test root to `test`,
// so `bun test` never reaches it, and `bun run test:live` is what runs it. It
// needs no platform token: the fake platform is what the door posts into.
//
// WHAT IS DELIBERATELY NOT ASSERTED, said here so nobody adds it later:
//   - which facts the model kept,
//   - which folder and which slug it chose,
//   - how many notes came back,
//   - WHETHER ANY CAME BACK AT ALL.
//
// The last one is the harness's ruling after the second Codex pass, and the
// second seat was right to push on it. L19 rule 3 says `nothing` is a real
// answer and not a failure, and the phase boundary says the model's taste is
// unbound. A check that required a positive note would be binding the model's
// judgment, which is the one thing this phase says no check may do, and it
// would fail for the weather. So `nothing` is a VALID OUTCOME here.
//
// WHAT IS ASSERTED IS THE MACHINERY, ON EITHER ANSWER: the watermark moved to
// the last line the model was shown, the turn record carries the harvester's
// preset id and real token counts, no refusal was written, and when notes DID
// come back each one is on disk with a `source:` that resolves to a real file.
// That is the whole of what this phase built, and it is bound the same way
// whichever answer the loop gives.
//
// It PRINTS which answer it got, because a `nothing` on a slice this concrete
// is worth a human reading even though it is not a failure: it would say the
// prompt is not carrying its weight, which is D-158's question and not this
// check's.
//
// Bounded at 420 s with the answer awaited inside 240 s. The probe measured a
// real harvest at 31 to 96 s on this Mac with the cheap model at low effort.
//
// Red reason: import missing, `src/harvest/prompt.ts`, reached through
// `src/runner/run.ts`, against the real CLI and the real loop. It fails on the
// `seam()` call before a single token is spent.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  freshDatabase,
  seam,
  startCluster,
  until,
  type Cluster,
} from "../test/helpers/cluster.ts";
import { createFakePlatform } from "../test/helpers/fake-platform.ts";
import { writeImprntShim } from "../test/helpers/imprnt-shim.ts";
import { scratchVault, type ScratchVault } from "../test/helpers/scratch-vault.ts";
import { writeRegistry } from "../test/helpers/registry.ts";
import { announceClock, clockGate, clockSuffix } from "../test/helpers/clock-gate.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogFile,
  scratchDir,
  storeReader,
  userlessStoreUrl,
} from "../test/helpers/hub-fixture.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "../test/helpers/preset-oracle.ts";

let cluster: Cluster;

/** Bounds the whole test, and the wait below is well inside it. */
const LIVE = 420_000;
const ANSWER_MS = 240_000;

// THE CLOCK GATE. The conversation is planted fifty minutes back and a real
// door runs over it with a ten hour quiet period. The daily backstop ignores
// that, and a spurious backstop row here would cost a SECOND real model turn.
// Fifty minutes of planting plus four of running is fifty-four.
const GATE_16 = clockGate(54);
announceClock(GATE_16, "check 16, the live harvest turn");

/** The cheap real model, named here and nowhere else in the repository. */
const MODEL = "claude-haiku-4-5-20251001";

interface ChatLine {
  at: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

/** Every `.md` under the vault's own note folders, relative, sorted. */
function notesOnDisk(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const here = join(dir, entry.name);
      if (entry.isDirectory()) walk(here, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md") && prefix !== "") out.push(`${prefix}${entry.name}`);
    }
  };
  walk(vaultDir, "");
  return out.sort();
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test.skipIf(!GATE_16.ok)(
  "LIVE HARV-01 and HARV-02 the real loop reads a real slice in a real vault, the real imprnt files what came back, the watermark is the last line the model was shown, and the record carries the harvester's preset id and the loop's own token counts (SPEC §4, L19, L18)" + clockSuffix(GATE_16),
  async () => {
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");
    // The one import that makes this red before a single token is spent.
    const { harvestMessage } = await seam("src/harvest/prompt.ts");
    expect(typeof harvestMessage).toBe("function");
    const { HARVEST_SHEET } = await seam("src/harvest/sheet.ts");

    const db = await freshDatabase(cluster);
    // THE REAL PATH, and BUILD-NOTES 10 has the measurement. macOS hands out
    // scratch directories under `/var/folders/...`, which is a symlink to
    // `/private/var/folders/...`, and a sandbox profile's
    // `(subpath "/var/folders/...")` matches nothing because the kernel
    // resolves the path first. This person's `tree` IS this directory, so a
    // box drawn around the unresolved spelling denies the loop everything and
    // the real child dies at startup with `An unknown error occurred`. It is
    // the same fact `test/helpers/trees.ts` records for the boxed live check,
    // which is why that one works and this one did not.
    const dir = realpathSync(await scratchDir("hub-live-harvest-"));
    let vault: ScratchVault | null = null;
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    const read = storeReader(cluster, db);
    try {
      vault = await scratchVault(dir);
      const shim = writeImprntShim(dir);
      const fake = createFakePlatform({ name: "fake" });

      const agentPreset = {
        adapter: "claude-code",
        model: MODEL,
        provider: "anthropic",
        effort: "low",
        paid: "plan",
      };
      const harvesterPreset = {
        adapter: "claude-code",
        model: MODEL,
        provider: "anthropic",
        // A different effort, so the two derived ids differ and the assertion
        // below is not satisfiable by accident.
        effort: "medium",
        paid: "plan",
      };
      const registryFile = writeRegistry(dir, {
        hub: {
          store_url: userlessStoreUrl(cluster, db),
          state_dir: dir,
          tick_seconds: 2,
          imprnt: shim,
        },
        people: [
          {
            id: PERSON,
            language: "en",
            tree: dir,
            harvester: "harvest",
            vault: vault.root,
            harvest_quiet_minutes: 600,
            harvest_min_messages: 99,
            harvest_report: true,
          },
        ],
        presets: { daily: agentPreset, harvest: harvesterPreset },
        agents: [
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
        ],
      });

      // THE SLICE, nine lines carrying THREE durable facts with chatter around
      // them, written out here so a reader sees exactly what the model was
      // shown. The shape is 05-BRIEF's slice A, which the probe measured
      // producing three notes.
      //
      // It is deliberately unmistakable: a moved appointment with a date and a
      // time, a cancelled subscription with an amount and a refund window, and
      // a renewal with a notice period and a decision date. A harvester that
      // answered `nothing` to this is not exercising its taste, it is failing,
      // and assertion 1 below is written so that failure is READ rather than
      // shrugged off as weather.
      const now = Date.now();
      // PLAIN OFFSETS, strictly ordered. The clock gate at the top of this
      // file is what keeps the conversation inside one UTC day, and a clamp on
      // the times was withdrawn for producing future and equal timestamps.
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const slice: ChatLine[] = [
        { at: at(50), direction: "in", from: PERSON, text: "morning" },
        { at: at(49), direction: "out", from: AGENT, text: "morning, what is on today" },
        {
          at: at(48),
          direction: "in",
          from: PERSON,
          text: "the dentist moved my appointment from Tuesday to Thursday the 24th at 9am, and it is the six month check rather than the filling",
        },
        { at: at(47), direction: "out", from: AGENT, text: "noted, Thursday the 24th at 9am" },
        {
          at: at(46),
          direction: "in",
          from: PERSON,
          text: "also I cancelled the gym membership today, the last charge was 42 on the 3rd of August and they said the refund takes ten working days",
        },
        { at: at(45), direction: "out", from: AGENT, text: "got it, cancelled, last charge 42 on 3 August, refund in ten working days" },
        {
          at: at(44),
          direction: "in",
          from: PERSON,
          text: "one more, the flat insurance renews on the 12th of November and the notice period is 30 days, so I have to decide by the 13th of October",
        },
        { at: at(43), direction: "out", from: AGENT, text: "so the decision date is 13 October, renewal 12 November" },
        { at: at(42), direction: "in", from: PERSON, text: "thanks, talk later" },
      ];
      for (const line of slice) {
        const file = chatLogFile({
          stateDir: dir,
          person: PERSON,
          agent: AGENT,
          at: new Date(line.at),
        });
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
      }
      const lastLine = slice[slice.length - 1];

      // 9. THE SCRATCH VAULT IS A REAL VAULT. `imprnt init` writes the contract
      //    as the PROJECT ROOT's own CLAUDE.md (measured 2026-09-16: at
      //    `<root>/CLAUDE.md`, not inside `vault/`), and that file is what makes
      //    a loop started there load the filing rules.
      expect(existsSync(join(vault.root, "CLAUDE.md"))).toBe(true);
      expect(readFileSync(join(vault.root, "CLAUDE.md"), "utf8").length).toBeGreaterThan(0);

      // AND THE VAULT HOLDS NO NOTE BEFORE THE RUN, which is what makes "a note
      // landed" unfakeable by the fixture.
      expect(notesOnDisk(vault.vaultDir)).toEqual([]);

      door = await (runDoor as Function)({ door: DOOR, registryFile, platform: fake.platform });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile,
        adapters: ADAPTERS,
      });

      // The harvest row, planted directly as the door role. The door's three
      // triggers are bound by 05-02 against a fake platform, and making this
      // check wait out a real quiet period would add a minute to a run that
      // already costs a model turn and would bind nothing 05-02 does not.
      const until_ = new Date(now).toISOString();
      const rowId = `harvest:${AGENT}:${until_}`;
      const door_ = cluster.connectAs("hub_door", db) as unknown as {
        unsafe(query: string, values?: unknown[]): Promise<unknown>;
        close(): Promise<void>;
      };
      try {
        await door_.unsafe("begin");
        await door_.unsafe(
          `insert into inbound (id, person, agent, body, kind)
           values ($1, $2, $3, $4, 'harvest')`,
          [
            rowId,
            PERSON,
            AGENT,
            JSON.stringify({ from: null, until: until_, reason: "quiet", lines: slice.length }),
          ],
        );
        await door_.unsafe(
          `insert into ledger_event (stream, subject, kind, actor)
           values ('inbound', $1, 'received', 'door')`,
          [rowId],
        );
        await door_.unsafe("commit");
      } finally {
        await door_.close();
      }

      await until(
        "the real harvest turn reached answered",
        async () =>
          (await read.ledger({ stream: "inbound", subject: rowId })).some(
            (one) => one.kind === "answered",
          ),
        ANSWER_MS,
        async () =>
          `inbound=${JSON.stringify(await read.inbound())} refusals=${JSON.stringify(
            await read.ledger({ stream: "refusal" }),
          )}`,
      );
      await Bun.sleep(2000);

      // --- 0. NO REFUSAL. `nothing` is a real answer and an unreadable reply is
      //     not, so this is the one thing that is a failure whatever the model
      //     decided, and it is read first so its own words reach the report.
      const refused = await read.ledger({ stream: "refusal", subject: rowId });
      expect(
        refused.map((one) => `${one.kind}: ${String(one.detail.said).slice(0, 300)}`),
      ).toEqual([]);

      // --- 1. WHICH ANSWER CAME BACK. Either is valid. The count is printed
      //     and never asserted.
      const landed = notesOnDisk(vault.vaultDir);
      const turnLine = (await read.ledger({ stream: "turn", subject: rowId }))[0];
      expect(turnLine).toBeDefined();
      const answered = turnLine.detail.harvest as Record<string, unknown>;
      const filedPaths = (answered.notes as string[]) ?? [];
      process.stderr.write(
        `[live-harvest] the loop answered ${
          filedPaths.length === 0 ? "NOTHING" : `${filedPaths.length} note(s)`
        } over ${slice.length} lines: ${JSON.stringify(filedPaths)}\n` +
          (filedPaths.length === 0
            ? "[live-harvest] `nothing` is a valid answer (L19 rule 3) and this check " +
              "does not fail on it. On a slice this concrete it is worth reading: it " +
              "would point at the prompt, which is D-158's question.\n"
            : ""),
      );
      // The two views agree: every note the record says filed is a note on disk.
      expect(landed.length).toBe(
        new Set([...landed, ...filedPaths.map((one) => `${one}.md`)]).size,
      );

      // --- 2. the manifest carries at least one `apply:sha256:` key and a
      //     snapshot exists under `raw/proposed/`. The real provenance really
      //     landed.
      if (filedPaths.length > 0) {
        const manifest = JSON.parse(
          readFileSync(join(vault.vaultDir, ".manifest.json"), "utf8"),
        ) as Record<string, { raw?: string }>;
        const applied = Object.keys(manifest).filter((key) => key.startsWith("apply:sha256:"));
        expect(applied.length).toBeGreaterThan(0);
        expect(existsSync(join(vault.rawDir, "proposed"))).toBe(true);
        expect(readdirSync(join(vault.rawDir, "proposed")).length).toBeGreaterThan(0);
      } else {
        // `nothing` files nothing, stages nothing and snapshots nothing.
        expect(landed).toEqual([]);
      }

      // --- 3. THE WATERMARK IS ONE ROW whose `at` is the LAST PLANTED LINE's
      //     own time, computed by the test from the lines it wrote. A build
      //     that stamped `now()` into `at` lands minutes off and fails, and
      //     that is one of the two real controls here.
      const sheet = await read.sheet(HARVEST_SHEET as string);
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(`${PERSON}/${AGENT}`);
      expect((sheet[0].data as Record<string, unknown>).at).toBe(lastLine.at);
      expect((sheet[0].data as Record<string, unknown>).row).toBe(rowId);

      // --- 4. THE TURN RECORD carries the HARVESTER's preset id and three
      //     real token counts. That is criterion 2 against a real loop.
      const turn = turnLine;
      expect(turn.detail.preset_id).toBe(expectedPresetId(harvesterPreset));
      expect(turn.detail.preset_id).not.toBe(expectedPresetId(agentPreset));
      expect(turn.detail.preset).toBe("harvest");
      expect(turn.detail.tail).toBe(false);
      expect(Number(turn.detail.input_tokens)).toBeGreaterThan(0);
      expect(Number(turn.detail.output_tokens)).toBeGreaterThan(0);
      expect(Number(turn.detail.cached_input_tokens)).toBeGreaterThanOrEqual(0);
      expect(turn.detail.cached_input_tokens).not.toBeNull();

      // --- 5. EVERY ENTRY IN `harvest.notes` IS A FILE THAT REALLY EXISTS,
      //     checked one by one. How many there are is the model's and is not
      //     asserted. An empty list is a valid answer and the loop below simply
      //     has nothing to walk.
      for (const one of filedPaths) {
        expect(existsSync(join(vault.vaultDir, `${one}.md`))).toBe(true);
      }
      expect(answered.conflicts).toBeDefined();

      // --- 6. THE REPLY REACHED NO CHAT AS A REPLY. That is the second real
      //     control: it is the exact failure the shipped runner produces (it
      //     settles every turn's text into the outbox), so a build that
      //     regressed to it fails here against the real loop rather than only
      //     against a scripted one.
      const outbox = await read.sql("select id, inbound_id, kind from outbox order by id");
      expect(outbox.some((row) => row.inbound_id === rowId)).toBe(false);

      // --- 7. ONE NOTICE, whose key is the row's own id, whose body names the
      //     notes that filed, and which the door posted into the chat.
      const notices = await read.noticeRows();
      const mine = notices.filter((row) => row.notice_key === `harvest:${rowId}`);
      if (filedPaths.length > 0) {
        expect(mine.length).toBe(1);
        expect(mine[0].body.startsWith("[door] saved. Notes: ")).toBe(true);
        for (const one of filedPaths) expect(mine[0].body).toContain(one);
        await until(
          "the door posted the report line into the chat",
          () => fake.posts().some((post) => post.text === mine[0].body),
          60_000,
          () => JSON.stringify(fake.posts()),
        );
      } else {
        // D-159: a QUIET harvest that saved nothing says nothing. The report
        // line says what was saved, and on this row there is nothing to say.
        expect(mine).toEqual([]);
      }

      // --- 8. EVERY `source:` POINTS AT A SNAPSHOT THAT REALLY EXISTS, which
      //     is the prompt's own promise rather than taste. The apply writes
      //     `source: "[[raw/proposed/<slug>-<hash>]]"`, a WIKILINK and not a
      //     path, so the resolution is spelled out: take the text between the
      //     brackets, join it to the vault's ROOT and add `.md`. The apply
      //     injects the real one when the note carried none, so the only way
      //     this fails is the model having written its own fabricated one and
      //     the prompt not having stopped it, which is the measured defect
      //     D-158 exists to close.
      for (const one of landed) {
        const text = readFileSync(join(vault.vaultDir, one), "utf8");
        const said = /^source:\s*"?\[\[([^\]]+)\]\]"?\s*$/m.exec(text);
        expect(said).not.toBeNull();
        const target = join(vault.root, `${said![1]}.md`);
        expect(existsSync(target)).toBe(true);
      }
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await read.close().catch(() => {});
      if (vault) await vault.remove();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  LIVE,
);
