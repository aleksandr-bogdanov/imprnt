# Plugin: Kopeika (family ledger & German tax face)

> The agent fragment — the plugin's entry point. The core never reads it; you (the assistant) do.
> Install = `imprnt plugin add kopeika`, which wires `@plugins/kopeika/agent.md` into `CLAUDE.local.md`
> (gitignored, per-machine). Remove = `imprnt plugin rm kopeika` (add `--purge` to delete the folder).

## What this plugin is

A deterministic, local-first family ledger with a tax face. It parses bank CSV exports into one clean,
deduplicated ledger, categorizes rows via ratified rules, matches internal transfers, tracks savings
destinations, and projects net worth. It renders a self-contained bilingual HTML dashboard.

The same ledger carries TWO AXES per row: the household category (spend/income analytics) and a
per-person tax disposition (whose books, which tax category, pinned or ruled). The tax face turns the
ledger into per-person German small-business bookkeeping: EÜR reports (§ 4 Abs. 3 EStG) with Anlage
EÜR line mapping, Bewirtung 70/30, AfA from an Anlagenverzeichnis, and migration connectors
(Lexoffice DATEV today). Germany ships as a DATA PACK (`categories.de.json`) — no country is
hardcoded; another country is another pack. Scope ceiling: ONE small business per person,
Kleinunternehmer under § 19, EÜR, a Steuerberater who wants figures. Explicitly not in scope: VAT
filings, payroll, multi-entity anything.

No LLM ever touches a row at runtime, so the same exports always produce the same ledger, report, and
dashboard. It is the local money tool that lives next to the vault, not inside it.

## Where its data lives

Everything personal stays inside this plugin folder, gitignored, never in a vault note:

- `data/ledger.csv` — the clean normalized ledger (both axes), built from the raw exports.
- `data/raw/<source>/` — the immutable original bank exports and DATEV XMLs.
- `data/rules.csv`, `data/tiers.csv`, `data/rates.csv`, `data/savings.csv` — the household edit layer
  (categorization, floor vs flex, FX rates, savings destinations).
- `profiles/` — the CONSOLIDATED PII ZONE. `profiles/household.json` is the household profile (own
  names/IBANs, net-worth marks, display labels — formerly `data/profile.json`, which still reads).
  `profiles/<person>/` holds one tax person: `profile.json` (identity, Steuernummer, country pack,
  which ledger accounts feed the books, dedicated vs mixed), `rules.json` (ratified merchant rules),
  `pins.json` (per-transaction decisions, written by `decide`, outrank rules forever), `assets.json`
  (Anlagenverzeichnis for AfA). Templates in `profiles.example/`.
- `categories.de.json` — SHIPPED DATA, committed: the Germany pack. Category set → Anlage EÜR lines,
  plus the SKR account-code map the DATEV connector uses. Line numbers are per-year form data — edit
  the pack, never code.
- `deploy/` — the optional hosted-dashboard bundle (the rendered HTML plus a tiny server). Gitignored.

`data/` and `profiles/` hold raw financial data and identities and must never reach a remote. In a
remoteless private store like the imprnt vault they are committed as the canonical source of truth;
anywhere a remote exists, gitignore them. `check.js` enforces both. `deploy/` is derived and stays
local. None of them ship with the plugin code.

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

The tax face (same binary, `--who` switches the axis):

- `imprnt kopeika import lexoffice-datev <unzipped-dir> --account <label> --owner <o> --who <person>`
  imports a Lexoffice "DATEV-Export Belegbilder mit Belegdaten" folder of XMLs. Rows land on the
  person's books with tax categories mapped from SKR account codes via the pack; the household
  analytics never see them (category Exclude). Stornos import as negative income rows and net out.
  An unmapped SKR code queues the row — never guessed.
- `imprnt kopeika categorize --who <person>` — the deterministic tax pass: pins first (never
  overridden), then ratified rules (fill empty dispositions only), then prints the queue of
  undisposed rows on dedicated accounts.
