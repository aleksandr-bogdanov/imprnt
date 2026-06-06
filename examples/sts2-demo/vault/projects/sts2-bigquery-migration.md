---
type: project
tags: ["sts2", "bigquery", "migration", "identity"]
status: in-progress
owner: "[[people/maya-tanaka]] (team: Tech Foundations) — exec by Alex"
updated: 2026-06-02
---

# STS2 → BigQuery migration

Migrate the identity-events warehouse off legacy **STS2** onto **BigQuery** as the new source
of truth.

## State (2026-06-02)
- Schema mirrored into BigQuery. 90-day backfill complete. {extracted}
- Daily delta load running on **Airflow**. {extracted}
- STS2 still the source of truth; running in parallel during validation. {extracted}

## Open risks
- **Ownership** → resolving: Tech Foundations becomes owner + on-call (Maya raising with EM).
  Raj Patel knows the DAG but isn't an owner. {extracted}
- **Partitioning cost bug** → BigQuery used ingestion-time partitioning, not `event_date`;
  queries filtering on `event_date` scanned the whole table = **40x cost** for 2 days. Fix:
  re-partition on `event_date` + cluster on `tenant_id`, **due Friday**. See
  [[mistakes/2026-05-bq-partition-assumption]]. {extracted}
- **Finance dashboards** read STS2 directly → must repoint at BigQuery views (depends on the
  finance data team lead). {extracted}

## Open decisions
- Cutover vs. parallel-run: **gated on 2 weeks of parallel-run data** — no blind cutover. {extracted}

## Links
- [[events/2026-06-02-sts2-bigquery-migration-sync-with-maya]]
- [[people/maya-tanaka]] · [[people/raj-patel]]
