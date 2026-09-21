import { cardBroken, cardOk, cardWaiting } from "../door/lines.ts";
import { NEVER_STOPPED, type AgentEntry, type MachineEntry, type PersonEntry, type RunEntry } from "../registry/load.ts";
import type { MetricsRow } from "../metrics/stamps.ts";
import type { VoiceHealthRow } from "../voice/health.ts";
import { escape, page } from "./html.ts";

/**
 * The four pages, each taking what its readers already returned.
 *
 * NOTHING HERE OPENS A STORE OR A SEAM. Every function is pure, so a page can
 * be rendered without a server and what a page SHOWS is separable from what a
 * request READS.
 *
 * THE PAGE COMPUTES NOTHING. Where a card needs one word, the word is whether
 * the `check` sheet holds a finding about this thing. A board that worked out
 * its own verdict would disagree with `check` the first time the two rules
 * drifted, and then a household would have two answers to one question.
 */

/** A row of the `check` sheet, as `check` itself wrote it. */
export interface CheckRow {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
  updated_at: string;
}

/** A row of the `control` sheet: what somebody asked for and what came of it. */
export interface ControlRow {
  id: string;
  target_id: string;
  target_kind: string;
  actor: string;
  status: string;
  cause: string | null;
  requested_at: string;
}

/** What a measure with no data prints. A zero in a table a person reads is a claim. */
const NOTHING = "-";

/** The unit-family findings, which are all another machine's state can tell us. */
const UNIT_KINDS = ["unit-missing", "unit-extra", "crash-loop"];

/**
 * The findings about a resident's memory, shown on the machines page beside the
 * numbers they are about.
 *
 * They are `check`'s rows, printed in `check`'s own words. The page holds no
 * opinion about how large a process is: a board that coloured a row red would
 * be a second rule about memory, and the first time the two drifted a household
 * would have two answers to one question.
 */
const MEMORY_KINDS = ["memory-over-limit", "peak-missing"];

function table(headings: string[], rows: string[]): string {
  if (rows.length === 0) return "";
  return [
    "<table>",
    `<tr>${headings.map((one) => `<th>${escape(one)}</th>`).join("")}</tr>`,
    ...rows,
    "</table>",
  ].join("\n");
}

function cell(value: unknown, className = ""): string {
  const text = value === null || value === undefined || value === "" ? NOTHING : String(value);
  return `<td${className === "" ? "" : ` class="${className}"`}>${escape(text)}</td>`;
}

/** One act, as a form that posts and redirects. There is no other kind here. */
function act(at: string, target: string, label: string, value?: string): string {
  const hidden = value === undefined ? "" : `<input type="hidden" name="value" value="${escape(value)}">`;
  return (
    `<form method="post" action="${escape(at)}">` +
    `<input type="hidden" name="target" value="${escape(target)}">${hidden}` +
    `<button type="submit">${escape(label)}</button></form>`
  );
}

/**
 * The one word on a card, and it is `check`'s answer.
 *
 * `about` is every subject a finding could name for this thing: the agent, its
 * door, and the door and chat together, which is how a chat that cannot be read
 * is written down. Broken outranks waiting, because a person whose agent is
 * broken is waiting too and the first word is the one worth reading.
 */
export function wordFor(args: { findings: CheckRow[]; about: string[]; openTurns: number }): string {
  if (args.findings.some((finding) => args.about.includes(finding.subject))) return cardBroken("en");
  if (args.openTurns > 0) return cardWaiting("en");
  return cardOk("en");
}

