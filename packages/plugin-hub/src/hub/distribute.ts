import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { putRow } from "../records/statesheet.ts";
import { RegistryEditRefused, replaceRegistry, type RegistryEditSeam } from "../registry/edit.ts";
import { indexLines, PASSWORD_LITERAL, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { storeMachineOf } from "./digest.ts";

/**
 * THE STORE MACHINE'S REGISTRY, DELIVERED TO EVERY MACHINE THAT READS A COPY OF IT.
 *
 * A spoke reads a copy of the registry and serves nothing until that copy is the store machine's, byte for byte (`digest.ts`). Until now
 * nothing delivered the copy: a person did it by hand after every edit. This is the delivery, and it is deliberately small.
 *
 * WHO MAY SAY WHAT THE REGISTRY IS: only the hub of the store machine, and only in the diary. The `registry.published` line, stream `machine`,
 * actor `hub`, subject `registry:<store machine>`, carries the sha256 of the exact bytes of the file. The diary is the one channel the door and
 * the runner roles cannot write that actor into, so it is the authority. A STATE SHEET IS NOT: `state_row` is writable by the door and the
 * runner, so the sheet `registry_copy` is only the CARRIER of bytes, and a spoke installs bytes only when their own sha256 equals the
 * published digest. Whatever a sheet says about itself (its `sha256` field, its size, who wrote it) is never read as a fact.
 *
 * THE STORE MACHINE'S HUB, each tick: reads the file once, proves it stable (the loader reads it and the digest has not moved), refuses to
 * publish a file that carries a credential (see `unsafeToPublish`), puts the bytes on the sheet, and then appends the line. A sheet ahead of
 * its line (a crash between the two) is a spoke that waits and a next tick that finishes it. An unchanged tick writes nothing.
 *
 * A SPOKE'S HUB, each tick: asks whether its file is the latest published digest. If it is not, it replaces it ONLY if its file is a version
 * this authority published before. Any other file is DIVERGED: left exactly as it is, named once in the diary, and replaced only by the
 * operator, by `imprnt hub registry <registry> <machine> <digest>`, which names the exact digest it discards and keeps those bytes in a
 * backup of its own. Replacing what the authority published is what a spoke's copy is for; discarding bytes it never published is not
 * something this module ever does by itself.
 *
 * AUTHORITY AND FRESHNESS DO NOT CHANGE UNDER A WRITE. The replacement is a compare-and-swap on the live bytes (`replaceRegistry`) and, inside
 * the editor's lock, asks the diary once more whether the digest it is installing is still the latest published, so an install that waited
 * for the lock never writes an older state over a newer one. The publisher reads its bytes again immediately before its line and drops the
 * line when the file moved.
 *
 * NOTHING A DIAGNOSTIC SAYS CAN CARRY A VALUE FROM THE FILE. A refusal records a code, a line and a schema path, never the loader's sentence
 * (which quotes the value it refused) and never the candidate.
 *
 * Only one machine writes the registry: the store machine, where the doors, the board, the lifecycle and the topic binding all run. An edit
 * made on a spoke (by anything) makes that copy diverged. It is refused and never merged.
 */

export const REGISTRY_COPY_SHEET = "registry_copy";
/** The largest registry this delivers. The sheet carries it as base64, in one row. */
export const REGISTRY_COPY_MAX_BYTES = 512 * 1024;
/** How long a copy the loader refused here waits before the same bytes are tried again (a placement file may exist by then). */
export const REFUSED_RETRY_MS = 60_000;
/** How long a spoke waits on something that is not its own to fix before it says so in the diary. */
export const WAIT_REPORT_MS = 5 * 60_000;
/** How long the same unexpected failure is not said again. */
const FAILED_RETRY_MS = 60_000;
/** How many one-time lines this process remembers having said, so a long-running hub's memory stays bounded. */
const REMEMBERED = 64;

export type Delivery = "published" | "installed" | "current" | "waiting" | "diverged" | "refused" | "none";

export interface DeliveryContext {
  store: StoreLike;
  registryFile: string;
  /** This hub's machine. */
  machine: string;
  /** The registry this tick loaded, for this machine: it names the store machine. */
  registry: Registry;
  /** Loads the file again for this machine. May throw for a file caught half written. */
  load: () => Registry;
  say: (kind: string, subject: string, detail: Record<string, unknown>) => Promise<void>;
  now?: () => number;
  maxBytes?: number;
  /** The editor's own staging points, so a check can land a hand edit or a newer publication at an exact moment. Nothing in production sets it. */
  seam?: RegistryEditSeam;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const short = (digest: string): string => digest.slice(0, 16);
const publisherSubject = (machine: string): string => `registry:${machine}`;
const copySubject = (machine: string): string => `registry-copy:${machine}`;

// ---------------------------------------------------------------------------------------------------------------------------------------
// What this process has already said. In memory, per store handle (one per hub process), bounded.
// ---------------------------------------------------------------------------------------------------------------------------------------

interface Memory {
  said: Map<string, number>;
  waiting: { key: string; since: number; reported: boolean } | null;
  refused: Map<string, { at: number; signature: string }>;
}

const memories = new WeakMap<object, Map<string, Memory>>();

function memoryFor(store: StoreLike, machine: string): Memory {
  let byMachine = memories.get(store);
  if (!byMachine) memories.set(store, byMachine = new Map());
  let memory = byMachine.get(machine);
  if (!memory) byMachine.set(machine, memory = { said: new Map(), waiting: null, refused: new Map() });
  return memory;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > REMEMBERED) map.delete(map.keys().next().value as string);
}

/** True the first time `key` is asked, and again only after `within` ms when one is given. */
function first(memory: Memory, key: string, at: number, within?: number): boolean {
  const was = memory.said.get(key);
  if (was !== undefined && (within === undefined || at - was < within)) return false;
  remember(memory.said, key, at);
  return true;
}

function forget(memory: Memory, prefix: string): void {
  for (const key of [...memory.said.keys()]) if (key.startsWith(prefix)) memory.said.delete(key);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The diary and the sheet, read. Every read states what it trusts.
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface Published {
  seq: number;
  sha256: string;
}

/**
 * The latest digest the store machine's hub published: stream `machine`, actor `hub`, the subject of that machine, the kind, and a digest
 * that is one. THE ACTOR FILTER IS THE AUTHORITY. A line in any other actor or stream, or for another machine's subject, is not read.
 */
export async function latestPublished(store: StoreLike, reference: string): Promise<Published | null> {
  const rows = (await store.sql`select seq, detail->>'sha256' as sha256 from ledger_event
    where stream = 'machine' and actor = 'hub' and subject = ${publisherSubject(reference)} and kind = 'registry.published'
      and detail->>'machine' = ${reference} and detail->>'sha256' ~ '^[0-9a-f]{64}$'
    order by seq desc limit 1`) as unknown as { seq: string; sha256: string }[];
  return rows[0] ? { seq: Number(rows[0].seq), sha256: rows[0].sha256 } : null;
}

/** Whether the store machine's hub ever published exactly this digest: the baseline a copy may be replaced from. */
export async function everPublished(store: StoreLike, reference: string, digest: string): Promise<boolean> {
  const rows = (await store.sql`select 1 as found from ledger_event
    where stream = 'machine' and actor = 'hub' and subject = ${publisherSubject(reference)} and kind = 'registry.published'
      and detail->>'machine' = ${reference} and detail->>'sha256' = ${digest}
    limit 1`) as unknown as unknown[];
  return rows.length > 0;
}

/** The base64 of the largest copy this will read back, which bounds what a spoke asks the store to send. */
const limitFor = (max: number): number => Math.ceil(max / 3) * 4 + 16;

/**
 * The bytes the sheet carries for `reference`, but only when they are the published bytes: their own sha256 is `digest`. The sheet's other
 * fields are not read. Null when the row is absent, too large, not base64, or anything else.
 */
export async function fetchCopy(store: StoreLike, reference: string, digest: string, max = REGISTRY_COPY_MAX_BYTES): Promise<Buffer | null> {
  const rows = (await store.sql`select data->>'bytes_b64' as b64 from state_row
    where sheet = ${REGISTRY_COPY_SHEET} and id = ${reference} and jsonb_typeof(data->'bytes_b64') = 'string'
      and length(data->>'bytes_b64') <= ${limitFor(max)}`) as unknown as { b64: string }[];
  const encoded = rows[0]?.b64;
  if (typeof encoded !== "string") return null;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length <= max && sha(bytes) === digest ? bytes : null;
}

/** Whether the sheet already holds these exact bytes, hashed where they are stored so nothing large is read back. */
async function sheetHolds(store: StoreLike, machine: string, digest: string, max: number): Promise<boolean> {
  try {
    const rows = (await store.sql`select 1 as found from state_row
      where sheet = ${REGISTRY_COPY_SHEET} and id = ${machine} and jsonb_typeof(data->'bytes_b64') = 'string'
        and length(data->>'bytes_b64') <= ${limitFor(max)}
        and encode(sha256(decode(data->>'bytes_b64', 'base64')), 'hex') = ${digest}`) as unknown as unknown[];
    return rows.length > 0;
  } catch {
    // A row that is not base64 is not these bytes, and the put below replaces it.
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// What may be published.
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface Unsafe {
  /** A closed code. Never the value that caused it. */
  reason: string;
  line?: number;
  /** The schema path of a store url, which is one of two fixed spellings built here (`hub.store_url`, `machines[n].store_url`). Never a key from the file, never the value. */
  at?: string;
}

const USERINFO_SCHEMES = new Set(["ssh:", "git:", "git+ssh:"]);
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A store url is `where the store is, with no user`: no user, no password, and no query or fragment, which is where a driver reads a password from too. */
function storeUrlProblem(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value); } catch { return "store-url-invalid"; }
  if (url.username !== "" || url.password !== "") return "store-url-userinfo";
  if (url.search !== "" || url.hash !== "") return "store-url-query";
  return null;
}

function walk(value: unknown, path: string, visit: (text: string, path: string) => string | null): { reason: string; path: string } | null {
  if (typeof value === "string") {
    const reason = visit(value, path);
    return reason === null ? null : { reason, path };
  }
  if (Array.isArray(value)) {
    for (const [nth, one] of value.entries()) {
      const found = walk(one, `${path}[${nth}]`, visit);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, one] of Object.entries(value)) {
      const found = walk(one, path === "" ? key : `${path}.${key}`, visit);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Whether these registry bytes may be published, which puts them in the store, in its backups, and in front of every door, runner and hub
 * process. Null when they may. A reason is a CLOSED CODE, with a line or a schema path where there is one, and never the value.
 *
 * WHAT IS LOOKED AT, and why that is all. The registry text may hold a credential in more places than the loader refuses one, and the one
 * rule the loader already has for a command line (`PASSWORD_LITERAL`) is a guard and NOT proof that a file holds no secret. So:
 *  - the loader's own rule, over the WHOLE TEXT, comments and keys the loader ignores included;
 *  - every store url the schema permits inline (`hub.store_url`, which the loader only type-checks, and each machine's) must be a url with no
 *    user, no password, no query and no fragment, because that is what a store url is declared to be (`SETTING_FIELDS`, and the loader's own
 *    refusal for a machine's);
 *  - every other string in the file that is a url must carry no password, and no user either unless it is an ssh or git remote, where a user
 *    is the account and not a credential (`ssh://git@host/...`).
 * A value in a form none of these can see (a bare token in an unknown key, in a free-form `destination`, `query`, `ssh_command` or `imprnt`
 * string) cannot be verified by this module and is NOT claimed to be: no sensitivity classifier is added here, and that is a stated limit.
 */
export function unsafeToPublish(text: string): Unsafe | null {
  const matched = PASSWORD_LITERAL.exec(text);
  if (matched) return { reason: "password-literal", line: text.slice(0, matched.index).split("\n").length };
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    return { reason: "unreadable" };
  }
  const lines = indexLines(text);
  // The line of a value, or of the nearest key above it that the loader's own index knows (a value inside an inline table or a list).
  const located = (path: string): Unsafe["line"] => {
    let at = path;
    for (;;) {
      const line = lines.get(at);
      if (line !== undefined) return line;
      const up = at.replace(/(?:\.[^.[\]]*|\[\d+\])$/, "");
      if (up === at || up === "") return undefined;
      at = up;
    }
  };
  const hub = parsed.hub as Record<string, unknown> | undefined;
  const hubProblem = storeUrlProblem(hub?.store_url);
  if (hubProblem) return { reason: hubProblem, at: "hub.store_url", line: located("hub.store_url") };
  const machines = Array.isArray(parsed.machines) ? parsed.machines as Record<string, unknown>[] : [];
  for (const [nth, machine] of machines.entries()) {
    const problem = storeUrlProblem(machine?.store_url);
    if (problem) return { reason: problem, at: `machines[${nth}].store_url`, line: located(`machines[${nth}].store_url`) };
  }
  const found = walk(parsed, "", (value) => {
    if (!URLISH.test(value)) return null;
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.password !== "") return "url-password";
    if (url.username !== "" && !USERINFO_SCHEMES.has(url.protocol)) return "url-userinfo";
    return null;
  });
  // Only the line: a key of this file is the file's own text, and a key can be where somebody put a value.
  if (found) return { reason: found.reason, line: located(found.path) };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Where a copy stands.
// ---------------------------------------------------------------------------------------------------------------------------------------

export type Standing =
  /** The store machine has published nothing yet. */
  | { verdict: "no-publication"; local: string }
  | { verdict: "current"; local: string; published: string }
  /** The copy is not any version the store machine published. */
  | { verdict: "diverged"; local: string; published: string }
  /** The copy is an earlier published version, and the sheet does not (yet) hold the latest bytes. */
  | { verdict: "waiting"; local: string; published: string }
  /** The copy is an earlier published version, and these are the bytes to replace it with. */
  | { verdict: "behind"; local: string; published: string; bytes: Buffer };

/**
 * Where the copy at `registryFile` stands against what the store machine's hub published. Reads the diary first and the sheet only when it
 * has to, and trusts the sheet for nothing but bytes that hash to the published digest.
 */
export async function standingOf(store: StoreLike, args: { registryFile: string; reference: string; maxBytes?: number }): Promise<Standing> {
  const published = await latestPublished(store, args.reference);
  const local = sha(readFileSync(args.registryFile));
  if (published === null) return { verdict: "no-publication", local };
  if (local === published.sha256) return { verdict: "current", local, published: published.sha256 };
  if (!(await everPublished(store, args.reference, local))) return { verdict: "diverged", local, published: published.sha256 };
  const bytes = await fetchCopy(store, args.reference, published.sha256, args.maxBytes);
  if (bytes === null) return { verdict: "waiting", local, published: published.sha256 };
  return { verdict: "behind", local, published: published.sha256, bytes };
}

/** What the replacement is asked, inside the editor's lock, about the file it would put in place and about the authority that sent it. */
function replacement(store: StoreLike, args: { reference: string; published: string; expect: string; machine: string; seam?: RegistryEditSeam }) {
  return {
    expect: args.expect,
    machine: args.machine,
    seam: args.seam,
    // A published file that names another machine as the store machine would move the authority by being installed. That is a decision, not a copy.
    accept: (candidate: Registry) => storeMachineOf(candidate) === args.reference
      ? null : "the published registry names a different store machine than the one that published it, so it was not installed",
    // The authority, asked again inside the lock: what is installed is still the latest thing the store machine published.
    fresh: async () => (await latestPublished(store, args.reference))?.sha256 === args.published,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * One tick's delivery. `none` when the file names no store machine (one route to the store, one copy, nothing to deliver), so a single-route
 * file is not touched. Thrown errors are the store's; everything about the file is answered, not thrown.
 */
export async function deliverRegistry(ctx: DeliveryContext): Promise<Delivery> {
  const reference = storeMachineOf(ctx.registry);
  if (reference === null) return "none";
  const memory = memoryFor(ctx.store, ctx.machine);
  return reference === ctx.machine ? await publish(ctx, memory) : await receive(ctx, memory, reference);
}

async function publish(ctx: DeliveryContext, memory: Memory): Promise<Delivery> {
  const now = (ctx.now ?? Date.now)();
  const max = ctx.maxBytes ?? REGISTRY_COPY_MAX_BYTES;
  const read = (): Buffer => readFileSync(ctx.registryFile);
  // The bytes once, and proof that they are the bytes the loader read: a file that moved while it was being read is looked at on the next tick.
  const bytes = read();
  const digest = sha(bytes);
  let observed: Registry;
  try { observed = ctx.load(); } catch { return "waiting"; }
  if (sha(read()) !== digest) return "waiting";
  // The tick decided this machine is the store machine from the file it loaded then. A file that names another machine now is not this machine's to
  // publish (the next tick reads it as a spoke's).
  if (storeMachineOf(observed) !== ctx.machine) return "waiting";

  const unsafe: Unsafe | null = bytes.length > max ? { reason: "too-large" } : unsafeToPublish(bytes.toString("utf8"));
  if (unsafe) {
    if (first(memory, `publish-refused:${digest}:${unsafe.reason}`, now)) {
      await ctx.say("registry.publish-refused", publisherSubject(ctx.machine), {
        machine: ctx.machine, sha256: digest, reason: unsafe.reason,
        ...(unsafe.line === undefined ? {} : { line: unsafe.line }), ...(unsafe.at === undefined ? {} : { at: unsafe.at }),
      });
    }
    return "refused";
  }

  const latest = await latestPublished(ctx.store, ctx.machine);
  let wrote = false;
  // THE SHEET FIRST, then the line: a sheet ahead of its line is a spoke that waits, and a line ahead of its bytes would be a spoke that waits too.
  if (!(await sheetHolds(ctx.store, ctx.machine, digest, max))) {
    await putRow(ctx.store, REGISTRY_COPY_SHEET, ctx.machine, {
      sha256: digest, size: bytes.length, bytes_b64: bytes.toString("base64"), at: new Date(now).toISOString(),
    });
    wrote = true;
  }
  if (latest?.sha256 !== digest) {
    // The bytes again, immediately before the line: a file that moved since it was read is never published as what it was.
    if (sha(read()) !== digest) return "waiting";
    await contested(ctx, memory, latest, now);
    await ctx.say("registry.published", publisherSubject(ctx.machine), { machine: ctx.machine, sha256: digest, size: bytes.length });
    wrote = true;
  }
  return wrote ? "published" : "current";
}

/**
 * Another machine published as the store machine more recently than this one did (or this one never did): two files naming different store
 * machines, or a store machine that was changed. Nothing here moves the authority, and nothing here stops this machine's own publication. It is
 * said, once, where the operator reads it, because two machines each serving as the authority is a split the household must resolve by hand.
 */
async function contested(ctx: DeliveryContext, memory: Memory, own: Published | null, now: number): Promise<void> {
  const rows = (await ctx.store.sql`select seq, subject from ledger_event
    where stream = 'machine' and actor = 'hub' and kind = 'registry.published' and subject like 'registry:%' and subject <> ${publisherSubject(ctx.machine)}
    order by seq desc limit 1`) as unknown as { seq: string; subject: string }[];
  const other = rows[0];
  if (!other || Number(other.seq) <= (own?.seq ?? 0)) return;
  const machine = other.subject.slice("registry:".length).replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 64);
  if (first(memory, `contested:${other.seq}`, now)) {
    await ctx.say("registry.authority-contested", publisherSubject(ctx.machine), { machine: ctx.machine, other: machine });
  }
}

async function receive(ctx: DeliveryContext, memory: Memory, reference: string): Promise<Delivery> {
  const now = (ctx.now ?? Date.now)();
  const standing = await standingOf(ctx.store, { registryFile: ctx.registryFile, reference, maxBytes: ctx.maxBytes });

  if (standing.verdict === "no-publication" || standing.verdict === "waiting") {
    const key = `${standing.verdict}:${"published" in standing ? standing.published : ""}:${standing.local}`;
    if (memory.waiting?.key !== key) memory.waiting = { key, since: now, reported: false };
    else if (!memory.waiting.reported && now - memory.waiting.since >= WAIT_REPORT_MS) {
      memory.waiting.reported = true;
      await ctx.say("registry.copy-waiting", copySubject(ctx.machine), {
        machine: ctx.machine, reference, reason: standing.verdict === "no-publication" ? "no-publication" : "sheet-mismatch",
        local: short(standing.local), ...("published" in standing ? { published: short(standing.published) } : {}),
      });
    }
    return "waiting";
  }
  memory.waiting = null;

  if (standing.verdict === "current") {
    forget(memory, "diverged:");
    memory.refused.clear();
    return "current";
  }
  if (standing.verdict === "diverged") {
    if (first(memory, `diverged:${standing.local}:${standing.published}`, now)) {
      await ctx.say("registry.copy-diverged", copySubject(ctx.machine), {
        machine: ctx.machine, reference, local: short(standing.local), published: short(standing.published),
      });
    }
    return "diverged";
  }

  // `behind`: an earlier published version, and the latest published bytes in hand.
  const key = `${standing.published}:${standing.local}`;
  const held = memory.refused.get(key);
  if (held && now - held.at < REFUSED_RETRY_MS) return "refused";
  try {
    const result = await replaceRegistry(ctx.registryFile, standing.bytes, replacement(ctx.store, {
      reference, published: standing.published, expect: standing.local, machine: ctx.machine, seam: ctx.seam,
    }));
    if (!result.changed) return "current";
    memory.refused.clear();
    // The file is already replaced. A line that cannot be written is only a line, and the caller must still reload what is now on disk.
    try {
      await ctx.say("registry.copy-installed", copySubject(ctx.machine), {
        machine: ctx.machine, reference, from: short(standing.local), to: short(standing.published),
      });
    } catch { /* informational */ }
    return "installed";
  } catch (error) {
    if (error instanceof RegistryEditRefused) {
      // `locked`, `concurrent`, `precondition`, `stale` and `backup` are a busy file, a hand edit or a publication that moved on: next tick, silently.
      if (!["load", "owner", "diff", "authority"].includes(error.step)) return "waiting";
      // The step and the line of the PUBLISHED file, and nothing else: the loader's sentence and its key can carry a value out of the file.
      const signature = `${error.step}:${error.line ?? ""}`;
      const same = held?.signature === signature;
      remember(memory.refused, key, { at: now, signature });
      if (!same) {
        await ctx.say("registry.copy-refused", copySubject(ctx.machine), {
          machine: ctx.machine, reference, published: short(standing.published), local: short(standing.local), step: error.step,
          ...(error.line === undefined ? {} : { line: error.line }),
        });
      }
      return "refused";
    }
    // Anything else is the file system or the store failing. Said by its code only, and not again for a minute.
    const code = failureCode(error);
    if (first(memory, `failed:${code}`, now, FAILED_RETRY_MS)) {
      await ctx.say("registry.copy-failed", copySubject(ctx.machine), { machine: ctx.machine, reference, code });
    }
    return "waiting";
  }
}

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "FAILED";
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The operator's explicit override of a diverged copy.
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Where the bytes an override replaces are kept: beside the file, bound to their own digest, so a second backup can never be the first. */
export function backupPathFor(live: string, digest: string): string {
  return join(dirname(live), `.${basename(live)}.diverged-${digest}`);
}

/**
 * Keep `previous` beside `live`, under a name that is its own sha256, and never in place of a file that is there.
 *
 * WRITTEN COMPLETE OR NOT AT ALL: the bytes go to a temporary name, are read back and hashed, and only then does a hard link give them the
 * final name. A link refuses a name that exists, so a prior backup is never overwritten. A prior backup under this exact name is accepted
 * only when it holds exactly these bytes (the same bytes kept twice lose nothing), and refused otherwise. The backup has the registry's own
 * mode and owner, or this refuses rather than make a more readable copy of the registry than the registry. Any failure throws, and the
 * editor then refuses the replacement.
 */
export function preserveBytes(previous: Buffer, live: string): string {
  const digest = sha(previous);
  const path = backupPathFor(live, digest);
  const had = statSync(live);
  const mode = had.mode & 0o777;
  const temporary = join(dirname(live), `.${basename(live)}.diverged-${crypto.randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(temporary, previous, { flag: "wx", mode });
  try {
    chmodSync(temporary, mode);
    const made = statSync(temporary);
    if (made.uid !== had.uid || made.gid !== had.gid) chownSync(temporary, had.uid, had.gid);
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    if (!readFileSync(temporary).equals(previous)) throw new Error("backup-readback");
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (!readFileSync(path).equals(previous)) throw new Error("backup-conflict");
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  const directory = openSync(dirname(live), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return path;
}

export type Override =
  | { result: "replaced"; from: string; to: string; backup: string }
  | { result: "refused"; cause: string; local?: string; published?: string };

/**
 * `imprnt hub registry <registry> <machine> <digest>`: replace a DIVERGED copy with what the store machine published, naming the exact digest
 * of the file being discarded.
 *
 * It refuses on the store machine and on a file with one route; when the digest is not the file's own, judged again INSIDE the editor's lock on
 * the bytes it overwrites; when the copy is not diverged (a current copy needs nothing, and a copy that is an earlier published version is
 * replaced by the hub itself); and when the published bytes cannot be verified against the diary. The bytes being discarded are kept first,
 * from the same read the editor holds under its lock, under a name no other backup can have, and a copy that cannot be kept is not replaced.
 */
export async function overrideRegistryCopy(args: {
  store: StoreLike;
  registryFile: string;
  machine: string;
  registry: Registry;
  digest: string;
  say: (kind: string, subject: string, detail: Record<string, unknown>) => Promise<void>;
  maxBytes?: number;
  seam?: RegistryEditSeam;
}): Promise<Override> {
  const reference = storeMachineOf(args.registry);
  if (reference === null) return { result: "refused", cause: "single-route" };
  if (reference === args.machine) return { result: "refused", cause: "store-machine" };
  const standing = await standingOf(args.store, { registryFile: args.registryFile, reference, maxBytes: args.maxBytes });
  const said = { local: standing.local, ...("published" in standing ? { published: standing.published } : {}) };
  if (standing.local !== args.digest) return { result: "refused", cause: "digest", ...said };
  if (standing.verdict !== "diverged") return { result: "refused", cause: "not-diverged", ...said };
  const bytes = await fetchCopy(args.store, reference, standing.published, args.maxBytes);
  if (bytes === null) return { result: "refused", cause: "unverifiable", ...said };
  let backup = "";
  try {
    const result = await replaceRegistry(args.registryFile, bytes, {
      ...replacement(args.store, { reference, published: standing.published, expect: args.digest, machine: args.machine, seam: args.seam }),
      preserve: (previous, live) => { backup = preserveBytes(previous, live); },
    });
    if (!result.changed) return { result: "refused", cause: "not-diverged", ...said };
  } catch (error) {
    if (!(error instanceof RegistryEditRefused)) return { result: "refused", cause: "failed", ...said };
    const cause = error.step === "load" ? "load" : error.step === "owner" ? "owner" : error.step === "authority" ? "authority"
      : error.step === "backup" ? "backup" : error.step === "diff" ? "failed" : "busy";
    return { result: "refused", cause, ...said };
  }
  await args.say("registry.copy-replaced", copySubject(args.machine), {
    machine: args.machine, reference, from: short(args.digest), to: short(standing.published), backup: basename(backup),
  });
  return { result: "replaced", from: args.digest, to: standing.published, backup: basename(backup) };
}
