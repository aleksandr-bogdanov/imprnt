// imprnt statusline — the bottom line of your Claude session, yours to shape.
// Shipped as built statusline.js. Claude Code runs it on every refresh, pipes the session JSON on
// stdin, and shows whatever single line it prints. The wiring rides imp's --settings (see this
// plugin's imp-settings.json); there is nothing to configure in your own settings files.
//
// This default line is deliberately small: model · directory · context used · session cost. It is
// a starting point you personalize — edit the segments below (or copy the plugin into
// plugins/_personal/ first if you want to keep the shipped one pristine). The full field list the
// JSON carries is documented at https://code.claude.com/docs/en/statusline — git branch, rate
// limits, PR number, output style, and more are all in there to pick from.
//
// Defensive on purpose: every field is optional, a missing one just drops its segment, and
// unparseable stdin prints nothing. A status line must never crash a session.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

type SessionInfo = {
  model?: { display_name?: string };
  workspace?: { current_dir?: string };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
};

let info: SessionInfo = {};
try {
  info = JSON.parse(readFileSync(0, "utf8")) as SessionInfo;
} catch {
  process.exit(0);
}

const segments: string[] = [];

if (info.model?.display_name) segments.push(info.model.display_name);
if (info.workspace?.current_dir) segments.push(basename(info.workspace.current_dir));
if (typeof info.context_window?.used_percentage === "number") {
  segments.push(`ctx ${Math.round(info.context_window.used_percentage)}%`);
}
if (typeof info.cost?.total_cost_usd === "number") {
  segments.push(`$${info.cost.total_cost_usd.toFixed(2)}`);
}

if (segments.length) console.log(segments.join(" · "));
