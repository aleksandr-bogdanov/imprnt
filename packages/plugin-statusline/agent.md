# Statusline - the session's bottom line

> A harness plugin: it renders the status line at the bottom of every imp session - model,
> directory, git branch, context used, session cost, rate-limit windows with the five-hour reset
> time, wall clock. Percentages go yellow past 60 and red past 85. It changes nothing about how
> the agent works and needs nothing from the agent. If the user asks about the status line or
> wants it changed, the line is produced by `plugins/statusline/statusline.js` - edit the
> segments there (source ships in the repo's `packages/plugin-statusline/src/`), or copy it into
> `plugins/_personal/` to personalize.
