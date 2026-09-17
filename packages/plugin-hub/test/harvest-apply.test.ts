// HARV-01. The REAL `imprnt ingest --apply` answers exactly four outcomes, and
// the classifier reads each one from the CLI's own bytes.
//
// SPEC §4: "a separate model reads a chat and files what was worth keeping
// through the normal ingest path". SPEC §2: "an agent produces text, delivery
// is machinery", which is the sentence this whole file applies to filing. L19.
//
// THIS CHECK DRIVES THE REAL THING. No Postgres, no door, no runner: a scratch
// vault scaffolded by the real `imprnt init` with `XDG_CONFIG_HOME` pointed
// under scratch, the shim of `test/helpers/imprnt-shim.ts` in place of
// `hub.imprnt`, and the real `applyStaged` reached exactly as production
// reaches it, as a child process.
//
// THE FOUR OUTCOME LINES, measured on 2026-09-16 against the monorepo's own
// `packages/imprnt/scripts/cli.ts` under bun 1.3.14 on this Mac, copied here
// from the run rather than retyped:
//
//   filed     STDOUT, exit 0
//     "  ✓ filed finances/card-fee-rises-in-october  (type: note, domain: finances)"
//     "     snapshot -> <root>/raw/proposed/card-fee-rises-in-october-<hash>.md"
//     "     staged copy removed: <file>"
//     and the staged file is DELETED by the CLI.
//   noop      STDOUT, exit 0
//     "  = finances/card-fee-rises-in-october already filed, identical content (hash <h>) — no-op"
//     and the staged file is DELETED by the CLI.
//   conflict  STDERR, exit 1
//     "  ! finances/card-fee-rises-in-october exists with DIFFERENT content — not overwriting (contradiction discipline)"
//     and the staged file is KEPT, and `_needs-review.md` gains a line.
//   refused   STDERR, exit 1
//     "  ✗ <file>: no `type:` in frontmatter — can't file a note with no type"
//     "no such staged note: <file>"
//     "no vault at <dir> — run `imprnt init` first"
//     and the staged file is KEPT.
//
// The em dash and the backticks above are the CLI's OWN bytes, quoted. They are
// not this file's prose.
//
// D-152's rule is the one a permissive build fails: UNKNOWN IS REFUSED,
// whatever the exit code. An output no marker classified is an outcome nobody
// read, and a watermark must never move on one.
//
// Red reason: import missing, `src/harvest/apply.ts`. The check fails on the
// `seam()` call before it reaches the CLI at all.

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { writeHangingImprntShim, writeImprntShim } from "./helpers/imprnt-shim.ts";
import { scratchVault, slugOf } from "./helpers/scratch-vault.ts";

/** The tests' own copy of the answer shape, never imported from the build. */
interface ApplyResult {
  outcome: string;
  note: string;
  said: string;
  exit: number;
  file: string;
}

const SLOW = 90_000;

function note(args: { title: string; type?: string; domain?: string; body: string }): string {
  const front = [
    "---",
    ...(args.type === undefined ? [] : [`type: ${args.type}`]),
    ...(args.domain === undefined ? [] : [`domain: ${args.domain}`]),
    "kind: reference",
    `summary: ${args.body}`,
    "tags: [banking]",
    "---",
  ];
  return `${front.join("\n")}\n\n# ${args.title}\n\n${args.body}\n`;
}

