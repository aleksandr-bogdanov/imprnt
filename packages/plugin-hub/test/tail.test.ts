// MSG-12. The tail is the last hours, capped at the configured tokens, newest
// kept, and the size is a household setting rather than a per-agent one.
//
// SPEC §2, the chat log line: "On every spawn the runner feeds the tail (24
// hours, 8k tokens, defaults until measured) before any human message. The
// agent never chooses what to read on spawn. No per-agent tail size." That last
// sentence is in the chat log line itself rather than in section 2's Forbidden
// list, and the refusal being loud and naming its line is SPEC §6, L14.
//
// These three touch no Postgres, on purpose, the same way phase 1's registry
// checks do: the tail is a function of a folder of lines and a clock, and the
// per-agent refusal is a file loader's refusal, so a database would add a
// dependency without adding a probe.
//
// Red reasons: import missing, src/chatlog.ts, for the two tail checks.
// Behaviour absent, src/registry/load.ts is shipped and does not yet refuse a
// per-agent tail size, for the third.

import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { seam, hubPath } from "./helpers/cluster.ts";
import { AGENT, PERSON, chatLogFile, scratchDir } from "./helpers/hub-fixture.ts";

/**
 * A fixed `now`, chosen so that 30 hours ago, 23 hours ago and 10 minutes ago
 * fall on three different UTC days. A build that reads only today's file fails
 * the age check and no other, which is what that spread is for.
 */
const NOW = new Date("2026-09-15T05:00:00.000Z");

function planted(stateDir: string, at: Date, text: string): void {
  const file = chatLogFile({ stateDir, person: PERSON, agent: AGENT, at });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify({
      at: at.toISOString(),
      direction: "in",
      from: PERSON,
      text,
    }) + "\n",
    "utf8",
  );
}

function hoursBefore(hours: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - hours * 3_600_000 + extraMs);
}

