# imprnt-plugin-kopeika

A deterministic, local-first personal-finance and net-worth CLI, packaged as an imprnt plugin. It
parses bank CSV exports into one clean, deduplicated ledger, categorizes via ratified rules, tracks
savings, and projects net worth, then renders a self-contained bilingual dashboard. No LLM touches a
row at runtime. All personal data lives in the plugin's own `data/` folder (local only, never on a remote), never in a vault note.

It is a sibling of [imprnt](https://github.com/aleksandr-bogdanov/imprnt). The shared idea: the LLM
builds the tools at authoring time, the deterministic tools do the work at runtime, and verification is
structural (golden tests plus reconcilable invariants). The problem it answers is the ZenMoney one:
categorize each merchant once and it is automatic forever, with no per-transaction manual entry and no
untrustworthy auto-categorization.

## Install

```bash
imprnt plugin add kopeika
```

This fetches the package, copies it to `plugins/kopeika/` in your project, and wires
`@plugins/kopeika/agent.md` into `CLAUDE.local.md` (gitignored, per-machine). To wire it by hand
instead, add `@plugins/kopeika/agent.md` to `CLAUDE.local.md` yourself.

Then create your profile: copy `plugins/kopeika/profile.example.json` to
`plugins/kopeika/data/profile.json` and fill it in (see Profile below). Without a profile the tool
runs in generic mode (raw labels, no net-worth layer).

## Remove

```bash
imprnt plugin rm kopeika           # unwire it
imprnt plugin rm kopeika --purge   # and delete plugins/kopeika/
```

## The monthly run

kopeika does not take hand-typed transactions. You feed it the bank's CSV exports. Commands run as
`imprnt kopeika <cmd>` (the core dispatches to `node plugins/kopeika/kopeika.js`).

1. **Export** a fresh CSV from each account (re-importing an overlap is a safe no-op, dedup handles it).
2. **Import** each file with its stable `--account` label:
   ```bash
   imprnt kopeika import <revolut|n26|trading212|tbank|alfa> <file> --account <label> --owner <owner>
   ```
3. **Categorize and match transfers:**
   ```bash
   imprnt kopeika categorize          # applies data/rules.csv
   imprnt kopeika transfers           # pairs internal account-to-account legs
   imprnt kopeika categorize --review # the one judgement step: new merchants by spend
   ```
   For each new merchant worth a label, add one line to `data/rules.csv` and re-run `categorize`.
4. **Verify:** `imprnt kopeika report` and `imprnt kopeika project`.

### Correcting an existing transaction

The ledger is derived, so you rarely hand-edit a row. You change the data file that governs it, then
re-run:

| You want to change | Edit | Then |
|---|---|---|
| A wrong or blank category | `data/rules.csv` (one rule) | `categorize` |
| Floor vs flex of a category | `data/tiers.csv` | nothing, `report` reads it live |
| A savings destination | `data/savings.csv` | `project` |
| A merchant display name / note, or net-worth marks | `data/profile.json` | re-render |

A clean reset is `rm data/ledger.csv` then re-import every account.

## Commands

```
imprnt kopeika import <revolut|n26|trading212|tbank|alfa> <file> --account <name> --owner <owner>
imprnt kopeika categorize [--review]
imprnt kopeika transfers
imprnt kopeika recurring [--min-months N] [--from YYYY-MM]
imprnt kopeika list [--source <x>] [--uncategorized] [--month YYYY-MM]
imprnt kopeika report [--month YYYY-MM] [--from YYYY-MM] [--html <path> --lang <en|ru>]
imprnt kopeika project [--rate <eur/mo>] [--lump-sum <eur>] [--years N]
```

### The tax face (`--who` switches the axis)

Every ledger row carries two independent axes: the household category above, and a per-person tax
disposition (whose books, which tax category, how it was decided). That second axis turns the family
ledger into per-person small-business bookkeeping — EÜR reports with Anlage EÜR line mapping,
Bewirtung 70/30, AfA from an Anlagenverzeichnis. Country specifics ship as a data pack
(`categories.de.json` for Germany); the core hardcodes no country.

```
imprnt kopeika import lexoffice-datev <unzipped-dir> --account <name> --owner <o> [--who <person>]
imprnt kopeika categorize --who <person>
imprnt kopeika decide <txid> <category> --who <person> [--note <text>]
imprnt kopeika report --who <person> [--year YYYY]
imprnt kopeika status
imprnt kopeika list --who <person> [--queued]
```

A tax category is never guessed: pins (`decide`) outrank rules, rules fill empty dispositions only,
and anything unmatched on a dedicated books account queues until you decide it. Per-person identity,
rules, pins, and assets live under `profiles/<person>/` — see `profiles.example/`.

`report --html <path> --lang <en|ru>` writes the self-contained dashboard. The deep model (raw vs
clean, stock vs flow, the two axes, net worth, projection) is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Data files (all under `plugins/kopeika/data/`, local only)

| File | Format |
|------|--------|
| `data/raw/<source>/` | archived immutable original exports |
| `data/ledger.csv` | clean normalized ledger |
| `data/rules.csv` | `pattern,match_type,field,category,type` |
| `data/rates.csv` | `month,currency,rate_to_eur` |
| `data/tiers.csv` | `scope,value,tier` (tier `mandatory` = floor, else flex) |
| `data/savings.csv` | `scope,value,balance_eur` (`account` cost basis, `marker` pot, `anchor` manual) |
| `data/profile.json` | your personal layer (see Profile) |

## Profile

Every personal fact lives in `data/profile.json`, kept local (never on a remote). The code ships generic. Copy
`profile.example.json` and fill in: `owners` (allowed `--owner` labels), `ownNames` / `ownIbans` (for
internal-transfer detection), `netWorth` (`flatsRub`, `mortgageRub`, `bcsNominalCny`, `propertyApr`),
`accountLabels`, `merchantInfo`, and `footer`. Every field is optional. A missing profile runs in
generic mode. Nothing here is hardcoded in the source, so the package carries no personal data.

## Privacy

Your `data/` folder holds raw financial data: the bank exports, the clean ledger, and
`data/profile.json` with your names, IBANs, and net-worth marks. The one hard rule is that **it must
never reach a remote.**

There are two safe setups. In a private, remoteless store like the imprnt vault, `data/` is committed
as the canonical source of truth - that is the intended arrangement, and the data never leaves the
machine because the repo has no remote. Anywhere a remote exists, gitignore `data/` so it is never
committed. `check.js` enforces exactly this: it fails if `data/` is tracked in a repo that has a
remote, and passes otherwise. The published package itself ships no personal data (only the generic
code and `profile.example.json`). The rendered `deploy/` bundle is derived, so it stays local. The
hosted page carries no account numbers, IBANs, or balances, and sits behind a password.
