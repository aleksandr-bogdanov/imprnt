// Test infrastructure: a credential prober the test answers for.
//
// D-131. `check` opens every credential and asks whether it still works, and
// the two bot kinds answer that question with a network call to the real
// platform. No check can reach Telegram or Discord, so the prober is a seam in
// the style of `os` and `kernel`, and this is the fixture that stands in it.
//
// It RECORDS every credential it was asked about, which is what makes "a health
// check that does not open the credential" able to fail: a `check` that
// produced the right findings out of a table it never opened passes every
// assertion about the findings and fails `calls()`.
//
// The types are written out HERE rather than imported from
// `src/check/credentials.ts`, because that module does not exist in this round
// and a fixture that imported it would fail to typecheck rather than letting
// its check go red on the import. The same reason `test/helpers/units.ts` keeps
// its own copy of the two unit prefixes.

/** What one credential's health is, as the seam contract pins it. */
export type CredentialHealth =
  | { ok: true }
  | {
      ok: false;
      kind: "blank" | "expired" | "unreadable" | "refused";
      says: string;
    };

/** One credential as the registry declares it. */
export interface CredentialEntry {
  id: string;
  kind: string;
  file: string;
  owner: string;
}

export interface CredentialProber {
  open(entry: CredentialEntry): Promise<CredentialHealth>;
  /** The secret strings this credential holds. They never leave the process. */
  secrets(entry: CredentialEntry): Promise<string[]>;
}

export interface FakeProber extends CredentialProber {
  /** Every entry this prober was asked to open, in order, as it was handed. */
  calls(): CredentialEntry[];
  /** Change one answer mid-run, which is how a check binds the clear. */
  setAnswer(id: string, health: CredentialHealth): void;
}

/**
 * A prober that answers from a map, by credential id OR by file path.
 *
 * The file is the second key on purpose. A door's `token_file` is a credential
 * without being a `[[credentials]]` entry (D-111) and the seam contract pins no
 * id for it, so a check that keyed its answer on a guess at that id would get
 * the fallback below instead and bind nothing. The FILE is the one thing that
 * entry is certain to carry.
 *
 * An entry the map does not carry either way answers `unreadable`, and says so,
 * because a prober that answered `ok` for a credential nobody planted would
 * hide exactly the credential a build forgot to ask about.
 */
export function fakeProber(
  answers: Record<string, CredentialHealth>,
  secrets: Record<string, string[]> = {},
): FakeProber {
  const asked: CredentialEntry[] = [];
  const said: Record<string, CredentialHealth> = { ...answers };
  return {
    async open(entry) {
      asked.push({ ...entry });
      return (
        said[entry.id] ??
        said[entry.file] ?? {
          ok: false,
          kind: "unreadable",
          says: `this fixture was given no answer for ${entry.id}`,
        }
      );
    },
    async secrets(entry) {
      return [...(secrets[entry.id] ?? secrets[entry.file] ?? [])];
    },
    calls: () => asked.map((one) => ({ ...one })),
    setAnswer(id, health) {
      said[id] = health;
    },
  };
}
