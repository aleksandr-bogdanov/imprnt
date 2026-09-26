// LIVE. An agent whose runner sits on another machine files notes from its own
// chat: a real harvester, on a machine whose agent's door is elsewhere, reads a
// slice that exists ONLY as store rows and files what came back into a real
// vault through the real `imprnt`, in the vault checkout that machine has,
// with the login that machine keeps. (SPEC §1, §4, L7, L19)
//
// WHY IT IS HERE RATHER THAN IN THE AUTOMATED SET. Everything a shim can close
// about a spoke harvest is closed by `test/spoke-harvest.test.ts` and
// `test/spoke-state.test.ts`: the derived slice equals the file's line for
// line, the watermark lands at the last harvested line's own time, the staging
// directory and the vault are the spoke's own. What no shim can close is that
// a real model turn, fed a slice nothing on this machine has a file for,
// produces something a real CLI can file into a real vault. That is this file,
// and it lives outside bun's test root so no automated run reaches it.
// `bun run test:live` is what runs it.
//
// IT MAKES ITS OWN SCRATCH VAULT with the real `imprnt init`, under a
// temporary directory it removes at the end, so it needs no vault of anybody's
// and never writes into one. What it needs is the real `claude` on PATH and a
// login FILE made for a runner on this machine, the one the operator makes once
// with `claude auth login` pointed at the runner's own login directory (on a
// Linux box the account's own login file stands in). Never the owner's keychain
// item and never a copy of one: a refresh token is single use, and a copy that
// refreshes revokes the login it was copied from. Both are checked before the
// test is named, the reason is printed, and a box without them skips by name
// rather than passing.
//
// THE SPOKE SHAPE IS THE REAL ONE. The hub machine's paths in the registry are
// paths this box does not have, and the person's tree, vault and login on the
// spoke are this box's, under `on.<machine>`, so a build that quietly kept the
// hub machine's paths files nothing and fails here.
//
// WHAT THE MODEL WROTE IS ASSERTED NOWHERE. A harvester's judgement is the
// model's, and a check that bound its words would fail for a model release.
// What is asserted is the machinery: a note landed in the spoke's vault, the
// watermark moved to the last line the harvester was shown, and the turn
// carries the harvester's preset and the loop's own token counts. The measured
// numbers are PRINTED, because those are what a first real week is supposed
// to produce.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { seam, startCluster, until, type Cluster } from "../test/helpers/cluster.ts";
import { announceGate, claudeGate, gateSuffix } from "../test/helpers/claude-gate.ts";
import { writeImprntShim } from "../test/helpers/imprnt-shim.ts";
import { scratchVault, type ScratchVault } from "../test/helpers/scratch-vault.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER2,
  SPOKE_MACHINE,
  chatLogFile,
  insertInbound,
  scratchDir,
  spokeStage,
  stageHub,
  type StagedHub,
} from "../test/helpers/hub-fixture.ts";
import type { CredentialSpec, PresetSpec } from "../test/helpers/registry.ts";
import { loginCommand } from "../src/adapters/launch.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";
import type { SliceLine } from "../src/harvest/slice.ts";

/** Bounds the whole check, and the wait below is well inside it. */
const LIVE = 600_000;
const ANSWER_MS = 300_000;

/** The cheap real model, named here and nowhere else in this file. */
const MODEL = "claude-haiku-4-5-20251001";

/** Paths the hub machine has and this box does not. */
const HUB_ONLY = join("/nowhere-on-this-machine", crypto.randomUUID());

const CLAUDE = claudeGate();
announceGate(CLAUDE, "the live spoke harvest");

/**
 * The login file the spoke's runner will run on: the runner's own login under
 * the account's hub state directory, made once by the operator, and on a Linux
 * box the account's own login file when there is no runner login. Asked once,
 * at module load, so the reason goes into the test name.
 */
function loginSource(): { ok: true; file: string } | { ok: false; reason: string } {
  const own = join(homedir(), ".imprnt-hub", "login", ".credentials.json");
  const candidates = process.platform === "darwin" ? [own] : [own, join(homedir(), ".claude", ".credentials.json")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      if (typeof JSON.parse(readFileSync(file, "utf8")).claudeAiOauth === "object") return { ok: true, file };
    } catch {
      // Not a login: the next candidate, or the reason below.
    }
  }
  return { ok: false, reason: `no runner login at ${own}: make one once with ${loginCommand(own)}` };
}

const LOGIN = loginSource();
const reason = !CLAUDE.ok ? CLAUDE.reason : !LOGIN.ok ? LOGIN.reason : "";
if (reason !== "") process.stderr.write(`SKIP: the live spoke harvest: ${reason}\n`);

