# Example: a personal digital-assistant vault

One person's vault. Sam Rivera, a product designer in Lisbon, who keeps their knowledge by talking to
an AI assistant. The assistant files what Sam tells it and recalls it later. Sam never types commands.

## What it looks like

Sam drops in a weekly voice memo and asks the assistant to keep it:

```
Sam:    Here's my weekly check-in memo. [raw/transcripts/2026-05-12-weekly-checkin.txt]
Claude: Filed it. Updated health/sleep-stack with the new routine, finances/accounts-overview with
        the account split, logged the checkup under events/, and noted the late VAT filing as a
        mistake to fix.

(later)

Sam:    What's my current sleep routine?
Claude: Magnesium glycinate 300mg at 8pm, no caffeine after 1pm, screens off by 10:30. You moved
        magnesium earlier on May 12 and held five nights of 7h+ since. (health/sleep-stack)
```

## What the assistant filed

That one memo fanned out into notes, each carrying the real payload (the sleep stack and accounts as
tables, the books as a rated list) rather than a vague summary:

```
vault/people/sam-rivera.md          vault/health/sleep-stack.md
vault/people/jonas-rivera.md        vault/finances/accounts-overview.md
vault/people/dr-elena-costa.md      vault/life/books.md
vault/identity/mission.md           vault/holdings/magnesium-glycinate.md
vault/events/2026-05-12-annual-checkup-and-weekly-dump.md
vault/mistakes/2026-05-late-vat-filing.md
```

Under the hood, the recall the assistant ran ranks the vault locally and returns a tight set:

```
recall "sleep"
  [1.46] health/sleep-stack.md
  [1.26] holdings/magnesium-glycinate.md
  [1.14] identity/mission.md
  [1.01] people/sam-rivera.md
  [0.86] events/2026-05-12-annual-checkup-and-weekly-dump.md
```

The vault passes its own integrity check: every note is tagged, every domain and form note links an
entity, and the index is generated from the notes.
