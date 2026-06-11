# Statusline - the session's bottom line

> A harness plugin: it renders the two-row panel at the bottom of every imp session. Row one is
> the work (model, session name, directory, git branch with ahead/behind and stash, cost,
> duration, lines changed). Row two is the meters (banded context gauge, rate-limit windows with
> reset times, vault note + needs-review counts, cached weather, clock). Colored by threshold,
> and each row drops segments by priority on a narrow terminal. It changes nothing about how
> the agent works and needs nothing from the agent. If the user asks about the status line or
> wants it changed, the line is produced by `plugins/statusline/statusline.js` - edit the
> segments there (source ships in the repo's `packages/plugin-statusline/src/`), or copy it into
> `plugins/_personal/` to personalize.
