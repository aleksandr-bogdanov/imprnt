#!/usr/bin/env node
// Reads `turbo ls --affected --output=json` on stdin (affected since the last stable release) and emits
// the STABLE release matrix: each affected package bumped one patch from its current npm `latest`.
// Clean versions, no -edge suffix. Outputs to $GITHUB_OUTPUT:  any=<bool>  matrix=<JSON {include}>
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OUT = process.env.GITHUB_OUTPUT;
if (!OUT) {
  console.error("release-matrix: GITHUB_OUTPUT env required");
  process.exit(1);
}

// "Ready for the stable @latest channel" is a per-package property: a package opts in by setting
// `"stable": true` in its own package.json. Absent or false means edge-only, so the draft plugins keep
// flowing to @edge for dogfooding (edge-matrix.mjs is unfiltered, only this stable matrix is gated) and
// a new package can never leak to @latest by accident. A plugin graduates by flipping its own flag.
function isStable(pkgPath) {
  try {
    return JSON.parse(readFileSync(`${pkgPath}/package.json`, "utf8")).stable === true;
  } catch {
    return false;
  }
}

const raw = readFileSync(0, "utf8");
const allAffected = JSON.parse(raw.slice(raw.indexOf("{"))).packages.items.filter((p) => p.path && p.path.startsWith("packages/"));
const affected = allAffected.filter((p) => isStable(p.path));
const excluded = allAffected.filter((p) => !isStable(p.path)).map((p) => p.name);
if (excluded.length) console.error(`release matrix: excluded ${excluded.length} affected non-stable package(s) (edge-only): ${excluded.join(", ")}`);

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

function lastStable(name, dir) {
  try {
    const v = execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (v) return v;
  } catch {
    /* never published */
  }
  try {
    return JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

const include = affected.map((p) => {
  const dir = p.path.replace(/^packages\//, "");
  const version = bumpPatch(lastStable(p.name, p.path)) ?? "0.0.1";
  return { package: dir, name: p.name, version };
});

appendFileSync(OUT, `any=${include.length > 0}\n`);
appendFileSync(OUT, `matrix=${JSON.stringify({ include })}\n`);
console.error(`release matrix (${include.length}): ${JSON.stringify(include)}`);
