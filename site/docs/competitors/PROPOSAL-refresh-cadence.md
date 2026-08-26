# Proposal: a refresh cadence for this folder (not built)

Status: PROPOSAL, 2026-08-26, on Alex's ask after the field's biggest competitor
(OpenClaw, ~388k stars) was discovered from LinkedIn rather than from this
folder. The README swears "That does not happen again" about exactly this
failure mode, and nothing currently enforces it: the last full refresh was
2026-06-20, and staleness is invisible until someone trips over it.

## The mechanism, kept small

One data file, one script, one timer line. No new plugin, no state, no LLM.

1. **`watched.tsv`** in this folder, checked in. One row per dossier:
   `file <tab> github_repo <tab> stars_claimed <tab> release_claimed <tab> checked`.
   Example: `openclaw.md  openclaw/openclaw  388000  2026.8.1-beta.3  2026-08-26`.
   Non-GitHub tools (Obsidian) carry `-` in the repo column and are skipped
   with a note. The file is the dossiers' own claims made machine-readable,
   nothing more.

2. **`freshness.mjs`** beside it (~60 lines). For each row it hits the GitHub
   API (no auth needed at this volume: 14 repos, 2 calls each, well under the
   60/hour anonymous limit) for `stargazers_count`, latest release tag + date,
   and `pushed_at`. It prints one line per tool: current values next to
   claimed, and flags three conditions - stars drifted more than 25%, a release
   newer than the dossier's check date, and a repo silent for more than 90 days
   (the dormancy signal the Reor lesson is about). Exit code 1 if anything is
   flagged, 0 if quiet. Archived/renamed repos show up free: the API returns
   301 or `archived: true`, which is exactly the Reor-class event.

3. **Wiring, two options, pick one:**
   - The watcher way: a `systemd` timer on the hub, monthly, output through the
     existing watcher digest path like the other residues. Fits the fleet, but
     puts site-repo knowledge on the hub.
   - The check way (leaner, recommended): the script doubles as this repo's CI
     or a line the site's existing build/test flow runs. No hub involvement,
     and the flag fires where the fix happens (a session in this repo).
   Either way the OUTPUT is a report, never an edit: a flag means "a session
   should re-check the dossier", the same conscious-refresh model as today,
   just with the trigger automated.

4. **Discovery of NEW competitors stays human plus one query.** No API tells
   you a competitor was born. The cheap approximation: the script also runs one
   GitHub search (`topic:ai-assistant stars:>20000 created:>{last-refresh}`)
   and prints anything not in the TSV. That would have caught both OpenClaw and
   Hermes months early. Imperfect by design, and one line of code.

## Why this shape

- The TSV is the contract: dossiers claim facts, the script diffs reality
  against the claims. That is `imprnt check` applied to this folder.
- No LLM anywhere: staleness detection is arithmetic on API responses.
- Fails loud, changes nothing: the script never edits a dossier, it names the
  ones that need a human pass.
- Small enough to not be a project: one TSV, one ~60-line script, one timer or
  CI line. Delete both files and nothing else notices.

## Cost of not building it

This folder goes stale silently again, and the next OpenClaw arrives via
LinkedIn again. The August sweep found the last refresh was 67 days old with
the two biggest repos in the field missing.
