# profiles/ — the consolidated PII zone (examples)

Copy this folder's contents into `profiles/` in your installed plugin and fill in real values. `profiles/` is where EVERY personal fact lives: the household profile (own names, IBANs, net-worth marks — formerly `data/profile.json`) and one folder per person whose taxes the ledger keeps.

`profiles/` is gitignored the moment a remote exists (`check.js` enforces). Committing it inside a remoteless private vault is the intended setup. Nothing in it ever ships.

Layout:

```
profiles/
  household.json          the household profile (see ../profile.example.json for the shape)
  <person>/
    profile.json          identity: name, country pack, Steuernummer, the accounts feeding the books
    rules.json            ratified merchant rules for the tax axis
    pins.json             per-transaction decisions — written by `kopeika decide`, outrank rules
    assets.json           Anlagenverzeichnis: gross, business share, useful life in months
    thresholds.json       statutory lines the year must land against (basis, window, limit)
    forward.json          the forward book: expected income, planned purchases, off-book yearly adjustments
```

Account modes in `profile.json`:

- `dedicated` — every row of that account belongs on this person's books. A row no rule or pin or import mapping disposes QUEUES for an explicit `decide`. Use for book exports (lexoffice-datev) and single-purpose business accounts.
- `mixed` — a shared bank account. Only rules and pins pull rows onto the books; everything else stays household.
