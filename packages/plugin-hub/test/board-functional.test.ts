// What the board shows an operator, pinned on its own: where an open message
// really stands, another machine's declared entries with what the store
// recorded about them, a `check` command filled in with this machine's own
// registry file, and a recorded cause as one plain line. (RUN-05, SPEC §2, §6)
//
// THE PURE HALVES FIRST. The placing of a turn, the filling of a command and the
// reduction of a cause are functions of what they are handed, so most of this
// file needs no server and no store. The two readers that do need the store are
// checked against a throwaway cluster with the rows planted the way the runner
// and the door write them, and with a real client connected under a runner's
// name, because "connected" is the server's own client list and nothing else.
//
// NOTHING HERE WRITES A LIFECYCLE ROW THROUGH THE BOARD. The rows are planted by
// the check as superuser, the board reads them, and the check asserts the rows
// are byte for byte what it planted afterwards.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { DOOR, RUNNER, stageHub, superStore, plantChatLine, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { openStore, type Store } from "../src/store/connect.ts";
import { fillCommand, mib, plainCause, plainLine, requestCause, withRegistry, type CommandPlaces } from "../src/board/plain.ts";
import { shellWord } from "../src/os/diff.ts";
import { placeTurn, readTurnStates, summarizeTurns, type TurnFacts } from "../src/board/turns.ts";
import { defaultTools, readApprovals, readRemoteFacts } from "../src/board/fleet.ts";
import { readRegistryDigests, recordRegistryDigest } from "../src/hub/digest.ts";
import { registryDigest } from "../src/registry/load.ts";
import { previewOf, readChatNewest } from "../src/board/chats.ts";
import { chatLine, chatsPage, findingsPage, machinesPage, metricsPage, overviewPage, peoplePage, usagePage, wordFor, type CheckRow } from "../src/board/pages.ts";
import { VALIDATED_ORDINARY_PROFILES } from "../src/adapters/claude-code.ts";
import { ORDINARY_PROFILE } from "../src/adapters/opencode-config.ts";
import { RegistryEditRefused } from "../src/registry/edit.ts";
import { whole, wordsCell } from "../src/board/html.ts";
import { cardOk, cardQueued, cardWaiting, chatHealthy, chatPaused } from "../src/door/lines.ts";
import type { AgentEntry, MachineEntry, RunEntry } from "../src/registry/load.ts";
import type { MetricsRow } from "../src/metrics/stamps.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const THERE = HERE === "mac" ? "pi" : "mac";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const THERE_OS = HERE_OS === "macos" ? "linux" : "macos";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

const scratch: string[] = [];
function scratchDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

let cluster: Cluster | undefined;
afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

// ---------------------------------------------------------------- commands

test("a check command names a registry file that exists where it runs: this board's own or the one the other hub reported, and never a guess", () => {
  const registryFile = "/srv/hub state/it's registry.toml";
  const quoted = `'/srv/hub state/it'\\''s registry.toml'`;
  expect(shellWord(registryFile)).toBe(quoted);
  expect(shellWord("/var/lib/imprnt-hub/registry.toml")).toBe("/var/lib/imprnt-hub/registry.toml");
  const context: CommandPlaces = { here: "pi", registryFile, machines: ["pi", "mac"] };
  const only = (text: string, on: string) => ({ lead: "", text, tail: "", on, unavailable: "" });

  // Written on this machine, run on this machine.
  expect(fillCommand("imprnt hub recover <registry> agent:p1-lair", "pi", context))
    .toEqual(only(`imprnt hub recover ${quoted} agent:p1-lair`, "pi"));
  // `recover` writes one row into the shared store and the target's own hub
  // carries it out, so it runs HERE even when another machine wrote it.
  expect(fillCommand("imprnt hub recover <registry> door:door-a", "mac", context))
    .toEqual(only(`imprnt hub recover ${quoted} door:door-a`, "pi"));
  // In a household with two routes to the store the command must name its
  // machine, and this one is named; one that already names a machine is kept.
  const routed = { ...context, routesDiffer: true };
  expect(fillCommand("imprnt hub recover <registry> agent:p1-lair", "mac", routed).text)
    .toBe(`imprnt hub recover ${quoted} agent:p1-lair pi`);
  expect(fillCommand("imprnt hub recover <registry> agent:p1-lair mac", "mac", routed).text)
    .toBe(`imprnt hub recover ${quoted} agent:p1-lair mac`);

  // Run on the other machine, whose hub reported its file: that file, quoted,
  // with spaces and a single quote in it, run exactly as a shell would read it.
  const theirs = "/Users/some one/it's; odd, dir/registry.toml";
  const reported = { ...context, files: { mac: theirs } };
  expect(fillCommand("imprnt hub status <registry> mac", "pi", reported))
    .toEqual(only(`imprnt hub status ${shellWord(theirs)} mac`, "mac"));

  // Not reported yet: NO command, and one plain sentence saying why. Never a
  // placeholder, never this board's path, never an expression that reads a
  // unit file whose layout is assumed.
  const unreported = fillCommand("imprnt hub status <registry> mac", "pi", context);
  expect(unreported).toEqual({
    lead: "", text: "", tail: "", on: "mac",
    unavailable: "no command is shown: the hub on mac has not reported which registry file it runs with.",
  });
  for (const one of Object.values(unreported)) {
    expect(one).not.toContain("<registry");
    expect(one).not.toContain(registryFile);
    expect(one).not.toMatch(/plutil|systemctl|awk|\$\(/);
  }
  // This machine named explicitly wins over whoever wrote it.
  expect(withRegistry("imprnt hub status <registry> pi", { ...context, found: "mac" })).toBe(`imprnt hub status ${quoted} pi`);
  // A single-machine file says no machine on its findings, and no "run on".
  expect(fillCommand("imprnt hub recover <registry> agent:x", "", { here: "pi", registryFile, machines: ["pi"] }))
    .toEqual(only(`imprnt hub recover ${quoted} agent:x`, ""));
  // Every placeholder in one whole command, each placed on its own.
  expect(withRegistry("imprnt hub status <registry> mac; imprnt hub check <registry>", { ...reported, found: "pi" }))
    .toBe(`imprnt hub status ${shellWord(theirs)} mac; imprnt hub check ${quoted}`);
  // A command with no placeholder is the command check wrote, whole: its own
  // `;` and its own quoted path are part of it and are never cut.
  expect(withRegistry("systemctl --user reset-failed imprnt-hub-runner-a.service", { ...context, found: "pi" }))
    .toBe("systemctl --user reset-failed imprnt-hub-runner-a.service");
  const removal = `systemctl --user disable --now imprnt-hub-x.service; rm -f ${shellWord("/home/a b/it's; here, too.service")}; systemctl --user daemon-reload`;
  expect(fillCommand(removal, "pi", context)).toEqual(only(removal, "pi"));
  const bootstrap = `launchctl bootstrap gui/501 "$HOME/Library/LaunchAgents/imprnt-hub-x.plist"`;
  expect(fillCommand(bootstrap, "pi", context)).toEqual(only(bootstrap, "pi"));
});

test("a fix that is a sentence keeps its words out of the copy box, and only an imprnt hub command is taken out of one", () => {
  const registryFile = "/srv/hub state/it's registry.toml";
  const quoted = shellWord(registryFile);
  const theirs = "/Users/some one/it's; odd, dir/registry.toml";
  const context: CommandPlaces = { here: "pi", registryFile, machines: ["pi", "mac"], files: { mac: theirs } };

  // The registry-stale fix: the command alone in the box, the instruction to
  // copy the registry as words beneath it. The path is filled in AFTER the
  // split, so its own `;`, `,` and quote never decide where the command ends.
  const stale = fillCommand("check the hub on mac: imprnt hub status <registry> mac there, and copy the registry from pi to mac again", "pi", context);
  expect(stale).toEqual({
    lead: "check the hub on mac", text: `imprnt hub status ${shellWord(theirs)} mac`,
    tail: "then copy the registry from pi to mac again", on: "mac", unavailable: "",
  });
  // The topics fix: a `;` the sentence puts after the command.
  expect(fillCommand("check the hub on mac: imprnt hub status <registry> mac; the chat and the owner's message are kept and nothing is lost", "pi", context))
    .toMatchObject({ lead: "check the hub on mac", text: `imprnt hub status ${shellWord(theirs)} mac`, tail: "the chat and the owner's message are kept and nothing is lost" });
  // On this machine, with this board's own quoted file.
  expect(fillCommand("check the hub on pi: imprnt hub status <registry> pi there", "mac", context))
    .toMatchObject({ lead: "check the hub on pi", text: `imprnt hub status ${quoted} pi`, tail: "", on: "pi" });
  // The sentence's words are never a command: a word after the command that is
  // not an argument the verb takes ends it, a machine the file does not declare
  // included.
  expect(fillCommand("run imprnt hub status <registry> laptop now", "pi", context).text).toBe(`imprnt hub status ${quoted}`);
  // A sentence starting with a program name is still a sentence.
  for (const prose of [
    "imprnt hub check, then look at the unresolved attempt of p1-lair: a stop that cannot be shown stays unresolved by design",
    "enable user lingering with loginctl enable-linger",
    "read the journal of imprnt-hub-door-a and inspect its store connection and outbox delivery loop",
    "in the owner's chat: /recover p1-lair x1 2 continue, keep-held, or fresh-context",
    "run claude --help by hand to see whether it answers, then imprnt hub check /srv/x/registry.toml",
  ]) {
    expect(fillCommand(prose, "pi", context), prose).toEqual({ lead: prose, text: "", tail: "", on: "", unavailable: "" });
  }
  // A placeholder in a sentence that carries no command is said in words.
  expect(fillCommand("copy <registry> to the other machine", "pi", context).lead).toBe("copy the registry file to the other machine");
  // A sentence whose command names a machine whose hub has not reported: the
  // words stay, the box does not appear, and why is said.
  expect(fillCommand("check the hub on mac: imprnt hub status <registry> mac there", "pi", { ...context, files: {} }))
    .toEqual({ lead: "check the hub on mac", text: "", tail: "", on: "mac",
      unavailable: "no command is shown: the hub on mac has not reported which registry file it runs with." });
  // With no box between them the words before and after the command are one
  // sentence again, joined the way they read, and no line starts with "and".
  expect(fillCommand("check the hub on mac: imprnt hub status <registry> mac there, and copy the registry from pi to mac again", "pi", { ...context, files: {} }))
    .toEqual({ lead: "check the hub on mac, and copy the registry from pi to mac again", text: "", tail: "", on: "mac",
      unavailable: "no command is shown: the hub on mac has not reported which registry file it runs with." });
  expect(fillCommand("check the hub on mac: imprnt hub status <registry> mac; the chat and the owner's message are kept and nothing is lost", "pi", { ...context, files: {} }).lead)
    .toBe("check the hub on mac. the chat and the owner's message are kept and nothing is lost");

  // On both pages: every copy box holds a command and nothing else, the words
  // sit outside it in the reading face, and the bare placeholder is nowhere.
  const findings: CheckRow[] = [
    { id: "f1", kind: "agent-retry", subject: "p1-lair", machine: "pi", says: "agent-retry: p1-lair: task failed.",
      fix: "imprnt hub recover <registry> agent:p1-lair", updated_at: "2026-10-04T00:30:00.000Z" },
    { id: "f2", kind: "registry-stale", subject: "mac", machine: "pi", says: "mac's copy of the registry is not the one pi runs",
      fix: "check the hub on mac: imprnt hub status <registry> mac there, and copy the registry from pi to mac again", updated_at: "2026-10-04T00:31:00.000Z" },
    { id: "f3", kind: "linger", subject: "pi", machine: "pi", says: "user lingering is disabled",
      fix: "enable user lingering with loginctl enable-linger", updated_at: "2026-10-04T00:32:00.000Z" },
  ];
  const pages = [
    findingsPage({ findings, fix: context }),
    overviewPage({
      machine: "pi", entries: [], machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }] as MachineEntry[], status: [], findings, peaks: [],
      remote: {}, acts: [], people: [], agents: [], turns: {}, agentHealth: [], doorHealth: [], lifetimes: {}, now: new Date("2026-10-04T01:00:00Z"), fix: context,
    }),
  ];
  const decode = (html: string) => html.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  for (const page of pages) {
    // The first screen shows a remote machine's findings in its fold too, so a
    // command may be there twice; each box is still one of the two commands.
    const boxes = [...new Set([...page.matchAll(/<code class="cmd">([^<]*)<\/code>/g)].map((one) => decode(one[1])))];
    expect(boxes).toEqual([`imprnt hub recover ${quoted} agent:p1-lair`, `imprnt hub status ${shellWord(theirs)} mac`]);
    for (const box of boxes) {
      expect(box.startsWith("imprnt ")).toBe(true);
      expect(box).not.toMatch(/: |there, and/);
    }
    expect(page).toContain('<span class="lead">check the hub on mac</span><span class="on">run on mac</span>');
    expect(page).toContain('<span class="tail">then copy the registry from pi to mac again</span>');
    expect(page).not.toMatch(/<span class="(?:lead|tail|none)">and /);
    expect(page).toContain('<span class="lead">enable user lingering with loginctl <span class="nw">enable-linger</span></span>');
    expect(page).not.toContain("&lt;registry");
  }
  // The quoted path, escaped for HTML, inside the box a tap selects.
  expect(pages[0]).toContain(`<code class="cmd">imprnt hub recover &#39;/srv/hub state/it&#39;\\&#39;&#39;s registry.toml&#39; agent:p1-lair</code>`);
  expect(pages[0]).toContain('<span class="on">run on pi</span>');
});

