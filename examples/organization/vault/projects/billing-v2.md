---
type: project
updated: 2026-05-18
tags: [work, billing, meridian]
summary: Meridian's Q2 priority. Fix billing reliability before any new pricing, idempotency first.
source: "[[raw/transcripts/2026-05-18-eng-planning]]"
status: active
owner: "[[people/tom-decker]]"
---

# Billing v2

The quarter's priority for [[orgs/meridian]]. No new pricing ships until billing is solid. Triggered
by the April [[mistakes/2026-05-double-charge-incident]], which cost trust with
[[orgs/bramble-plumbing]] and two smaller accounts.

## Backlog (ranked 2026-05-18)

| Priority | Item | Owner | Why |
|----------|------|-------|-----|
| P0 | Idempotency keys on charge creation | [[people/tom-decker]] | Root cause of the double charge |
| P0 | Duplicate-charge metric + pager alert | [[people/tom-decker]] | April had no alert at all |
| P1 | Invoice redesign | [[people/lena-brandt]] | Customers cannot read the current invoice |
| P1 | Dunning emails | [[people/tom-decker]] | Failed-payment recovery |
| P2 | Usage-based metering | [[people/tom-decker]] | Needed for future pricing, not before |

## Target
- Idempotency fix within two weeks of 2026-05-18.

## Support signal
- 60% of billing tickets last month were "charged twice" or "cannot find my invoice". Both close once
  idempotency and the invoice land. Source: [[people/marcus-hale]].
