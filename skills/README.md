# imprint — skills (the agent entry points)

These are the **shareable entry points**. You never run the CLI by hand; you talk to an agent,
the agent runs a skill, the skill runs the CLI for the deterministic part and does the one LLM
semantic pass itself. The skill is the steering wheel; `scripts/` is the engine.

Three skills, all opt-in:
- **Ingest/** — turn a transcript/note into a structured, resolved, tagged vault note.
- **Recall/** — load scoped context by topic ("load my context on taxes").
- **Hot/** — prime a cold session: needs-review backlog + the current-context primer ("catch me up").

## Install (opt-in, never auto-wired)

imprint does **not** symlink itself into your agent's skill directory (that's the monolith
sin). You copy in only what you want:

```sh
cp -r skills/Ingest skills/Recall skills/Hot ~/.claude/skills/   # or your agent's skills dir
```

Each skill is a self-contained dir — `rm -rf` any you don't use. The skills assume the imprint
CLI is reachable (either `imprint` on PATH, or `bun <imprint-repo>/scripts/cli.ts`) and a vault
path (default `./vault`, override with `--vault`).
