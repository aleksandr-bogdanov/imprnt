// Read-only: rejudges a SAVED resume report (or a result file holding one under `resume.report`) with the current judge and prints
// the saved and the rejudged judgments side by side. No model call, no host access, and nothing is written or modified.
//
//   bun live/claude-session-portability-rejudge.ts <saved-report-or-result.json>

import { readFileSync } from "node:fs";
import { rejudgeResumeReport } from "./claude-session-portability.ts";

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { process.stderr.write("usage: bun live/claude-session-portability-rejudge.ts <saved-report-or-result.json>\n"); process.exit(2); }
  const data = JSON.parse(readFileSync(file, "utf8")) as { resume?: { report?: unknown } };
  const report = (data.resume?.report ?? data) as { verdict?: unknown; judgments?: unknown };
  const now = rejudgeResumeReport(report);
  console.log(JSON.stringify({ saved: { verdict: report.verdict, judgments: report.judgments },
    rejudged: { verdict: now.decision.verdict, exit_code: now.decision.code, failures: now.failures, refusals: now.refusals, carried: now.carried } }, null, 2));
}