test("a finding's sentence on a page does not repeat its own kind or subject, which are printed beside it", () => {
  const context: CommandPlaces = { here: "pi", registryFile: "/srv/registry.toml", machines: ["pi"] };
  const findings: CheckRow[] = [
    { id: "f1", kind: "agent-retry", subject: "p1-lair", machine: "pi", says: "agent-retry: p1-lair: the model provider answered 529 overloaded three times.",
      fix: "imprnt hub recover <registry> agent:p1-lair", updated_at: "2026-10-04T00:30:00.000Z" },
    { id: "f2", kind: "memory-over-limit", subject: "runner-pi", machine: "pi", says: "runner-pi was last measured holding 566 MB and the registry asks for 512 MB",
      fix: "raise memory_limit_mb for runner-pi in <registry>", updated_at: "2026-10-04T00:31:00.000Z" },
  ];
  const listed = findingsPage({ findings, fix: context });
  const first = overviewPage({
    machine: "pi", entries: [], machines: [{ id: "pi", os: "linux" }] as MachineEntry[], status: [], findings, peaks: [],
    remote: {}, acts: [], people: [], agents: [], turns: {}, agentHealth: [], doorHealth: [], lifetimes: {}, now: new Date("2026-10-04T01:00:00Z"), fix: context,
  });
  expect(listed).toContain('data-label="what it says" class="said">the model provider answered 529 overloaded three times.</td>');
  expect(listed).toContain('data-label="what it says" class="said">was last measured holding 566 MB and the registry asks for 512 MB</td>');
  expect(first).toContain('<div class="says">the model provider answered 529 overloaded three times.</div>');
  for (const page of [listed, first]) {
    const said = [...page.matchAll(/(?:class="said"|class="says")>([^<]*)</g)].map((one) => one[1]);
    expect(said.length).toBeGreaterThan(0);
    for (const one of said) expect(one).not.toMatch(/^(?:agent-retry|memory-over-limit|p1-lair|runner-pi)\b/);
  }
  // On a wide screen the fix column keeps room for its command, so a copy box
  // is never squeezed until a file name breaks inside it.
  expect(listed).toContain("td.fix { min-width: min(26rem, 45vw); width: 40%; }");
});

// ---------------------------------------------------------------- causes, memory

test("a recorded cause is one plain line: a closed code kept, a driver error, a JSON body or a stack reduced, nothing raw", () => {
  expect(plainCause("recovery-target-stopped")).toBe("recovery-target-stopped");
  expect(plainCause("enabled-not-for-this-kind")).toBe("enabled-not-for-this-kind");
  expect(plainCause("task failed")).toBe("task failed");
  expect(plainCause(null)).toBe("");
  expect(plainCause(undefined)).toBe("");

  const driver = 'PostgresError: duplicate key value violates unique constraint "execution_one_per_agent"\nDETAIL: Key (agent)=(p1-lair) already exists.';
  expect(plainCause(driver)).toBe("operation failed");
  expect(plainCause(new Error('relation "replay_hold" does not exist'))).toBe("operation failed");
  expect(plainCause("connection refused")).toBe("operation failed");
  expect(plainCause("permission denied for table execution")).toBe("access denied");
  expect(plainCause("ENOENT: no such file or directory, open '/srv/private/thing.json'")).toBe("operation failed");
  expect(plainCause("EACCES: permission denied, open '/srv/private/thing.json'")).toBe("access denied");

  // A body a service answered with is read for the cause it names.
  expect(plainCause('{"error":{"type":"overloaded","message":"model overloaded"},"request_id":"r-1"}')).toBe("model overloaded");
  expect(plainCause('{"cause":"login refused","detail":{"body":"<html>…</html>"}}')).toBe("login refused");
  expect(plainCause('{"detail":{"nested":true}}')).toBe("operation failed");
  expect(plainCause("[1,2,3]")).toBe("operation failed");

  // A stack never reaches the page: the first line, its prefix taken off.
  const stack = new Error("the candidate file would not load");
  stack.stack = "Error: the candidate file would not load\n    at edit (/srv/hub/src/registry/edit.ts:272:13)";
  expect(plainCause(stack)).toBe("the candidate file would not load");
  expect(plainCause("TypeError: x is not a function\n    at /srv/hub/src/a.ts:1:1")).toBe("x is not a function");

  // The registry editor's own step, which is closed, and never its path.
  expect(plainCause(new RegistryEditRefused("locked", "/srv/hub/registry.toml is being edited"))).toBe("registry-edit-locked");

  // One line, bounded, and nothing that writes another.
  const long = plainCause("x ".repeat(400));
  expect(long.length).toBeLessThanOrEqual(160);
  expect(long.endsWith("…")).toBe(true);
  for (const one of [plainCause("one\ntwo"), plainCause("a\u0007b"), plainLine("one\r\ntwo")]) {
    expect(one).not.toMatch(/[\r\n\u0007]/);
  }

  // A finding's sentence is printed in its own words; only what is not a sentence is reduced.
  expect(plainLine("p1-lair is retrying: permission denied")).toBe("p1-lair is retrying: permission denied");
  expect(plainLine('{"cause":"window"}')).toBe("window");
  expect(plainLine("first line\n    at somewhere (/srv/x.ts:1:1)")).toBe("first line");
});

test("memory reads in MiB, the unit the limit is enforced in, and nothing is not zero", () => {
  expect(mib(null)).toBeNull();
  expect(mib(undefined)).toBeNull();
  expect(mib(Number.NaN)).toBeNull();
  expect(mib(0)).toBe("0 MiB");
  expect(mib(4096)).toBe("<0.1 MiB");
  expect(mib(1024 * 1024)).toBe("1.0 MiB");
  expect(mib(456 * 1024 * 1024)).toBe("456.0 MiB");
  expect(mib(456_123_000)).toBe("435.0 MiB");
});

