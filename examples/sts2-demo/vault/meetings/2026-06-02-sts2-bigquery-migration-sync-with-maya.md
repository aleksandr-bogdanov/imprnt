---
type: meeting
date: 2026-06-02
participants: ["[[people/maya-tanaka]]"]
tags: ["meeting", "sts2", "bigquery", "migration"]
workstream: "[[workstreams/sts2-bigquery-migration]]"
source: "examples/sts2-demo/raw/2026-06-02-sts2-1on1.txt"
source_hash: 3b47e0061d8e6051
status: enriched
ingested: 2026-06-02T13:45:37.966Z
---

# STS2 BigQuery migration — sync with Maya

> 14 turns · parsed deterministically, then semantically cleaned. `^[extracted]` = from the
> transcript verbatim; `^[inferred]` = added by the semantic pass.

## Summary
Schema is mirrored into BigQuery with 90 days backfilled and a daily delta load on Airflow.
The two live risks are **ownership** (currently only Alex; Maya will move it to Tech Foundations
on-call) and a **partitioning cost bug** (BigQuery defaulted to ingestion-time partitioning, not
`event_date`, causing a 40x scan-cost blowup — fix is an explicit re-partition + cluster, due
Friday). Cutover-vs-parallel-run is deferred until two weeks of parallel numbers exist. Finance
dashboards still read STS2 directly and must be repointed (depends on the finance data team).

## Decisions
- Tech Foundations becomes the owning team for the Airflow load and it goes into the on-call rotation. — _Maya_ ^[inferred] (transcript: "Agreed. Let's make Tech Foundations the owning team and put it in the on-call rotation.")
- Cutover timing will be decided from data after a 2-week parallel run — no blind cutover. — _Maya_ ^[inferred]

## Action items
- [ ] Rebuild `identity_events` with explicit `event_date` partitioning + `tenant_id` clustering — **due Friday**. — _Alex_ ^[extracted]
- [ ] Write the partitioning gotcha into a mistake note the team will see. — _Alex_ ^[extracted]
- [ ] Stand up a 2-week parallel-run validation dashboard; send Maya the link next week. — _Alex_ ^[extracted]
- [ ] Raise Tech Foundations ownership + on-call with the EM this week. — _Maya_ ^[extracted]
- [ ] Loop in the finance data team lead to repoint finance dashboards at the BigQuery views. — _Maya_ ^[extracted]

## Open questions
- Keep STS2 running in parallel for a full quarter, or cut over after 2 weeks of validation? — _Alex_ ^[extracted] → **gated on parallel-run data** (see decision above).

## Participants
- [[people/maya-tanaka]] — staff engineer / tech lead, drove ownership + cutover calls
- [[people/raj-patel]] — knows the DAG but is not an owner (payments squad)
- Alex (self) — owns the migration

## Source
Raw transcript: `examples/sts2-demo/raw/2026-06-02-sts2-1on1.txt` (sha256:3b47e0061d8e6051). Immutable — do not edit; re-ingest instead.
