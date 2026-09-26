// A runner budget between one and four child limits admits fewer agents than
// it looks like, and `check` says how many.
//
// The admission reserves each child's own limit whenever that is under the
// budget, so a 2048 MB limit inside a 3072 MB budget admits ONE agent whatever
// `max_active_children` says. Seen live, a resident agent held the only slot
// and every other agent waited for ever, which looked like a login failure.
// The file still loads, because a budget under the count is a legal way to
// bound a fleet, so the answer is a finding that names the number and the two
// edits that would admit the declared count.
//
// No Postgres: the arithmetic is a function of one entry.
import { expect, test } from "bun:test"
import { admissionFindings } from "../src/check/admission.ts"
import { runnerAdmission } from "../src/registry/entries.ts"
import type { RunEntry } from "../src/registry/load.ts"

const runner = (fields: Partial<RunEntry>): RunEntry =>
  ({ id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, ...fields }) as RunEntry

test("the arithmetic is the admission's own: the limit is reserved under the budget, a share of it otherwise", () => {
  // The Pi's cutover shape: one at a time, whatever the count says.
  expect(runnerAdmission(runner({ child_memory_limit_mb: 2048, child_memory_budget_mb: 3072 })).admits).toBe(1)
  // The Pi's fix: four of 1024 in 4096.
  expect(runnerAdmission(runner({ child_memory_limit_mb: 1024, child_memory_budget_mb: 4096 })).admits).toBe(4)
  // The example registry: a limit equal to the default budget shares it in four.
  expect(runnerAdmission(runner({ child_memory_limit_mb: 2048 }))).toMatchObject({ admits: 4, reserve_mb: 512 })
  // A fleet bounded by its budget on purpose admits what the budget holds.
  expect(runnerAdmission(runner({ child_memory_limit_mb: 150, max_active_children: 18, child_memory_budget_mb: 400 })).admits).toBe(2)
})

test("a runner that admits fewer than its count is a finding naming the number and both edits, and one that admits its count is not", () => {
  const found = admissionFindings({ machine: "pi", entries: [
    runner({ child_memory_limit_mb: 2048, child_memory_budget_mb: 3072 }),
    runner({ id: "runner-ok", child_memory_limit_mb: 1024, child_memory_budget_mb: 4096 }),
    { id: "door-fake", kind: "door", machine: "pi", schedule: "always", memory_limit_mb: 192 } as RunEntry,
  ] })
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({ id: "pi/runner-admits-fewer:runner-pi", kind: "runner-admits-fewer", subject: "runner-pi", machine: "pi" })
  expect(found[0].says).toContain("admits 1 agent at a time")
  expect(found[0].says).toContain("max_active_children says 4")
  expect(found[0].fix).toContain("child_memory_budget_mb to at least 8192")
  expect(found[0].fix).toContain("child_memory_limit_mb to at most 768")
})