export function machinesPage(args: {
  machine: string;
  entries: RunEntry[];
  machines: MachineEntry[];
  status: { id: string; wanted: string; seen: string; pid: number | null }[];
  findings: CheckRow[];
  /**
   * The peaks sheet as the hub wrote it: the largest this piece has ever been
   * and what it was holding at the last sample.
   *
   * THE PAGE READS THE CURRENT READING AND NEVER MEASURES IT. It is the hub's
   * own record, taken on the hub's own tick, and a read that could start work
   * is not a read: a page that sampled would touch every process on the box
   * every time somebody refreshed it.
   */
  peaks: { id: string; bytes: number; reading_bytes?: number | null }[];
  acts: ControlRow[];
  notice?: string | null;
}): string {
  const here = args.entries.filter((entry) => entry.machine === "" || entry.machine === args.machine);
  const rows = here.map((entry) => {
    const said = args.status.find((one) => one.id === entry.id);
    const peak = args.peaks.find((one) => one.id === entry.id);
    const restart = act("/act/restart", entry.id, "restart");
    // An entry's own act is stop or start, which is one edit to one field. An
    // agent's is pause, and it lives on the people page: the two are never
    // offered on one thing, because on a run entry they are the same edit.
    //
    // THE HUB AND THE BOARD CARRY NO STOP. The file refuses the field on both,
    // because neither could be started again from where it was stopped, so a
    // button here would be a button whose only answer is a refusal.
    const enabled = entry.enabled !== false;
    const hold = (NEVER_STOPPED as readonly string[]).includes(entry.kind)
      ? ""
      : act("/act/enabled", entry.id, enabled ? "stop" : "start", enabled ? "false" : "true");
    return (
      "<tr>" +
      cell(entry.id) +
      cell(entry.kind) +
      // The manager's own word, where the manager said one.
      cell(said?.wanted) +
      cell(said?.seen) +
      cell(said?.pid) +
      cell(peak ? peak.bytes : null) +
      // An absent reading is the nothing mark and never a zero, because zero
      // bytes is a measurement and "nothing has sampled it" is not.
      cell(peak ? (peak.reading_bytes ?? null) : null) +
      cell(entry.memory_limit_mb) +
      `<td>${restart}${hold}</td>` +
      "</tr>"
    );
  });

  // Another machine's state is not reachable from here, so its rows are that
  // machine's own `check` sheet with the sheet's time beside them.
  const elsewhere = args.machines
    .filter((one) => one.id !== args.machine)
    .map((one) => {
      const said = args.findings.filter(
        (finding) => finding.machine === one.id && UNIT_KINDS.includes(finding.kind),
      );
      const rows = said.map(
        (finding) =>
          "<tr>" + cell(finding.subject) + cell(finding.kind) + cell(finding.says, "said") + cell(finding.updated_at) + "</tr>",
      );
      return (
        `<h2>${escape(one.id)}</h2>` +
        (rows.length === 0
          ? `<p class="empty">nothing is reported for ${escape(one.id)} in the check sheet this store holds.</p>`
          : table(["entry", "finding", "what it says", "as of"], rows))
      );
    })
    .join("\n");

  // What `check` said about this machine's memory, in its own words and with
  // its own command, because a resident over its limit is a finding and not a
  // colour on a row.
  const said = args.findings.filter(
    (finding) => finding.machine === args.machine && MEMORY_KINDS.includes(finding.kind),
  );
  const memory =
    said.length === 0
      ? ""
      : "<h2>memory</h2>" +
        table(
          ["entry", "finding", "what it says", "the fix", "as of"],
          said.map(
            (finding) =>
              "<tr>" + cell(finding.subject) + cell(finding.kind) + cell(finding.says, "said") + cell(finding.fix) + cell(finding.updated_at) + "</tr>",
          ),
        );

  const acts = args.acts.map(
    (row) =>
      "<tr>" + cell(row.target_id) + cell(row.target_kind) + cell(row.actor) + cell(row.status) + cell(row.cause) + cell(row.requested_at) + "</tr>",
  );

  return page({
    title: "machines",
    here: "/",
    notice: args.notice,
    body: [
      `<h2>${escape(args.machine)}</h2>`,
      rows.length === 0
        ? '<p class="empty">this machine runs nothing the registry declares.</p>'
        : table(
            ["entry", "kind", "wanted", "seen", "pid", "peak bytes", "reading bytes", "limit mb", ""],
            rows,
          ),
      memory,
      elsewhere,
      "<h2>asked for</h2>",
      acts.length === 0
        ? '<p class="empty">nobody has asked for anything.</p>'
        : table(["target", "kind", "asked by", "state", "cause", "asked at"], acts),
    ].join("\n"),
  });
}

export function peoplePage(args: {
  people: PersonEntry[];
  agents: AgentEntry[];
  openTurns: Record<string, number>;
  agentHealth: { id: string; data: Record<string, unknown> }[];
  doorHealth: { id: string; data: Record<string, unknown> }[];
  lifetimes: Record<string, { mode: string; sleeping: boolean }>;
  findings: CheckRow[];
  notice?: string | null;
}): string {
  const body = args.people
    .map((person) => {
      const mine = args.agents.filter((agent) => agent.person === person.id);
      const rows = mine.map((agent) => {
        const life = args.lifetimes[agent.id] ?? { mode: "resident", sleeping: false };
        const health = args.agentHealth.find((row) => row.id === agent.id);
        const door = args.doorHealth.find((row) => row.data.door === agent.door && row.data.chat === agent.chat);
        const word = wordFor({
          findings: args.findings,
          // An agent that takes jobs alone names no door and no chat, so the
          // only findings about it are the ones that name it by id.
          about: agent.door === undefined ? [agent.id] : [agent.id, agent.door, `${agent.door}/${agent.chat}`],
          openTurns: args.openTurns[agent.id] ?? 0,
        });
        return (
          "<tr>" +
          cell(agent.id) +
          cell(word, "word") +
          cell(args.openTurns[agent.id] ?? 0) +
          cell(life.mode) +
          cell(life.sleeping ? "asleep" : "awake") +
          cell(health?.data.status) +
          cell(door?.data.status) +
          `<td>${act("/act/sleeping", agent.id, life.sleeping ? "wake" : "pause", life.sleeping ? "false" : "true")}</td>` +
          "</tr>"
        );
      });
      return (
        `<h2>${escape(person.id)}</h2>` +
        (rows.length === 0
          ? `<p class="empty">no agent is declared for ${escape(person.id)}.</p>`
          : table(["agent", "", "waiting on", "mode", "sleeping", "agent", "chat", ""], rows))
      );
    })
    .join("\n");
  return page({
    title: "people",
    here: "/people",
    notice: args.notice,
    body: body === "" ? '<p class="empty">this registry declares nobody.</p>' : body,
  });
}

