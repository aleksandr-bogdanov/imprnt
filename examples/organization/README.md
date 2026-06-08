# Example: a small organization's vault

A company's working knowledge. Meridian is a small SaaS company that makes scheduling and billing
software for field-service businesses. The team keeps its knowledge by talking to an AI assistant that
files decisions and recalls them later.

## What it looks like

Someone drops in the notes from a planning meeting and asks the assistant to keep them:

```
You:    Here are the notes from today's engineering planning. [raw/transcripts/2026-05-18-eng-planning.txt]
Claude: Filed it. billing-v2 is now the Q2 project with a ranked backlog, the on-call policy is
        recorded, the meeting is logged, and I linked the April double-charge postmortem that drove
        the decision.

(later)

You:    Why are we doing billing-v2 before new pricing?
Claude: The April double-charge bug (missing idempotency) hurt trust with Bramble Plumbing and two
        accounts, and 60% of billing tickets are "charged twice" or "cannot find my invoice".
        Idempotency is P0, target two weeks. New pricing waits until billing is solid.
```

## What the assistant filed

The meeting fanned out into a connected graph. People and the org are entities with one home each,
linked from the project, the meeting, and the postmortem. The project carries its backlog as a real
table, not a summary:

```
vault/orgs/meridian.md              vault/projects/billing-v2.md      (ranked backlog table)
vault/orgs/bramble-plumbing.md      vault/work/oncall-policy.md
vault/people/priya-nair.md          vault/events/2026-05-18-eng-planning.md
vault/people/tom-decker.md          vault/mistakes/2026-05-double-charge-incident.md
vault/people/lena-brandt.md
vault/people/marcus-hale.md
```

Under the hood, the recall the assistant ran ranks the postmortem first, the project that fixes it
second, the affected customer third:

```
recall "duplicate charge billing"
  [3.19] mistakes/2026-05-double-charge-incident.md
  [2.63] projects/billing-v2.md
  [1.40] orgs/bramble-plumbing.md
  [0.92] events/2026-05-18-eng-planning.md
```

Fix one fact (say Tom changes role) and every note that links him updates at once, because notes link
to the permanent file ID, never the display name.
