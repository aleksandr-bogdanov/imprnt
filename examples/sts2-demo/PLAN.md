# Implementation plan — STS2 partitioning fix (drafted from `recall`)

> This is the end of the loop. It was drafted by an agent **from the retrieved context only** —
> `knowful recall "STS2 BigQuery"` + `recall "partition cost"` surfaced the workstream note, the
> meeting note, and (ranked first) the mistake note. The agent read those four files and nothing
> else. No database, no embeddings — just grep over markdown.

## Context the agent pulled in (and why each mattered)
- [[mistakes/2026-05-bq-partition-assumption]] — **read first** (recall ranked it #1). The 40x
  cost came from assuming partitioning is inherited. This plan must not repeat it.
- [[workstreams/sts2-bigquery-migration]] — current state, owner, open risks.
- [[meetings/2026-06-02-sts2-bigquery-migration-sync-with-maya]] — the Friday deadline and the
  cluster-on-`tenant_id` decision.

## Plan
1. **Pre-flight (from the mistake note):** dry-run a byte estimate on the current
   `identity_events` to quantify the waste and get a before-number. Confirm queries filter on
   `event_date` and `tenant_id`.
2. **Recreate the table** partitioned on `event_date` (DAY), clustered on `tenant_id`:
   `CREATE TABLE ... PARTITION BY DATE(event_date) CLUSTER BY tenant_id AS SELECT ...`.
3. **Backfill** from STS2 (90 days, matching the existing mirror) into the new table.
4. **Verify the fix:** re-run the same dry-run byte estimate; confirm scan bytes dropped to the
   partition-pruned level (this is the success criterion, not "looks fine").
5. **Repoint the Airflow delta load** at the new table; keep STS2 in parallel.
6. **Hand-off readiness:** add the table + DAG to the Tech Foundations on-call runbook (the
   ownership decision) so it isn't bus-factor-1 on Alex.

## Explicitly NOT in this plan
- Cutover from STS2 — gated on 2 weeks of parallel-run data (Maya's decision). Out of scope here.
- Finance dashboard repointing — depends on the finance data team lead, not this fix.

## Deadline
Friday (from the 2026-06-02 1:1).
