#!/usr/bin/env node
// Reads `turbo ls --affected --output=json` on stdin and emits a GitHub Actions matrix of the packages
// to publish to the `edge` channel, one entry per affected workspace package.
//
// Edge version = {patch-bump of the package's current npm `latest`}-edge.{RUN_NUMBER}. The base is
// derived from the last STABLE release and is FROZEN until the next stable cut — only the run number
// moves (e.g. 0.3.3-edge.418, 0.3.3-edge.419, …, then a stable 0.3.3 rolls the base to 0.3.4-edge.N).
// This is also semver-required: a prerelease sorts BEFORE its base, so basing edge on last-stable+1
// keeps every edge build newer than the last release and older than the eventual stable.
//
// Outputs to $GITHUB_OUTPUT:  any=<bool>  matrix=<JSON {include:[{package,name,version}]}>
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RUN = process.env.RUN_NUMBER;
const OUT = process.env.GITHUB_OUTPUT;
if (!RUN || !OUT) {
  console.error("edge-matrix: RUN_NUMBER and GITHUB_OUTPUT env are required");
  process.exit(1);
}

// turbo prints a "• turbo <ver>" banner to stdout even with --output=json; strip any non-JSON preamble.
const raw = readFileSync(0, "utf8");
const json = raw.slice(raw.indexOf("{"));
const affected = JSON.parse(json).packages.items.filter((p) => p.path && p.path.startsWith("packages/"));

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

// The package's last STABLE version = its npm `latest`. A never-published package (404) falls back to
// the local package.json so a brand-new package still gets a sane first edge build.
function lastStable(name, dir) {
  try {
    const v = execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (v) return v;
  } catch {
    /* not published yet */
  }
  try {
    return JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

const include = affected.map((p) => {
  const dir = p.path.replace(/^packages\//, "");
  const base = bumpPatch(lastStable(p.name, p.path)) ?? "0.0.1";
  return { package: dir, name: p.name, version: `${base}-edge.${RUN}` };
});

const matrix = JSON.stringify({ include });
appendFileSync(OUT, `any=${include.length > 0}\n`);
appendFileSync(OUT, `matrix=${matrix}\n`);
console.error(`edge matrix (${include.length}): ${matrix}`);
