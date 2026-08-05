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
  (Anlagenverzeichnis for AfA), `thresholds.json` (the statutory lines the year must land against),
  `forward.json` (the forward book the threshold projector reads). Templates in `profiles.example/`.
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
- `imprnt kopeika import norman-dump <file.json> --account <label> --owner <o> --who <person>
  [--category-map <rules.json>]` imports a Norman (norman.finance) transaction dump, one JSON array
  of raw API transaction objects fetched day by day (the API ignores limit and caps at 20 rows).
  The connector never talks to Norman itself. Rows land on the person's books with tax categories
  mapped from the Norman category names (Software to software, Equipment to equipment_gwg, Office
  supplies to office, Meals to meals GROSS so the EÜR builder splits 70/30 itself, Transportation to
  transport, Education to education, Services to revenue, Capital contribution to
  capital_contribution, Personal to personal neutral). Zero-amount rows are card authorisation holds
  and are skipped. A row carrying amortization metadata is an activated asset and books neutral as
  asset_purchase. The asset itself belongs in `profiles/<person>/assets.json` so the write-off
  arrives via AfA, never doubled as an expense row. An unknown category queues, never guessed.
  `--category-map` points at the norman plugin's rules.json when a dump carries category uuids
  instead of names. Dedup rides on the Norman transaction uuid, so re-importing a fresh dump of the
  same books is a no-op.
- `imprnt kopeika categorize --who <person>` — the deterministic tax pass: pins first (never
  overridden), then ratified rules (fill empty dispositions only), then prints the queue of
  undisposed rows on dedicated accounts.
- `imprnt kopeika decide <txid> <category> --who <person> [--note <text>]` — pin ONE row. This is
  the explicit-permission step: the model may PROPOSE a category for a queued row, but only this
  verb (run on the user's say-so) ratifies it. txid prefixes work.
- `imprnt kopeika report --who <person> [--year YYYY]` — the EÜR: line-mapped totals, Bewirtung
  70/30, AfA, Storno reconciliation, profit.
- `imprnt kopeika project --who <person> [--year YYYY]` — the threshold projector: actuals plus the
  forward book landed against each statutory line, with the gap priced while the fix is buyable.
- `imprnt kopeika status` — one line per tax profile: book rows, years, pins, rules, queue size,
  plus the binding threshold's landing vs limit when the person keeps thresholds.
- `imprnt kopeika list --who <person> [--queued]` — book rows with the tax axis shown.
- `imprnt kopeika invoice --who <person> ...` — generate a § 14 UStG invoice PDF in the person's
  own layout. Details in the Invoices section below.

The monthly procedure (export, import, categorize, transfers, review, report) is in README.md.

## Invoices (the § 14 generator)

When the user says "invoice for Erika, 4 lessons at 62.50", run the command and report the path:

```
imprnt kopeika invoice --who <person> --client "Erika Musterfrau" --qty 4 --unit-price 62.50
```

The output lands as PDF plus HTML under `profiles/<person>/invoices/`, named by the invoice number
(`RE0042.pdf`). The one-line summary the command prints carries the number, the client, the total
and the path. Relay exactly that.

How it works, so you can explain it and not break it:

- The letterhead (business name, address, phone, email, PayPal, logo, the § 19 clause) is the
  `invoice` object in `profiles/<person>/profile.json`. A missing field fails loud. Payment is
  PayPal-only by the user's ruling. There is no bank or IBAN line and you never add one.
- `profiles/<person>/clients.json` maps each client name to a stable Kundennr. Seed or refresh it
  with `imprnt kopeika invoice --who <person> --sync-clients`, which derives every name and number
  from the archived DATEV XMLs so numbers continue the Lexoffice range. A client the registry does
  not know gets max+1 and is saved when the invoice is written. `anrede` ("Frau", "Herr") and an
  optional address are hand-filled fields. Set them when the user tells you, never guess a salutation.
- `profiles/<person>/invoices/counter.json` is the gapless § 14 sequence. The number is consumed
  ONLY after the PDF (or final HTML) is on disk. Never edit `next` by hand to skip or reuse a number.
- For a preview, ALWAYS use `--dry-run`. It renders `draft-preview.pdf` with a DRAFT watermark and
  consumes nothing. Never generate a numbered invoice as a test.
- The PayPal box carries a QR code encoded locally, pointing at `<paypal.me>/<total>eur`, the same
  link printed under the box.
- The backwards flow: `--from-tx <ledger-txid>` builds the invoice from an income row already on the
  books. Total = the row amount, date = the row date, client = the row merchant matched against
  clients.json. `--qty N` splits the total into N whole-cent units. This becomes the default once
  PayPal rows land in the ledger.
- PDF rendering shells out to system Chrome headless. Without Chrome the HTML is written and the
  command says so. That HTML is the final artifact in that case.

## Onboarding a new tax person (the interview — the one place the LLM is load-bearing)

When the user wants a person's books set up, run a short interview in conversation and WRITE DATA
FILES the code then runs on. Ask: who (name, slug), Rechtsform (Freiberufler/Gewerbe), Steuernummer,
§ 19 Kleinunternehmer yes/no, activity start, which ledger accounts feed the books (and dedicated vs
mixed for each), which thresholds bind. Then create `profiles/<slug>/profile.json` (copy
`profiles.example/person/profile.json`) and an empty `rules.json`. Never invent a Steuernummer or a
date — read them from the vault or ask.

## The threshold projector (`project --who`)

`project --who <person>` answers "where does the year land" for the statutory lines that matter:
the Familienversicherung monthly-average profit cap, the Kleinunternehmer § 19 revenue cap, a
Liebhaberei Totalgewinn line. Actuals come from the same EÜR builder as `report --who`, so the two
can never disagree. Both inputs are pure data under `profiles/<person>/`:

- `thresholds.json` describes each line: basis (profit or revenue), window (monthly-average,
  calendar-year, all-years-cumulative), limit, direction (stay-under or reach-above-eventually),
  whether off-book adjustments count (`include_offbook`), and what crossing costs (free text).
- `forward.json` is the forward book. The user states the numbers in conversation ("I expect 1,400
  a month from teaching through December", "I plan to buy an interface for 350 by November") and
  you write them into the file as data. Never invent a forward number. Off-book adjustments are
  yearly amounts that never appear in the ledger (an Arbeitszimmer declared elsewhere) and count
  only into thresholds with `include_offbook: true`.

Run the command and read the table. A stay-under line that lands OVER prints the fix (how much
more Ausgaben by December brings the landing exactly to the limit) next to what crossing costs.
The run-rate line at the bottom is deliberately naive (actuals extrapolated, no forward book).
It exists as a cross-check because the run-rate once said "comfortably under" while the forward
book already priced the crossing. Trust the landing, not the run-rate.

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
