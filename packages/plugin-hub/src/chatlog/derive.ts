import { renderTailLines, validLine, type ChatLine } from "../chatlog.ts";
import { CLOCK_STREAM } from "../door/clock.ts";
import { clockLine, waitReasonLine, type Language } from "../door/lines.ts";
import { isDemand, isRecoveryCommand, SLICE_MAX_DAYS, type SliceLine } from "../harvest/slice.ts";
import { languageOf, listAgents } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * One chat, read out of the store instead of out of the file its door wrote.
 *
 * The file and these rows are two projections of one conversation. A person's
 * message is an `inbound` row carrying the platform's own record of it, an
 * agent's answer and the door's own notices are `outbox` rows, and the one line
 * the door says on its own, when a clock runs out, is a `clock` diary row. That
 * covers every line the log holds but one: the `/recover` exchange is machinery
 * dialogue the store never sees, and every harvest already drops it.
 *
 * A runner whose agent's door is on another machine reads its tail and its
 * harvest slice from here, and the rendering, the budget and the filters are
 * the shipped ones, so the two readers cannot drift into two shapes of one
 * chat.
 */
export interface DerivedLine extends ChatLine {
  id: string;
}

/**
 * How far either side of the window the rows are read from.
 *
 * A line's own time is the platform's clock and the row's `received_at` is the
 * door's, so the two are close and not equal, and a door that was down catches
 * up hours later. The read is widened by a day and the window is then applied
 * to the LINE's own time, which is the only time either reader ever answers.
 */
const MARGIN_MS = 86_400_000;

const DAY_MS = 86_400_000;

/**
 * The stamps a clock line can be about, and the whole set of them.
 *
 * `transcribed` is one of them: while a voice note has no words the door says
 * so in the chat, and a spoke that did not know the stamp would drop the one
 * line the person actually saw in that window.
 */
const CLOCK_STAMPS = ["transcribed", "acked", "started", "answered"];

export async function deriveLines(
  store: StoreLike,
  args: {
    registry: unknown;
    person: string;
    agent: string;
    /** ISO, inclusive. */
    from: string;
    /** ISO, inclusive. */
    until: string;
  },
): Promise<DerivedLine[]> {
  const fromMs = Date.parse(args.from);
  const untilMs = Date.parse(args.until);
  const wideFrom = new Date(fromMs - MARGIN_MS).toISOString();
  const wideUntil = new Date(untilMs + MARGIN_MS).toISOString();
  const agent = listAgents(args.registry).find((one) => one.id === args.agent);
  // The door the agent is declared to speak through, which is who a machinery
  // line is from until the row it sits on has a route pinned on it.
  const door = agent?.door ?? "";
  const language = languageOf(args.registry, args.person) as Language;
  // The order two lines of one instant are in. A reply written in one
  // transaction gives every one of its parts the same `written_at`, so the
  // clock cannot separate them and the outbox id is what does.
  const candidates: { line: ChatLine; order: number }[] = [];

  // A ROW IS A LINE ONLY ONCE IT HAS BEEN PROJECTED. A voice note is written
  // down the moment it arrives and its words land later, and the file carries
  // no line for it until they do, which is what `log_ready` records. Without
  // this the tail a spoke feeds a session carries the note with no words in it,
  // and the line the person really saw, the door's own "still transcribing",
  // arrives beside it.
  const said = (await store.sql`
    select id, person, source from inbound
    where agent = ${args.agent} and source is not null and log_ready
      and received_at >= ${wideFrom}::timestamptz
      and received_at <= ${wideUntil}::timestamptz`) as unknown as {
    id: string;
    person: string;
    source: { log_id?: string; at?: string; text?: string } | null;
  }[];
  for (const row of said) {
    // Every kind of row, because a harvest demand's committed row is a line in
    // the file too and carries the id its own pre-line used: one row, one line.
    const source = row.source;
    if (!source) continue;
    candidates.push({
      line: {
        id: source.log_id,
        at: source.at,
        direction: "in",
        from: row.person,
        text: source.text,
      } as ChatLine,
      order: 0,
    });
  }

  const answered = (await store.sql`
    select o.id, o.kind, o.body, o.written_at, o.route,
           coalesce(o.person, i.person) as person, coalesce(o.agent, i.agent) as agent
    from outbox o left join inbound i on i.id = o.inbound_id
    where coalesce(o.agent, i.agent) = ${args.agent}
      and o.written_at >= ${wideFrom}::timestamptz
      and o.written_at <= ${wideUntil}::timestamptz
    order by o.id`) as unknown as {
    id: number | string;
    kind: string;
    body: string;
    written_at: string | Date;
    route: { door?: string } | null;
    agent: string;
  }[];
  for (const row of answered) {
    candidates.push({
      line: {
        id: `outbox:${row.id}`,
        at: new Date(row.written_at).toISOString(),
        direction: "out",
        // A machinery line is the DOOR speaking, and which door is pinned on
        // the row at delivery. Before that it is the one the agent declares.
        from: row.kind === "notice" ? (row.route?.door ?? door) : String(row.agent),
        text: row.body,
      } as ChatLine,
      order: Number(row.id),
    });
  }

  const clocks = (await store.sql`
    select e.detail from ledger_event e
    join inbound i on i.id = e.subject
    where e.stream = ${CLOCK_STREAM} and e.kind = 'expired' and i.agent = ${args.agent}
      and e.at >= ${wideFrom}::timestamptz
      and e.at <= ${wideUntil}::timestamptz`) as unknown as {
    detail: {
      id?: string; at?: string; stamp?: string; seconds?: number;
      why?: { id?: string; kind?: string; values?: Record<string, string | number> };
    } | null;
  }[];
  for (const row of clocks) {
    const detail = row.detail;
    // A row written before the line's id was recorded is SKIPPED rather than
    // guessed at: a line whose id nobody wrote down cannot be told from a line
    // somebody replayed, and the sentence is rendered here rather than stored,
    // so a stamp this vocabulary has no sentence for has nothing to render.
    if (!detail?.id || !detail.at || !CLOCK_STAMPS.includes(String(detail.stamp))) continue;
    candidates.push({
      line: {
        id: detail.id,
        at: detail.at,
        direction: "out",
        from: door,
        text: clockLine(language, String(detail.stamp), Number(detail.seconds)),
      },
      order: 0,
    });
    // The reason line the door said under it, rendered from the same row and
    // ordered after the clock line it belongs to.
    if (detail.why?.id && detail.why.kind) {
      candidates.push({
        line: {
          id: detail.why.id,
          at: detail.at,
          direction: "out",
          from: door,
          text: waitReasonLine(language, detail.why.kind, detail.why.values ?? {}),
        },
        order: 1,
      });
    }
  }

  // ONE DAMAGED ROW COSTS ONLY ITSELF, which is the rule the file walk already
  // applies and the reason `validLine` is exported.
  return candidates
    .filter((one) => validLine(one.line) && typeof one.line.id === "string" && one.line.id !== "")
    .filter((one) => {
      const at = Date.parse(one.line.at);
      return at >= fromMs && at <= untilMs;
    })
    .sort(
      (a, b) => Date.parse(a.line.at) - Date.parse(b.line.at) || a.order - b.order,
    )
    .map((one) => one.line as DerivedLine);
}

