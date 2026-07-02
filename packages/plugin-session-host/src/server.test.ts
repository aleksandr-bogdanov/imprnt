import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore, loopbackHost } from "./server.ts";

// An installed copy arrives without the repo's .gitignore (npm strips it from tarballs), so the host
// writes its own before the profile/audit.log exist — otherwise a git-init'd vault stages live cookies.
test("ensureGitignore writes the guard when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-host-test-"));
  ensureGitignore(dir);
  const body = readFileSync(join(dir, ".gitignore"), "utf8");
  expect(body).toContain("profile/");
  expect(body).toContain("audit.log");
});

test("ensureGitignore leaves an existing .gitignore untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-host-test-"));
  writeFileSync(join(dir, ".gitignore"), "custom\n");
  ensureGitignore(dir);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom\n");
});

// The DNS-rebinding fence: only requests addressed to loopback are answered. A rebound page connects
// to 127.0.0.1 but carries its own hostname in the Host header — that must be a 403.
test("loopbackHost accepts loopback hosts, with or without a port", () => {
  expect(loopbackHost("127.0.0.1")).toBe(true);
  expect(loopbackHost("127.0.0.1:8787")).toBe(true);
  expect(loopbackHost("localhost")).toBe(true);
  expect(loopbackHost("localhost:59999")).toBe(true);
});

test("loopbackHost rejects everything else", () => {
  expect(loopbackHost("attacker.example")).toBe(false);
  expect(loopbackHost("attacker.example:8787")).toBe(false);
  expect(loopbackHost("localhost.attacker.example")).toBe(false);
  expect(loopbackHost("")).toBe(false);
  expect(loopbackHost(undefined)).toBe(false);
});