test("the acts table and the voice table print a recorded cause as one plain line", () => {
  const machines = machinesPage({
    machine: "pi", entries: [], machines: [{ id: "pi", os: "linux" }], status: [], findings: [], peaks: [],
    acts: [{ id: "c1", target_id: "runner-a", target_kind: "run", actor: "board", status: "refused",
      cause: 'PostgresError: syntax error at or near "("\n    at /srv/hub/src/store/x.ts:1:1', requested_at: "2026-10-04T00:30:00.000Z" }],
  });
  expect(machines).toContain(">operation failed<");
  expect(machines).not.toContain("syntax error");
  expect(machines).not.toContain("/srv/hub");
  const metrics = metricsPage({
    rows: [],
    health: [{ recognizer: "local", since: "2026-10-04T00:00:00.000Z", class: "infra", cause: '{"error":{"message":"upstream timed out"}}',
      attempts: 3, retry_at: null, last_ok_at: null } as never],
  });
  expect(metrics).toContain(">upstream timed out<");
  expect(metrics).not.toContain("{&quot;error");
});

// ---------------------------------------------------------------- turns, pure

const BASE: TurnFacts = {
  agent: "a1", id: "m1", state: "received", received_at: "2026-10-04T00:10:00.000Z",
  claimed_by: null, claim_current: true, claimer_connected: false, retry_at: null, retry_pending: false,
  hold_cause: null, hold_state: null, hold_at: null,
  execution_state: null, execution_runner: null, execution_started_at: null, owner_current: false, owner_connected: false,
};

test("an open message is answering only when an attempt may be running with its owner current and connected", () => {
  const running = { ...BASE, state: "started", claimed_by: "runner-a", execution_state: "running", execution_runner: "runner-a",
    execution_started_at: "2026-10-04T00:11:00.000Z", owner_current: true, owner_connected: true };
  expect(placeTurn(running)).toMatchObject({ state: "answering", reason: "answering", runner: "runner-a", at: "2026-10-04T00:11:00.000Z" });
  for (const attempt of ["claimed", "feed_intent", "received", "running", "stop_requested"]) {
    expect(placeTurn({ ...running, execution_state: attempt })!.state, attempt).toBe("answering");
  }
  // Each of the three facts missing, alone, is not answering.
  expect(placeTurn({ ...running, owner_connected: false })).toMatchObject({ state: "stale", reason: "owner-gone" });
  expect(placeTurn({ ...running, owner_current: false })).toMatchObject({ state: "stale", reason: "owner-gone" });
  expect(placeTurn({ ...running, execution_state: "completed", claimed_by: null })).toMatchObject({ state: "stale", reason: "orphaned" });
  // Nobody shows the attempt is over.
  expect(placeTurn({ ...running, execution_state: "unknown" })).toMatchObject({ state: "stale", reason: "ownership-unknown" });
  expect(placeTurn({ ...running, execution_state: "stop_unknown" })).toMatchObject({ state: "stale", reason: "ownership-unknown" });
  // It may have reached the engine, is never fed again, and nobody was asked.
  expect(placeTurn({ ...running, execution_state: "interrupted" })).toMatchObject({ state: "stale", reason: "not-held" });
});

test("a hold outranks every attempt, and the queue is unclaimed, claimed by a connected runner, or waiting out a retry", () => {
  const held = { ...BASE, state: "acked", hold_state: "held", hold_cause: "interrupted", hold_at: "2026-10-04T00:20:00.000Z",
    execution_state: "interrupted", execution_runner: "runner-a" };
  expect(placeTurn(held)).toMatchObject({ state: "held", reason: "hold", cause: "interrupted", at: "2026-10-04T00:20:00.000Z" });
  expect(placeTurn({ ...held, hold_state: "keep_held" })).toMatchObject({ state: "held", reason: "hold" });
  for (const hold of ["continue_pending", "continuing"]) {
    expect(placeTurn({ ...held, hold_state: hold }), hold).toMatchObject({ state: "held", reason: "continuing" });
  }
  expect(placeTurn({ ...held, execution_state: "running", owner_current: true, owner_connected: true })!.state).toBe("held");

  expect(placeTurn(BASE)).toMatchObject({ state: "queued", reason: "unclaimed", at: "2026-10-04T00:10:00.000Z" });
  expect(placeTurn({ ...BASE, claimed_by: "runner-a", claimer_connected: true, claim_current: true }))
    .toMatchObject({ state: "queued", reason: "claimed", runner: "runner-a" });
  expect(placeTurn({ ...BASE, state: "acked", retry_at: "2026-10-04T00:40:00.000Z", retry_pending: true }))
    .toMatchObject({ state: "queued", reason: "retry", at: "2026-10-04T00:40:00.000Z" });
  // A failed attempt was never given the input, and the row is tried again.
  expect(placeTurn({ ...BASE, state: "acked", execution_state: "failed", execution_runner: "runner-a" })!.state).toBe("queued");

  // A claim whose runner is gone, or whose deadline passed, is not a queue.
  expect(placeTurn({ ...BASE, state: "acked", claimed_by: "runner-a", claimer_connected: false }))
    .toMatchObject({ state: "stale", reason: "owner-gone", runner: "runner-a" });
  expect(placeTurn({ ...BASE, state: "acked", claimed_by: "runner-a", claimer_connected: true, claim_current: false }))
    .toMatchObject({ state: "stale", reason: "owner-gone" });
  // Said to have started, and held by nothing.
  expect(placeTurn({ ...BASE, state: "started" })).toMatchObject({ state: "stale", reason: "orphaned", runner: null });
});

test("an original input whose hold the owner's recovery choice released is left out of current activity entirely", () => {
  // The shape the owner's live store showed on 30 Sept, as read-only evidence:
  // the input received, unclaimed, no retry, one interrupted attempt and no
  // active one, and its hold released by a fresh context at revision 2.
  const released: TurnFacts = { ...BASE, id: "m-original", state: "received", claimed_by: null, retry_at: null,
    hold_state: "released", hold_cause: "interrupted", hold_at: "2026-09-30T08:00:00.000Z",
    execution_state: "interrupted", execution_runner: "runner-a" };
  expect(placeTurn(released)).toBeNull();
  // Whatever else the row says, a released hold is never answering, queued,
  // held or unfinished.
  for (const attempt of ["interrupted", "stopped", "running", "unknown", null]) {
    expect(placeTurn({ ...released, execution_state: attempt, owner_current: true, owner_connected: true }), String(attempt)).toBeNull();
  }
  const summary = summarizeTurns([released]);
  expect(summary.a1).toBeUndefined();
  // Beside ordinary rows it changes nothing they say.
  const mixed = summarizeTurns([released, { ...BASE, id: "q1", received_at: "2026-10-04T00:01:00.000Z" }]);
  expect(mixed.a1.counts).toEqual({ answering: 0, queued: 1, held: 0, stale: 0 });
  expect(mixed.a1.since).toBe("2026-10-04T00:01:00.000Z");
  // On the card and on the first screen: nothing about it at all.
  const agent = { id: "a1", person: "p1", chat: "c1", door: "d1", runner: "runner-a", preset: "daily" } as AgentEntry;
  expect(wordFor({ findings: [], about: ["a1"], turns: summarizeTurns([released]).a1 })).toBe(cardOk("en"));
  const line = chatLine({ agent, findings: [], turns: summarizeTurns([released]).a1, sleeping: false, now: new Date("2026-10-04T12:00:00Z") });
  expect(line).toMatchObject({ rank: 5, says: chatHealthy("en"), why: null });
  for (const said of [line.says, wordFor({ findings: [], about: ["a1"], turns: summarizeTurns([released]).a1 })]) {
    expect(said).not.toMatch(/answering|queued|waiting to be picked|held|retained|unfinished/);
  }
});

test("a retry an operator resolved on its evidence is not said as retrying, from the health row or a sheet written before it", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const agent = { id: "a1", person: "p1", chat: "c1", door: "d1", runner: "runner-a", preset: "daily" } as AgentEntry;
  const retry = { status: "retry", cause: "Error: Connection closed", retry_at: "2026-10-04T11:00:30.000Z" };
  const stale: CheckRow = { id: "f", kind: "agent-retry", subject: "a1", machine: "pi", says: "agent-retry: a1: Connection closed.", fix: "", updated_at: now.toISOString() };
  // Unresolved, it is retrying, from the row alone or from the finding.
  expect(chatLine({ agent, findings: [], agentHealth: retry, sleeping: false, now }).rank).toBe(2);
  expect(chatLine({ agent, findings: [stale], agentHealth: retry, sleeping: false, now }).rank).toBe(0);
  // Resolved: what the chat is doing now, with the resolution as its why.
  const resolved = { ...retry, resolved: true };
  for (const findings of [[], [stale]]) {
    expect(chatLine({ agent, findings, agentHealth: resolved, sleeping: false, now })).toMatchObject({ rank: 5, says: chatHealthy("en"), why: "retry resolved by an operator" });
  }
  expect(chatLine({ agent, findings: [], agentHealth: resolved, sleeping: true, now })).toMatchObject({ rank: 4, why: "retry resolved by an operator" });
  // Another finding about the same agent still stands.
  const other: CheckRow = { ...stale, id: "g", kind: "unit-missing", says: "unit-missing: a1." };
  expect(chatLine({ agent, findings: [stale, other], agentHealth: resolved, sleeping: false, now }).rank).toBe(0);
});

