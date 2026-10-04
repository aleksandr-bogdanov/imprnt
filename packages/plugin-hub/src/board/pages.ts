import {
  cardBroken, cardHeld, cardOk, cardQueued, cardStale, cardWaiting, chatBusy, chatHealthy, chatPaused, chatRetryAt, chatRetrying, chatStuck,
  chatUnreachable, overviewChats, overviewFindings, turnReason,
} from "../door/lines.ts";
import { wantedState } from "../os/diff.ts";
import { NEVER_STOPPED, type AgentEntry, type MachineEntry, type PersonEntry, type PresetEntry, type RunEntry } from "../registry/load.ts";
import type { MetricsRow } from "../metrics/stamps.ts";
import type { VoiceHealthRow } from "../voice/health.ts";
import type { ChatNewest, ChatPage } from "./chats.ts";
import { defaultTools, type RemoteFact } from "./fleet.ts";
import { cell, escape, NOTHING, page, rawCell, table, whole, wordsCell } from "./html.ts";
import { renderChatText } from "./markup.ts";
import { agentCause, agentNext, fillCommand, findingGist, kindGist, mib, plainCause, plainLine, requestCause, type CommandPlaces, type FilledCommand } from "./plain.ts";
import type { PlacedTurn, TurnState, TurnSummary } from "./turns.ts";
import type { UsageRow, WindowLine } from "./usage.ts";

/**
 * The pages, each taking what its readers already returned.
 *
 * NOTHING HERE OPENS A STORE, A FILE OR A SEAM. Every function is pure, so a
 * page can be rendered without a server and what a page SHOWS is separable
 * from what a request READS.
 *
 * THE PAGE COMPUTES NOTHING. Where a card needs a sentence, the sentence is
 * whether the `check` sheet holds a finding about this thing, in that
 * finding's own words, or where the store places that agent's open messages. A
 * board that worked out its own verdict would disagree with `check` the first
 * time the two rules drifted, and then a household would have two answers to
 * one question.
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

/**
 * What a `check` command needs to be filled in: the machine this board runs
 * on, its registry file, every machine the file declares with its service
 * manager and hub, and the file each machine's hub reported running with, so a
 * command is placed on the machine it runs on and names a file that is there.
 */
export type FixContext = CommandPlaces;

/** The unit-family findings, which say something about an entry that is not declared. */
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

/** One act, as a form that posts and redirects. There is no other kind here. */
function act(at: string, target: string, label: string, value?: string): string {
  const hidden = value === undefined ? "" : `<input type="hidden" name="value" value="${escape(value)}">`;
  return (
    `<form method="post" action="${escape(at)}">` +
    `<input type="hidden" name="target" value="${escape(target)}">${hidden}` +
    `<button type="submit">${escape(label)}</button></form>`
  );
}

