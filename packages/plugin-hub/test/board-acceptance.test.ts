// This phase's evidence, held as DATA, and the assertion that the data is
// honest. (SPEC §6, L4)
//
// WHAT THIS FILE IS. It reads files and digests them and it starts nothing. It
// does not re-run the phase's checks and it could not: what it refuses is an
// INVENTORY that claims a run nobody made, a gate a skip closed, or an
// owner-only row a script says it satisfied.
//
// A SKIP NEVER CLOSES A GATE. That is the sentence the validator below exists
// to enforce, and it is enforced against a row marked skipped, a row marked
// failed and a row with no evidence at all, each refused with its own reason.
//
// WHICH ASSERTIONS ARE GREEN FROM THE FIRST RUN, so nobody reads a green here
// as evidence of work: the six window digests, the door fence, the two
// untouched files and the owner-only refusals. A digest that never changes is
// the point of taking one, and the validator is data in this file, so the rows
// it refuses are refused the moment it exists. They were green before this
// file's first line and are meant to stay green for the rest of the phase. What
// was red at the start is the inventory itself, whose rows name check files
// that did not all exist yet.
//
// THE BASELINE IS THE TREE THIS BRANCH IS REBASED ONTO, not the working tree. A
// digest read off the working tree could only catch a change made after this
// file was written, which is not what the fence is about.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hubPath } from "./helpers/cluster.ts";

/** How a requirement is closed. A skip never closes a gate. */
type Seam = "A" | "K" | "L" | "C";

/** What a run of one check on one operating system came to. */
type Ran = "ran" | "skipped" | "failed";

interface Evidence {
  seam: Exclude<Seam, "C">;
  file: string;
  /** The two operating systems, as the round that wrote this filled them in. */
  runs: Partial<Record<"macos" | "linux", Ran>>;
}

interface Row {
  requirement: string;
  observation: string;
  seams: Seam[];
  evidence: Evidence[];
  /** The owner-only half, in words, with no evidence in this repository. */
  acceptance: string[];
  /** What a script might offer for the owner-only half and what it is not. */
  notSatisfiedBy: string[];
}

/**
 * The phase's requirement table, one row per line of it.
 *
 * `runs` is the part a round fills in from its own runs. The validator refuses a
 * row that claims an automated seam and cannot show both operating systems, so
 * an inventory nobody ran cannot serialize as accepted.
 */
const BOTH: Partial<Record<"macos" | "linux", Ran>> = { macos: "ran", linux: "ran" };
/** A gated check runs on the operating system it is for and says so on the other. */
const HERE_ONLY: Partial<Record<"macos" | "linux", Ran>> =
  process.platform === "darwin" ? { macos: "ran", linux: "skipped" } : { macos: "skipped", linux: "ran" };

