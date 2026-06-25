# Architecture

How kopeika is built and why it is shaped this way. The [README](../README.md) is the front door and the command reference. [RUNBOOK.md](../RUNBOOK.md) is the monthly operating procedure. This document is the durable design: the model, the data layers, and the decisions that do not change month to month.

## The core principle

The LLM builds the tools at authoring time. The deterministic tools do the work at runtime. No model touches a transaction at runtime, so the same exports always produce the same ledger, report, and dashboard.

Verification is structural, not a model's opinion:

- **A golden test suite** over parsing, dedup, FX, rules, transfers, savings, and projection.
- **Reconcilable invariants.** A known month must reproduce a known spend and saved figure. Income, spend, and saved are derived from the same signed rows, so they cannot silently drift apart. This is the lesson that started the project: an earlier money tool reported income and outflow that did not reconcile to the actual balance, a double-count no single test run catches. Reconciliation is the missing check.

The cost of the principle is that vendor-specific logic is the one human-written surface (the connectors). Everything downstream is shared and deterministic.

## The pipeline

```
bank CSV export
   │  import      archive raw, parse, FX→EUR, dedup by id, append
   ▼
data/ledger.csv  (clean, normalized)
   │  categorize  apply data/rules.csv, first match wins
   │  transfers   pair internal account-to-account legs
   ▼
   ├─ report      income / spend / saved per month, category + floor/flex
   ├─ project     roll the savings stock forward 1y / 5y at a set rate
   └─ report --html   the self-contained net-worth dashboard
```

Each stage is a CLI command and is safe to re-run. Import dedups, so an overlapping re-export is a no-op. Transfers re-pairs idempotently. A full reset is `rm data/ledger.csv` then re-import every account.

## Raw vs clean

Original exports are archived under `data/raw/<source>/` and never edited. The clean ledger `data/ledger.csv` is rebuilt from them. Keeping both layers means a re-import or a rebuild can never lose the source of truth, and any categorization or transfer logic can be replayed from scratch.

## Stock vs flow

Two different questions about money:

- **Flow:** transactions summed over a month. Income, spend, saved. This is what `report` answers.
- **Stock:** an account level at a moment. The buffer balance, the savings total, the projection's starting point. The `balance` column carries the running level when an export reports it (Revolut does, N26 and Trading 212 do not).

Savings is the stock that matters: money that has landed in a savings destination. Everything else on any account is spendable float. Money leaving a savings destination is a negative flow that lowers the stock, so a bad month reports itself with no penny-counting. The only glance needed is whether the buffer slid backwards, which is just "did we raid it."

## The two axes

A row has a **category** (what it is) and the ledger separately reads a **tier** (floor vs flex) from `data/tiers.csv`.

- Category answers "what was this": Groceries, Rent, Shopping. It comes from the rules.
- Tier answers "could we skip it": floor (mandatory) vs flex (optional). It is a property of the category, set in one file, not a per-row column and not derived from recurrence. A frequent buy recurs but can still be flex.

Keeping them orthogonal means the spend view can split mandatory from discretionary without re-touching a single transaction. Changing a tier is a one-line data edit.

## Savings as destinations

The "saved this month" number is the inflow to the savings destinations, not income-minus-spend. Defining savings as the inflow to specific accounts means a bad month shows up as less landing there, without having to count every euro of spend first. The destinations are configured in `data/savings.csv`:

- `account,<label>` builds the stock from that account's flow (the cost basis: cumulative deposits minus withdrawals).
- `marker,<name>` is an in-account pot (a stash inside a regular account).
- `anchor,<value>` is a manual balance, the last resort for an account with no export.

## The net-worth layer

On top of liquid savings sits an illiquid layer that the dashboard charts as its own toggleable lines:

- **Property:** the flats, valued in RUB, net of their mortgage. The flats compound at a conservative nominal appreciation rate. The mortgage is carried flat (subtracted, never appreciating). The mortgage figure is the real current balance after prepayment, not the origination schedule.
- **A structured note (BCS):** a nominal held flat in CNY.

These marks (flat values, mortgage balance, note nominal, the appreciation rate) live in `data/profile.json` (see "The personal layer" below), not in code. They are facts about the world, not ledger rows, so they are a single edit point rather than transactions. With no marks declared, the chart shows liquid savings only.

The dashboard's Total sums only the **visible** lines. Toggling real estate off collapses the headline number to the liquid, touchable amount. That is the point: a large net worth is real but not spendable, and the page lets you see the number you can actually touch.

## Projection

The projection rolls the savings stock forward 1 and 5 years at a monthly rate you set with a slider, defaulting to the recent actual. The slider is what keeps the forecast honest: the rate is an assumption you own, not a number the tool pretends to know.

