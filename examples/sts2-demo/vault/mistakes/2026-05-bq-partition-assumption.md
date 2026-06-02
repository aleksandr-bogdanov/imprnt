---
type: mistake
tags: ["bigquery", "partitioning", "cost", "sts2"]
workstream: "[[workstreams/sts2-bigquery-migration]]"
---

# BigQuery didn't inherit STS2's partitioning

The highest-value note type — `recall` the `mistakes/` folder before related work so you
don't pay for the same lesson twice.

- **believed (2026-05):** BigQuery would partition `identity_events` by `event_date`
  automatically, the way STS2 did.
- **found-false (2026-05):** It defaulted to **ingestion-time** partitioning. Queries filter on
  `event_date`, so every query scanned the **whole table** — ~**40x** the expected cost for two
  days before it was caught.
- **true-now (2026-06-02):** Partitioning is never inherited across warehouses. On any new
  BigQuery table, set explicit partitioning on the column your queries filter (`event_date`)
  and cluster on the high-cardinality filter (`tenant_id`). Verify with a dry-run byte estimate
  before backfilling.

## Trigger for recall
Before creating *any* BigQuery table in this migration, re-read this. ^[inferred]

## Related
- [[workstreams/sts2-bigquery-migration]] · [[meetings/2026-06-02-sts2-bigquery-migration-sync-with-maya]]