const INVENTORY: Row[] = [
  {
    requirement: "RUN-05, the list, the OS state, the difference",
    observation: "the entries, what the manager says about them, and what the check sheet says about the other machine",
    seams: ["A", "K"],
    evidence: [
      { seam: "A", file: "test/board-pages.test.ts", runs: BOTH },
      { seam: "K", file: "test/board-native.test.ts", runs: HERE_ONLY },
    ],
    acceptance: [],
    notSatisfiedBy: [],
  },
  {
    requirement: "RUN-05, the acts and the Forbidden line",
    observation: "restart through the one shipped verb, stop as a registry field, and no board code touching an acting verb",
    seams: ["A", "C"],
    evidence: [
      { seam: "A", file: "test/board-acts.test.ts", runs: BOTH },
      { seam: "A", file: "test/board-control.test.ts", runs: BOTH },
    ],
    acceptance: ["one real act performed from a phone and read back in the ledger"],
    notSatisfiedBy: ["a board served in this process"],
  },
  {
    requirement: "RUN-05, tailnet only",
    observation: "the loader's bind refusals and the exit a bind this machine does not hold makes",
    seams: ["A", "C"],
    evidence: [
      { seam: "A", file: "test/registry-board.test.ts", runs: BOTH },
      { seam: "A", file: "test/board-idle.test.ts", runs: BOTH },
    ],
    acceptance: ["the board opened from a second device on the tailnet"],
    notSatisfiedBy: ["a board served in this process", "a loopback bind on this box"],
  },
  {
    requirement: "RUN-13, the board watched",
    observation: "the shipped unit findings and the peak reach a board entry, and check opens no connection to its port",
    seams: ["A", "K"],
    evidence: [
      { seam: "A", file: "test/check-board.test.ts", runs: BOTH },
      { seam: "K", file: "test/board-native.test.ts", runs: HERE_ONLY },
    ],
    acceptance: [],
    notSatisfiedBy: [],
  },
  {
    requirement: "the read path",
    observation: "zero writes across a page sweep, and no statement and no processor time with nobody looking",
    seams: ["A"],
    evidence: [
      { seam: "A", file: "test/board-idle.test.ts", runs: BOTH },
      { seam: "A", file: "test/board-windows.test.ts", runs: BOTH },
    ],
    acceptance: [],
    notSatisfiedBy: [],
  },
  {
    requirement: "S1, the tail",
    observation: "the derived tail equals the file's over one planted conversation, and a runner on the other machine is fed from the store",
    seams: ["A", "C"],
    evidence: [
      { seam: "A", file: "test/chatlog-derive.test.ts", runs: BOTH },
      { seam: "A", file: "test/spoke-tail.test.ts", runs: BOTH },
      { seam: "A", file: "test/door-clock-replay.test.ts", runs: BOTH },
    ],
    acceptance: ["a runner on the second machine answering a message sent from a phone, if an agent is ever placed there"],
    notSatisfiedBy: ["two declared machines in one registry on one box"],
  },
  {
    requirement: "S1, harvest",
    observation: "the derived slice equals the file's, and a real harvester files into a real vault from it",
    seams: ["A", "L"],
    evidence: [
      { seam: "A", file: "test/spoke-harvest.test.ts", runs: BOTH },
      { seam: "L", file: "live/spoke-harvest.test.ts", runs: {} },
    ],
    acceptance: [],
    notSatisfiedBy: [],
  },
  {
    requirement: "the refusal a spoke replaces",
    observation: "a cross-machine agent is served from the store and an unreadable local state root is still refused",
    seams: ["A"],
    evidence: [{ seam: "A", file: "test/local-state-preflight.test.ts", runs: BOTH }],
    acceptance: [],
    notSatisfiedBy: [],
  },
  {
    requirement: "the artifacts pages",
    observation: "the route, the opt-in field, the real-path rule and the one 404",
    seams: ["A", "C"],
    evidence: [{ seam: "A", file: "test/board-artifacts.test.ts", runs: BOTH }],
    acceptance: ["a link posted in a chat and opened from a phone"],
    notSatisfiedBy: ["a board served in this process"],
  },
  {
    requirement: "the last wave",
    observation: "the sixth measure beside the five, the recognizer's health shown, and the current reading beside the peak",
    seams: ["A"],
    evidence: [
      { seam: "A", file: "test/metrics-transcribe.test.ts", runs: BOTH },
      { seam: "A", file: "test/board-voice-rows.test.ts", runs: BOTH },
    ],
    acceptance: [],
    notSatisfiedBy: [],
  },
];

/**
 * Whether a row may be serialized as accepted, and why not when it may not.
 *
 * The rules, in the order they are applied: an owner-only row is never closed
 * by anything here, a run that skipped or failed closes nothing, an automated
 * row owes both operating systems, and a gated row owes at least one that
 * really ran.
 */
function accepted(row: Row, exists: (file: string) => boolean): { ok: boolean; because: string } {
  if (row.seams.includes("C") && row.acceptance.length === 0) {
    return { ok: false, because: "an owner-only row with nothing for the owner to record" };
  }
  for (const one of row.evidence) {
    if (!exists(one.file)) return { ok: false, because: `${one.file} does not exist` };
    const said = Object.values(one.runs);
    if (one.seam === "L") {
      // An opt-in check is run by hand and its result is not a round's to claim.
      if (said.length > 0) {
        return { ok: false, because: `${one.file} is run by hand and no automated round may claim it` };
      }
      continue;
    }
    if (said.length === 0) return { ok: false, because: `${one.file} shows no run at all` };
    if (said.includes("failed")) return { ok: false, because: `${one.file} failed` };
    if (!said.includes("ran")) return { ok: false, because: `${one.file} only ever skipped, and a skip never closes a gate` };
    if (one.seam === "A") {
      for (const os of ["macos", "linux"] as const) {
        if (one.runs[os] !== "ran") return { ok: false, because: `${one.file} has no ${os} run` };
      }
    }
  }
  if (row.seams.includes("C") && row.evidence.some((one) => (one.seam as Seam) === "C")) {
    return { ok: false, because: "an owner-only row carries evidence in this repository" };
  }
  return { ok: true, because: "" };
}