test(
  "HARV-01 the real imprnt ingest --apply answers four outcomes and the classifier reads each one from the CLI's own bytes, with an output no marker classified refused at either exit code (SPEC §4 and §2, L19, D-152)",
  async () => {
    const {
      applyNote,
      classifyApply,
      stageSlug,
      stageDirFor,
      stageNotes,
      APPLY_TIMEOUT_MS,
    } = await seam("src/harvest/apply.ts");
    expect(typeof applyNote).toBe("function");
    expect(typeof classifyApply).toBe("function");
    expect(typeof stageSlug).toBe("function");
    expect(typeof stageDirFor).toBe("function");
    expect(typeof stageNotes).toBe("function");

    // THE DEFAULT BOUND IS PINNED, so a build that leaves an apply child able
    // to hang for ever is caught here rather than by a household whose runner
    // stopped answering one evening.
    expect(APPLY_TIMEOUT_MS).toBe(120_000);

    const apply = applyNote as (args: {
      imprnt: string;
      vault: string;
      file: string;
      timeoutMs?: number;
    }) => Promise<ApplyResult>;
    const classify = classifyApply as (
      output: string,
      exit: number,
    ) => { outcome: string; note: string; said: string };

    const dir = await mkdtemp(join(tmpdir(), "hub-harvest-apply-"));
    let vault: Awaited<ReturnType<typeof scratchVault>> | null = null;
    try {
      vault = await scratchVault(dir);
      const shim = writeImprntShim(dir);
      const stateDir = join(dir, "state");

      // The staging directory, computed by the TEST from the pinned shape, so
      // a build that put it elsewhere fails rather than being followed.
      const rowId = "harvest:p1-lair:2026-09-16T21:00:00.000Z";
      const staged = (stageDirFor as (s: string, p: string, r: string) => string)(
        stateDir,
        "p1",
        rowId,
      );
      mkdirSync(staged, { recursive: true });

      const title = "Card fee rises in October";
      const slug = slugOf(title);
      const filedNote = note({
        title,
        type: "note",
        domain: "finances",
        body: "The monthly card fee goes from nine to eleven in October.",
      });

      // ---------------------------------------------------------------
      // 1. filed. The control of this whole check: a build whose applyNote
      //    always answered `refused` fails here, and one that always answered
      //    `filed` fails cases 3, 4 and 5.
      // ---------------------------------------------------------------
      const one = join(staged, "1.md");
      writeFileSync(one, filedNote, "utf8");
      const filed = await apply({ imprnt: shim, vault: vault.root, file: one });
      expect(filed.outcome).toBe("filed");
      expect(filed.exit).toBe(0);
      expect(filed.note).toBe(`finances/${slug}`);
      expect(filed.said).toContain("✓");
      expect(filed.said).toContain(`finances/${slug}`);
      expect(filed.file).toBe(one);
      // On disk: the note, the snapshot, the manifest row, and the staged file
      // GONE, because the CLI deletes what it filed.
      expect(existsSync(join(vault.vaultDir, "finances", `${slug}.md`))).toBe(true);
      const snapshots = join(vault.rawDir, "proposed");
      expect(existsSync(snapshots)).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(vault.vaultDir, ".manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(manifest).some((key) => key.startsWith("apply:sha256:"))).toBe(true);
      expect(existsSync(one)).toBe(false);
      const filedBytes = readFileSync(join(vault.vaultDir, "finances", `${slug}.md`), "utf8");

      // ---------------------------------------------------------------
      // 2. noop. The identical bytes staged again and applied again.
      // ---------------------------------------------------------------
      writeFileSync(one, filedNote, "utf8");
      const noop = await apply({ imprnt: shim, vault: vault.root, file: one });
      expect(noop.outcome).toBe("noop");
      expect(noop.exit).toBe(0);
      expect(noop.note).toBe(`finances/${slug}`);
      expect(noop.said).toContain("=");
      expect(existsSync(one)).toBe(false);
      expect(readFileSync(join(vault.vaultDir, "finances", `${slug}.md`), "utf8")).toBe(filedBytes);

      // ---------------------------------------------------------------
      // 3. conflict. The same slug, DIFFERENT body bytes. Not overwriting is
      //    the whole of the contradiction discipline, so the note on disk is
      //    asserted unchanged and the vault's own workflow is asserted to have
      //    recorded it.
      // ---------------------------------------------------------------
      const two = join(staged, "2.md");
      writeFileSync(
        two,
        note({
          title,
          type: "note",
          domain: "finances",
          body: "The monthly card fee goes from nine to twelve in October.",
        }),
        "utf8",
      );
      const conflict = await apply({ imprnt: shim, vault: vault.root, file: two });
      expect(conflict.outcome).toBe("conflict");
      expect(conflict.exit).toBe(1);
      expect(conflict.note).toBe(`finances/${slug}`);
      expect(conflict.said).toContain("!");
      expect(conflict.said).toContain(`finances/${slug}`);
      expect(existsSync(two)).toBe(true);
      expect(readFileSync(join(vault.vaultDir, "finances", `${slug}.md`), "utf8")).toBe(filedBytes);
      const review = join(vault.vaultDir, "_needs-review.md");
      expect(existsSync(review)).toBe(true);
      expect(readFileSync(review, "utf8")).toContain(slug);

      // ---------------------------------------------------------------
      // 4. refused, two shapes: a note with no `type:`, and a file that is not
      //    there at all. Both keep whatever is staged.
      // ---------------------------------------------------------------
      const three = join(staged, "3.md");
      writeFileSync(three, note({ title: "A note with no type", body: "Body." }), "utf8");
      const refused = await apply({ imprnt: shim, vault: vault.root, file: three });
      expect(refused.outcome).toBe("refused");
      expect(refused.exit).toBe(1);
      expect(refused.said).toContain("✗");
      expect(existsSync(three)).toBe(true);

      const missing = await apply({
        imprnt: shim,
        vault: vault.root,
        file: join(staged, "nowhere.md"),
      });
      expect(missing.outcome).toBe("refused");
      expect(missing.exit).toBe(1);
      expect(missing.said).toContain("no such staged note:");

      // ---------------------------------------------------------------
      // 4b. refused, a THIRD shape driven for real: a vault directory that is
      //     not there. The CLI refuses before it opens the note at all. It is
      //     driven rather than typed, because a sentence this file invented
      //     would bind the classifier to what the check imagined the CLI says.
      // ---------------------------------------------------------------
      const noVaultFile = join(staged, "4.md");
      writeFileSync(noVaultFile, filedNote, "utf8");
      const noVault = await apply({
        imprnt: shim,
        vault: join(dir, "not-a-vault-at-all"),
        file: noVaultFile,
      });
      expect(noVault.outcome).toBe("refused");
      expect(noVault.exit).toBe(1);
      expect(noVault.said).toContain("no vault at ");
      expect(existsSync(noVaultFile)).toBe(true);

      // ---------------------------------------------------------------
      // 4c. AN APPLY THAT NEVER FINISHES IS REFUSED ON ITS OWN BOUND.
      //
      //     This is the harness's answer to the second seat's every-child
      //     reading of the memory watch. The apply is not a loop and its risk
      //     is not memory: it is the hub's own delivery machinery running the
      //     household's `imprnt` for a second or two, and what goes wrong is a
      //     HANG. So the bound is a wall clock, it lives on `applyNote`, and a
      //     child past it is killed and reported `refused` with `said` naming
      //     the bound. A refused apply never moves a watermark (D-153), so a
      //     hung CLI costs a retry and never a lost slice.
      //
      //     The shim here traps TERM, INT and HUP and loops for ever, so a
      //     build that asks politely and waits is caught beside one that never
      //     asks at all.
      // ---------------------------------------------------------------
      const hangs = writeHangingImprntShim(dir);
      const hungFile = join(staged, "5.md");
      writeFileSync(hungFile, filedNote, "utf8");
      const startedAt = Date.now();
      const hung = await apply({
        imprnt: hangs,
        vault: vault.root,
        file: hungFile,
        timeoutMs: 2_000,
      });
      const took = Date.now() - startedAt;
      expect(hung.outcome).toBe("refused");
      expect(hung.said).toContain("2000");
      // It really was killed on the bound rather than waited out: two seconds
      // plus slack, and nowhere near the pinned default.
      expect(took).toBeGreaterThanOrEqual(1_500);
      expect(took).toBeLessThan(30_000);
      // And the staged note is KEPT, as every refusal keeps it.
      expect(existsSync(hungFile)).toBe(true);
      // Nothing of that child is left behind.
      expect(
        Bun.spawnSync(["pgrep", "-f", "imprnt-hangs"]).stdout?.toString().trim(),
      ).toBe("");

      // ---------------------------------------------------------------
      // 5. `classifyApply` is PURE, and UNKNOWN IS REFUSED.
      //
      //    THE TRANSCRIPTS GO IN FROM THE CHILD, NOT FROM `applyNote`. The
      //    second seat's finding: feeding `applyNote`'s own `said` back into
      //    the classifier lets a build launder its output, because the same
      //    code produced both sides of the comparison. So this drives the shim
      //    directly, captures stdout and stderr itself, and hands THAT to
      //    `classifyApply`. A build whose `applyNote` reshapes what the child
      //    said is caught by the pair.
      // ---------------------------------------------------------------
      const transcriptOf = async (
        file: string,
        vaultRoot: string,
      ): Promise<{ text: string; exit: number }> => {
        const child = Bun.spawn(
          [shim, "ingest", "--apply", file, "--vault", join(vaultRoot, "vault")],
          { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
        );
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { text: `${out}${err}`, exit };
      };

      // Four fresh drives against a SECOND vault, so each one meets the same
      // state the drives above met and the transcripts are the CLI's own.
      const second = await scratchVault(dir, "vault-project-2");
      try {
        const own = join(staged, "own");
        mkdirSync(own, { recursive: true });
        const a = join(own, "1.md");
        writeFileSync(a, filedNote, "utf8");
        const tFiled = await transcriptOf(a, second.root);
        writeFileSync(a, filedNote, "utf8");
        const tNoop = await transcriptOf(a, second.root);
        const b = join(own, "2.md");
        writeFileSync(
          b,
          note({
            title,
            type: "note",
            domain: "finances",
            body: "The monthly card fee goes from nine to twelve in October.",
          }),
          "utf8",
        );
        const tConflict = await transcriptOf(b, second.root);
        const c = join(own, "3.md");
        writeFileSync(c, note({ title: "A note with no type", body: "Body." }), "utf8");
        const tRefused = await transcriptOf(c, second.root);

        expect(tFiled.exit).toBe(0);
        expect(tNoop.exit).toBe(0);
        expect(tConflict.exit).toBe(1);
        expect(tRefused.exit).toBe(1);

        expect(classify(tFiled.text, tFiled.exit).outcome).toBe("filed");
        expect(classify(tNoop.text, tNoop.exit).outcome).toBe("noop");
        expect(classify(tConflict.text, tConflict.exit).outcome).toBe("conflict");
        expect(classify(tRefused.text, tRefused.exit).outcome).toBe("refused");
        expect(classify(tFiled.text, tFiled.exit).note).toBe(`finances/${slug}`);
        expect(classify(tConflict.text, tConflict.exit).note).toBe(`finances/${slug}`);

        // And `applyNote` reported the same outcome the child's own bytes do,
        // which is what says its `said` is the child's and not its own.
        expect(classify(tFiled.text, tFiled.exit).outcome).toBe(filed.outcome);
        expect(classify(tConflict.text, tConflict.exit).outcome).toBe(conflict.outcome);
      } finally {
        await second.remove();
      }

      // --- UNKNOWN IS REFUSED, whatever the exit code.
      expect(classify("", 0).outcome).toBe("refused");
      expect(classify("", 1).outcome).toBe("refused");
      expect(classify("something the CLI never says", 0).outcome).toBe("refused");
      expect(classify("something the CLI never says", 1).outcome).toBe("refused");

      // --- AND A MARKER THE EXIT CODE CONTRADICTS IS REFUSED, both ways
      //     round. This is the assertion the second seat found missing, and it
      //     is the one that stops a watermark moving on an apply that did not
      //     land: a classifier reading the marker alone and ignoring its `exit`
      //     argument passes every case above and fails here.
      //
      //     `conflict` and `refused` BOTH exit 1 in the real CLI, so the exit
      //     code alone cannot tell them apart either. Both signals are needed
      //     and neither is sufficient, which is what D-152 pins.
      expect(classify(filed.said, 1).outcome).toBe("refused");
      expect(classify(noop.said, 1).outcome).toBe("refused");
      expect(classify(conflict.said, 0).outcome).toBe("refused");
      expect(classify(refused.said, 0).outcome).toBe("refused");
      // A success marker that reports a non-zero exit is an outcome nobody
      // read, and the rule is that an outcome nobody read never lands.
      expect(classify("  ✓ filed finances/invented  (type: note)", 1).outcome).toBe("refused");
      expect(classify("  ✗ finances/invented: something went wrong", 0).outcome).toBe("refused");

      // ---------------------------------------------------------------
      // 6. The staging paths are pure and colon-free. A row id carries colons,
      //    which are legal at the POSIX layer and are shown as `/` by macOS's
      //    Finder, so the directory name replaces every character outside
      //    [A-Za-z0-9._-].
      // ---------------------------------------------------------------
      const slugged = (stageSlug as (id: string) => string)(rowId);
      expect(slugged).not.toContain(":");
      expect(/^[A-Za-z0-9._-]+$/.test(slugged)).toBe(true);
      expect(staged).toBe(join(stateDir, "p1", "harvest", slugged));

      // ---------------------------------------------------------------
      // 7. `stageNotes` writes 1.md, 2.md in REPLY ORDER, each holding its
      //    block's bytes exactly. Order is the contract: check 10 depends on
      //    the second note being applied after the first.
      // ---------------------------------------------------------------
      const secondRow = "harvest:p1-lair:2026-09-16T22:00:00.000Z";
      const bodies = ["first note bytes\n", "second note bytes\n", "third note bytes\n"];
      const written = await (stageNotes as (args: {
        stateDir: string;
        person: string;
        rowId: string;
        notes: string[];
      }) => Promise<string[]>)({ stateDir, person: "p1", rowId: secondRow, notes: bodies });
      const secondDir = (stageDirFor as (s: string, p: string, r: string) => string)(
        stateDir,
        "p1",
        secondRow,
      );
      expect(written).toEqual([
        join(secondDir, "1.md"),
        join(secondDir, "2.md"),
        join(secondDir, "3.md"),
      ]);
      written.forEach((file, at) => {
        expect(readFileSync(file, "utf8")).toBe(bodies[at]);
      });
    } finally {
      if (vault) await vault.remove();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);