/** `2026-10-04 00:30 UTC`: a time a person reads, to the minute, in the clock every day here is cut by. */
function whenOf(at: string | null | undefined): string | null {
  if (at === null || at === undefined || at === "") return null;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return String(at);
  return `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** An entry's own limit, in the unit it is enforced in. */
function limitOf(entry: RunEntry): string {
  return `${entry.memory_limit_mb} MiB`;
}

/**
 * A finding's fix, with the command it carries taken out of the sentence, the
 * registry file filled in and the machine it runs on named. Without a context
 * the page knows no registry file, so a command that needs one is not shown.
 */
function fixOf(finding: CheckRow, context: FixContext | undefined): FilledCommand {
  return fillCommand(String(finding.fix ?? ""), finding.machine, context ?? { here: finding.machine, registryFile: "", machines: [] });
}

/**
 * A fix as markup: the sentence before the command, the command alone in the
 * copy box with the machine it runs on, and the sentence after it, each in its
 * own face. Only a command is ever in the box, so one tap copies something
 * that runs; a fix in words alone has no box at all.
 */
function fixMarkup(fixed: FilledCommand): string {
  return [
    fixed.lead === "" ? "" : `<span class="lead">${whole(fixed.lead)}</span>`,
    fixed.text === ""
      ? ""
      : `${fixed.on === "" ? "" : `<span class="on">run on ${escape(fixed.on)}</span>`}<code class="cmd">${escape(fixed.text)}</code>`,
    fixed.tail === "" ? "" : `<span class="tail">${whole(fixed.tail)}</span>`,
    fixed.unavailable === "" ? "" : `<span class="none">${whole(fixed.unavailable)}</span>`,
  ].join("");
}

/**
 * How long a hyphenated subject may be and still be kept whole beside a fix:
 * `kim-shopping` is, and a unit file's long name wraps at its own hyphens so
 * the fix column keeps its room.
 */
const SHORT_ID = 16;

/** The fix cell of a table. */
function fixCell(fixed: FilledCommand): string {
  const inner = fixMarkup(fixed);
  return inner === "" ? cell(null) : `<td class="fix">${inner}</td>`;
}

/** Each state's own sentence, in the order a card says them. */
const CARD_FOR: Record<TurnState, (language: "en", values: { count: number }) => string> = {
  answering: cardWaiting,
  held: cardHeld,
  stale: cardStale,
  queued: cardQueued,
};

/**
 * The sentence on a card.
 *
 * `about` is every subject a finding could name for this thing: the agent, its
 * door, and the door and chat together, which is how a chat that cannot be read
 * is written down. A finding outranks everything, because a person whose agent
 * is broken is waiting too and the first sentence is the one worth reading, and
 * the broken sentence is the finding's own words rather than a word about it.
 * Without one the card says where the agent's open messages stand, one sentence
 * per state that has any, and "answering" only for a turn the store shows
 * running with its owner connected.
 */
export function wordFor(args: { findings: CheckRow[]; about: string[]; turns?: TurnSummary }): string {
  const found = args.findings.find((finding) => args.about.includes(finding.subject));
  if (found) return cardBroken("en", { says: ownWords(found, args.about) });
  const counts = args.turns?.counts;
  const parts: string[] = [];
  for (const state of ["answering", "held", "stale", "queued"] as TurnState[]) {
    const count = counts?.[state] ?? 0;
    if (count > 0) parts.push(CARD_FOR[state]("en", { count }));
  }
  return parts.length === 0 ? cardOk("en") : parts.join("; ");
}

/**
 * A finding's sentence without what the row it sits on already says: its own
 * kind's code at the head (`agent-retry: kim-shopping: …`, the shape `check`'s
 * closed finding line has) and the name the row is headed by. Nothing else in
 * the sentence is touched; it is still `check`'s own words.
 */
export function ownWords(found: CheckRow, names: string[]): string {
  let text = plainLine(found.says);
  if (text.startsWith(`${found.kind}: `)) text = text.slice(found.kind.length + 2);
  for (const name of [found.subject, ...names]) {
    const lead = [`${name}: `, `${name} is `, `${name} `].find((one) => text.startsWith(one));
    if (lead !== undefined) {
      text = text.slice(lead.length);
      break;
    }
  }
  return text.trim();
}

/**
 * Every state an agent's open messages are in, one counted sentence each, or
 * null when they are in fewer than two. The people page says it beside the
 * one state only when there is more to it than that state, so a mix of held,
 * unfinished and waiting messages is not folded into the first of them, and a
 * single state is not said twice.
 */
function openMessages(summary: TurnSummary | undefined): string | null {
  const states = Object.values(summary?.counts ?? {}).filter((count) => count > 0).length;
  return states < 2 ? null : wordFor({ findings: [], about: [], turns: summary });
}

/**
 * What the store can say about a remote entry's connection, and nothing it
 * cannot. A piece that is not meant to be running connects only while it runs,
 * so "not connected" is said with why that is expected; and with no reading at
 * all (the read failed), the cell says the observation is unavailable rather
 * than leaving a blank a person reads as fine.
 */
function connectionOf(fact: RemoteFact | undefined, wanted: string, observed: boolean): string {
  if (!observed || !fact) return "observation unavailable";
  if (fact.connected) return "connected now";
  if (wanted === "scheduled") return "not connected now; it connects only while it runs";
  if (wanted === "loaded") return "not connected now; it connects only when it is started";
  if (wanted === "stopped") return "not connected now; stopped in the registry";
  return "not connected now";
}

/**
 * What a folded machine line adds about the findings on it: how many, and the
 * first two in a few words each, so a problem inside is never hidden behind a
 * closed fold. A pointer to the findings, never a second wording of them.
 */
function foundOn(findings: CheckRow[]): string {
  if (findings.length === 0) return "";
  const named = findings.slice(0, 2).map(findingGist);
  const more = findings.length > 2 ? `, and ${findings.length - 2} more` : "";
  return `; ${findings.length} ${findings.length === 1 ? "finding" : "findings"}: ${named.join(", ")}${more}`;
}

/**
 * The findings about one machine: about the machine itself (a registry copy,
 * a silent hub), about an entry it declares, or a unit or memory finding its
 * own `check` wrote. Each finding once, in the sheet's order.
 */
function findingsAbout(findings: CheckRow[], machine: string, ids: Set<string>): CheckRow[] {
  return findings.filter((finding) =>
    finding.subject === machine || ids.has(finding.subject) ||
    (finding.machine === machine && (UNIT_KINDS.includes(finding.kind) || MEMORY_KINDS.includes(finding.kind))));
}

/** The arguments every rendering of the machines carries. */
export interface MachinesArgs {
  machine: string;
  entries: RunEntry[];
  machines: MachineEntry[];
  status: { id: string; wanted: string; seen: string; pid: number | null }[];
  findings: CheckRow[];
  /**
   * The peaks sheet as the hub wrote it: the largest this piece has ever been
   * and what it was holding at the last sample, and when.
   *
   * THE PAGE READS THE CURRENT READING AND NEVER MEASURES IT. It is the hub's
   * own record, taken on the hub's own tick on the machine that runs the piece,
   * and a read that could start work is not a read: a page that sampled would
   * touch every process on the box every time somebody refreshed it.
   */
  peaks: { id: string; bytes: number; reading_bytes?: number | null; reading_at?: string | null }[];
  /**
   * What the store says about each entry on another machine, by id. Null when
   * the read failed, which every remote row then says.
   */
  remote?: Record<string, RemoteFact> | null;
  acts: ControlRow[];
  /** Where `check` commands are filled in. Absent leaves them as `check` wrote them. */
  fix?: FixContext;
  notice?: string | null;
}

/** One machine's section, as a summary line and the body it opens to. */
interface MachineSection {
  id: string;
  summary: string;
  body: string;
}

function machineSections(args: MachinesArgs): MachineSection[] {
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
    return [
      cell(entry.id, "id"),
      cell(entry.kind),
      // The manager's own word, where the manager said one.
      cell(said?.wanted),
      cell(said?.seen),
      cell(said?.pid, "num"),
      cell(peak ? mib(peak.bytes) : null, "num"),
      // An absent reading is the nothing mark and never a zero, because zero
      // bytes is a measurement and "nothing has sampled it" is not.
      cell(peak ? mib(peak.reading_bytes ?? null) : null, "num"),
      cell(limitOf(entry), "num"),
      rawCell(`${restart}${hold}`, "acts"),
    ];
  });

  // What `check` said about this machine's memory, in its own words and with
  // its own command, because a resident over its limit is a finding and not a
  // colour on a row.
  const memorySaid = args.findings.filter(
    (finding) => finding.machine === args.machine && MEMORY_KINDS.includes(finding.kind),
  );
  const memory =
    memorySaid.length === 0
      ? ""
      : "<h3>memory</h3>" +
        table(
          ["entry", "finding", "what it says", "the fix", "as of"],
          memorySaid.map((finding) => [
            wordsCell(finding.subject, "id", SHORT_ID), wordsCell(finding.kind), cell(ownWords(finding, [finding.subject]), "said"), fixCell(fixOf(finding, args.fix)), wordsCell(whenOf(finding.updated_at), "when"),
          ]),
        );

  // How this machine's pieces stand against the file, counted from the
  // manager's own answers. No answer at all is said as that, never as "fine".
  const differ = here.filter((entry) => {
    const said = args.status.find((one) => one.id === entry.id);
    return said !== undefined && said.wanted !== said.seen;
  }).length;
  const hereSummary = (here.length === 0
    ? "this machine: runs nothing the registry declares"
    : args.status.length === 0
      ? `this machine: ${here.length} declared, the service manager did not answer`
      : differ === 0
        ? `this machine: ${here.length} declared, all as the registry wants`
        : `this machine: ${here.length} declared, ${differ} not as the registry wants`) +
    foundOn(findingsAbout(args.findings, args.machine, new Set(here.map((entry) => entry.id))));
  const own: MachineSection = {
    id: args.machine,
    summary: hereSummary,
    body: [
      rows.length === 0
        ? '<p class="empty">this machine runs nothing the registry declares.</p>'
        : table(["entry", "kind", "wanted", "seen", "pid", "peak", "now", "limit", ""], rows),
      memory,
    ].filter((part) => part !== "").join("\n"),
  };

  // ANOTHER MACHINE IS NOT REACHABLE FROM HERE, and its section says what is
  // declared for it and what the store recorded, never a state inferred from
  // what is missing. Every declared entry has a row, so a machine with nothing
  // wrong is a list of what it runs and not an empty section.
  const observed = args.remote !== null;
  const others = args.machines.filter((one) => one.id !== args.machine).map((one): MachineSection => {
    const declared = args.entries.filter((entry) => entry.machine === one.id);
    const ids = new Set(declared.map((entry) => entry.id));
    const known = findingsAbout(args.findings, one.id, ids);
    let connected = 0;
    // Only an entry the registry wants running all the time is expected to be
    // connected now. A scheduled or on-demand piece connects only while it
    // runs, and a stopped one not at all, so neither is ever counted as a
    // connection that is missing.
    const missing: string[] = [];
    const units = declared.map((entry) => {
      const wanted = wantedState(entry);
      const fact = args.remote?.[entry.id];
      if (observed && fact?.connected) connected += 1;
      if (observed && fact !== undefined && !fact.connected && wanted === "running") missing.push(entry.id);
      const peak = args.peaks.find((row) => row.id === entry.id);
      const reading = peak ? mib(peak.reading_bytes ?? null) : null;
      const about = known.filter((finding) => finding.subject === entry.id).map((finding) => kindGist(finding.kind));
      return [
        cell(entry.id, "id"),
        cell(entry.kind),
        cell(wanted),
        cell(connectionOf(fact, wanted, observed)),
        cell(entry.kind !== "runner" ? null : !observed ? "observation unavailable" : whenOf(fact?.started_at) ?? "no start recorded", "when"),
        cell(reading ?? "no sample recorded", "num"),
        cell(reading === null ? null : whenOf(peak?.reading_at), "when"),
        cell(limitOf(entry), "num"),
        cell(about.length === 0 ? "none recorded" : [...new Set(about)].join(", ")),
      ];
    });
    const said = known
      .map((finding) => [
        wordsCell(finding.subject, "id", SHORT_ID), wordsCell(finding.kind), cell(ownWords(finding, [finding.subject]), "said"), fixCell(fixOf(finding, args.fix)), wordsCell(whenOf(finding.updated_at), "when"),
      ]);
    const wantedMissing = missing.length === 0
      ? ""
      : `; ${missing.length} wanted running ${missing.length === 1 ? "is" : "are"} not connected: ${missing.join(", ")}`;
    const summary = (declared.length === 0
      ? "declares nothing to run"
      : !observed
        ? `${declared.length} declared, observation unavailable`
        : `${declared.length} declared, ${connected} connected to the store now${wantedMissing}`) + foundOn(known);
    return {
      id: one.id,
      summary,
      body: [
        '<p class="empty">this board asks no other machine anything: below is what the registry declares there and what the store recorded, and no finding does not mean running.</p>',
        units.length === 0
          ? '<p class="empty">the registry declares nothing to run on this machine.</p>'
          : table(
              ["entry", "kind", "wanted", "store connection", "runner started", "memory now", "sampled at", "limit", "findings"],
              units,
            ),
        said.length === 0 ? "" : table(["subject", "finding", "what it says", "the fix", "as of"], said),
      ].filter((part) => part !== "").join("\n"),
    };
  });
  return [own, ...others];
}

/**
 * The restarts, stops and recoveries somebody asked for and what came of each,
 * newest first as the sheet keeps it. The `control` sheet holds what was asked
 * from this board, from the command line and from a chat alike, which is why
 * the fold is named for the requests and not for the board, and "asked by"
 * says which.
 */
const REQUESTS = "restart and recovery requests";

function actsTable(acts: ControlRow[]): string {
  const rows = acts.map((row) => [
    cell(row.target_id, "id"), cell(row.target_kind), cell(row.actor), cell(row.status), cell(requestCause(row.cause)), cell(whenOf(row.requested_at), "when"),
  ]);
  return rows.length === 0
    ? '<p class="empty">nobody has asked for anything.</p>'
    : table(["target", "kind", "asked by", "state", "cause", "asked at"], rows);
}

/** The requests fold's summary: how many, and how many were refused, so a refusal is not hidden behind the fold. */
function requestsSummary(acts: ControlRow[]): string {
  if (acts.length === 0) return "none recorded";
  const refused = acts.filter((row) => row.status === "refused").length;
  return `${acts.length} recorded${refused === 0 ? "" : `, ${refused} refused`}`;
}

/** Every machine, opened, as its own page. */
export function machinesPage(args: MachinesArgs): string {
  const sections = machineSections(args);
  return page({
    title: "machines",
    here: "/",
    notice: args.notice,
    body: [
      ...sections.map((one) => `<h2>${escape(one.id)}</h2>\n<p class="sub">${escape(one.summary)}</p>\n${one.body}`),
      `<h2>${REQUESTS}</h2>`,
      actsTable(args.acts),
    ].join("\n"),
  });
}

/** A time a person reads at a glance: the clock alone today, the day too otherwise, always UTC. */
function shortWhen(at: string | null | undefined, now: Date): string {
  if (at === null || at === undefined || at === "") return NOTHING;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return String(at);
  const clock = `${String(when.getUTCHours()).padStart(2, "0")}:${String(when.getUTCMinutes()).padStart(2, "0")} UTC`;
  if (when.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return clock;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][when.getUTCMonth()];
  return `${when.getUTCDate()} ${month} ${clock}`;
}

/**
 * How pressing a chat's row is, lowest first: a chat that is stuck, then one
 * whose input is held for the owner, then one that keeps failing, then work in
 * progress, then a paused one, then a healthy one.
 */
export type ChatRank = 0 | 1 | 2 | 3 | 4 | 5;

export interface ChatLine {
  agent: AgentEntry;
  rank: ChatRank;
  /** The one sentence, from the pinned vocabulary. */
  says: string;
  /** Why, in the store's or the finding's own closed words, or null. */
  why: string | null;
  /** The record's whole words where `why` shortens them, for the people page only. */
  detail?: string;
}

/** Whether a rank is something a person has to look at. */
export const needsAttention = (rank: ChatRank): boolean => rank <= 2;

/**
 * One chat's line on the first screen. The order of the checks is the order of
 * the ranks, and every sentence is a pinned one: a finding in its own words, a
 * recorded failure, the store's turn states, the file's own pause, and only
 * with none of those, healthy.
 */
export function chatLine(args: {
  agent: AgentEntry;
  findings: CheckRow[];
  turns?: TurnSummary;
  agentHealth?: Record<string, unknown> | null;
  doorHealth?: Record<string, unknown> | null;
  sleeping: boolean;
  now: Date;
}): ChatLine {
  const { agent, now } = args;
  const about = agent.door === undefined ? [agent.id] : [agent.id, agent.door, `${agent.door}/${agent.chat}`];
  const found = args.findings.find((finding) => about.includes(finding.subject));
  const counts = args.turns?.counts ?? { answering: 0, queued: 0, held: 0, stale: 0 };
  const oldest = args.turns?.oldest ?? {};
  const reason = (one: PlacedTurn | undefined) =>
    one ? turnReason("en", one.reason, { runner: one.runner ?? "", at: shortWhen(one.at, now), cause: one.cause ?? "" }) : null;
  const line = (rank: ChatRank, says: string, why: string | null = null): ChatLine => ({ agent, rank, says, why });
  const retryAt = (health: Record<string, unknown>) =>
    health.retry_at === undefined || health.retry_at === null || health.retry_at === "" ? null : chatRetryAt("en", { at: shortWhen(String(health.retry_at), now) });

  // A finding outranks the store's states and is said once, as one state: the
  // row is already headed by the agent's name, so the sentence does not say it
  // again, and a retrying agent is said to be retrying, not stuck AND retrying.
  // When the finding's words carry a colon of their own, the state stands
  // alone and the finding's words are the why, so no line holds two.
  if (found) {
    const words = ownWords(found, about);
    if (found.kind === "agent-retry") {
      const health = args.agentHealth?.status === "retry" ? args.agentHealth : null;
      if (health) {
        return line(0, chatRetrying("en", { cause: plainCause(health.cause) || "failed" }), retryAt(health));
      }
      const cause = words.replace(/^retrying(?::\s*|\s*$)/, "").replace(/\.$/, "");
      return line(0, cause === "" ? "retrying" : chatRetrying("en", { cause }));
    }
    return words.includes(": ") ? line(0, "stuck", words) : line(0, chatStuck("en", { why: words }));
  }
  if (args.doorHealth?.status === "failed") {
    return line(0, chatUnreachable("en"), plainCause(args.doorHealth.cause ?? args.doorHealth.code ?? "failed") || "failed");
  }
  if (args.agentHealth?.status === "blocked") {
    const remedy = args.agentHealth.remedy === undefined ? "" : plainLine(args.agentHealth.remedy);
    const next = agentNext(args.agentHealth.cause, args.agentHealth.remedy);
    const said = line(0, chatStuck("en", { why: agentCause(args.agentHealth.cause) || "blocked" }), next);
    return remedy === "" || remedy === next ? said : { ...said, detail: remedy };
  }
  if (counts.stale > 0) return line(0, chatStuck("en", { why: reason(oldest.stale) ?? "" }), counts.stale > 1 ? cardStale("en", { count: counts.stale }) : null);
  if (counts.held > 0) return line(1, cardHeld("en", { count: counts.held }), reason(oldest.held));
  if (args.agentHealth?.status === "retry") {
    return line(2, chatRetrying("en", { cause: plainCause(args.agentHealth.cause) || "failed" }), retryAt(args.agentHealth));
  }
  if (counts.answering > 0) {
    const busy = oldest.answering!;
    return line(3, chatBusy("en", { kind: busy.kind, at: shortWhen(busy.at, now) }), counts.queued > 0 ? cardQueued("en", { count: counts.queued }) : null);
  }
  if (counts.queued > 0) return line(3, cardQueued("en", { count: counts.queued }), reason(oldest.queued));
  if (args.sleeping) return line(4, chatPaused("en"));
  return line(5, chatHealthy("en"));
}

/**
 * THE FIRST SCREEN, by the owner's ruling: on a phone it answers "is everything
 * okay" before anything else. One sentence for the household, one line per
 * chat with the ones that need a person first, then what `check` holds with
 * commands to copy, and the machines folded away, each a summary line that
 * opens to its full table, memory and acts included.
 */
export function overviewPage(args: MachinesArgs & {
  people: PersonEntry[];
  agents: AgentEntry[];
  turns: Record<string, TurnSummary>;
  agentHealth: { id: string; data: Record<string, unknown> }[];
  doorHealth: { id: string; data: Record<string, unknown> }[];
  lifetimes: Record<string, { mode: string; sleeping: boolean }>;
  now: Date;
}): string {
  const lines = args.agents.map((agent) => chatLine({
    agent,
    findings: args.findings,
    turns: args.turns[agent.id],
    agentHealth: args.agentHealth.find((row) => row.id === agent.id)?.data ?? null,
    doorHealth: agent.door === undefined
      ? null
      : args.doorHealth.find((row) => row.data.door === agent.door && row.data.chat === agent.chat)?.data ?? null,
    sleeping: args.lifetimes[agent.id]?.sleeping ?? false,
    now: args.now,
  }));
  // Problems first, then by the file's own order, which is stable.
  const ordered = lines.map((one, at) => ({ one, at })).sort((a, b) => a.one.rank - b.one.rank || a.at - b.at).map((x) => x.one);
  // The headline counts chats, which is what a person talks to; a job-only
  // worker has a row of its own and is never counted as a chat.
  const chatLines = lines.filter((one) => one.agent.chat !== undefined);
  const problems = chatLines.filter((one) => needsAttention(one.rank)).length;
  const chats = chatLines.length;
  const row = (one: ChatLine) => {
    const name = one.agent.chat === undefined
      ? `<span class="name">${escape(one.agent.id)}</span>`
      : `<a class="name" href="${escape(chatPath(one.agent.person, one.agent.id))}">${escape(one.agent.id)}</a>`;
    const what = one.agent.chat === undefined ? `${one.agent.person} · worker` : one.agent.person;
    return (
      `<li class="chat${needsAttention(one.rank) ? " attention" : ""}">` +
      `<div class="head">${name}<span class="who">${escape(what)}</span></div>` +
      `<div class="says">${escape(one.says)}</div>` +
      (one.why === null || one.why === "" ? "" : `<div class="why">${escape(one.why)}</div>`) +
      "</li>"
    );
  };
  const findingRows = args.findings.map((finding) => {
    const fixed = fixMarkup(fixOf(finding, args.fix));
    return (
      '<li class="finding">' +
      `<div class="head"><span class="kind">${escape(finding.kind)}</span><span class="who">${escape(finding.subject)}${finding.machine === "" ? "" : ` · ${escape(finding.machine)}`}</span></div>` +
      `<div class="says">${escape(ownWords(finding, [finding.subject]))}</div>` +
      (fixed === "" ? "" : `<div class="fix">${fixed}</div>`) +
      "</li>"
    );
  });
  const sections = machineSections(args);
  const headline = lines.length === 0
    ? "this registry declares no agent."
    : chats === 0 ? "this registry declares no chat." : overviewChats("en", { problems, chats });
  return page({
    title: "status",
    here: "/",
    notice: args.notice,
    heading: headline,
    body: [
      `<p class="sub">${escape(overviewFindings("en", { count: args.findings.length }))} As of ${escape(shortWhen(args.now.toISOString(), args.now))}.</p>`,
      // The chats, and what `check` holds beside them on a wide screen.
      '<div class="first">',
      lines.length === 0 ? "" : `<section class="now"><ul class="chats">\n${ordered.map(row).join("\n")}\n</ul></section>`,
      findingRows.length === 0 ? "" : `<section class="found"><h2>findings</h2>\n<ul class="findings">\n${findingRows.join("\n")}\n</ul></section>`,
      "</div>",
      "<h2>machines</h2>",
      ...sections.map((one) =>
        `<details class="machine"><summary><span class="name">${escape(one.id)}</span> <span class="who">${whole(one.summary)}</span></summary>\n${one.body}\n</details>`),
      `<details class="machine"><summary><span class="name">${REQUESTS}</span> <span class="who">${requestsSummary(args.acts)}</span></summary>\n${actsTable(args.acts)}\n</details>`,
    ].filter((part) => part !== "").join("\n"),
  });
}

/**
 * What an agent may do and where it runs, read off the registry and nothing
 * else, beside the owner's approvals the store recorded for its chat.
 *
 * NO ACL IS INVENTED HERE. What the file says is printed: the machine its
 * runner is declared on, whether it answers in a chat or takes jobs alone, its
 * preset's engine and model, the tool list exactly as the entry carries it (an
 * entry with none is launched with its engine's default list, which is printed
 * from the same constant the launch reads, see `defaultTools`), and whether it
 * names MCP servers of its own. Approvals are the `confirmation`
 * rows for its chat: how many wait for the owner's reaction, and when the last
 * one was approved.
 */
export interface FleetFacts {
  /** Each runner entry's machine, by runner id. */
  runnerMachine: Record<string, string>;
  presets: Record<string, PresetEntry>;
  /** Pending and last approved confirmations per `<door>/<chat>`. */
  approvals: Record<string, { pending: number; approved_at: string | null }>;
}

function fleetRows(agents: AgentEntry[], fleet: FleetFacts, now: Date): string[][] {
  return agents.map((agent) => {
    const preset = fleet.presets[agent.preset];
    const answers = agent.role === "triage"
      ? "triage master: no tools, no MCP"
      : agent.role === "council"
        ? "council seat: jobs only"
        : agent.chat === undefined ? "worker: jobs only" : `master: chat on ${agent.door}`;
    // The literal face only for tool names, never for a sentence.
    const fallback = agent.tools === undefined && agent.role !== "triage" ? defaultTools(preset?.adapter ?? "") : null;
    const tools: [string, string] = agent.role === "triage"
      ? ["none", ""]
      : agent.tools !== undefined
        ? agent.tools.length === 0 ? ["none", ""] : [agent.tools.join(", "), "list"]
        : fallback === null
          ? [`default for ${preset?.adapter ?? agent.preset} not known to this board`, ""]
          : "list" in fallback ? [`default: ${fallback.list}`, "list"] : [`default: ${fallback.words}`, ""];
    const asked = agent.door === undefined ? undefined : fleet.approvals[`${agent.door}/${agent.chat}`];
    const machine = fleet.runnerMachine[agent.runner];
    // An agent with no chat has no reaction to wait for, so no approvals cell.
    const approvals = agent.door === undefined
      ? null
      : `${asked === undefined || asked.pending === 0 ? "none waiting" : `${asked.pending} waiting`}; ${
        asked?.approved_at ? `last approved ${shortWhen(asked.approved_at, now)}` : "never approved"}`;
    return [
      cell(agent.id, "id"),
      wordsCell(machine === undefined ? answers : `${answers}; runner on ${machine}`),
      wordsCell(preset ? `${agent.preset}: ${preset.adapter}, ${preset.model}` : agent.preset),
      cell(tools[0], tools[1]),
      cell(agent.role === "triage" ? "no" : agent.mcp === undefined ? "no" : "yes"),
      cell(approvals),
    ];
  });
}

/** A recorded health status as words: the agent's own row and its chat's door row, each only when there is one. */
const AGENT_HEALTH: Record<string, string> = { retry: "agent retrying", blocked: "agent blocked" };
const DOOR_HEALTH: Record<string, string> = { healthy: "its door reads the chat", failed: "its door cannot read the chat" };

function healthOf(agent: unknown, door: unknown): string | null {
  const parts = [
    agent === undefined || agent === null || agent === "" ? "" : AGENT_HEALTH[String(agent)] ?? `agent ${plainCause(agent)}`,
    door === undefined || door === null || door === "" ? "" : DOOR_HEALTH[String(door)] ?? `door ${plainCause(door)}`,
  ].filter((one) => one !== "");
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * Every person's agents, one row each: the same one state the first screen
 * says (its sentence and its why come from `chatLine`, so the two pages can
 * never disagree, a paused agent included), since when its oldest open message
 * waits, how it lives, what its health rows say, and its pause button. On a
 * phone an empty cell is not a row, so an idle agent is a short block.
 */
export function peoplePage(args: {
  people: PersonEntry[];
  agents: AgentEntry[];
  /** Where each agent's open messages stand, from `readTurnStates`. */
  turns: Record<string, TurnSummary>;
  agentHealth: { id: string; data: Record<string, unknown> }[];
  doorHealth: { id: string; data: Record<string, unknown> }[];
  lifetimes: Record<string, { mode: string; sleeping: boolean }>;
  findings: CheckRow[];
  /** What each agent may do, from the file and the confirmation rows. Absent leaves the section out. */
  fleet?: FleetFacts;
  notice?: string | null;
  now?: Date;
}): string {
  const now = args.now ?? new Date();
  const body = args.people
    .map((person) => {
      const mine = args.agents.filter((agent) => agent.person === person.id);
      const rows = mine.map((agent) => {
        const life = args.lifetimes[agent.id] ?? { mode: "resident", sleeping: false };
        const health = args.agentHealth.find((row) => row.id === agent.id)?.data ?? null;
        const door = agent.door === undefined
          ? null
          : args.doorHealth.find((row) => row.data.door === agent.door && row.data.chat === agent.chat)?.data ?? null;
        const turns = args.turns[agent.id];
        const said = chatLine({ agent, findings: args.findings, turns, agentHealth: health, doorHealth: door, sleeping: life.sleeping, now });
        const open = openMessages(turns);
        return [
          cell(agent.id, "id"),
          cell(said.says, "word"),
          cell(said.detail ?? said.why),
          cell(open),
          cell(turns?.since ? shortWhen(turns.since, now) : null, "when"),
          cell(`${life.mode}, ${life.sleeping ? "paused" : "awake"}`),
          cell(healthOf(health?.status, door?.status)),
          rawCell(act("/act/sleeping", agent.id, life.sleeping ? "wake" : "pause", life.sleeping ? "false" : "true"), "acts"),
        ];
      });
      return (
        `<h2>${escape(person.id)}</h2>` +
        (rows.length === 0
          ? `<p class="empty">no agent is declared for ${escape(person.id)}.</p>`
          : table(["agent", "state", "why", "open messages", "waiting since", "lifetime", "health", ""], rows, { compact: true }) +
            (args.fleet === undefined
              ? ""
              : `\n<h3>what ${escape(person.id)}'s agents may do</h3>\n` +
                table(["agent", "answers", "engine", "tools", "own MCP", "approvals"], fleetRows(mine, args.fleet, now), { compact: true })))
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