/** What an owner-only row answers when a script offers to close it. */
function closedBy(row: Row, by: string): { ok: boolean; because: string } {
  if (row.notSatisfiedBy.includes(by)) {
    return { ok: false, because: `${by} is not ${row.acceptance.join(" and ")}` };
  }
  return { ok: false, because: "an owner-only row is the owner's to record and nothing here closes it" };
}

/**
 * The decisions this phase wrote, with the check file that owns each clause.
 *
 * A clause string appears ONCE across the whole table, which is what says a
 * clause has an owner rather than a hope, and the plan a clause was closed in
 * is recorded beside it so a clause carried across two plans reads as carried
 * rather than as a duplicate.
 */
interface Owner {
  plan: string;
  file: string;
  clause: string;
}

const DECISIONS: Record<string, Owner[]> = {
  "scope and the regression sweep": [
    { plan: "7b-04", file: "test/board-acceptance.test.ts", clause: "the fence on the door and the six windows" },
  ],
  "what a board is": [
    { plan: "7b-02", file: "test/registry-board.test.ts", clause: "the loader's bind and port refusals" },
    { plan: "7b-02", file: "test/run-kind-program.test.ts", clause: "the unit and the argv a board entry renders" },
    { plan: "7b-03", file: "test/board-idle.test.ts", clause: "the bind that fails and the exit it makes" },
    { plan: "7b-03", file: "test/board-pages.test.ts", clause: "every interpolated value through the escape helper" },
  ],
  "who reads it": [
    { plan: "7b-03", file: "test/board-pages.test.ts", clause: "no page carries chat text and no page writes a file" },
    { plan: "7b-03", file: "test/board-acts.test.ts", clause: "every control row the board writes names the board as the actor" },
  ],
  "the pages and what each one reads": [
    { plan: "7b-03", file: "test/board-pages.test.ts", clause: "the four pages and the readers each one calls" },
    { plan: "7b-04", file: "test/metrics-transcribe.test.ts", clause: "the sixth measure beside the five" },
    { plan: "7b-04", file: "test/board-voice-rows.test.ts", clause: "the voice-facing rows the pages render" },
  ],
  "the acts": [
    { plan: "7b-02", file: "test/board-control.test.ts", clause: "restart as the one verb, and stop and pause as a registry field" },
  ],
  "check watches the board": [
    { plan: "7b-02", file: "test/check-board.test.ts", clause: "the shipped findings reach a board entry and no port is opened" },
    { plan: "7b-04", file: "test/board-native.test.ts", clause: "the same watching against a real service manager" },
  ],
  "the read path's cost": [
    { plan: "7b-03", file: "test/board-idle.test.ts", clause: "a board nobody is looking at issues no statement" },
    { plan: "7b-03", file: "test/board-windows.test.ts", clause: "the shipped windows under this phase's registry" },
  ],
  "the transport and the derived tail": [
    { plan: "7b-01", file: "test/chatlog-derive.test.ts", clause: "the derived lines of one chat between two instants" },
    { plan: "7b-01", file: "test/door-clock-replay.test.ts", clause: "the clock line written once, with its own id" },
    { plan: "7b-01", file: "test/spoke-tail.test.ts", clause: "a runner on the other machine fed from the store" },
  ],
  "harvest on a spoke": [
    { plan: "7b-01", file: "test/spoke-harvest.test.ts", clause: "the derived slice and where the watermark lands" },
    { plan: "7b-04", file: "live/spoke-harvest.test.ts", clause: "a real harvester filing into a real vault" },
  ],
  "what survives of the refusal": [
    { plan: "7b-01", file: "test/local-state-preflight.test.ts", clause: "the cross-machine case served and the unreadable root refused" },
  ],
  "the artifacts pages": [
    { plan: "7b-03", file: "test/board-artifacts.test.ts", clause: "the route, the opt-in field and the one 404" },
  ],
  "the six protected windows": [
    { plan: "7b-04", file: "test/board-acceptance.test.ts", clause: "the six windows byte-unchanged by digest" },
  ],
  "requirement seams and evidence": [
    { plan: "7b-04", file: "test/board-acceptance.test.ts", clause: "the inventory and what a skip cannot close" },
  ],
  "the human output contract": [
    { plan: "7b-02", file: "test/board-lines.test.ts", clause: "the seventeen sentences, whole, in both languages" },
    { plan: "7b-04", file: "test/board-voice-rows.test.ts", clause: "no voice-facing row assembles a sentence from fragments" },
  ],
};

