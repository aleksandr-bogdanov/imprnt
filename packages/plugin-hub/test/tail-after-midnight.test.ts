import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendChatLine, readTail } from "../src/chatlog";

// The tail walks the dated log files. A window shorter than a day that starts
// before midnight must still reach the file of the day it ends in, or an agent
// spawned shortly after midnight wakes without anything said since.
test("MSG-12 a tail window that crosses UTC midnight reads the file of the day it ends in", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hub-tail-midnight-"));
  const chat = { stateDir, person: "p1", agent: "p1-lair" };
  try {
    const now = new Date("2026-09-19T00:30:00.000Z");
    const line = (id: string, at: string, text: string) =>
      appendChatLine(chat, { id, at, direction: "in", from: "p1", text } as never);
    await line("before-window", "2026-09-18T23:00:00.000Z", "older than the window");
    await line("yesterday", "2026-09-18T23:50:00.000Z", "said before midnight");
    await line("today", "2026-09-19T00:20:00.000Z", "said after midnight");

    const tail = await readTail({ ...chat, now, hours: 1, tokens: 10_000 });
    expect(tail, "a line from the day the window ends in").toContain("p1: said after midnight");
    expect(tail, "control: a line from the day it starts in").toContain("p1: said before midnight");
    expect(tail, "control: a line older than the window stays out").not.toContain("older than the window");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
