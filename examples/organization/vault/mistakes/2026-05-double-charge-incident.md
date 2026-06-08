---
type: mistake
updated: 2026-05-18
tags: [work, billing, meridian]
summary: April double-charge bug from missing idempotency. Hurt trust with Bramble and two accounts.
---

# Double-charge incident (April 2026)

A retry on charge creation, with no idempotency key, charged some customers twice. It hurt trust with
[[orgs/bramble-plumbing]] and two smaller accounts.

## Root cause
- Charge creation was not idempotent, so a retried request created a second charge.
- No metric or alert on duplicate charges, so it was found by customers, not by Meridian.

## Lessons
- Idempotency keys are mandatory on any money-moving endpoint.
- Every incident class needs a metric and a pager alert before it is closed.

## Fixed by
- [[projects/billing-v2]] (idempotency is P0) and [[work/oncall-policy]].
