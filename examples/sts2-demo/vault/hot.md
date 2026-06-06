---
type: hot
tags: ["hot"]
updated: 2026-06-02
---

# Hot — what's active right now

## Active project
[[projects/sts2-bigquery-migration]] — moving identity events off legacy STS2 onto BigQuery.

## Recent decisions
- Tech Foundations becomes the owning team + on-call for the Airflow load (Maya → EM this week).
- No blind cutover — gated on 2 weeks of parallel-run data.

## Waiting on
- Finance data team lead to repoint finance dashboards at the BigQuery views.

## Next
- Re-partition `identity_events` on `event_date` + cluster on `tenant_id` — **due Friday**.
  (See [[mistakes/2026-05-bq-partition-assumption]] first.)