test("the first screen says held, busy, waiting and healthy as four different things, problems first", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  const agent = (id: string, extra: Partial<AgentEntry> = {}) =>
    ({ id, person: "p1", chat: `chat-${id}`, door: "door-a", runner: "runner-a", preset: "daily", ...extra }) as AgentEntry;
  const held = summarizeTurns([{ ...BASE, agent: "held", hold_state: "held", hold_cause: "interrupted", hold_at: "2026-10-04T11:00:00.000Z",
    execution_state: "interrupted", execution_runner: "runner-a" }]).held;
  const busy = summarizeTurns([{ ...BASE, agent: "busy", state: "started", claimed_by: "runner-a", execution_state: "running",
    execution_runner: "runner-a", execution_started_at: "2026-10-04T11:58:00.000Z", owner_current: true, owner_connected: true }]).busy;
  const queued = summarizeTurns([{ ...BASE, agent: "queued", received_at: "2026-10-04T11:59:00.000Z" }]).queued;
  const stuck = summarizeTurns([{ ...BASE, agent: "stuck", state: "acked", claimed_by: "runner-gone", claimer_connected: false }]).stuck;

  const heldLine = chatLine({ agent: agent("held"), findings: [], turns: held, sleeping: false, now });
  // The unreleased hold says exactly that, and why in the closed hold words.
  expect(heldLine.says).toBe("1 message held, waiting for a recovery choice");
  expect(heldLine.why).toBe("held since 11:00 UTC: the attempt is over and did not finish.");
  expect(heldLine.rank).toBe(1);
  // Busy only for a turn the store shows running with its owner current and connected.
  const busyLine = chatLine({ agent: agent("busy"), findings: [], turns: busy, sleeping: false, now });
  expect(busyLine).toMatchObject({ rank: 3, says: "busy: answering a message since 11:58 UTC" });
  // An ordinary queued message is neither busy nor held.
  const queuedLine = chatLine({ agent: agent("queued"), findings: [], turns: queued, sleeping: false, now });
  expect(queuedLine).toMatchObject({ rank: 3, says: cardQueued("en", { count: 1 }), why: "waiting for a runner since 11:59 UTC." });
  expect(queuedLine.says).not.toMatch(/busy|answering|held/);
  const stuckLine = chatLine({ agent: agent("stuck"), findings: [], turns: stuck, sleeping: false, now });
  expect(stuckLine).toMatchObject({ rank: 0, says: "stuck: runner-gone took it and is not working on it now." });
  // A finding outranks the store's states and is said as ONE state, without
  // the name the row is headed by and without its own kind's code: check's
  // closed line is `agent-retry: <agent>: <cause>.`, and a retrying agent is
  // retrying, never "stuck" and "retrying" at once.
  const closed: CheckRow = { id: "f", kind: "agent-retry", subject: "busy", machine: "pi", says: "agent-retry: busy: task failed.", fix: "", updated_at: now.toISOString() };
  const retried = chatLine({ agent: agent("busy"), findings: [closed], turns: busy, sleeping: false, now });
  expect(retried).toMatchObject({ rank: 0, says: "retrying: task failed", why: null });
  // With the agent's own health row beside it, the row's cause and its next try.
  expect(chatLine({ agent: agent("busy"), findings: [closed], turns: busy, sleeping: false, now,
    agentHealth: { status: "retry", cause: "the model provider answered 529 overloaded three times", retry_at: "2026-10-04T12:05:00.000Z" } }))
    .toMatchObject({ rank: 0, says: "retrying: the model provider answered 529 overloaded three times", why: "trying again at 12:05 UTC." });
  // The same in a hand-written sentence that names its subject first.
  const written: CheckRow = { ...closed, says: "busy is retrying: task failed" };
  expect(chatLine({ agent: agent("busy"), findings: [written], turns: busy, sleeping: false, now }).says).toBe("retrying: task failed");
  // Any other finding is "stuck", once; when its words carry a colon of their
  // own, the state stands alone and the words are the why.
  const memory: CheckRow = { ...closed, kind: "agent-unboxed", says: "busy cannot start and will not answer anyone, because the person p1 declares no tree" };
  expect(chatLine({ agent: agent("busy"), findings: [memory], sleeping: false, now }).says)
    .toBe("stuck: cannot start and will not answer anyone, because the person p1 declares no tree");
  const colon: CheckRow = { ...closed, kind: "sender-refused", says: "busy refused a sender: 1234" };
  expect(chatLine({ agent: agent("busy"), findings: [colon], sleeping: false, now })).toMatchObject({ says: "stuck", why: "refused a sender: 1234" });
  for (const one of [retried, chatLine({ agent: agent("busy"), findings: [written], sleeping: false, now }), chatLine({ agent: agent("busy"), findings: [colon], sleeping: false, now })]) {
    expect(one.says).not.toContain("busy");
    expect(one.says.split(": ").length).toBeLessThanOrEqual(2);
  }
  // Recorded failures: a blocked agent, a door that cannot reach the chat, a retry.
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "blocked", cause: "configured-engine-unavailable" }, sleeping: false, now }).says)
    .toBe("stuck: the engine it is set to use is not available on its runner");
  // A blocked agent's why is one short next step, never the runner's remedy
  // paragraph; the remedy is kept whole as the detail the people page shows.
  const mismatch = "Master conversation is bound to claude-code, but its preset configures opencode. Restore this agent's preset to claude-code; restarting or fresh_context does not change its engine. Independent jobs and harvests can still run.";
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "blocked", cause: "conversation.engine-mismatch", remedy: mismatch }, sleeping: false, now }))
    .toEqual({ agent: agent("x"), rank: 0, says: "stuck: its conversation was started on another engine than the one it is set to use",
      why: "set its preset back to the engine its conversation started on; restarting will not change it.", detail: mismatch });
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "blocked", cause: "configured-engine-unavailable", remedy: "Engine X needs a runtime. Provision one first." }, sleeping: false, now }).why)
    .toBe("its messages stay queued; restarting will not fix it, the engine has to be set up on that machine.");
  // A cause outside the closed list says its remedy's first sentence; a one-sentence remedy is not repeated as detail.
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "blocked", cause: "something-new", remedy: "Ask the owner. Then wait for the runner to retry." }, sleeping: false, now }))
    .toMatchObject({ why: "Ask the owner.", detail: "Ask the owner. Then wait for the runner to retry." });
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "blocked", cause: "something-new", remedy: "Ask the owner." }, sleeping: false, now }))
    .not.toHaveProperty("detail");
  expect(chatLine({ agent: agent("x"), findings: [], doorHealth: { status: "failed", cause: 'PostgresError: relation "x" does not exist' }, sleeping: false, now }))
    .toMatchObject({ rank: 0, says: "stuck: the door cannot reach this chat", why: "operation failed" });
  expect(chatLine({ agent: agent("x"), findings: [], agentHealth: { status: "retry", cause: "model overloaded", retry_at: "2026-10-04T12:05:00.000Z" }, sleeping: false, now }))
    .toMatchObject({ rank: 2, says: "retrying: model overloaded", why: "trying again at 12:05 UTC." });
  expect(chatLine({ agent: agent("x"), findings: [], sleeping: true, now })).toMatchObject({ rank: 4, says: chatPaused("en") });
  expect(chatLine({ agent: agent("x"), findings: [], sleeping: false, now })).toMatchObject({ rank: 5, says: "healthy, nothing waiting" });

  // The page: the headline counts what needs a person, and the rows that do come first.
  const page = overviewPage({
    machine: "pi", entries: [], machines: [{ id: "pi", os: "linux" }] as MachineEntry[], status: [], findings: [], peaks: [], remote: {}, acts: [],
    people: [{ id: "p1" } as never],
    agents: [agent("fine"), agent("busy"), agent("held"), agent("queued"), agent("stuck")],
    turns: { busy, held, queued, stuck }, agentHealth: [], doorHealth: [], lifetimes: {}, now,
  });
  expect(page).toContain("<h1>2 of 5 chats need attention.</h1>");
  const order = [...page.matchAll(/<a class="name" href="\/chats\/p1\/([a-z]+)">/g)].map((one) => one[1]);
  expect(order).toEqual(["stuck", "held", "busy", "queued", "fine"]);
  expect(page).toContain('<details class="machine">');
  expect(page).not.toMatch(/\bowed\b|: OK\b/);

  // The first screen says the short next step; the people page keeps the
  // runner's whole remedy, and its state column keeps room beside it.
  const blocked = [{ id: "stuck", data: { status: "blocked", cause: "conversation.engine-mismatch", remedy: mismatch } }];
  const first = overviewPage({
    machine: "pi", entries: [], machines: [{ id: "pi", os: "linux" }] as MachineEntry[], status: [], findings: [], peaks: [], remote: {}, acts: [],
    people: [{ id: "p1" } as never], agents: [agent("stuck")], turns: {}, agentHealth: blocked, doorHealth: [], lifetimes: {}, now,
  });
  expect(first).toContain("set its preset back to the engine its conversation started on; restarting will not change it.");
  expect(first).not.toContain("Master conversation is bound");
  const people = peoplePage({ people: [{ id: "p1" } as never], agents: [agent("stuck")], turns: {}, agentHealth: blocked, doorHealth: [], lifetimes: {}, findings: [], now });
  expect(people).toContain(`data-label="why">${mismatch.replace(/'/g, "&#39;")}</td>`);
  expect(people).toContain("td.word { min-width: min(22rem, 30vw); }");
});

