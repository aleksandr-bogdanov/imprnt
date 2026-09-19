import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { boxCommand, type BoxContext } from "../box/index.ts";
import { listCredentials } from "../registry/entries.ts";
import type { AgentEntry, CredentialEntry } from "../registry/load.ts";
import { credentialOfPreset, type Preset } from "../registry/presets.ts";

export function credentialSource(registry: unknown, preset: string): CredentialEntry {
  const id = credentialOfPreset(registry, preset);
  const entry = listCredentials(registry).find(one => one.id === id);
  if (!entry) throw new Error("credential-source-missing");
  return { ...entry };
}

export function validateCredentialSource(entry: CredentialEntry): void {
  if (entry.kind !== "claude-login" || !isAbsolute(entry.file) || basename(entry.file) !== ".credentials.json") {
    throw new Error("credential-source-unsupported");
  }
  accessSync(entry.file, constants.R_OK);
  if (!statSync(entry.file).isFile()) throw new Error("credential-source-unreadable");
}

export interface LoopLaunchInput {
  registry: unknown;
  preset: Preset;
  credential?: CredentialEntry;
  agent: AgentEntry;
  sessionDir: string;
  purpose: "ordinary" | "harvest";
  box: BoxContext;
}

/** Prepare the wrapper before any model child can start. */
export function sessionBox(input: LoopLaunchInput, readPaths: string[] = []) {
  if (!input.box?.tree || !isAbsolute(input.box.tree) || !isAbsolute(input.sessionDir)) throw new Error("box-required");
  mkdirSync(input.sessionDir, { recursive: true, mode: 0o700 });
  const cwd = realpathSync(input.sessionDir);
  const ctx = { ...input.box, sessionDir: cwd, purpose: input.purpose, readPaths };
  const command = boxCommand([], ctx);
  const profile = command.profile ? join(cwd, "box.sb") : null;
  if (profile) writeFileSync(profile, command.profile!.text, { mode: 0o600 });
  return { cwd, wrap(argv: string[]) {
    const boxed = boxCommand(argv, ctx);
    if (profile) boxed.argv[boxed.argv.indexOf("-f") + 1] = profile;
    return boxed.argv;
  } };
}

function jsonFile(file: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!file) return fallback;
  if (!isAbsolute(file)) throw new Error("invalid-configuration");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("invalid-configuration"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-configuration");
  return value as Record<string, unknown>;
}

export async function makeLoopLaunch(input: LoopLaunchInput) {
  if (input.preset.adapter !== "claude-code") throw new Error("loop-configuration-unsupported");
  if (!input.box) throw new Error("box-required");
  if (!statSync(input.box.tree).isDirectory()) throw new Error("box-tree-unavailable");
  if (input.purpose !== "ordinary" && input.purpose !== "harvest") throw new Error("invalid-configuration");
  const credential = input.credential ?? credentialSource(input.registry, input.agent.preset);
  validateCredentialSource(credential);
  const ordinary = input.purpose === "ordinary";
  const settings = ordinary ? jsonFile(input.agent.settings, {}) : {};
  if (Object.keys(settings).some(key => key !== "permissions")) throw new Error("invalid-settings-configuration");
  if (settings.permissions !== undefined) {
    const permissions = settings.permissions as Record<string, unknown>;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) ||
        Object.entries(permissions).some(([key, value]) => !["allow", "deny", "ask"].includes(key) ||
          !Array.isArray(value) || value.some(one => typeof one !== "string"))) {
      throw new Error("invalid-settings-permissions");
    }
  }
  const mcp = ordinary ? jsonFile(input.agent.mcp, { mcpServers: {} }) : { mcpServers: {} };
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object" || Array.isArray(mcp.mcpServers)) {
    throw new Error("invalid-mcp-configuration");
  }
  const mcpFile = ordinary ? input.agent.mcp : undefined;
  const fragment = ordinary ? input.agent.fragment : undefined;
  if (fragment) accessSync(fragment, constants.R_OK);
  const ambient = process.env.HOME;
  // The box masks every credential file, and this launch keeps the one login its
  // loop runs on. Every other one, bot tokens and any other model login alike,
  // stays masked. The launched login's own directory is bound writable because
  // the model CLI rotates its token in place there, so it is added to the box's
  // write paths rather than left to the read-only host.
  const same = (a: string, b: string) => a === b || existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
  input = { ...input, box: { ...input.box,
    writePaths: [...(input.box.writePaths ?? []), dirname(credential.file)],
    secretPaths: input.box.secretPaths?.filter(path => !same(path, credential.file)) } };
  const boxed = sessionBox(input, [dirname(credential.file), credential.file, ...(fragment ? [fragment] : []), ...(mcpFile ? [mcpFile] : []),
    ...(ambient ? [join(ambient, ".claude", "settings.json"), join(ambient, ".claude", "CLAUDE.md")] : [])]);
  const config = join(boxed.cwd, "config"), home = join(boxed.cwd, "home"), scratch = join(boxed.cwd, "tmp");
  for (const dir of [config, home, scratch]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only runtime plumbing is inherited; no ambient login, loader, or plugin variables.
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: home, TMPDIR: scratch, CLAUDE_CONFIG_DIR: config,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: dirname(credential.file),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const tools = ordinary ? input.agent.tools : ["Read", "Glob", "Grep"];
  const argv = ["claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--replay-user-messages", "--include-partial-messages",
    "--model", input.preset.model, "--effort", input.preset.effort,
    "--setting-sources", "", "--settings", JSON.stringify(settings),
    "--strict-mcp-config", "--mcp-config", mcpFile ?? JSON.stringify(mcp),
    "--tools", tools === undefined ? "default" : tools.join(","), "--disable-slash-commands"];
  if (fragment) argv.push("--append-system-prompt-file", fragment);
  if (ordinary) argv.push("--dangerously-skip-permissions");
  else argv.push("--allowedTools", "Read,Glob,Grep");
  return { ...boxed, argv, env, credentialId: credential.id };
}