test(
  "MSG-12 the tail is the last hours and a line older than them is not in it: three dated files, the 30 hour line absent, the 23 hour and 10 minute lines present oldest first under the preamble, and the boundary probed on both sides (SPEC §2, L2)",
  async () => {
    const { readTail, TAIL_PREAMBLE } = await seam("src/chatlog.ts");
    expect(typeof readTail).toBe("function");
    expect(typeof TAIL_PREAMBLE).toBe("string");

    const stateDir = await scratchDir("hub-tail-");
    try {
      planted(stateDir, hoursBefore(30), "marker-thirty-hours");
      planted(stateDir, hoursBefore(23), "marker-twenty-three-hours");
      planted(stateDir, hoursBefore(0, -600_000), "marker-ten-minutes");

      const tail = (await (readTail as Function)({
        stateDir,
        person: PERSON,
        agent: AGENT,
        now: NOW,
        hours: 24,
        tokens: 8000,
      })) as string;

      expect(tail).not.toContain("marker-thirty-hours");
      expect(tail).toContain("marker-twenty-three-hours");
      expect(tail).toContain("marker-ten-minutes");

      // Oldest first, under a first line that is exactly the preamble.
      const lines = tail.split("\n").filter((l) => l.trim() !== "");
      expect(lines[0]).toBe(TAIL_PREAMBLE as string);
      expect(lines.length).toBe(3);
      expect(lines[1]).toContain("marker-twenty-three-hours");
      expect(lines[2]).toContain("marker-ten-minutes");
      // Each rendered line is <at> <from>: <text>.
      expect(lines[1]).toContain(`${PERSON}: `);

      // The boundary, because an off-by-one here silently drops a message.
      const edge = await scratchDir("hub-tail-edge-");
      try {
        planted(edge, hoursBefore(24, 1000), "marker-inside-by-a-second");
        planted(edge, hoursBefore(24, -1000), "marker-outside-by-a-second");
        const cut = (await (readTail as Function)({
          stateDir: edge,
          person: PERSON,
          agent: AGENT,
          now: NOW,
          hours: 24,
          tokens: 8000,
        })) as string;
        expect(cut).toContain("marker-inside-by-a-second");
        expect(cut).not.toContain("marker-outside-by-a-second");
      } finally {
        await rm(edge, { recursive: true, force: true });
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

/**
 * The preamble, written out here rather than imported, so the budget below is
 * computed from the pinned contract and not from the code under test.
 */
const PINNED_PREAMBLE =
  "[hub] chat log tail, for context only. Do not answer it. The message to answer arrives next.";

/** The pinned estimate: ceil(characters / 4), applied by the TEST. */
function pinnedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

test(
  "MSG-12 the tail is capped at the configured tokens and the newest lines are kept: the returned text's own size measured by the pinned formula is inside the budget, exactly the newest lines that fit come back, and no line is cut in half (SPEC §2, L2)",
  async () => {
    const { readTail, TAIL_PREAMBLE, estimateTokens } =
      await seam("src/chatlog.ts");
    expect(typeof readTail).toBe("function");
    expect(typeof estimateTokens).toBe("function");

    // The oracle is independent of the code under test in both directions: the
    // preamble is the pinned text and the estimate is the pinned formula. The
    // first pass used the seam's own estimator as its oracle, so a build whose
    // estimateTokens always returned 1 satisfied any budget.
    expect(TAIL_PREAMBLE).toBe(PINNED_PREAMBLE);
    expect((estimateTokens as Function)("abcdefgh")).toBe(2);
    expect((estimateTokens as Function)("abcdefghi")).toBe(3);

    const stateDir = await scratchDir("hub-tail-cap-");
    try {
      // A hundred lines, all inside the window, all the same length, each
      // carrying its ordinal at both ends so a line cut in half is visible.
      const written: { at: Date; text: string }[] = [];
      for (let n = 0; n < 100; n += 1) {
        const at = new Date(NOW.getTime() - (100 - n) * 60_000);
        const ordinal = String(n).padStart(3, "0");
        const text = `ordinal ${ordinal} start filler filler filler ordinal ${ordinal} end`;
        planted(stateDir, at, text);
        written.push({ at, text });
      }

      // The rendered shape is pinned: `<at> <from>: <text>`. The test renders
      // the newest lines itself and sets the budget to exactly what they cost,
      // with two tokens of slack so a one-character accounting difference does
      // not decide the count while a whole extra line (fifteen tokens) still
      // cannot fit.
      const KEEP = 8;
      const render = (line: { at: Date; text: string }) =>
        `${line.at.toISOString()} ${PERSON}: ${line.text}`;
      const newest = written.slice(-KEEP);
      const expectedText = [PINNED_PREAMBLE, ...newest.map(render)].join("\n");
      const budget = pinnedTokens(expectedText) + 2;

      const tail = (await (readTail as Function)({
        stateDir,
        person: PERSON,
        agent: AGENT,
        now: NOW,
        hours: 24,
        tokens: budget,
      })) as string;

      // The size assertion, by the test's own arithmetic over the returned
      // text. A build that returned 99 lines fails this whatever its own
      // estimator says.
      expect(pinnedTokens(tail.trimEnd())).toBeLessThanOrEqual(budget);

      const lines = tail.split("\n").filter((l) => l.trim() !== "");
      expect(lines[0]).toBe(PINNED_PREAMBLE);

      // The independent count: exactly the newest KEEP ordinals, no more and
      // no fewer. A build that kept the oldest satisfies the budget and
      // delivers exactly the wrong context, which nothing else would notice.
      const ordinals = lines
        .slice(1)
        .map((l) => /ordinal (\d+) start/.exec(l)![1]);
      expect(ordinals).toEqual(newest.map((_, i) => String(92 + i).padStart(3, "0")));
      expect(tail).not.toContain("ordinal 091 start");
      expect(tail).toContain("ordinal 099 start");

      // The rendering is the pinned one, which is what makes the count above
      // sound rather than a guess at a line length.
      expect(lines[1]).toBe(render(newest[0]));
      expect(lines[lines.length - 1]).toBe(render(newest[newest.length - 1]));

      // A line is kept or dropped whole, never truncated.
      for (const line of lines.slice(1)) {
        const ordinal = /ordinal (\d+) start/.exec(line)![1];
        expect(line).toContain(`ordinal ${ordinal} end`);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "MSG-12 a per-agent tail size is refused: tail_tokens or tail_hours inside an [[agents]] entry refuses the registry and names that line, and the same file without it loads and the household value reads back (SPEC §2 chat log, L2, and SPEC §6 L14 for the loud refusal)",
  async () => {
    const { loadRegistry, readSetting, RegistryRefused } = await seam(
      "src/registry/load.ts",
    );
    expect(typeof loadRegistry).toBe("function");

    const dir = await scratchDir("hub-tail-registry-");
    try {
      const base = [
        "# the hub's registry",
        "",
        "[hub]",
        "tick_seconds = 5",
        'store_url = "postgres://127.0.0.1:5432/hub"',
        'state_dir = "/var/lib/imprnt-hub"',
        "tail_hours = 24",
        "tail_tokens = 8000",
        "claim_lease_seconds = 300",
        "",
        "[presets.daily]",
        'adapter = "claude-code"',
        'model = "a-model-name"',
        'provider = "a-provider"',
        'effort = "medium"',
        'paid = "plan"',
        "",
        "[[agents]]",
        'id = "p1-lair"',
        'person = "p1"',
        'preset = "daily"',
        'chat = "1000000001"',
        'door = "door-telegram"',
        'runner = "runner-pi"',
        "",
        "[[run]]",
        'id = "door-telegram"',
        'kind = "door"',
        'platform = "telegram"',
        'person = "p1"',
        'token_file = "/dev/null"',
        'schedule = "always"',
        "memory_limit_mb = 192",
        "",
        "[[run]]",
        'id = "runner-pi"',
        'kind = "runner"',
        'schedule = "always"',
        "memory_limit_mb = 512",
        "",
      ];

      // Both spellings, each at a line the test computes from the text it wrote.
      for (const key of ["tail_tokens = 4000", "tail_hours = 6"]) {
        const lines = [...base];
        const agentAt = lines.findIndex((l) => l === 'runner = "runner-pi"');
        lines.splice(agentAt + 1, 0, key);
        const badLine = lines.indexOf(key) + 1;
        const file = join(dir, `per-agent-${key.split(" ")[0]}.toml`);
        writeFileSync(file, lines.join("\n"), "utf8");

        let refusal: unknown;
        try {
          (loadRegistry as Function)(file);
        } catch (err) {
          refusal = err;
        }
        // The specific new refusal, never merely that something threw: the
        // shipped loader already throws for other reasons.
        expect(refusal).toBeInstanceOf(RegistryRefused as Function);
        expect((refusal as { line: number }).line).toBe(badLine);
        expect((refusal as { key: string }).key).toContain(key.split(" ")[0]);
        expect(String((refusal as Error).message)).toContain(String(badLine));
        // The reason a human reads names the offending key, so the refusal is
        // about THIS key rather than about something being wrong somewhere.
        expect(String((refusal as { reason: string }).reason)).toContain(
          key.split(" ")[0],
        );
      }

      // THE NARROWING CONTROL. Without it a loader that refuses ANY unknown key
      // inside an [[agents]] entry passes the two halves above while refusing
      // nothing the rule names. The same entry carrying an unrelated key nobody
      // reads still loads, so what is refused is a per-agent tail size and not
      // novelty.
      const unrelated = [...base];
      const unrelatedAt = unrelated.findIndex((l) => l === 'runner = "runner-pi"');
      unrelated.splice(unrelatedAt + 1, 0, 'note = "a key nobody reads"');
      const tolerated = join(dir, "unrelated-agent-key.toml");
      writeFileSync(tolerated, unrelated.join("\n"), "utf8");
      const loaded = (loadRegistry as Function)(tolerated);
      expect((readSetting as Function)(loaded, "hub.tail_tokens")).toBe(8000);

      // The control. Without it this passes on a loader that refuses every
      // unknown key for some other reason: the same file with the key removed
      // loads, the setting exists, and it lives in one place.
      const good = join(dir, "household.toml");
      writeFileSync(good, base.join("\n"), "utf8");
      const registry = (loadRegistry as Function)(good);
      expect((readSetting as Function)(registry, "hub.tail_tokens")).toBe(8000);
      expect((readSetting as Function)(registry, "hub.tail_hours")).toBe(24);

      // And the shipped example file carries them, which is what keeps phase
      // 1's both-directions binding true.
      const shipped = await Bun.file(
        hubPath("src/registry/registry.example.toml"),
      ).text();
      expect(shipped).toMatch(/^\s*tail_hours\s*=/m);
      expect(shipped).toMatch(/^\s*tail_tokens\s*=/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
