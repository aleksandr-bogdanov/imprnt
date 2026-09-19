import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * SCRAM-SHA-256 (RFC 5802 and RFC 7677), the one password method the hub's
 * roles use. Two halves share the arithmetic here.
 *
 * The install writes a role's VERIFIER, never its password, into the server:
 * `alter role ... password 'SCRAM-SHA-256$...'` is stored as given, so the
 * password itself never reaches a statement log. The verifier cannot be used to
 * log in, because the client proof needs the client key and the server holds
 * only its hash.
 *
 * The notification connection speaks the wire protocol itself
 * (`src/store/listen.ts`), so it needs the client half of the exchange.
 *
 * Passwords here are always generated base64url text, which SASLprep leaves
 * unchanged, so no normalisation is done.
 */

const ITERATIONS = 4096;

function hmac(key: Buffer, text: string | Buffer): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function salted(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, 32, "sha256");
}

function keys(password: string, salt: Buffer, iterations: number) {
  const saltedPassword = salted(password, salt, iterations);
  const clientKey = hmac(saltedPassword, "Client Key");
  return {
    clientKey,
    storedKey: sha256(clientKey),
    serverKey: hmac(saltedPassword, "Server Key"),
  };
}

/** The verifier Postgres stores for this password, as `rolpassword` spells it. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = ITERATIONS): string {
  const { storedKey, serverKey } = keys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Whether a stored verifier was made from this password. False for anything that is not one. */
export function scramMatches(stored: string | null, password: string): boolean {
  const found = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(stored ?? "");
  if (!found || password === "") return false;
  const [, iterations, salt, storedKey, serverKey] = found;
  const made = keys(password, Buffer.from(salt, "base64"), Number(iterations));
  const same = (a: Buffer, b: string) => {
    const other = Buffer.from(b, "base64");
    return a.length === other.length && timingSafeEqual(a, other);
  };
  return same(made.storedKey, storedKey) && same(made.serverKey, serverKey);
}

/** A generated password: 32 random bytes, base64url, so it is safe in a URL and in SASLprep. */
export function newPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The client side of one exchange. `first` is sent in SASLInitialResponse,
 * `final(serverFirst)` answers SASLContinue, and `verify(serverFinal)` checks
 * that the server knew the verifier, so a server that merely said "ok" is not
 * taken on trust.
 */
export function scramClient(password: string) {
  const nonce = randomBytes(18).toString("base64");
  // The user name travels in the startup message, and Postgres ignores this one.
  const firstBare = `n=,r=${nonce}`;
  let expected: Buffer | null = null;
  return {
    first: `n,,${firstBare}`,
    final(serverFirst: string): string {
      const fields = Object.fromEntries(serverFirst.split(",").map((part) => [part[0], part.slice(2)]));
      const combined = fields.r ?? "";
      if (!combined.startsWith(nonce) || !fields.s || !fields.i) {
        throw new Error("the server's scram reply did not continue this exchange");
      }
      const { clientKey, storedKey, serverKey } = keys(password, Buffer.from(fields.s, "base64"), Number(fields.i));
      const withoutProof = `c=biws,r=${combined}`;
      const message = `${firstBare},${serverFirst},${withoutProof}`;
      const signature = hmac(storedKey, message);
      const proof = Buffer.alloc(clientKey.length);
      for (let at = 0; at < proof.length; at += 1) proof[at] = clientKey[at] ^ signature[at];
      expected = hmac(serverKey, message);
      return `${withoutProof},p=${proof.toString("base64")}`;
    },
    verify(serverFinal: string): boolean {
      const said = /(?:^|,)v=([^,]+)/.exec(serverFinal)?.[1];
      if (!said || !expected) return false;
      const got = Buffer.from(said, "base64");
      return got.length === expected.length && timingSafeEqual(got, expected);
    },
  };
}