export function findingsPage(args: { findings: CheckRow[]; fix?: FixContext; notice?: string | null }): string {
  const machines = [...new Set(args.findings.map((finding) => finding.machine))].sort();
  const body = machines
    .map((machine) => {
      const rows = args.findings
        .filter((finding) => finding.machine === machine)
        .map((finding) => [
          wordsCell(finding.kind),
          wordsCell(finding.subject, "id", SHORT_ID),
          cell(ownWords(finding, [finding.subject]), "said"),
          fixCell(fixOf(finding, args.fix)),
          wordsCell(whenOf(finding.updated_at), "when"),
        ]);
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
  // Grouped by who, each under its own heading, and only what was measured:
  // a measure with nothing in it is not a row of dashes. A who with nothing
  // measured in one window says so in one line, and every who with nothing in
  // either window is named once in a line of its scope's own.
  const scopes = [...new Set(args.rows.map((row) => row.scope))];
  const body = scopes
    .map((scope) => {
      const mine = args.rows.filter((one) => one.scope === scope);
      const whos = [...new Set(mine.map((row) => row.id))];
      const idle: string[] = [];
      const sections: string[] = [];
      for (const who of whos) {
        // One small table per window, headed by the window itself, so a phone
        // shows four columns that fit rather than five labelled lines a row.
        const tables: string[] = [];
        const quiet: string[] = [];
        for (const row of mine.filter((one) => one.id === who)) {
          const window = row.window === "week" ? "this week" : row.window;
          const measured = Object.entries(row.measures).filter(([, measure]) => measure.count > 0);
          if (measured.length === 0) {
            quiet.push(window);
            continue;
          }
          tables.push(table(
            [window, "p50 ms", "p99 ms", "count"],
            measured.map(([metric, measure]) => [
              cell(metric),
              cell(Math.round(measure.p50_ms ?? 0), "num"),
              cell(Math.round(measure.p99_ms ?? 0), "num"),
              cell(measure.count, "num"),
            ]),
            { keep: true },
          ));
        }
        if (tables.length === 0) {
          idle.push(who);
          continue;
        }
        sections.push(
          `<h3>${escape(who)}</h3>` +
            (quiet.length === 0 ? "" : `<p class="empty">nothing measured ${escape(quiet.join(" or "))}.</p>`) +
            tables.join("\n"),
        );
      }
      if (idle.length > 0) sections.push(`<p class="empty">nothing measured this week for ${escape(idle.join(", "))}.</p>`);
      return `<h2>${escape(scope)}</h2>\n${sections.join("\n")}`;
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
              args.health.map((row) => [
                cell(row.recognizer), cell(row.since), cell(row.class), cell(plainCause(row.cause)), cell(row.attempts), cell(row.retry_at), cell(row.last_ok_at),
              ]),
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

/** Where one agent's chat page is. */
function chatPath(person: string, agent: string): string {
  return `/chats/${encodeURIComponent(person)}/${encodeURIComponent(agent)}`;
}

/**
 * Every person's agents, each with the day and a one-line preview of the
 * newest line its log holds on this machine. An agent whose log holds nothing
 * says so, a worker with no chat is a name and no link, and a person with no
 * agent says that.
 */
export function chatsPage(args: {
  people: PersonEntry[];
  agents: AgentEntry[];
  newest: Record<string, ChatNewest | null>;
}): string {
  const body = args.people
    .map((person) => {
      const mine = args.agents.filter((agent) => agent.person === person.id);
      const rows = mine.map((agent) => {
        // A worker takes jobs and has no chat, so it is a name and not a link
        // to a page that could only ever be empty, said the way the first
        // screen says it.
        if (agent.chat === undefined) {
          return (
            '<li class="chat">' +
            `<div class="head"><span class="name">${escape(agent.id)}</span><span class="who">worker</span></div>` +
            '<div class="why">takes jobs only, no chat</div>' +
            "</li>"
          );
        }
        const last = args.newest[agent.id] ?? null;
        return (
          '<li class="chat">' +
          `<div class="head"><a class="name" href="${escape(chatPath(person.id, agent.id))}">${escape(agent.id)}</a>` +
          `<span class="who">${last === null ? "" : `${escape(last.day)} · ${escape(last.from)}`}</span></div>` +
          (last === null
            ? '<div class="why">nothing has been said here yet</div>'
            : `<div class="says">${escape(last.text)}</div>`) +
          "</li>"
        );
      });
      return (
        `<h2>${escape(person.id)}</h2>` +
        (rows.length === 0
          ? `<p class="empty">no agent is declared for ${escape(person.id)}.</p>`
          : `<ul class="chats">\n${rows.join("\n")}\n</ul>`)
      );
    })
    .join("\n");
  return page({
    title: "chats",
    here: "/chats",
    body: body === "" ? '<p class="empty">this registry declares nobody.</p>' : body,
  });
}

/** `07:12`, the UTC clock time of a line, which is the clock its day is cut by. */
function clockOf(at: string): string {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return at;
  return `${String(when.getUTCHours()).padStart(2, "0")}:${String(when.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * One agent's chat, newest day first and newest line first inside a day, each
 * line as the time, who said it and what they said, and one plain link to the
 * older days. No button and no form: this page reads and does nothing.
 */
export function chatPage(args: { person: string; agent: string; chat: ChatPage; before?: string | null }): string {
  const days = args.chat.days.map((day) =>
    `<h2>${escape(day.day)}</h2>\n` +
    day.lines
      .map((line) =>
        `<div class="line"><div class="meta"><span class="when">${escape(clockOf(line.at))}</span> · ` +
        `<span class="from">${escape(line.from)}</span></div>` +
        `<div class="text">${renderChatText(line.text)}</div></div>`,
      )
      .join("\n"),
  );
  const empty = !args.chat.exists || args.chat.days.length === 0;
  const older =
    args.chat.older === null
      ? ""
      : `<p><a href="${escape(chatPath(args.person, args.agent))}?before=${escape(args.chat.older)}">older</a></p>`;
  return page({
    title: `${args.agent} chat`,
    here: "/chats",
    body: [
      `<p class="back"><a href="/chats">every chat</a> · ${escape(args.person)} · newest first</p>`,
      empty
        ? args.before
          ? '<p class="empty">nothing older than that.</p>'
          : '<p class="empty">nothing has been said here yet.</p>'
        : days.join("\n"),
      older,
    ]
      .filter((one) => one !== "")
      .join("\n"),
  });
}

/** A whole number with its thousands grouped, so a count of tokens reads at a glance. */
function grouped(value: number): string {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString("en-US") : String(value);
}

/** A price as a person reads it: the amount to four places and its currency. */
function priceOf(row: UsageRow): string {
  if (row.price === null) return NOTHING;
  return `${row.price.toFixed(4)}${row.currency === null ? "" : ` ${row.currency}`}`;
}

/** One window's spend as one cell: turns, tokens and price, each said only when the records carry it, and never a zero for nothing. */
function spentOf(row: UsageRow | undefined): string | null {
  if (row === undefined || row.turns === null || row.turns === 0) return null;
  return [
    `${grouped(row.turns)} ${row.turns === 1 ? "turn" : "turns"}`,
    row.tokens === null ? "no token count" : `${grouped(row.tokens)} tokens`,
    row.price === null ? "unpriced" : priceOf(row),
  ].join(" · ");
}

/** A plan window's reading, a fraction of one, as a person reads it; anything else in the sheet's own words. */
function usedOf(utilization: unknown): string | null {
  if (utilization === null || utilization === undefined || utilization === "") return null;
  const value = Number(utilization);
  if (typeof utilization === "boolean" || !Number.isFinite(value)) return String(utilization);
  return `${Math.round(value * 100)}% used`;
}

/**
 * What each agent spent today and over the last seven days, one row per agent
 * with the two windows side by side, and every credential's newest window
 * reading. Every nothing is the nothing mark: a zero on a page a person reads
 * is a claim, and "no turn ran" is not one.
 */
export function usagePage(args: { rows: UsageRow[]; windows: WindowLine[]; notice?: string | null }): string {
  const agents = [...new Set(args.rows.map((row) => row.agent))];
  const turns = agents.map((agent) => {
    const of = (window: UsageRow["window"]) => args.rows.find((row) => row.agent === agent && row.window === window);
    return [cell(agent, "id"), cell(spentOf(of("today")), "num"), cell(spentOf(of("week")), "num")];
  });
  const windows = args.windows.map((line) => [
    cell(line.credential, "id"),
    cell(usedOf(line.utilization), "num"),
    cell(whenOf(line.resets_at === null || line.resets_at === undefined ? null : String(line.resets_at)), "when"),
    cell(whenOf(line.at === null || line.at === undefined ? null : String(line.at)), "when"),
    cell(line.reported_by),
  ]);
  return page({
    title: "usage",
    here: "/usage",
    notice: args.notice,
    body: [
      "<h2>turns</h2>",
      turns.length === 0
        ? '<p class="empty">no turn has run in the last seven days.</p>'
        : table(["agent", "today", "last 7 days"], turns),
      "<h2>plan windows</h2>",
      windows.length === 0
        ? '<p class="empty">no window has been reported.</p>'
        : table(["credential", "used", "resets at", "read at", "reported by"], windows),
    ].join("\n"),
  });
}