/** How the capability probe finds the CLI and how long one call to it may take. */
export interface LoopProbeOptions { bin?: string; timeoutMs?: number }
export const LOOP_PROBE_TIMEOUT_MS = 10_000;

/**
 * IMP-162. A probe call that did not answer within its wait, asked twice.
 *
 * A killed call leaves an empty answer, and an empty answer says nothing about
 * what the CLI supports. So this is reported as the timeout it is, never as
 * `credential-source-unsupported`: an operator told that a sound login source
 * is unsupported goes looking for a problem that is not there.
 */
export class LoopProbeTimeout extends Error {
  constructor(readonly call: string, readonly timeoutMs: number) {
    super(`loop-probe-timeout: claude ${call} timed out after ${timeoutMs / 1000} s, twice`);
    this.name = "LoopProbeTimeout";
  }
}

/**
 * IMP-162. The probe's answer, kept per binary and per login, in this process only.
 *
 * The probe proves a property of the installed CLI (D-176): that it selects the
 * named login file, follows its atomic replacement and falls back to nothing.
 * That answer cannot change while neither the binary nor the login does, so a
 * launch probes again only when one of them is not the file probed last. The
 * stamp is each file's own identity at nanosecond resolution: its real path,
 * device, inode, size, mtime and ctime. An atomic replacement is a new inode
 * (the signal ROLL-13 pins), an update that repoints a symlink moves the real
 * path, and every write, rename or chmod moves ctime, which no program can set
 * back.
 *
 * A stamp is trusted only once the file has SETTLED. Timestamps come from a
 * coarse clock, one tick on Linux and a whole second on some filesystems, so a
 * second write inside the tick of the first can leave every field a stat reports
 * exactly as it was. A file whose ctime was already `LOOP_PROBE_SETTLED_MS` old
 * when it was stamped is past its tick, and any later change lands at a later
 * ctime. A file changed more recently than that is probed on every launch until
 * it settles, which is Git's rule for a racily clean index entry. The rule leans
 * on the wall clock moving forward, so a kept answer is dropped when the clock
 * has stepped back since it was stamped.
 *
 * What is never kept is the login's own refusal. `validateCredentialSource` runs
 * on every launch before the kept answer is read, so a login that is gone or of
 * a shape the loop cannot select is refused however recently the binary was
 * probed. Only a success is kept: a probe that failed or timed out is asked
 * again on the next launch.
 */
export const LOOP_PROBE_SETTLED_MS = 3_000;
const probed = new Map<string, { stamp: string; clock: number; answer: ReturnType<typeof probeLoopCapabilities> }>();

/** The wall clock's lead over the monotonic one. It falls only when the wall clock steps back. */
const clockLead = () => Date.now() - performance.now();

