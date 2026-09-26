import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The macOS keychain, as the hub reads the loop's login out of it.
 *
 * On a Mac, Claude Code keeps its login in a keychain item whose service name
 * is `Claude Code-credentials`, and `~/.claude/.credentials.json` holds only
 * MCP entries. MEASURED on the owner's Mac, and it is why the launch below
 * copies rather than points: with `CLAUDE_CONFIG_DIR` set to a directory of
 * its own, the CLI looks for a keychain item keyed by that directory and
 * reports `loggedIn: false`, so a boxed session with its own config directory
 * never sees the owner's item. With `CLAUDE_SECURESTORAGE_CONFIG_DIR` set, the
 * same CLI reads `.credentials.json` from that directory and reports the login
 * in it, on macOS as on Linux. So the keychain item is the SOURCE, and the
 * file the box binds is a copy of it made for the session.
 *
 * `security` finds an item in the account's login keychain, which is unlocked
 * by the login session a launchd agent runs in. A locked keychain, or a
 * process with no login session behind it, answers with an error rather than
 * an item, and that answer is carried up as the reason the login is
 * unreadable rather than as an empty login.
 */
export interface KeychainOptions {
  /**
   * A keychain FILE to read instead of the account's own search list. A check
   * hands in a scratch keychain of its own here, because a check must never
   * touch the account's login keychain. Production never sets it.
   */
  keychain?: string;
}

export type KeychainRead = { ok: true; text: string } | { ok: false; says: string };

/** `security`'s own exit code for an item that is not there. */
const ITEM_NOT_FOUND = 44;

const SECURITY_TIMEOUT_MS = 10_000;

/** The item's secret, as text, or why it could not be read. */
export function readKeychainItem(service: string, options: KeychainOptions = {}): KeychainRead {
  if (process.platform !== "darwin") {
    return { ok: false, says: `the keychain item ${JSON.stringify(service)} cannot be read on ${process.platform}: only macOS keeps a keychain` };
  }
  const where = options.keychain === undefined ? "the login keychain" : options.keychain;
  let answer: ReturnType<typeof Bun.spawnSync>;
  try {
    answer = Bun.spawnSync(
      ["/usr/bin/security", "find-generic-password", "-s", service, "-w", ...(options.keychain === undefined ? [] : [options.keychain])],
      { stdout: "pipe", stderr: "pipe", timeout: SECURITY_TIMEOUT_MS },
    );
  } catch (error) {
    return { ok: false, says: `security could not be run: ${(error as Error).message}` };
  }
  if (answer.exitedDueToTimeout) {
    return { ok: false, says: `security did not answer for the keychain item ${JSON.stringify(service)} within ${SECURITY_TIMEOUT_MS / 1000} s` };
  }
  if (answer.exitCode === ITEM_NOT_FOUND) {
    return { ok: false, says: `there is no keychain item ${JSON.stringify(service)} in ${where}` };
  }
  if (answer.exitCode !== 0) {
    const said = (answer.stderr?.toString() ?? "").trim().split("\n")[0] || `exit ${answer.exitCode}`;
    return { ok: false, says: `the keychain item ${JSON.stringify(service)} in ${where} could not be read: ${said}` };
  }
  // `-w` prints the secret and one newline after it.
  return { ok: true, text: (answer.stdout?.toString() ?? "").replace(/\n$/, "") };
}

/**
 * The item, copied into `file` for one session: the directory private to the
 * account, the file mode 600, replaced whole by a rename so a session that is
 * reading it never sees half a login.
 *
 * Remade for every launch, so a login renewed on the Mac reaches the next
 * session with nobody copying anything by hand.
 */
export function exportKeychainLogin(args: { service: string; file: string } & KeychainOptions): void {
  const read = readKeychainItem(args.service, { keychain: args.keychain });
  if (!read.ok) throw new Error(`credential-source-unreadable: ${read.says}`);
  const dir = dirname(args.file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.next`);
  writeFileSync(temp, read.text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, args.file);
}
