# Examples

Two worked vaults, each a real folder you can open in an editor. Both show the same flow: you talk to
an AI assistant, it files what you tell it and recalls what you ask for, all as plain files you own.
Both pass `imprnt check` clean.

- [`digital-assistant/`](digital-assistant/) is a personal vault for one person (Sam Rivera): identity,
  health, finances, people, and the daily life of someone who keeps notes by talking to an assistant.
- [`organization/`](organization/) is a small software company's vault (Meridian): employees, a
  customer, a project with a ranked backlog, a decision, and a postmortem.

Each folder's own README shows the conversation. If you want to poke at the engine the assistant drives,
point it at either vault:

```sh
cd examples/organization
IMPRNT_VAULT="$PWD/vault" imprnt recall "duplicate charge billing"
```