test("one agent's rows are counted per state with the oldest of each, and the card never calls a queue answering", () => {
  const rows: TurnFacts[] = [
    { ...BASE, id: "q1", received_at: "2026-10-04T00:01:00.000Z" },
    { ...BASE, id: "q2", received_at: "2026-10-04T00:02:00.000Z" },
    { ...BASE, id: "h1", received_at: "2026-10-04T00:03:00.000Z", hold_state: "held", hold_cause: "stopped", hold_at: "2026-10-04T00:05:00.000Z" },
    { ...BASE, id: "s1", received_at: "2026-10-04T00:04:00.000Z", state: "started" },
    { ...BASE, agent: "a2", id: "r1", received_at: "2026-10-04T00:06:00.000Z", state: "started", execution_state: "running",
      execution_runner: "runner-b", owner_current: true, owner_connected: true, execution_started_at: "2026-10-04T00:07:00.000Z" },
  ];
  const summary = summarizeTurns(rows);
  expect(summary.a1.counts).toEqual({ answering: 0, queued: 2, held: 1, stale: 1 });
  expect(summary.a1.oldest.queued?.received_at).toBe("2026-10-04T00:01:00.000Z");
  expect(summary.a1.since).toBe("2026-10-04T00:01:00.000Z");
  expect(summary.a2.counts).toEqual({ answering: 1, queued: 0, held: 0, stale: 0 });

  expect(wordFor({ findings: [], about: ["a1"], turns: summary.a1 }))
    .toBe("1 message held, waiting for a recovery choice; 1 message unfinished, with nothing working on it; 2 messages waiting to be picked up");
  expect(wordFor({ findings: [], about: ["a2"], turns: summary.a2 })).toBe(cardWaiting("en", { count: 1 }));

  // The people page says the same one state the first screen says, and the
  // mix of states beside it only when there is more to it than that state.
  const now = new Date("2026-10-04T12:00:00.000Z");
  const agents = [
    { id: "a1", person: "p1", chat: "c1", door: "d1" } as never,
    { id: "a2", person: "p1", chat: "c2", door: "d1" } as never,
    { id: "a3", person: "p1", chat: "c3", door: "d1" } as never,
    { id: "a4", person: "p1", chat: "c4", door: "d1" } as never,
  ];
  const lifetimes = { a1: { mode: "resident", sleeping: false }, a2: { mode: "resident", sleeping: false },
    a3: { mode: "resident", sleeping: true }, a4: { mode: "on-demand", sleeping: false } };
  const page = peoplePage({ people: [{ id: "p1" } as never], agents, turns: summary, agentHealth: [], doorHealth: [], lifetimes, findings: [], now });
  const cells = (agent: string) => Object.fromEntries(
    [...(new RegExp(`<tr><td[^>]*>${agent}</td>([\\s\\S]*?)</tr>`).exec(page)?.[1] ?? "").matchAll(/<td([^>]*)>([^<]*)<\/td>/g)]
      .map((one) => [/data-label="([^"]*)"/.exec(one[1])?.[1] ?? "", one[2]]));
  for (const id of ["a1", "a2", "a3", "a4"]) {
    const line = chatLine({ agent: agents.find((one: { id: string }) => one.id === id)!, findings: [], turns: summary[id], sleeping: lifetimes[id as "a1"].sleeping, now });
    expect(cells(id).state, id).toBe(line.says);
  }
  expect(cells("a1")).toMatchObject({ state: "stuck: it was started and no runner holds it now.",
    "open messages": "1 message held, waiting for a recovery choice; 1 message unfinished, with nothing working on it; 2 messages waiting to be picked up",
    "waiting since": "00:01 UTC", lifetime: "resident, awake" });
  expect(cells("a1").state).not.toContain("answering");
  // One state alone is not said twice.
  expect(cells("a2")).toMatchObject({ state: "busy: answering a message since 00:07 UTC", "open messages": "-" });
  // A paused agent reads paused here exactly as on the first screen.
  expect(cells("a3")).toMatchObject({ state: chatPaused("en"), lifetime: "resident, paused" });
  expect(cells("a4")).toMatchObject({ state: "healthy, nothing waiting", why: "-", "open messages": "-", "waiting since": "-", lifetime: "on-demand, awake", health: "-" });
  expect(page).toContain('<div class="rows compact">');
  expect(page).toMatch(/<td data-label="why" class="nil">-<\/td>/);
  expect(page).toContain("@media (max-width: 599px)");
  expect(page).toContain(".compact td.nil { display: none; }");
  for (const heading of ["agent", "state", "why", "open messages", "waiting since", "lifetime", "health"]) {
    expect(page).toContain(`<th>${heading}</th>`);
  }
  for (const gone of ["answering", "queued", "held", "unfinished", "mode", "sleeping", "agent health", "chat health"]) {
    expect(page).not.toContain(`<th>${gone}</th>`);
  }
  expect(page).not.toMatch(/\bowed\b/i);
});

// ---------------------------------------------------------------- remote machines, pure

test("another machine with nothing wrong shows every declared entry with what was recorded, and never a state inferred from silence", () => {
  const entries = [
    { id: "runner-there", kind: "runner", machine: THERE, schedule: "always", memory_limit_mb: 512 },
    { id: "hub-there", kind: "hub", machine: THERE, schedule: "always", memory_limit_mb: 128 },
    { id: "sync-there", kind: "sync", machine: THERE, schedule: "every 15m", memory_limit_mb: 128 },
    { id: "backup-there", kind: "backup", machine: THERE, schedule: "on demand", memory_limit_mb: 128 },
    { id: "watch-there", kind: "watch", machine: THERE, schedule: "always", enabled: false, memory_limit_mb: 128 },
  ] as RunEntry[];
  const page = machinesPage({
    machine: HERE,
    entries,
    machines: [{ id: HERE, os: HERE_OS }, { id: THERE, os: THERE_OS }] as MachineEntry[],
    status: [],
    findings: [],
    peaks: [{ id: "runner-there", bytes: 300 * 1024 * 1024, reading_bytes: 210 * 1024 * 1024, reading_at: "2026-10-04T00:29:00.000Z" }],
    remote: {
      "runner-there": { connected: true, started_at: "2026-10-03T21:00:00.000Z" },
      "hub-there": { connected: false, started_at: null },
      "sync-there": { connected: false, started_at: null },
      "backup-there": { connected: false, started_at: null },
      "watch-there": { connected: false, started_at: null },
    },
    acts: [],
  });
  const row = (id: string) =>
    [...(new RegExp(`<tr><td[^>]*>${id}</td>([\\s\\S]*?)</tr>`).exec(page)?.[1] ?? "").matchAll(/<td([^>]*)>([^<]*)<\/td>/g)]
      .map((one) => [/data-label="([^"]*)"/.exec(one[1])?.[1] ?? "", one[2]] as [string, string]);
  const runner = Object.fromEntries(row("runner-there"));
  expect(runner).toMatchObject({
    kind: "runner", wanted: "running", "store connection": "connected now", "runner started": "2026-10-03 21:00 UTC",
    "memory now": "210.0 MiB", "sampled at": "2026-10-04 00:29 UTC", limit: "512 MiB", findings: "none recorded",
  });
  // A resident the store does not see connected says exactly that.
  expect(Object.fromEntries(row("hub-there"))["store connection"]).toBe("not connected now");
  // A scheduled piece connects only while it runs, and the row says so; a
  // missing sample is said as missing and never as a zero or a blank.
  expect(Object.fromEntries(row("sync-there"))).toMatchObject({
    wanted: "scheduled", "store connection": "not connected now; it connects only while it runs", "memory now": "no sample recorded",
  });
  // An on-demand piece connects only when it is started, and a stopped one
  // not at all: neither is a connection the summary calls missing. Only the
  // resident hub the registry wants running is.
  expect(Object.fromEntries(row("backup-there"))["store connection"]).toBe("not connected now; it connects only when it is started");
  expect(Object.fromEntries(row("watch-there"))["store connection"]).toBe("not connected now; stopped in the registry");
  expect(page).toContain("5 declared, 1 connected to the store now; 1 wanted running is not connected: hub-there</p>");
  // Nothing on that machine claims a service manager's word.
  expect(page).not.toContain("nothing is reported for");
  for (const [label] of [...row("runner-there"), ...row("hub-there"), ...row("sync-there"), ...row("backup-there")]) {
    expect(["seen", "pid"]).not.toContain(label);
  }
  expect(page).toContain("no finding does not mean running");

  // The store could not be read: every remote row says the observation is
  // unavailable, and nothing is left blank for a person to read as fine.
  const blind = machinesPage({
    machine: HERE, entries, machines: [{ id: HERE, os: HERE_OS }, { id: THERE, os: THERE_OS }] as MachineEntry[],
    status: [], findings: [], peaks: [], remote: null, acts: [],
  });
  const blindRow = Object.fromEntries(
    [...(new RegExp(`<tr><td[^>]*>runner-there</td>([\\s\\S]*?)</tr>`).exec(blind)?.[1] ?? "").matchAll(/<td([^>]*)>([^<]*)<\/td>/g)]
      .map((one) => [/data-label="([^"]*)"/.exec(one[1])?.[1] ?? "", one[2]]),
  );
  expect(blindRow).toMatchObject({ "store connection": "observation unavailable", "runner started": "observation unavailable" });
  expect(blind).toContain("5 declared, observation unavailable</p>");
});

test("a folded machine line names the findings inside it, and the requests fold says its causes in words", () => {
  const entries = [
    { id: "runner-a", kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512 },
    { id: "hub-a", kind: "hub", machine: HERE, schedule: "always", memory_limit_mb: 128 },
    { id: "runner-b", kind: "runner", machine: THERE, schedule: "always", memory_limit_mb: 512 },
  ] as RunEntry[];
  const findings: CheckRow[] = [
    { id: "m", kind: "memory-over-limit", subject: "runner-a", machine: HERE, says: "runner-a was last measured holding 540 MB and the registry asks for 512 MB",
      fix: "raise memory_limit_mb for runner-a in /x/registry.toml or make it hold less", updated_at: "2026-10-04T00:30:00.000Z" },
    { id: "s", kind: "registry-stale", subject: THERE, machine: HERE, says: `${THERE}'s copy of the registry is not the one ${HERE} runs`,
      fix: `check the hub on ${THERE}: imprnt hub status <registry> ${THERE} there, and copy the registry from ${HERE} to ${THERE} again`, updated_at: "2026-10-04T00:31:00.000Z" },
  ];
  const page = overviewPage({
    machine: HERE, entries, machines: [{ id: HERE, os: HERE_OS }, { id: THERE, os: THERE_OS }] as MachineEntry[],
    status: [{ id: "runner-a", wanted: "running", seen: "running", pid: 1 }, { id: "hub-a", wanted: "running", seen: "running", pid: 2 }],
    findings, peaks: [], remote: { "runner-b": { connected: true, started_at: null } },
    acts: [
      { id: "c1", target_id: "kim-shopping", target_kind: "agent", actor: "board", status: "refused", cause: "recovery-target-stopped", requested_at: "2026-10-04T00:20:00.000Z" },
      { id: "c2", target_id: "runner-a", target_kind: "run", actor: "cli", status: "applied", cause: null, requested_at: "2026-10-04T00:10:00.000Z" },
    ],
    people: [], agents: [], turns: {}, agentHealth: [], doorHealth: [], lifetimes: {}, now: new Date("2026-10-04T01:00:00Z"),
    fix: { here: HERE, registryFile: "/x/registry.toml", machines: [HERE, THERE] },
  });
  // A short hyphenated word is kept whole in its own span, so the words are read without the markup.
  const summaries = [...page.matchAll(/<summary><span class="name">([^<]*)<\/span> <span class="who">(.*?)<\/span><\/summary>/g)]
    .map((one) => [one[1], one[2].replace(/<\/?span[^>]*>/g, "").replaceAll("&#39;", "'")]);
  expect(page).toContain('<span class="nw">runner-a</span> over its memory limit');
  expect(summaries).toEqual([
    [HERE, "this machine: 2 declared, all as the registry wants; 1 finding: runner-a over its memory limit"],
    [THERE, `1 declared, 1 connected to the store now; 1 finding: ${THERE} has a registry copy that is not the current one`],
    ["restart and recovery requests", "2 recorded, 1 refused"],
  ]);
  // The cause column says what a refusal code means, and no code is left in it.
  expect(page).toContain('data-label="cause">the target is stopped in the registry, so nothing restarts it</td>');
  expect(page).not.toContain(">recovery-target-stopped<");
  expect(page).not.toContain(">asked for<");
  expect(requestCause("recovery-target-stopped")).toBe("the target is stopped in the registry, so nothing restarts it");
  expect(requestCause("enabled-not-for-this-kind")).toBe("this kind of entry is never stopped or started from the board");
  // A code nobody wrote words for is the code, and a raw error is still reduced.
  expect(requestCause("something-new")).toBe("something-new");
  expect(requestCause('PostgresError: syntax error at or near "("')).toBe("operation failed");
});

test("an agent that names no tools shows the very list its engine is launched with, never a vague set", () => {
  const nine = VALIDATED_ORDINARY_PROFILES["2.1.286"].join(", ");
  expect(defaultTools("claude-code")).toEqual({ list: nine });
  expect(defaultTools("opencode")).toEqual({ list: ORDINARY_PROFILE.join(", ") });
  expect(defaultTools("codex")).toEqual({ words: "codex's own tools inside the box; a list cannot be set" });
  expect(defaultTools("scripted")).toBeNull();
  const agents = [
    { id: "a-claude", person: "p1", preset: "daily", runner: "runner-a", chat: "c1", door: "d1" },
    { id: "a-open", person: "p1", preset: "open", runner: "runner-a" },
    { id: "a-own", person: "p1", preset: "daily", runner: "runner-a", tools: ["Read", "Grep"], mcp: { x: {} } },
    { id: "a-triage", person: "p1", preset: "daily", runner: "runner-a", role: "triage" },
    { id: "a-odd", person: "p1", preset: "odd", runner: "runner-a" },
  ] as unknown as AgentEntry[];
  const page = peoplePage({
    people: [{ id: "p1" } as never], agents, turns: {}, agentHealth: [], doorHealth: [], lifetimes: {}, findings: [], now: new Date("2026-10-04T12:00:00Z"),
    fleet: {
      runnerMachine: { "runner-a": HERE },
      presets: { daily: { adapter: "claude-code", model: "sonnet" }, open: { adapter: "opencode", model: "m" }, odd: { adapter: "scripted", model: "s" } } as never,
      approvals: { "d1/c1": { pending: 1, approved_at: "2026-10-04T09:30:00.000Z" } },
    },
  });
  const fleet = page.slice(page.indexOf("<h3>what p1"));
  const tools = (agent: string) => new RegExp(`<tr><td[^>]*>${agent}</td>[^\\n]*?<td data-label="tools"([^>]*)>([^<]*)</td>`).exec(fleet)?.slice(1) ?? [];
  expect(tools("a-claude")).toEqual([' class="list"', `default: ${nine}`]);
  expect(tools("a-open")).toEqual([' class="list"', `default: ${ORDINARY_PROFILE.join(", ")}`]);
  expect(tools("a-own")).toEqual([' class="list"', "Read, Grep"]);
  expect(tools("a-triage")).toEqual(["", "none"]);
  expect(tools("a-odd")).toEqual(["", "default for scripted not known to this board"]);
  expect(page).not.toContain("validated set");
  expect(page).toContain(`master: chat on d1; runner on ${HERE}`);
  // Prose keeps a short hyphenated word whole and escaped, and leaves a long path free to wrap.
  const path = "/Users/some-one/Library/LaunchAgents/imprnt-hub-x.plist";
  expect(whole(`runner on home-server, <b> & ${path}`))
    .toBe(`runner on <span class="nw">home-server,</span> &lt;b&gt; &amp; ${path}`);
  // In a cell the words are ONE element: a phone lays a cell out as a two-column
  // grid, and a bare span would be a grid item landing in the label's column.
  expect(wordsCell("chat on door-sam; runner on home-server"))
    .toBe('<td><span>chat on <span class="nw">door-sam;</span> runner on <span class="nw">home-server</span></span></td>');
  expect(wordsCell(null)).toBe('<td class="nil">-</td>');
  // Beside a fix, a short subject and a date stay whole and a long subject may wrap.
  expect(wordsCell("kim-shopping", "id", 16)).toBe('<td class="id"><span><span class="nw">kim-shopping</span></span></td>');
  expect(wordsCell("imprnt-hub-old-sync.plist", "id", 16)).toBe('<td class="id"><span>imprnt-hub-old-sync.plist</span></td>');
  expect(wordsCell("2026-10-04 02:27 UTC", "when")).toBe('<td class="when"><span><span class="nw">2026-10-04</span> 02:27 UTC</span></td>');
  expect(page).toContain("1 waiting; last approved 09:30 UTC");
});

test("the metrics page prints only what was measured, grouped by who, and says what was not in one line", () => {
  const measure = (p50: number, p99: number, count: number) => ({ p50_ms: p50, p99_ms: p99, count });
  const none = { p50_ms: null, p99_ms: null, count: 0 };
  const rows: MetricsRow[] = [
    { scope: "agent" as const, id: "a1", window: "today" as const, measures: { "time-to-ack": measure(812.4, 2400.6, 7), "time-to-start": none } },
    { scope: "agent" as const, id: "a1", window: "week" as const, measures: { "time-to-ack": measure(905, 3100, 31), "time-to-start": measure(1500, 9800, 30) } },
    { scope: "agent" as const, id: "a2", window: "today" as const, measures: { "time-to-ack": none, "time-to-start": none } },
    { scope: "agent" as const, id: "a2", window: "week" as const, measures: { "time-to-ack": measure(700, 1200, 3), "time-to-start": none } },
    { scope: "agent" as const, id: "a3", window: "today" as const, measures: { "time-to-ack": none } },
    { scope: "agent" as const, id: "a3", window: "week" as const, measures: { "time-to-ack": none } },
    { scope: "agent" as const, id: "a4", window: "today" as const, measures: { "time-to-ack": none } },
    { scope: "agent" as const, id: "a4", window: "week" as const, measures: { "time-to-ack": none } },
  ];
  const page = metricsPage({ rows, health: null });
  expect(page).toContain("<h3>a1</h3>");
  expect(page).toContain("<h3>a2</h3>");
  expect(page).not.toContain("<h3>a3</h3>");
  // Real numbers, rounded as the command line rounds them.
  for (const value of [">812<", ">2401<", ">7<", ">905<", ">3100<", ">31<", ">1500<", ">9800<", ">30<", ">700<", ">1200<", ">3<"]) expect(page).toContain(value);
  // No row of dashes: every row printed was measured.
  expect([...page.matchAll(/<tr>[\s\S]*?<\/tr>/g)].filter((one) => one[0].includes(">-<"))).toEqual([]);
  expect(page).toContain('<h3>a2</h3><p class="empty">nothing measured today.</p>');
  expect(page).toContain('<p class="empty">nothing measured this week for a3, a4.</p>');
  expect(page.match(/<th>who<\/th>/g)).toBeNull();
  // Each window its own small table headed by the window, kept a table on a phone.
  expect(page).toContain('<h3>a1</h3><div class="rows keep">');
  expect(page).toContain("<thead><tr><th>today</th><th>p50 ms</th><th>p99 ms</th><th>count</th></tr></thead>");
  expect(page).toContain("<thead><tr><th>this week</th><th>p50 ms</th><th>p99 ms</th><th>count</th></tr></thead>");
  expect(page).toContain(".keep td { border-bottom: 1px solid var(--line); display: table-cell;");
});

test("the usage page reads as a person reads it: one row per agent, the plan window as a percentage and times as times", () => {
  const page = usagePage({
    rows: [
      { agent: "a1", window: "today", turns: 1, tokens: 1500, price: 0.0125, currency: "USD" },
      { agent: "a1", window: "week", turns: 2, tokens: 2100, price: 0.0125, currency: "USD" },
      { agent: "a2", window: "today", turns: null, tokens: null, price: null, currency: null },
      { agent: "a2", window: "week", turns: 1, tokens: null, price: null, currency: null },
    ],
    windows: [{ credential: "household-claude", utilization: 0.37, resets_at: "2026-10-04T04:36:36.111Z", at: "2026-10-04T01:02:03.000Z", reported_by: "runner-a" }],
  });
  const row = (agent: string) => Object.fromEntries(
    [...(new RegExp(`<tr><td[^>]*>${agent}</td>([\\s\\S]*?)</tr>`).exec(page)?.[1] ?? "").matchAll(/<td([^>]*)>([^<]*)<\/td>/g)]
      .map((one) => [/data-label="([^"]*)"/.exec(one[1])?.[1] ?? "", one[2].replaceAll("&#39;", "'")]));
  expect(row("a1")).toEqual({ today: "1 turn · 1,500 tokens · 0.0125 USD", "last 7 days": "2 turns · 2,100 tokens · 0.0125 USD" });
  // Nothing today is the nothing mark, never a zero; a turn with no counts says so.
  expect(row("a2")).toEqual({ today: "-", "last 7 days": "1 turn · no token count · unpriced" });
  expect(row("household-claude")).toEqual({ used: "37% used", "resets at": "2026-10-04 04:36 UTC", "read at": "2026-10-04 01:02 UTC", "reported by": "runner-a" });
  expect(page).not.toMatch(/\dT\d{2}:\d{2}|\.\d{3}Z|>0\.37</);
  expect([...page.matchAll(/<tr><td[^>]*>a1<\/td>/g)].length).toBe(1);
});

test("a chat preview is one clean line cut between words, and a worker with no chat is a name and not a link", () => {
  expect(previewOf("Looking now. First failure:\n```\nerror: test timed out after 90000ms\n  at board-pages.test.ts:281\n```"))
    .toBe("Looking now. First failure: error: test timed out after 90000ms at…");
  expect(previewOf("Done: **Thursday 10:30**. Use `bun test` here.")).toBe("Done: Thursday 10:30. Use bun test here.");
  const long = previewOf("word ".repeat(40));
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long).toMatch(/word…$/);
  for (const one of [long, previewOf("a `b` ```c```")]) expect(one).not.toContain("`");
  // One word longer than the preview has no boundary, and is the one thing cut.
  expect(previewOf("x".repeat(100))).toBe(`${"x".repeat(79)}…`);

  const page = chatsPage({
    people: [{ id: "p1" } as never],
    agents: [
      { id: "p1-lair", person: "p1", chat: "c1", door: "d1" } as never,
      { id: "p1-worker", person: "p1" } as never,
    ],
    newest: { "p1-lair": { day: "2026-10-04", at: "2026-10-04T01:00:00.000Z", from: "p1", text: "hello" }, "p1-worker": null },
  });
  expect(page).toContain('<a class="name" href="/chats/p1/p1-lair">p1-lair</a>');
  expect(page).not.toContain('href="/chats/p1/p1-worker"');
  expect(page).toContain('<span class="name">p1-worker</span><span class="who">worker</span></div><div class="why">takes jobs only, no chat</div>');
});

// ---------------------------------------------------------------- chats

test("the newest line of a chat is the one a full newest-first sort puts first, ties going to the earlier line in the file", () => {
  const stateDir = scratchDir("hub-chat-newest-");
  const at = new Date("2026-10-04T09:00:00.000Z");
  plantChatLine({ stateDir, text: "earlier in the file, later in time", at: new Date("2026-10-04T10:00:00.000Z") });
  plantChatLine({ stateDir, text: "the first of two at the same time", at: new Date("2026-10-04T11:00:00.000Z") });
  plantChatLine({ stateDir, text: "the second of two at the same time", at: new Date("2026-10-04T11:00:00.000Z") });
  plantChatLine({ stateDir, text: "written last, said earliest", at });
  const newest = readChatNewest({ stateDir, person: "p1", agent: "p1-lair" });
  expect(newest).toMatchObject({ day: "2026-10-04", at: "2026-10-04T11:00:00.000Z", text: "the first of two at the same time" });
  expect(readChatNewest({ stateDir, person: "p1", agent: "nobody" })).toBeNull();
});

// ---------------------------------------------------------------- the store

/** The chat the stage's own agent answers in, read off the registry the stage wrote. */
async function readAgentChat(it: StagedHub): Promise<string> {
  const { listAgents } = await import("../src/registry/entries.ts");
  const { loadRegistry } = await import("../src/registry/load.ts");
  return listAgents(loadRegistry(it.registryFile)).find((one) => one.id === "p1-lair")!.chat!;
}

interface Planted {
  it: StagedHub;
  su: Store;
  live: Store;
  stop(): Promise<void>;
}

async function plantStore(): Promise<Planted> {
  cluster ??= await startCluster();
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree: scratchDir("hub-functional-tree-") }],
  });
  const su = await superStore(cluster, it.db);
  // A client connected under a runner's name, which is what "connected" is.
  const url = new URL(cluster.url(it.db));
  url.searchParams.set("application_name", "runner-live");
  const live = await openStore({ url: url.toString() });
  await live.sql`select 1`;
  return {
    it, su, live,
    async stop() {
      await live.close();
      await su.close();
      await it.stop();
    },
  };
}

