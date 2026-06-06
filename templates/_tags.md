---
type: tags
---

# Approved tags + synonym map

The fixed vocabulary. Ingest may only apply tags from `## Tags`. A new tag is a deliberate,
human-approved one-line addition here. The synonym map normalizes **both** a note's tag and a
query — so "AMT" and "taxes" resolve to the same thing, at write and at search.

Keep the map lean and avoid over-broad canonicals that collapse specific terms into one bucket:
core `recall` ranks with BM25, which boosts a tag hit and weights rarer tags above common ones by
inverse-document-frequency — but a canonical applied to most notes still has low idf and can't
discriminate, so over-broad collapsing defeats the ranker. One concept = one tag.

This ships seeded for both halves of the vault's job — DH/work AND Alex's life domains (the
contract requires the vault to hold ALL life domains). Recall on insurance/citizenship/health/
family/housing/Voronezh/Kita/music/finances hits a tag tier from day one, not body-only literal
matching. Re-seed/extend from your own domains before first ingest (Ingest workflow Step 0).

## Tags
etl, bigquery, identity, access, otp, cost, migration, security, airflow, dbt, dwh, oncall, ownership, taxes, compliance, vertex, fraud, insurance, citizenship, health, family, housing, voronezh, kita, music, finances

## Synonyms
pipeline, ingestion, data-pipeline -> etl
bq, big-query -> bigquery
iam, sso, iiq, identityiq, sailpoint -> identity
finanzamt, steueramt, amt, est, tax-office -> taxes
on-call, pager, pagerduty -> oncall
data-warehouse, warehouse -> dwh
bu, berufsunfaehigkeit, berufsunfähigkeit, disability, disability-insurance -> insurance
einbuergerung, einbürgerung, naturalization, passport, staatsangehoerigkeit -> citizenship
medical, doctor, psychiatrist, medication, mental-health -> health
anna, leo, partner, child, wife, son -> family
flat, apartment, wohnung, mietminderung, landlord, rent -> housing
voronezh-house, homestead, dacha -> voronezh
kindergarten, daycare, creche -> kita
band, oshibsya-nomerom, korsvian, song, recording -> music
money, salary, savings, budget, net-worth -> finances
