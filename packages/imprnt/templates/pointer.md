# imprnt vault (the user's long-term memory)

This user keeps a persistent knowledge vault at {{VAULT_PROJECT}} holding people, orgs, projects,
decisions, finances, health, and history.

- When the user references their own world (a person, a past decision, a deadline, anything not
  in this workspace), search the vault before saying you don't know:
  `imprnt recall "<keywords>"`, then read the top hits.
- Before filing or editing ANYTHING in the vault, run `imprnt context` and follow what it prints.
  Never write a vault note without it.
- The vault is the only knowledge store. Durable facts go in a vault note, never the host's
  auto-memory (Claude Code's `MEMORY.md` / `memory/`), which `recall` cannot search.
- The vault is private data. Never copy its contents into committed files, code, or external
  services.