export function findingsPage(args: { findings: CheckRow[]; notice?: string | null }): string {
  const machines = [...new Set(args.findings.map((finding) => finding.machine))].sort();
  const body = machines
    .map((machine) => {
      const rows = args.findings
        .filter((finding) => finding.machine === machine)
        .map(
          (finding) =>
            "<tr>" +
            cell(finding.kind) +
            cell(finding.subject) +
            cell(finding.says, "said") +
            cell(finding.fix) +
            cell(finding.updated_at) +
            "</tr>",
        );
      return `<h2>${escape(machine)}</h2>` + table(["finding", "subject", "what it says", "the fix", "as of"], rows);
    })
    .join("\n");
  // The one act with a cost. `runCheck` writes the sheet and opens every
  // credential, so it is not a read and no page view runs it.
  const now = '<form method="post" action="/act/check"><button type="submit">check now</button></form>';
  return page({
    title: "findings",
    here: "/findings",
    notice: args.notice,
    body: [body === "" ? '<p class="empty">the check sheet holds nothing.</p>' : body, `<p>${now}</p>`].join("\n"),
  });
}

/** One recognizer's line of the health sheet, as the sheet holds it. */
export type VoiceHealthLine = { recognizer: string } & VoiceHealthRow;

export function metricsPage(args: {
  rows: MetricsRow[];
  /**
   * The recognizer's health, or null when this household names no recognizer.
   *
   * THREE FACTS, RENDERED THREE WAYS. Null is a household that does not
   * transcribe at all and gets no voice block. An empty list is a household
   * that does and has never had a failure, which is said in its own line
   * rather than claimed as health. A list with rows is printed as the sheet
   * holds it, field for field, so this page and `check` cannot disagree about
   * whether transcription is working.
   */
  health: VoiceHealthLine[] | null;
  notice?: string | null;
}): string {
  const scopes = [...new Set(args.rows.map((row) => row.scope))];
  const body = scopes
    .map((scope) => {
      const rows: string[] = [];
      for (const row of args.rows.filter((one) => one.scope === scope)) {
        for (const [metric, measure] of Object.entries(row.measures)) {
          const nothing = measure.count === 0;
          rows.push(
            "<tr>" +
              cell(row.id) +
              cell(row.window) +
              cell(metric) +
              cell(nothing ? NOTHING : Math.round(measure.p50_ms ?? 0)) +
              cell(nothing ? NOTHING : Math.round(measure.p99_ms ?? 0)) +
              cell(nothing ? NOTHING : measure.count) +
              "</tr>",
          );
        }
      }
      return `<h2>${escape(scope)}</h2>` + table(["who", "window", "measure", "p50 ms", "p99 ms", "count"], rows);
    })
    .join("\n");
  // The transcribing interval needs no code of its own here: the table above
  // prints whatever the reader returned, which is why the sixth measure was
  // built beside the five rather than as a shape of its own.
  const voice =
    args.health === null
      ? ""
      : "<h2>voice</h2>" +
        (args.health.length === 0
          ? '<p class="empty">no recognizer has ever failed.</p>'
          : table(
              ["recognizer", "failing since", "class", "cause", "attempts", "next try", "last worked"],
              args.health.map(
                (row) =>
                  "<tr>" + cell(row.recognizer) + cell(row.since) + cell(row.class) + cell(row.cause) + cell(row.attempts) + cell(row.retry_at) + cell(row.last_ok_at) + "</tr>",
              ),
            ));
  return page({
    title: "metrics",
    here: "/metrics",
    notice: args.notice,
    body: [body === "" ? '<p class="empty">nothing has been measured yet.</p>' : body, voice]
      .filter((one) => one !== "")
      .join("\n"),
  });
}
