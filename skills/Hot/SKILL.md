---
name: imprnt-hot
description: Prime a fresh session from the imprnt vault — surface the needs-review backlog (ingest soft-fails, unresolved entities) plus the ~500-token current-context primer. Explicit-on-request, never auto-injected. USE WHEN what's active, prime me, what needs review, catch me up, hot, session primer, what was I doing, imprnt hot.
---

# imprnt — Hot (session primer + needs-review)

The user wants to get oriented in a cold session ("catch me up", "what needs review"). This is the
ONE surface for the ingest soft-fail backlog — notes that resolved no entity or linked nothing get
flagged `needs-review` and would otherwise strand silently. Explicit-on-request only; nothing
auto-injects.

Run the already-built CLI command:

```sh
imprnt hot [--vault DIR]    # or: bun <imprnt-repo>/packages/imprnt/scripts/cli.ts hot [--vault DIR]
```

Present the **needs-review items first** (these are the backlog the user has to clear), then the
primer. Offer to help clear or resolve each flagged item (re-ingest, resolve the entity, or add the
missing link) — but only act when the user says so. No new machinery: this wraps `imprnt hot`, stays
explicit, and is `rm -rf`-able like Ingest/Recall.
