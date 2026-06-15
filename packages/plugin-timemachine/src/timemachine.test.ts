import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "./timemachine.ts";

let repo: string;
const g = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "timemachine-test-"));
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.md"), "v1\n");
  g(["add", "tracked.md"]);
  g(["commit", "-qm", "init"]);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("captures untracked-not-ignored, excludes gitignored secrets", () => {
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=hunter2\n"); // gitignored -> must NOT be captured
  writeFileSync(join(repo, "notes.md"), "important\n"); // untracked, not ignored -> captured
  const sha = snapshot(repo);
  expect(sha).toBeTruthy();
  const tree = g(["ls-tree", "-r", "--name-only", sha!]);
  expect(tree).toContain("notes.md");
  expect(tree).toContain("tracked.md");
  expect(tree).not.toContain(".env"); // the secret-safety assertion
});

test("excludes secret shapes even when not gitignored", () => {
  writeFileSync(join(repo, "id_rsa"), "PRIVATE KEY\n");
  writeFileSync(join(repo, "deploy.pem"), "CERT\n");
  writeFileSync(join(repo, "notes.md"), "keep\n");
  const sha = snapshot(repo);
  const tree = g(["ls-tree", "-r", "--name-only", sha!]);
  expect(tree).toContain("notes.md");
  expect(tree).not.toContain("id_rsa");
  expect(tree).not.toContain("deploy.pem");
});

test("does not disturb the working tree or index", () => {
  writeFileSync(join(repo, "notes.md"), "x\n");
  const before = g(["status", "--porcelain"]);
  snapshot(repo);
  expect(g(["status", "--porcelain"])).toBe(before);
});

test("restore brings back a deleted untracked file", () => {
  writeFileSync(join(repo, "notes.md"), "precious\n");
  const sha = snapshot(repo);
  rmSync(join(repo, "notes.md")); // agent "deletes" it
  expect(existsSync(join(repo, "notes.md"))).toBe(false);
  g(["checkout", sha!, "--", "notes.md"]); // what `timemachine restore` runs
  expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("precious\n");
});

test("returns null when there is nothing new to snapshot", () => {
  expect(snapshot(repo)).toBeNull(); // clean tree after the initial commit
});