function stampOf(file: string): string | null {
  const real = realpathSync(file);
  const seen = statSync(real, { bigint: true });
  if (BigInt(Date.now()) - seen.ctimeMs < BigInt(LOOP_PROBE_SETTLED_MS)) return null;
  return [real, seen.dev, seen.ino, seen.size, seen.mtimeNs, seen.ctimeNs].join(":");
}

export function loopCapabilitiesFor(credential: CredentialEntry, probe: LoopProbeOptions = {}) {
  validateCredentialSource(credential);
  const bin = probe.bin ?? "claude";
  const key = [bin, credential.id, credential.file].join("\0");
  let stamp: string | null = null;
  try {
    const executable = Bun.which(bin);
    const both = executable ? [stampOf(executable), stampOf(credential.file)] : [null];
    if (both.every(one => one !== null)) stamp = both.join("|");
  } catch { stamp = null; }
  const kept = probed.get(key), clock = clockLead();
  // A second of slack keeps an ordinary clock slew from dropping a good answer.
  if (stamp !== null && kept?.stamp === stamp && clock > kept.clock - 1_000) return kept.answer;
  const answer = probeLoopCapabilities(bin, probe.timeoutMs);
  if (stamp !== null) probed.set(key, { stamp, clock, answer });
  else probed.delete(key);
  answer.catch(() => { if (probed.get(key)?.answer === answer) probed.delete(key); });
  return answer;
}

/** Offline capability evidence; no real login or model request enters this probe. */
export async function probeLoopCapabilities(bin = "claude", timeoutMs = LOOP_PROBE_TIMEOUT_MS) {
  const executable = Bun.which(bin);
  if (!executable) throw new Error("credential-source-unsupported");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-loop-capability-")));
  try {
    const source = join(root, "login", ".credentials.json");
    mkdirSync(dirname(source));
    const bytes = (subscriptionType: string) => JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-capability-access", refreshToken: "synthetic-capability-refresh",
      expiresAt: Date.now() + 86_400_000, scopes: ["user:inference", "user:profile"], subscriptionType,
    } });
    writeFileSync(source, bytes("max"), { mode: 0o600 });
    const launch = await makeLoopLaunch({ registry: null,
      preset: { adapter: "claude-code", model: "synthetic", provider: "synthetic", effort: "medium", paid: "plan" },
      credential: { id: "probe", owner: "probe", kind: "claude-login", file: source },
      agent: { id: "probe", person: "probe", preset: "probe", runner: "probe", door: "probe", chat: "probe" },
      sessionDir: join(root, "session"), purpose: "ordinary",
      box: { agent: "probe", person: "probe", tree: root, sharedZone: "", otherTrees: [] },
    });
    // IMP-162. A call that hangs is asked once more before the probe gives up:
    // measured on the Linux box, `auth status` hung in 4 of 36 runs and answered
    // in under half a second otherwise.
    const ask = (args: string[]) => {
      for (let attempt = 1; ; attempt++) {
        const answer = Bun.spawnSync(launch.wrap([executable, ...args]), {
          env: launch.env, cwd: launch.cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
        });
        if (!answer.exitedDueToTimeout) return answer;
        if (attempt === 2) throw new LoopProbeTimeout(args.join(" "), timeoutMs);
      }
    };
    const version = ask(["--version"]), help = ask(["--help"]);
    const flags = ["--setting-sources", "--strict-mcp-config", "--settings", "--tools"];
    if (version.exitCode !== 0 || help.exitCode !== 0 || flags.some(flag => !help.stdout.toString().includes(flag))) {
      throw new Error("credential-source-unsupported");
    }
    // Poison the session store: only the separate canonical source may win.
    writeFileSync(join(launch.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), bytes("poison"));
    const status = () => {
      const answer = ask(["auth", "status", "--json"]);
      return JSON.parse(answer.stdout.toString()) as Record<string, unknown>;
    };
    const first = status();
    writeFileSync(source + ".next", bytes("pro"), { mode: 0o600 });
    renameSync(source + ".next", source);
    const replacement = status();
    rmSync(source);
    const missing = status();
    if (first.loggedIn !== true || first.subscriptionType !== "max" ||
        replacement.loggedIn !== true || replacement.subscriptionType !== "pro" || missing.loggedIn !== false) {
      throw new Error("credential-source-unsupported");
    }
    return { version: version.stdout.toString().match(/\d+(?:\.\d+)+/)?.[0] ?? "unreported",
      credential_source: true, replacement: true, no_fallback: true, flags };
  } catch (error) {
    if ((error as Error)?.name === "LoopProbeTimeout") throw error;
    throw new Error("credential-source-unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