test("readTurnStates places active, queued, held and stale rows in one statement, from the store's own evidence, and writes nothing", async () => {
  const s = await plantStore();
  try {
    const q = (text: string, values: unknown[] = []) => s.it.read.sql(text, values);
    for (const [agent, conversation] of [["a-active", "c-active"], ["a-gone", "c-gone"], ["a-held", "c-held"], ["a-unknown", "c-unknown"], ["a-released", "c-released"]]) {
      await q(`insert into conversation (id, person, agent, kind, adapter, native_session) values ($1, 'p1', $2, 'master', 'scripted', $3)`,
        [conversation, agent, crypto.randomUUID()]);
    }
    await q(`insert into runner_incarnation (runner, incarnation, protocol, machine) values ('runner-live', 'live-2', 2, 'here'), ('runner-dead', 'dead-1', 2, 'here')`);
    const inbound = async (id: string, agent: string, state: string, extra: Record<string, unknown> = {}) => {
      await q(`insert into inbound (id, person, agent, body, kind, state, claimed_by, claim_deadline, retry_at)
               values ($1, 'p1', $2, $3, 'human', $4, $5, $6::timestamptz, $7::timestamptz)`,
        [id, agent, `private words of ${id}`, state, extra.claimed_by ?? null, extra.claim_deadline ?? null, extra.retry_at ?? null]);
    };
    const attempt = async (id: string, inboundId: string, conversation: string, agent: string, runner: string, incarnation: string, state: string) => {
      await q(`insert into execution (id, inbound_id, conversation_id, agent, runner, incarnation, placement_generation, state, input_digest)
               values ($1, $2, $3, $4, $5, $6, 1, $7, 'd')`, [id, inboundId, conversation, agent, runner, incarnation, state]);
    };
    // ACTIVE: running, owned by the current incarnation of a connected runner.
    await inbound("m-active", "a-active", "started", { claimed_by: "runner-live", claim_deadline: "2999-01-01T00:00:00Z" });
    await attempt("x-active", "m-active", "c-active", "a-active", "runner-live", "live-2", "running");
    // QUEUED: nothing has it; and a refused turn waiting out its retry.
    await inbound("m-queued", "a-queued", "received");
    await inbound("m-retry", "a-queued", "acked", { retry_at: "2999-01-01T00:00:00Z" });
    // HELD: interrupted, with the owner's hold open.
    await inbound("m-held", "a-held", "acked");
    await attempt("x-held", "m-held", "c-held", "a-held", "runner-dead", "dead-1", "interrupted");
    await q(`insert into replay_hold (inbound_id, execution_id, conversation_id, cause) values ('m-held', 'x-held', 'c-held', 'interrupted')`);
    // STALE: "running" by a runner nobody sees connected; an old incarnation of
    // a connected one; ownership unknown; a claim whose runner is gone.
    await inbound("m-gone", "a-gone", "started", { claimed_by: "runner-dead", claim_deadline: "2999-01-01T00:00:00Z" });
    await attempt("x-gone", "m-gone", "c-gone", "a-gone", "runner-dead", "dead-1", "running");
    await inbound("m-unknown", "a-unknown", "started");
    await attempt("x-unknown", "m-unknown", "c-unknown", "a-unknown", "runner-live", "live-1", "unknown");
    await inbound("m-claim", "a-claim", "acked", { claimed_by: "runner-dead", claim_deadline: "2999-01-01T00:00:00Z" });
    // RELEASED: the owner's recovery choice (a fresh context, revision 2)
    // released the hold. The input stays received, unclaimed, with no retry
    // and its one interrupted attempt, and no attempt of the agent is active:
    // the shape read from the live store on 30 Sept. Not current activity.
    await inbound("m-released", "a-released", "received");
    await attempt("x-released", "m-released", "c-released", "a-released", "runner-dead", "dead-1", "interrupted");
    await q(`insert into replay_hold (inbound_id, execution_id, conversation_id, cause, state, revision, choice, chosen_by, chosen_at)
             values ('m-released', 'x-released', 'c-released', 'interrupted', 'released', 2, 'fresh_context', 'owner', now())`);
    // Not open, so not counted at all.
    await inbound("m-done", "a-active", "answered");

    const before = await q(`select id, state, claimed_by from inbound order by id`);
    const holds = await q(`select inbound_id, state, revision from replay_hold order by inbound_id`);
    const attempts = await q(`select id, state from execution order by id`);

    const states = await readTurnStates(s.su, ["a-active", "a-queued", "a-held", "a-gone", "a-unknown", "a-claim", "a-quiet", "a-released"]);
    // The released original is read (the statement sees the hold in every
    // state) and left out whole: no count, no reason, no time.
    expect(states["a-released"]).toEqual({ counts: { answering: 0, queued: 0, held: 0, stale: 0 }, oldest: {}, since: null });
    expect(states["a-active"].counts).toEqual({ answering: 1, queued: 0, held: 0, stale: 0 });
    expect(states["a-active"].oldest.answering).toMatchObject({ reason: "answering", runner: "runner-live" });
    expect(states["a-queued"].counts).toEqual({ answering: 0, queued: 2, held: 0, stale: 0 });
    expect(states["a-queued"].oldest.queued?.reason).toBe("unclaimed");
    expect(states["a-held"].counts).toEqual({ answering: 0, queued: 0, held: 1, stale: 0 });
    expect(states["a-held"].oldest.held).toMatchObject({ reason: "hold", cause: "interrupted" });
    // Reopening the released one's hold would make it held again: the omission
    // is the hold's state, not the attempt's.
    await q(`update replay_hold set state = 'held' where inbound_id = 'm-released'`);
    expect((await readTurnStates(s.su, ["a-released"]))["a-released"].counts).toEqual({ answering: 0, queued: 0, held: 1, stale: 0 });
    await q(`update replay_hold set state = 'released' where inbound_id = 'm-released'`);
    expect(states["a-gone"].counts).toEqual({ answering: 0, queued: 0, held: 0, stale: 1 });
    expect(states["a-gone"].oldest.stale).toMatchObject({ reason: "owner-gone", runner: "runner-dead" });
    expect(states["a-unknown"].oldest.stale).toMatchObject({ reason: "ownership-unknown", runner: "runner-live" });
    expect(states["a-claim"].oldest.stale).toMatchObject({ reason: "owner-gone", runner: "runner-dead" });
    expect(states["a-quiet"]).toMatchObject({ counts: { answering: 0, queued: 0, held: 0, stale: 0 }, since: null });
    // No body travelled with the facts.
    expect(JSON.stringify(states)).not.toContain("private words");

    // The live runner's current incarnation moves on, and its old attempt is
    // no longer answering: a restart is not a turn that kept running.
    await q(`update runner_incarnation set incarnation = 'live-3' where runner = 'runner-live'`);
    expect((await readTurnStates(s.su, ["a-active"]))["a-active"].counts).toEqual({ answering: 0, queued: 0, held: 0, stale: 1 });
    await q(`update runner_incarnation set incarnation = 'live-2' where runner = 'runner-live'`);

    // Nothing the reader touched moved.
    expect(await q(`select id, state, claimed_by from inbound order by id`)).toEqual(before);
    expect(await q(`select inbound_id, state, revision from replay_hold order by inbound_id`)).toEqual(holds);
    expect(await q(`select id, state from execution order by id`)).toEqual(attempts);
  } finally {
    await s.stop();
  }
}, SLOW);