- `imprnt kopeika decide <txid> <category> --who <person> [--note <text>]` — pin ONE row. This is
  the explicit-permission step: the model may PROPOSE a category for a queued row, but only this
  verb (run on the user's say-so) ratifies it. txid prefixes work.
- `imprnt kopeika report --who <person> [--year YYYY]` — the EÜR: line-mapped totals, Bewirtung
  70/30, AfA, Storno reconciliation, profit.
- `imprnt kopeika status` — one line per tax profile: book rows, years, pins, rules, queue size.
- `imprnt kopeika list --who <person> [--queued]` — book rows with the tax axis shown.

The monthly procedure (export, import, categorize, transfers, review, report) is in README.md.

## Onboarding a new tax person (the interview — the one place the LLM is load-bearing)

When the user wants a person's books set up, run a short interview in conversation and WRITE DATA
FILES the code then runs on. Ask: who (name, slug), Rechtsform (Freiberufler/Gewerbe), Steuernummer,
§ 19 Kleinunternehmer yes/no, activity start, which ledger accounts feed the books (and dedicated vs
mixed for each), which thresholds bind. Then create `profiles/<slug>/profile.json` (copy
`profiles.example/person/profile.json`) and an empty `rules.json`. Never invent a Steuernummer or a
date — read them from the vault or ask.

## How to answer a money question

When the user asks about their spending, savings, net worth, or a given month, run the relevant command
(`report`, `project`, `list`) and read its output. The ledger is the source of truth and the numbers
are deterministic. To change how a transaction is treated, edit the data file that governs it
(`rules.csv` for category, `tiers.csv` for floor/flex, `savings.csv` for destinations, `profile.json`
for display labels and net-worth marks), then re-run. Never hand-edit a ledger row.

## Adding new data and publishing (the "eat this CSV" loop)

When the user hands you a fresh export ("here is my Revolut CSV, add it and update the site"), run the
loop and report what changed at each step:

1. `imprnt kopeika import <connector> <path> --account <label> --owner <owner>` — confirm the
   imported / skipped-dup counts and any missing FX rates it warns about.
2. `imprnt kopeika categorize` then `imprnt kopeika transfers`.
3. `imprnt kopeika categorize --review` — for each new merchant worth a label, add one line to
   `data/rules.csv` and re-run `categorize`. This is the one judgement step.
4. `imprnt kopeika report` (and `project`) to sanity-check the month against the known anchor.
5. Publish: render both languages, then deploy the `deploy/` bundle to the host.
   ```
   imprnt kopeika report --html deploy/public/en.html --lang en
   imprnt kopeika report --html deploy/public/ru.html --lang ru
   # then deploy the deploy/ bundle (the exact host command is in the user's deploy note)
   ```

Reuse the same `--account` label for an account every month; the display aliases and savings
destinations are keyed to them. The plugin's `data/` folder is the single source of truth for both the
CLI and the hosted dashboard.

## Rules (always-on while this fragment is installed)

- **Personal data stays in `data/` and `profiles/` (gitignored), never in a vault note.** To put
  something durable in the vault, propose a *summary* note (net worth, savings rate, an EÜR figure)
  into `proposed/` for `imprnt ingest --apply`. Never a per-transaction dump, never account numbers,
  balances, or Steuernummern.
- **The pipeline is deterministic; no LLM touches a row at runtime.** An LLM may propose a
  categorization *rule* or a category for a queued row at authoring time, never mutate a ledger row
  directly.
- **A tax category is NEVER guessed.** An unmatched row queues. You may propose; the user ratifies
  via `decide` or a rules.json edit. Pins outrank rules, and a decided row changes only by another
  explicit `decide`. (The inverse of Norman's silent 200s and re-guessing Autopilot.)
- **Never talk to a bank** except a first-party API the user holds themselves (opt-in, e.g. their own
  PayPal business credentials). No PSD2 aggregator, ever. CSV forever — bank credentials never touch
  the tool.
- **Never file or submit anything anywhere.** The Steuerberater stays the judgment layer; `report`
  hands over figures.
- **Financial data must never reach a remote.** `data/` and `profiles/` hold the real exports,
  ledger, identities, pins. Committing them in a remoteless private store (the imprnt vault) is the
  intended setup; anywhere with a remote, gitignore both. `check.js` fails if either meets a remote.
  `deploy/` stays local.
- **Namespace any vault label** you ever add with `kopeika.*`.
- The hosted dashboard carries no account numbers, IBANs, or balances, and sits behind a password.
