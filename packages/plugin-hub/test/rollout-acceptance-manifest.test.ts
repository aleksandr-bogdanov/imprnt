import { beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { hubPath } from "./helpers/cluster.ts"
import { policy, protectedWindows, completeEvidenceFixture, requirementIssues, manifestIssues, serializeAccepted, proveEvidenceValidator, type Manifest } from "./helpers/rollout-evidence.ts"

beforeAll(proveEvidenceValidator)
const read = () => JSON.parse(readFileSync(hubPath("test/fixtures/rollout-acceptance.json"), "utf8")) as Manifest

// These are acceptance-readiness checks. Reading an open gate executes no login,
// phone, service-manager or owner action. Red means evidence is still owed.
for (const id of Object.keys(policy)) test(`${id} closure requires every D-184 evidence class and owning Forbidden control`, () => {
  const good = completeEvidenceFixture()
  expect(requirementIssues(id, good.requirements[id])).toEqual([])
  const row = good.requirements[id]
  for (const gate of Object.keys(row.evidence)) {
    const saved = row.evidence[gate]
    for (const result of ["skip", "fail", "missing"] as const) {
      row.evidence[gate] = { ...saved!, result }
      expect(requirementIssues(id, row).length).toBeGreaterThan(0)
      expect(() => serializeAccepted({ ...good, synthetic: false, status: "accepted" })).toThrow()
    }
    row.evidence[gate] = { ...saved!, observed: "skip", result: "pass" }
    expect(() => serializeAccepted({ ...good, synthetic: false, status: "accepted" })).toThrow()
    row.evidence[gate] = saved
  }
  if (id === "ROLL-05" || id === "ROLL-12") {
    const e = row.evidence["owner-cutover"]!
    e.facts.phoneP1 = "test-message"
    expect(requirementIssues(id, row).length).toBeGreaterThan(0)
    e.facts.phoneP1 = "human"
    if (id === "ROLL-12") {
      e.facts.operatorLogin = true
      expect(requirementIssues(id, row).length).toBeGreaterThan(0)
      e.facts.operatorLogin = false
      e.facts.bootChanged = false
      expect(requirementIssues(id, row).length).toBeGreaterThan(0)
      e.facts.bootChanged = true
    }
  }
  expect(requirementIssues(id, row)).toEqual([])
  const actual = read()
  const issues = requirementIssues(id, actual.requirements[id])
  if (issues.length) throw new Error(issues.join("\n"))
})

test("D-185 closure requires unchanged six windows on both hosts and exactly 28 active plus four deferred IDs", () => {
  const good = completeEvidenceFixture()
  expect(manifestIssues(good)).toEqual([])
  for (const file of protectedWindows) {
    const bad = structuredClone(good)
    delete bad.windows[file]
    expect(manifestIssues(bad)).toContain("six exact protected filenames required")
  }
  for (const id of good.deferred) {
    const bad = structuredClone(good)
    bad.requirements[id] = structuredClone(good.requirements["ROLL-01"])
    expect(manifestIssues(bad)).toContain("all 28 6a requirements required exactly once")
  }
  const actual = read()
  expect(Object.keys(actual.requirements).sort()).toEqual(Object.keys(good.requirements).sort())
  expect(actual.deferred).toEqual(good.deferred)
  expect(Object.keys(actual.windows).sort()).toEqual([...protectedWindows].sort())
  const issues = manifestIssues(actual).filter(s => s.startsWith("test/"))
  if (issues.length) throw new Error(issues.join("\n"))
})