let cluster: Cluster;

beforeAll(async () => {
  if (reason === "") cluster = await startCluster();
});

afterAll(async () => {
  await cluster?.stop();
});

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

test.skipIf(reason !== "")(
  `LIVE an agent whose runner sits on another machine files notes from its own chat: a real harvester on the spoke files into the spoke's own vault from a slice that exists only in the store${gateSuffix(CLAUDE)}${LOGIN.ok ? "" : ` [skipped: ${LOGIN.reason}]`}`,
  async () => {
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runRunner } = await seam("src/runner/run.ts");
    // The reader this whole transport rests on. A file-fed harvest would go on
    // working with this import missing, which is why it is named here.
    const { deriveSlice } = await seam("src/chatlog/derive.ts");
    expect(typeof deriveSlice).toBe("function");

    // THE REAL PATH: macOS hands out scratch directories under a symlink, and
    // a sandbox profile matches the path the kernel resolved.
    const dir = realpathSync(await scratchDir("hub-live-spoke-"));
    // The spoke's own state directory, where its sessions, its harvest staging
    // and its copy of the login go.
    const spokeState = join(dir, "spoke-state");
    mkdirSync(spokeState, { mode: 0o700 });
    let vault: ScratchVault | null = null;
    let filed: string[] = [];
    let it: StagedHub | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      vault = await scratchVault(dir);
      const shim = writeImprntShim(dir);
      const vaultDir = vault.vaultDir;
      const before = notesOnDisk(vaultDir);

      const preset: PresetSpec = {
        adapter: "claude-code",
        model: MODEL,
        provider: "anthropic",
        effort: "medium",
        paid: "plan",
        credential: "household-claude",
      };
      // One credential for the household, at the hub machine's path on the
      // entry and at this machine's under its placement: the runner's own
      // login file here.
      const credential: CredentialSpec = {
        id: "household-claude",
        kind: "claude-login",
        file: join(HUB_ONLY, "credentials", ".credentials.json"),
        owner: "household",
        on: { [SPOKE_MACHINE]: { file: LOGIN.ok ? LOGIN.file : "" } },
      };
      const placement = spokeStage().registry!;
      it = await stageHub(cluster, {
        ...spokeStage(),
        machines: spokeStage().machines!.map((one) => (one.id === SPOKE_MACHINE ? { ...one, state_dir: spokeState } : one)),
        hub: { tick_seconds: 2 },
        imprnt: shim,
        preset: { credential: "household-claude" },
        credentials: [credential],
        // The person's tree and vault on the hub machine are paths this box
        // does not have. On the spoke they are the scratch directory and the
        // vault the real `imprnt init` scaffolded under it.
        people: [
          {
            id: PERSON,
            language: "en",
            tree: HUB_ONLY,
            vault: join(HUB_ONLY, "vault-project"),
            harvester: "harvest",
            harvest_quiet_minutes: 600,
            harvest_min_messages: 99,
            harvest_report: false,
            on: { [SPOKE_MACHINE]: { tree: dir, vault: vault.root } },
          },
        ],
        registry: (base) => {
          const placed = placement(base);
          return { ...placed, presets: { daily: { ...preset, effort: "low" }, harvest: preset } };
        },
      });

      // --- 1. THE SLICE CAME FROM THE STORE. Every line below is a row and
      //     nothing on this machine has a file for any of them, on either
      //     state directory.
      const chatDirs = [it.stateDir, spokeState].map((state) =>
        dirname(chatLogFile({ stateDir: state, person: PERSON, agent: AGENT, at: new Date() })),
      );
      for (const chatDir of chatDirs) expect(existsSync(chatDir), "a chat log directory exists before the run").toBe(false);

      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      const said = async (id: string, text: string, at: Date): Promise<SliceLine> => {
        await insertInbound(cluster, it!.db, {
          id,
          body: text,
          receivedAt: at.toISOString(),
          logReady: true,
          source: { log_id: id, at: at.toISOString(), door: DOOR, chat: CHAT, sender_id: "fixture-sender", text },
        });
        await it!.read.sql(
          `insert into ledger_event (at, stream, subject, kind, actor)
           values ($2, 'inbound', $1, 'delivered', 'door')`,
          [id, new Date(at.getTime() + 1000).toISOString()],
        );
        return { at: at.toISOString(), direction: "in", from: PERSON, text };
      };
      const answered = async (to: string, text: string, at: Date): Promise<SliceLine> => {
        await it!.read.sql(
          `insert into outbox (inbound_id, seq_in_reply, body, written_at, delivered_at, delivery_state)
           values ($1, 1, $2, $3, $3, 'delivered')`,
          [to, text, at.toISOString()],
        );
        return { at: at.toISOString(), direction: "out", from: AGENT, text };
      };

      // Three durable facts with chatter around them, deliberately
      // unmistakable, so an answer of nothing is read as the prompt failing
      // rather than as the model exercising its taste.
      const lines: SliceLine[] = [
        await said("live-one", "morning", ago(50)),
        await answered("live-one", "morning, what is on today", ago(49)),
        await said(
          "live-two",
          "the dentist moved my appointment from Tuesday to Thursday the 24th at 9am, and it is the six month check rather than the filling",
          ago(48),
        ),
        await answered("live-two", "noted, Thursday the 24th at 9am", ago(47)),
        await said(
          "live-three",
          "also I cancelled the gym membership today, the last charge was 42 on the 3rd of August and they said the refund takes ten working days",
          ago(46),
        ),
        await answered("live-three", "got it, cancelled, refund in ten working days", ago(45)),
      ];
      const last = lines[lines.length - 1];

      runner = (await (runRunner as Function)({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: ADAPTERS as Record<string, unknown>,
      })) as { stop(): Promise<void> };

      const until_ = new Date(now).toISOString();
      const rowId = harvestRowId(AGENT, until_);
      await insertInbound(cluster, it.db, {
        id: rowId,
        kind: "harvest",
        body: encodeHarvestBody({ from: null, until: until_, reason: "quiet", lines: lines.length }),
      });

      await until(
        "the harvest settled",
        async () =>
          (await it!.read.harvestSheet()).some(
            (row) => row.id === `${PERSON}/${AGENT}` && row.data.row === rowId,
          ),
        ANSWER_MS,
        async () =>
          `inbound=${JSON.stringify(await it!.read.inbound())} refusals=${JSON.stringify(
            await it!.read.ledger({ stream: "refusal" }),
          )} health=${JSON.stringify(await it!.read.sheet("agent_health"))}`,
      );

      // Still no file for any of it, during and after.
      for (const chatDir of chatDirs) expect(existsSync(chatDir), "a chat log directory appeared during the run").toBe(false);

      // --- 2. A NOTE LANDED IN THE SPOKE'S VAULT. The path is printed rather
      //     than asserted: where a note goes is the vault's contract and not
      //     this check's, and the folder and the slug are the model's call.
      const after = notesOnDisk(vaultDir);
      filed = after.filter((one) => !before.includes(one));
      process.stderr.write(
        `[live-spoke-harvest] the harvester filed ${filed.length} note(s): ${filed.join(", ") || "none"}\n`,
      );
      expect(
        filed.length,
        "the harvester answered nothing to a slice carrying three dated facts, which is the prompt failing rather than this check",
      ).toBeGreaterThan(0);
      for (const one of filed) {
        const size = statSync(join(vaultDir, one)).size;
        process.stderr.write(`[live-spoke-harvest] ${one} is ${size} bytes\n`);
        expect(size).toBeGreaterThan(0);
      }
      // The work was staged on the spoke's own state directory and nowhere on
      // the hub machine's.
      expect(existsSync(join(spokeState, PERSON, "harvest"))).toBe(true);
      expect(existsSync(join(it.stateDir, PERSON))).toBe(false);

      // --- 3. THE WATERMARK IS THE LAST HARVESTED LINE'S OWN TIME, which is
      //     the property that stops a slice being harvested twice and is the
      //     one thing a real filing can get wrong that a shim cannot.
      const sheet = (await it.read.harvestSheet()).find((row) => row.id === `${PERSON}/${AGENT}`)!;
      expect(sheet.data.at).toBe(last.at);
      expect(sheet.data.at).not.toBe(until_);

      // --- 4. The turn record carries the harvester's preset and the loop's
      //     own token counts, and the numbers are printed.
      const turns = await it.read.ledger({ stream: "turn", subject: rowId });
      expect(turns.length).toBe(1);
      const detail = turns[0].detail as Record<string, unknown>;
      expect(detail.preset).toBe("harvest");
      expect(Number(detail.input_tokens)).toBeGreaterThan(0);
      expect(Number(detail.output_tokens)).toBeGreaterThan(0);
      expect(detail.cached_input_tokens).not.toBeNull();
      process.stderr.write(
        `[live-spoke-harvest] the turn cost ${detail.input_tokens} in, ${detail.output_tokens} out, ${detail.cached_input_tokens} cached\n`,
      );
      expect(await it.read.ledger({ stream: "refusal" })).toEqual([]);
    } finally {
      await runner?.stop();
      await it?.stop();
      // --- 5. Everything this run made goes. The login file is the runner's
      //     own, outside this directory, and is left exactly where it was.
      await vault?.remove();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  LIVE,
);
