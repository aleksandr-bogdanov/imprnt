# Plugin: Kopeika (personal finance & net worth)

> The agent fragment — the plugin's entry point. The core never reads it; you (the assistant) do.
> Install = `imprnt plugin add kopeika`, which wires `@plugins/kopeika/agent.md` into `CLAUDE.local.md`
> (gitignored, per-machine). Remove = `imprnt plugin rm kopeika` (add `--purge` to delete the folder).

## What this plugin is

A deterministic, local-first personal-finance and net-worth CLI. It parses bank CSV exports into one
clean, deduplicated ledger, categorizes rows via ratified rules, matches internal transfers, tracks
savings destinations, and projects net worth. It renders a self-contained bilingual HTML dashboard. No
LLM ever touches a row at runtime, so the same exports always produce the same ledger, report, and
dashboard. It is the local money tool that lives next to the vault, not inside it.

## Where its data lives

Everything personal stays inside this plugin folder, gitignored, never in a vault note:

- `data/ledger.csv` — the clean normalized ledger, built from the raw exports.
- `data/raw/<source>/` — the immutable original bank exports.
- `data/rules.csv`, `data/tiers.csv`, `data/rates.csv`, `data/savings.csv` — the edit layer
  (categorization, floor vs flex, FX rates, savings destinations).
- `data/profile.json` — the personal layer: own names and IBANs (for transfer detection), the
  net-worth marks, account and merchant display labels, the footer. Copy `profile.example.json` to
  start one. This file is the PII. It is gitignored and never leaves the machine.
- `deploy/` — the optional hosted-dashboard bundle (the rendered HTML plus a tiny server). Gitignored.

`data/` and `deploy/` are gitignored in full. None of it ships with the plugin code.

## Commands (you run these; nothing runs on its own)

Run as `imprnt kopeika <cmd>` (the core dispatches to `node plugins/kopeika/kopeika.js`), or call
`node plugins/kopeika/kopeika.js <cmd>` directly:

- `imprnt kopeika import <revolut|n26|trading212|tbank|alfa> <file> --account <label> --owner <owner>`
  archives the raw export, parses, FX-converts to EUR, dedups, and appends.
- `imprnt kopeika categorize [--review]` applies `data/rules.csv`. `--review` lists new merchants by spend.
- `imprnt kopeika transfers` pairs internal account-to-account legs.
- `imprnt kopeika report [--month YYYY-MM] [--html <path> --lang <en|ru>]` gives income/spend/saved per
  month, the category and floor/flex split, and optionally writes the self-contained dashboard.
- `imprnt kopeika project [--rate <eur/mo>] [--years N]` rolls the savings stock forward 1 and 5 years.
- `imprnt kopeika recurring` and `imprnt kopeika list` show the recurring backbone and a row table.

The monthly procedure (export, import, categorize, transfers, review, report) is in README.md.

## How to answer a money question

When the user asks about their spending, savings, net worth, or a given month, run the relevant command
(`report`, `project`, `list`) and read its output. The ledger is the source of truth and the numbers
are deterministic. To change how a transaction is treated, edit the data file that governs it
(`rules.csv` for category, `tiers.csv` for floor/flex, `savings.csv` for destinations, `profile.json`
for display labels and net-worth marks), then re-run. Never hand-edit a ledger row.

## Rules (always-on while this fragment is installed)

- **Personal data stays in `data/` (gitignored), never in a vault note.** The PII is `data/profile.json`.
  To put something durable in the vault, propose a *summary* note (net worth, savings rate) into
  `proposed/` for `imprnt ingest --apply`. Never a per-transaction dump, never account numbers or balances.
- **The pipeline is deterministic; no LLM touches a row at runtime.** An LLM may propose a categorization
  *rule* at authoring time, never mutate a ledger row directly.
- **Never commit `data/` or `deploy/`.** They hold the real financial data and the rendered figures.
- **Namespace any vault label** you ever add with `kopeika.*`.
- The hosted dashboard carries no account numbers, IBANs, or balances, and sits behind a password.
