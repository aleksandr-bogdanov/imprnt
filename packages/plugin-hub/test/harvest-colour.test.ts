// Classification under a colour setting. The harvest reads what the real `imprnt ingest
// --apply` said from the marker at the start of each line, and a terminal
// colour setting in the environment must not change what it reads.
//
// THE DEFECT, measured on 2026-09-18 under bun 1.3.14 on this Mac against the
// monorepo's own `packages/imprnt/scripts/cli.ts`: with FORCE_COLOR set, bun
// paints every `console.error` line red, so the conflict line arrives as
//
//   "\x1b[0m\x1b[31m  ! finances/<slug> exists with DIFFERENT content ...\x1b[0m"
//
// and the line no longer STARTS with `!`. No marker is found, the output is
// unknown, and unknown is refused, so a conflict the vault recorded is
// reported as a refusal and the watermark never moves. FORCE_COLOR wins over
// NO_COLOR in bun (measured the same day: both set still paints), and an
// EMPTY FORCE_COLOR paints too, so the only environment that cannot colour the
// child is one with FORCE_COLOR taken out.
//
// Two halves of the fix, and a check for each:
//   the parent's environment. A runner started from a shell that exports
//     FORCE_COLOR hands the apply child an environment that cannot colour.
//     Case 2, driven through `test/helpers/apply-subprocess.ts` because a
//     variable planted in this process never reaches a spawned child, and
//     reading what the child was handed from a shim that writes it down,
//     because the reader alone would hide a child that painted.
//   the reader. A CLI that colours whatever it is handed is still read,
//     because the escape sequences are taken out before the markers are.
//     Case 3, through a shim that sets FORCE_COLOR itself. Case 4 reads the
//     measured bytes with no CLI at all.
// Case 1 is the control: with no colour setting anywhere the same path reads
// both outcomes, so a check that only ever answered `conflict` fails there.
//
// Red reason: on a build that spawns the apply with the inherited environment
// and reads markers from raw bytes, cases 2, 3 and 4 read `refused` where the
// CLI said `conflict`. With only the reader fixed, case 2 still fails on the
// child's environment. With only the environment fixed, cases 3 and 4 still
// read `refused`. Case 1 is green on every build.

import { test, expect } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, seam } from "./helpers/cluster.ts";
import { imprntCliPath, writeImprntShim } from "./helpers/imprnt-shim.ts";
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
const ESC = "\x1b";

function note(title: string, body: string): string {
  return [
    "---",
    "type: note",
    "domain: finances",
    "kind: reference",
    `summary: ${body}`,
    "tags: [banking]",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

/**
 * The environment a runner started from a shell has, with the colour setting
 * chosen by the check and nothing left to the shell the suite was started
 * from. `XDG_CONFIG_HOME` points under scratch so no apply can reach a
 * developer's own vault registry.
 */
function parentEnv(dir: string, colour: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === "FORCE_COLOR" || key === "NO_COLOR") continue;
    env[key] = value;
  }
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  if (colour) env.FORCE_COLOR = "3";
  return env;
}