/** The tail a spawned session is fed, rendered and budgeted the one way. */
export async function deriveTail(
  store: StoreLike,
  args: {
    registry: unknown;
    person: string;
    agent: string;
    now: Date;
    hours: number;
    tokens: number;
    /** The lines of messages still waiting for their answer, which the runner names. */
    exclude?: ReadonlySet<string>;
  },
): Promise<string> {
  const lines = await deriveLines(store, {
    ...args,
    from: new Date(args.now.getTime() - args.hours * 3_600_000).toISOString(),
    until: args.now.toISOString(),
  });
  // The same rule the file reader applies, with the same set: the runner
  // names the lines of the messages it is about to hand the session as turns.
  return renderTailLines(lines.filter((line) => !args.exclude?.has(line.id)), args.tokens);
}

/**
 * The slice a harvest reads: this chat's two speakers and nobody else, less the
 * two messages a person addresses to the machinery.
 *
 * `from` is EXCLUSIVE and `until` is INCLUSIVE, the same arithmetic the file's
 * own slice applies, because the watermark carries the last harvested line's
 * own time and that line has to fall outside the next slice.
 */
export async function deriveSlice(
  store: StoreLike,
  args: {
    registry: unknown;
    person: string;
    agent: string;
    /** The watermark's `at`, exclusive. Null reaches back `SLICE_MAX_DAYS`. */
    from: string | null;
    until: string;
    includeFrom?: boolean;
  },
): Promise<SliceLine[]> {
  const untilMs = Date.parse(args.until);
  const fromMs =
    args.from === null ? untilMs - SLICE_MAX_DAYS * DAY_MS : Date.parse(args.from);
  const lines = await deriveLines(store, {
    ...args,
    from: new Date(fromMs).toISOString(),
    until: args.until,
  });
  return lines
    .filter((line) => {
      const at = Date.parse(line.at);
      if (!(at > fromMs || (args.includeFrom && at === fromMs)) || at > untilMs) return false;
      return (
        (line.from === args.person || line.from === args.agent) &&
        !isDemand(line.text) &&
        !isRecoveryCommand(line.text)
      );
    })
    .map((line) => ({
      at: line.at,
      direction: line.direction,
      from: line.from,
      text: line.text,
    }));
}