test("readRemoteFacts says connected only for a client the server lists under that entry's name, and a runner's last start", async () => {
  const s = await plantStore();
  try {
    // Every hub writes the file it runs with beside its digest, which is how
    // another machine's board names a file that exists there.
    await recordRegistryDigest(s.su, "there", s.it.registryFile);
    expect((await readRegistryDigests(s.su)).find((row) => row.machine === "there"))
      .toMatchObject({ machine: "there", file: s.it.registryFile, sha256: registryDigest(s.it.registryFile) });
    await s.it.read.sql(`insert into runner_incarnation (runner, incarnation, protocol, machine) values ('runner-live', 'live-2', 2, 'there')`);
    const facts = await readRemoteFacts(s.su, [
      { id: "runner-live", kind: "runner", machine: "there" },
      { id: "runner-quiet", kind: "runner", machine: "there" },
      { id: "hub-there", kind: "hub", machine: "there" },
    ]);
    expect(facts["runner-live"].connected).toBe(true);
    expect(facts["runner-live"].started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(facts["runner-quiet"]).toEqual({ connected: false, started_at: null });
    // A hub connects as hub-<machine>, which nothing here is.
    expect(facts["hub-there"]).toEqual({ connected: false, started_at: null });
    expect(await readRemoteFacts(s.su, [])).toEqual({});
  } finally {
    await s.stop();
  }
}, SLOW);

test("served: a healthy remote machine's declared runner is listed as connected with its sample, and a queued message is not answering", async () => {
  cluster ??= await startCluster();
  // The stage's own agent, p1-lair, answers through its door and runner on this machine.
  const door: RunSpec = { id: DOOR, kind: "door", machine: HERE, platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 };
  const here: RunSpec = { id: RUNNER, kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 };
  const there: RunSpec = { id: "runner-live", kind: "runner", machine: THERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 };
  const boardEntry: RunSpec = { id: "board", kind: "board", machine: HERE, schedule: "always", memory_limit_mb: 128, bind: "127.0.0.1", port: await freePort() };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }, { id: THERE, os: THERE_OS }],
    people: [{ id: "p1", tree: scratchDir("hub-functional-served-") }],
    run: [door, here, there, boardEntry],
  });
  const su = await superStore(cluster, it.db);
  const url = new URL(cluster.url(it.db));
  url.searchParams.set("application_name", "runner-live");
  const live = await openStore({ url: url.toString() });
  await live.sql`select 1`;
  const board = await serveBoard({ registryFile: it.registryFile, entryId: boardEntry.id, store: su, os: recordingSeam(plantedSeam(FLAVOUR).os).os });
  try {
    await it.read.sql(`insert into state_row (sheet, id, data) values ('memory_peak', 'runner-live', $1)`,
      [{ bytes: 300 * 1024 * 1024, at: "2026-10-04T00:00:00.000Z", how: "sampled", machine: THERE, pid: 7, reading_bytes: 200 * 1024 * 1024, reading_at: "2026-10-04T00:29:00.000Z" }]);
    const machines = await (await board.get("/")).text();
    const row = new RegExp(`<tr><td[^>]*>runner-live</td>[\\s\\S]*?</tr>`).exec(machines)?.[0] ?? "";
    expect(row, "the remote runner has a row").not.toBe("");
    expect(row).toContain(">connected now<");
    expect(row).toContain(">200.0 MiB<");
    expect(row).toContain(">2026-10-04 00:29 UTC<");
    expect(machines).not.toContain("nothing is reported for");

    await it.read.sql(`insert into inbound (id, person, agent, body, kind) values ('waiting-one', 'p1', 'p1-lair', 'private question text', 'human')`);
    const people = await (await board.get("/people")).text();
    expect(people).toContain(cardQueued("en", { count: 1 }));
    expect(people).not.toContain(cardWaiting("en", { count: 1 }));
    expect(people).not.toContain("private question text");
    // The first screen says the same message is waiting, never that it is answered.
    const first = await (await board.get("/")).text();
    expect(first).toContain(`<div class="says">${cardQueued("en", { count: 1 })}</div>`);
    expect(first).not.toContain("private question text");

    // What each agent may do, from the file, and the owner's approvals per
    // chat from the confirmation rows: counts and a time, no payload.
    await it.read.sql(
      `insert into confirmation (id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash, effect_keys)
       values ('k1', 'op1', 'outbound', 1, 'p1', $1, $2, 'owner-1', '{"text":"private draft"}'::jsonb, 'h', array['e1'])`,
      [DOOR, (await readAgentChat(it))],
    );
    expect(Object.values(await readApprovals(su))).toEqual([{ pending: 1, approved_at: null }]);
    const fleet = await (await board.get("/people")).text();
    expect(fleet).toContain("<h3>what p1's agents may do</h3>");
    expect(fleet).toContain(">1 waiting; never approved<");
    expect(fleet.replace(/<\/?span[^>]*>/g, "")).toContain(`>master: chat on ${DOOR}; runner on ${HERE}<`);
    expect(fleet).toContain(`<span class="nw">${DOOR};</span>`);
    expect(fleet).not.toContain("private draft");

    // The fonts the pages name are served by the board itself, byte for byte,
    // and nothing else under /fonts/ is.
    const font = await board.get("/fonts/golos-text-latin-wght-normal.woff2", { headers: { "sec-fetch-site": "same-origin" } });
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("max-age=86400");
    const shipped = await Bun.file(new URL("../assets/fonts/golos-text-latin-wght-normal.woff2", import.meta.url)).arrayBuffer();
    expect(Buffer.from(await font.arrayBuffer()).equals(Buffer.from(shipped))).toBe(true);
    expect((await board.get("/fonts/jetbrains-mono-latin-wght-normal.woff2")).status).toBe(200);
    for (const path of ["/fonts/sources.json", "/fonts/..%2Fpackage.json", "/fonts/../package.json", "/fonts/x.woff2", "/fonts"]) {
      expect((await board.get(path)).status, path).toBe(404);
    }
    // A page is still never kept, and a font from another site is still refused.
    expect((await board.get("/")).headers.get("cache-control")).toBe("no-store");
    expect((await board.get("/fonts/golos-text-latin-wght-normal.woff2", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(404);
  } finally {
    await board.stop();
    await live.close();
    await su.close();
    await it.stop();
  }
}, SLOW);