/** `applyNote`, run by a parent process that has `env` and nothing else. */
async function applyUnder(
  env: Record<string, string>,
  imprnt: string,
  vault: string,
  file: string,
): Promise<ApplyResult> {
  const child = Bun.spawn(
    [process.execPath, hubPath("test/helpers/apply-subprocess.ts"), imprnt, vault, file],
    { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const last = out.trim().split("\n").pop() ?? "";
  let answer: { ok: boolean; error?: string; result?: ApplyResult };
  try {
    answer = JSON.parse(last);
  } catch {
    throw new Error(`apply-subprocess printed no answer.\nstdout: ${out}\nstderr: ${err}`);
  }
  if (!answer.ok || !answer.result) throw new Error(`apply-subprocess: ${answer.error}\n${err}`);
  return answer.result;
}

/** The real CLI behind a shim that turns colour on whatever it is handed. */
function writeColouringShim(dir: string): string {
  const shim = join(dir, "imprnt-colours");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "FORCE_COLOR=3",
      "export FORCE_COLOR",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(imprntCliPath())} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
}

/**
 * The real CLI behind a shim that first writes down the two colour variables
 * it was handed, so the check reads the child's environment rather than
 * inferring it from the output.
 */
function writeRecordingShim(dir: string): { shim: string; seen: string } {
  const shim = join(dir, "imprnt-records");
  const seen = join(dir, "apply-env");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `printf '%s\\n' "FORCE_COLOR=\${FORCE_COLOR-unset}" "NO_COLOR=\${NO_COLOR-unset}" > ${JSON.stringify(seen)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(imprntCliPath())} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  return { shim, seen };
}

/** The stderr bytes of one apply run straight from a shim, with `env`. */
async function rawStderr(env: Record<string, string>, imprnt: string, vault: string, file: string) {
  const child = Bun.spawn([imprnt, "ingest", "--apply", file, "--vault", join(vault, "vault")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { err, exit };
}

/**
 * File one note, then a note with the same title and different content, both
 * through `applyNote` under `env`, and answer what each was read as.
 */
async function fileThenConflict(args: {
  env: Record<string, string>;
  imprnt: string;
  vault: string;
  dir: string;
  title: string;
}) {
  const first = join(args.dir, `${slugOf(args.title)}-1.md`);
  const second = join(args.dir, `${slugOf(args.title)}-2.md`);
  writeFileSync(first, note(args.title, "The monthly card fee goes from nine to eleven."), "utf8");
  writeFileSync(second, note(args.title, "The monthly card fee goes from nine to twelve."), "utf8");
  const filed = await applyUnder(args.env, args.imprnt, args.vault, first);
  const conflict = await applyUnder(args.env, args.imprnt, args.vault, second);
  return { filed, conflict, second };
}

async function scratch(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const vault = await scratchVault(dir);
  return {
    dir,
    vault,
    async remove() {
      await vault.remove();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test(
  "harvest colour 1, the control: with no colour setting in the parent the real filing path reads filed and then conflict",
  async () => {
    const s = await scratch("hub-harvest-colour-1-");
    try {
      const title = "Plain parent card fee";
      const read = await fileThenConflict({
        env: parentEnv(s.dir, false),
        imprnt: writeImprntShim(s.dir),
        vault: s.vault.root,
        dir: s.dir,
        title,
      });
      expect(read.filed.outcome).toBe("filed");
      expect(read.filed.note).toBe(`finances/${slugOf(title)}`);
      expect(read.conflict.outcome).toBe("conflict");
      expect(read.conflict.note).toBe(`finances/${slugOf(title)}`);
      expect(read.conflict.exit).toBe(1);
    } finally {
      await s.remove();
    }
  },
  SLOW,
);

test(
  "harvest colour 2: with FORCE_COLOR=3 in the parent the real filing path still reads a conflict as conflict, never refused (D-152, D-153)",
  async () => {
    const s = await scratch("hub-harvest-colour-2-");
    try {
      const recording = writeRecordingShim(s.dir);
      const title = "Coloured parent card fee";
      const read = await fileThenConflict({
        env: parentEnv(s.dir, true),
        imprnt: recording.shim,
        vault: s.vault.root,
        dir: s.dir,
        title,
      });

      // WHAT THE CHILD WAS HANDED. The parent had FORCE_COLOR=3, the apply
      // child has none and has NO_COLOR=1. Read from the child's own
      // environment, because the reader below would hide a child that was
      // handed the colour and painted.
      expect(readFileSync(recording.seen, "utf8")).toBe("FORCE_COLOR=unset\nNO_COLOR=1\n");

      // THE PREMISE. The CLI this check drives really does colour its
      // conflict line when FORCE_COLOR reaches it. A bun that stopped doing
      // so would turn this whole case into a pass that proves nothing, so it
      // fails loudly here instead.
      const plain = writeImprntShim(s.dir);
      const premise = await rawStderr(parentEnv(s.dir, true), plain, s.vault.root, read.second);
      expect(premise.exit).toBe(1);
      expect(premise.err).toContain(ESC);
      expect(premise.err).toContain("!");

      expect(read.filed.outcome).toBe("filed");
      expect(read.filed.note).toBe(`finances/${slugOf(title)}`);
      expect(read.conflict.outcome).toBe("conflict");
      expect(read.conflict.note).toBe(`finances/${slugOf(title)}`);
      expect(read.conflict.exit).toBe(1);
      expect(read.conflict.said).not.toContain(ESC);
    } finally {
      await s.remove();
    }
  },
  SLOW,
);

test(
  "harvest colour 3: a CLI that colours whatever environment it is handed is still read, filed as filed and conflict as conflict (D-152)",
  async () => {
    const s = await scratch("hub-harvest-colour-3-");
    try {
      const imprnt = writeColouringShim(s.dir);
      const title = "Colouring CLI card fee";
      const read = await fileThenConflict({
        env: parentEnv(s.dir, false),
        imprnt,
        vault: s.vault.root,
        dir: s.dir,
        title,
      });

      // THE PREMISE, handed the environment a fixed apply hands its child:
      // no FORCE_COLOR and NO_COLOR=1. The shim still paints, which is what
      // makes this the case only the reader can fix.
      const scrubbed = { ...parentEnv(s.dir, false), NO_COLOR: "1" };
      const premise = await rawStderr(scrubbed, imprnt, s.vault.root, read.second);
      expect(premise.exit).toBe(1);
      expect(premise.err).toContain(ESC);

      expect(read.filed.outcome).toBe("filed");
      expect(read.conflict.outcome).toBe("conflict");
      expect(read.conflict.note).toBe(`finances/${slugOf(title)}`);
      expect(read.conflict.said).not.toContain(ESC);
    } finally {
      await s.remove();
    }
  },
  SLOW,
);

test("harvest colour 4: the classifier reads the measured coloured bytes by their markers, and keeps refusing what it cannot read (D-152)", async () => {
  const { classifyApply } = await seam("src/harvest/apply.ts");
  const classify = classifyApply as (
    output: string,
    exit: number,
  ) => { outcome: string; note: string; said: string };

  const red = (line: string) => `${ESC}[0m${ESC}[31m${line}${ESC}[0m\n`;
  const conflict = classify(red("  ! finances/card-fee exists with DIFFERENT content"), 1);
  expect(conflict.outcome).toBe("conflict");
  expect(conflict.note).toBe("finances/card-fee");
  expect(conflict.said).not.toContain(ESC);

  const filed = classify(`${ESC}[32m  ✓ filed finances/card-fee  (type: note)${ESC}[0m\n`, 0);
  expect(filed.outcome).toBe("filed");
  expect(filed.note).toBe("finances/card-fee");

  const noop = classify(`${ESC}[2m  = finances/card-fee already filed, identical content${ESC}[0m\n`, 0);
  expect(noop.outcome).toBe("noop");
  expect(noop.note).toBe("finances/card-fee");

  // Stripping the colour must not turn a refusal into anything else, nor
  // let a coloured marker win against the exit code that contradicts it.
  expect(classify(red("  ✗ /tmp/1.md: no `type:` in frontmatter"), 1).outcome).toBe("refused");
  expect(classify(red("no such staged note: /tmp/1.md"), 1).outcome).toBe("refused");
  expect(classify(red("  ! finances/card-fee exists with DIFFERENT content"), 0).outcome).toBe("refused");
  expect(classify(red("something no marker names"), 0).outcome).toBe("refused");
});