/**
 * The six protected windows, by content, as they stand in the tree this branch
 * is rebased onto.
 */
const WINDOWS: Record<string, string> = {
  "test/door-typing.test.ts": "26bf5dfd5068c8ab1a5c3287fd3b9c7f53d021d1c60d678852c7f409c683a1e9",
  "test/door-outbox.test.ts": "019b343c1affd068ef5b37adda3bdb065081bda083a8262b51d10a4d3afc5be9",
  "test/door-clock.test.ts": "bacd4b48bac4b2755876a78c82aa7631f1704b3d1a945e783ef792fc303b605a",
  "test/runner-drain.test.ts": "e8a8a14e7a1025a12624915a0e1b8a90691d1af9c96a1c1e45ad8536841c93f8",
  "test/wait-idle.test.ts": "30905f0bc010ee9f10e275d4d5e0c51eded16951700583888ac4acb52897fc39",
  "test/check-silence.test.ts": "5d2007df83b96ccc61b472507537b9e7b90fa688d65e2ea34260d5af51a22c67",
};

/**
 * Every file under `src/door/`, by the digest it carried before this phase
 * started, and the three this phase is allowed to have changed.
 *
 * The listing beside the digests is the other half: a file quietly ADDED under
 * this directory has no entry to compare against, so the set of paths is
 * asserted as well as their contents.
 */
const DOOR: Record<string, string> = {
  "clock.ts": "257b67a2ad08d659c78fce64878f2a59b41684dd37a87abab9dc56779ef43caf",
  "cursor.ts": "b5f036a0c78361cc136ea3ce8812e10c1fe49b27f6b6da1e746701ae74f6b5ef",
  "denied.ts": "48d0f7e28bb830e9d9f8e10ace5b81a3512d898f2e58ea15f99a1dff01bbbd53",
  "health.ts": "8200bebff84640b1bccf234582c3d1b300470489ec3ce1c8768e26b6b76d744a",
  "ingest.ts": "e2a34bb8d1abb92316ee37dbf0cd7777eff924ccafea558991d2fe49f64c8742",
  "lines.ts": "e92dfa55b7c440553a08585486f06a856b0ac351742be9eb6f53152b41216bde",
  "media.ts": "fa9e9f99d008723030401171675046265e05b5f809946aeb2ee2c284a874e3e7",
  "platform.ts": "e791a58ac9c9582c162ead3fc60242d6fc6d76db624c3d150920ac55570e9529",
  "platforms/discord.ts": "e234bb3acafaea442a2b72d8c38a6cb741aecb67f49d3080331563d803694539",
  "platforms/telegram.ts": "b1662b1523d01073271226c8e051e44845792dbac0bd7202935521e19b23e374",
  "reply.ts": "9a588dab7ebe04e8c779387a22681cc5847dc6fa141efc09367f503c6030ab73",
  "run.ts": "411e910ed6099980cf62fa7c88d3c982f5bb31e6fed4c5c6ff3c2c10cf01ac88",
};

/** The three the contract named, and what each one carries. */
const DOOR_CHANGED: Record<string, string> = {
  "run.ts": "the clock line's once-only append, with its own id, and the diary detail beside it",
  "clock.ts": "the clock detail's two new fields",
  "lines.ts": "the phase's own pinned sentences",
};