- The ETF is held flat at cost basis. Growth is unmodeled upside, a loss is not drawn either. The transactions export has no portfolio-value column, so cost basis is what a flat projection can carry. A live market value would be one number a month from a second source, an optional add.
- Real estate compounds at its nominal rate, the mortgage stays flat.
- Output is dual-currency, EUR and RUB, because the income mix is mostly RUB.

## The dashboard

One self-contained HTML file: inline CSS, a hand-rolled SVG chart, vanilla JS, no CDN, no fetch, no external JS. Rendered by `report --html`, deployed as a static file. It is bilingual (RU default, EN), light/dark, and mobile-first, and it follows the shared house style (Inter + Space Grotesk + JetBrains Mono, an emerald accent, mono stats and eyebrows). On a phone the chart runs full-bleed with the line labels floating over a soft right-edge fade, so the chart reads as the centerpiece rather than a cropped strip.

The page carries no account numbers, no IBANs, and no balances. When hosted it sits behind a password. The display labels (clean merchant names, the "what for" note, account labels, the footer) come from `data/profile.json` at render time, so they survive ledger re-imports and keep personal text out of the code. The category colour palette is generic and stays in `src/dashboard.ts`.

## FX

`amount_eur = amount_native * rate_to_eur` for the row's month, from `data/rates.csv`. EUR converts at 1 with no row. A missing `(month, currency)` rate leaves `amount_eur` empty and is reported. kopeika never guesses a rate. Rates can be per-month, the schema has a `month` column.

## Connectors

A connector is `src/connectors/<name>.ts` exporting `parse<Name>(text: string): ParsedRow[]`. It translates the vendor CSV into the `ParsedRow` shape and filters out non-completed or invalid rows. It does not compute `id`, FX, dedup, or transfer grouping, the import pipeline owns those. Register it in `src/connectors/index.ts`. The built connectors are Revolut, N26, Trading 212, T-Bank, and Alfa. The Alfa connector keeps only savings-vehicle accounts by design, dropping card and current-account rows.

Some connectors flag a row as a likely internal transfer when it names one of your own accounts. The names and IBANs that define "yours" are not hardcoded. They come from the profile and are installed at startup through `src/identity.ts`, so a connector carries vendor-format logic only, never a person. The `transfers` command pairs the authoritative legs by amount and date regardless, so a missed hint never loses a transfer.

## The personal layer (the profile)

Every personal fact lives in `data/profile.json` (kept local, never on a remote), never in the code. This is the same "data is the source of truth" rule the ledger config follows, applied to identity and display: own names and IBANs for transfer detection, the net-worth marks, the account and merchant display labels, and the footer. `src/profile.ts` loads it once at startup. A committed `profile.example.json` is the template.

Loading is forgiving by design. A missing file yields an empty profile, so a fresh checkout runs in generic mode: no own-name matching, no net-worth layer, raw merchant and account strings. Filling the profile in lights those features up. The payoff is that the package ships with no personal data and the same binary works for anyone, while one local file holds everything specific to one household. That file, and the whole `data/` folder, must never reach a remote: committed in a remoteless private store (the imprnt vault) is the intended setup, and `check.js` fails if `data/` is tracked in a repo that has a remote.

## Data scope

What the ledger is allowed to contain, and why:

- **EUR side: fully tracked.** Spend, income, floor/flex, and savings. German transactions are stable merchants, and the rules already strip internal transfers, so full tracking is cheap and honest.
- **RU side: savings only.** The RU savings accounts are tracked as destinations (the accumulated stock). RU card spend and RU income are out of scope. RU income lands in a separate account and is taxed there.
- **Off the books:** cash (logged only on demand, never reconciled, a missing cash row is never a gap), and accounts whose labor outweighs their signal.

The scope is a policy choice, not a technical limit. Including an account is about whether it belongs in the household picture, not about effort. Cross-currency transfer matching is not needed because cross-border transfers do not happen.

## Design decisions

The durable choices, stated as principles rather than dated events:

- The household number that gets surfaced is savings going up, never spending picked apart. Full books underneath, a calm outcome on top.
- Savings is the inflow to named destinations, nothing else.
- Projection is the reason the tool exists. The go-forward rate is a slider, defaulting to the recent actual.
- The ETF is flat at cost basis. Live market value is an optional later add from a second source.
- Dual currency throughout, EUR and RUB.
- Net-worth marks are profile data, not ledger rows and not code.
- The data files are the source of truth, the code reads them. Categorization, tiers, savings destinations, FX rates, and the whole personal layer (names, marks, display labels) are all data edits, never code changes. The code ships with no personal data.
</content>