/**
 * Two files nothing in this phase may edit, by digest.
 *
 * The first is the untouched-path proof the transcriber shipped with. The
 * second is what says the shipped tail reader's answer did not move when its
 * renderer was pulled out of it.
 */
const UNTOUCHED: Record<string, string> = {
  "test/door-media.test.ts": "db7e42acfd65ae76b20f7e5b9c69d34ae30be782efa27edb902cf990f243251b",
  "test/tail.test.ts": "71446e5d14400d186ca1ea1aab4f73367f35a6685fb1370023a9b3b8ba14801e",
};

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(hubPath(path))).digest("hex");
}

/** Every file under a directory, by its path relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const one of readdirSync(at)) {
      const full = join(at, one);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

test("the inventory names a check file for every automated, gated and opt-in row, and every one of them exists", () => {
  expect(INVENTORY.length).toBe(10);
  for (const row of INVENTORY) {
    expect(row.seams.length, `${row.requirement} names no seam`).toBeGreaterThan(0);
    expect(row.observation.length, `${row.requirement} has no observation`).toBeGreaterThan(0);
    for (const seam of row.seams) {
      if (seam === "C") continue;
      expect(
        row.evidence.some((one) => one.seam === seam),
        `${row.requirement} claims a ${seam} seam and names no file for it`,
      ).toBe(true);
    }
    for (const one of row.evidence) {
      expect(existsSync(hubPath(one.file)), `${row.requirement} names ${one.file}, which is not there`).toBe(true);
    }
  }
  // The harvest row carries BOTH its halves, and they are different files.
  const harvest = INVENTORY.find((row) => row.requirement === "S1, harvest")!;
  expect(harvest.evidence.map((one) => one.file).sort()).toEqual([
    "live/spoke-harvest.test.ts",
    "test/spoke-harvest.test.ts",
  ]);
  expect(harvest.seams.sort()).toEqual(["A", "L"]);
});

test("a missing, a skipped and a failed gated row are each refused, and a skip never closes a gate", () => {
  const there = (file: string) => existsSync(hubPath(file));
  // The CONTROL first: a fully evidenced automated row is accepted, so a
  // validator that refused everything fails here rather than passing.
  const good = INVENTORY.find((row) => row.requirement === "the read path")!;
  expect(accepted(good, there)).toEqual({ ok: true, because: "" });

  const gated = INVENTORY.find((row) => row.requirement === "RUN-13, the board watched")!;
  const withRuns = (runs: Partial<Record<"macos" | "linux", Ran>>): Row => ({
    ...gated,
    evidence: gated.evidence.map((one) => (one.seam === "K" ? { ...one, runs } : one)),
  });

  // A row whose evidence is absent.
  const absent: Row = {
    ...gated,
    evidence: [{ seam: "K", file: "test/a-check-nobody-wrote.test.ts", runs: BOTH }],
  };
  expect(accepted(absent, there).ok).toBe(false);
  expect(accepted(absent, there).because).toContain("does not exist");

  // A row marked skipped on both operating systems.
  const skipped = accepted(withRuns({ macos: "skipped", linux: "skipped" }), there);
  expect(skipped.ok).toBe(false);
  expect(skipped.because).toContain("a skip never closes a gate");

  // A row marked failed.
  const failed = accepted(withRuns({ macos: "ran", linux: "failed" }), there);
  expect(failed.ok).toBe(false);
  expect(failed.because).toContain("failed");

  // A row with no run recorded at all.
  const nothing = accepted(withRuns({}), there);
  expect(nothing.ok).toBe(false);
  expect(nothing.because).toContain("shows no run at all");

  // An automated row that ran on one operating system only.
  const onlyHere = INVENTORY.find((row) => row.requirement === "the last wave")!;
  const halfway: Row = {
    ...onlyHere,
    evidence: onlyHere.evidence.map((one) => ({ ...one, runs: { macos: "ran" as Ran } })),
  };
  expect(accepted(halfway, there).ok).toBe(false);
  expect(accepted(halfway, there).because).toContain("no linux run");
});

test("an owner-only row is never closed by a script, and the wrong thing is refused by name", () => {
  const tailnet = INVENTORY.find((row) => row.requirement === "RUN-05, tailnet only")!;
  const spoke = INVENTORY.find((row) => row.requirement === "S1, the tail")!;

  // An in-process board is not the board reached from another device.
  const inProcess = closedBy(tailnet, "a board served in this process");
  expect(inProcess.ok).toBe(false);
  expect(inProcess.because).toContain("the board opened from a second device on the tailnet");

  // Two declared machines in one registry on one box prove no hop.
  const oneBox = closedBy(spoke, "two declared machines in one registry on one box");
  expect(oneBox.ok).toBe(false);
  expect(oneBox.because).toContain("answering a message sent from a phone");

  // And anything else offered for an owner-only row is refused too.
  expect(closedBy(tailnet, "a check nobody has written yet").ok).toBe(false);

  // The four owner-only rows are present, marked, and carry NO evidence here:
  // the board opened from a phone on the tailnet, the one act performed and
  // read back in the ledger, the artifact link opened from a chat, and a runner
  // on the second machine answering a phone message, which is acceptance only
  // if an agent is ever placed there.
  const owned = INVENTORY.filter((row) => row.seams.includes("C"));
  expect(owned.length).toBe(4);
  for (const row of owned) {
    expect(row.acceptance.length, `${row.requirement} names nothing for the owner to do`).toBeGreaterThan(0);
    expect(
      row.evidence.some((one) => (one.seam as string) === "C"),
      `${row.requirement} claims evidence for an owner-only seam`,
    ).toBe(false);
  }
});

test("every clause of this phase's decisions has an owning check file, and no clause is claimed twice", () => {
  const decisions = Object.entries(DECISIONS);
  expect(decisions.length).toBe(14);

  const clauses = decisions.flatMap(([, owners]) => owners.map((one) => one.clause));
  expect(new Set(clauses).size, `a clause is claimed twice: ${clauses.join(" | ")}`).toBe(clauses.length);

  for (const [decision, owners] of decisions) {
    expect(owners.length, `${decision} has no owner`).toBeGreaterThan(0);
    for (const one of owners) {
      expect(existsSync(hubPath(one.file)), `${decision} names ${one.file}, which is not there`).toBe(true);
      expect(one.plan).toMatch(/^7b-0[1-4]$/);
    }
  }

  // A clause CARRIED ACROSS TWO PLANS is recorded as carried rather than
  // pretended away. The two the plan named are here, and so are three more it
  // did not: watching a board against a real manager, filing from a real vault
  // and pinning the voice-facing sentences all landed in the wave that could
  // reach them, later than the wave that opened the decision.
  const carried = decisions
    .filter(([, owners]) => new Set(owners.map((one) => one.plan)).size > 1)
    .map(([decision]) => decision)
    .sort();
  expect(carried).toEqual(
    [
      "check watches the board",
      "harvest on a spoke",
      "the human output contract",
      "the pages and what each one reads",
      "what a board is",
    ].sort(),
  );
});

test("the six protected windows are byte-unchanged", () => {
  for (const [path, said] of Object.entries(WINDOWS)) {
    expect(existsSync(hubPath(path)), `${path} is gone`).toBe(true);
    expect(digest(path), `${path} changed`).toBe(said);
  }
});

test("exactly three files under the door changed, and a fourth would fail", () => {
  const dir = hubPath("src/door");
  // The listing first: a file added or dropped has no digest to compare
  // against, so the set of paths is what catches it.
  expect(filesUnder(dir).sort()).toEqual(Object.keys(DOOR).sort());

  const moved = Object.keys(DOOR).filter((path) => digest(join("src/door", path)) !== DOOR[path]);
  expect(
    moved.sort(),
    `the door's changed set is ${moved.join(", ")} and the contract named ${Object.keys(DOOR_CHANGED).join(", ")}`,
  ).toEqual(Object.keys(DOOR_CHANGED).sort());
  for (const [path, what] of Object.entries(DOOR_CHANGED)) {
    expect(what.length, `${path} changed for no stated reason`).toBeGreaterThan(0);
  }
});

test("the transcriber's untouched-path proof and the shipped tail check are unedited", () => {
  for (const [path, said] of Object.entries(UNTOUCHED)) {
    expect(digest(path), `${path} changed`).toBe(said);
  }
});
