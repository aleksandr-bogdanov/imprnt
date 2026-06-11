# imprnt-plugin-statusline

A customizable status line for your imp sessions:

```
Fable 5 · imprint-vault · main · ▰▰▰▰▱▱▱▱ 48% · $0.42 · 1h12m · +156/-23 · 5h 24% →18:00 · 7d 41% · 14:05
```

Model, directory, git branch, a context bar, session cost and duration, lines added/removed, both
rate-limit windows (with the five-hour reset time), wall clock. Percentages and the bar go yellow
past 60 and red past 85, a 30-second refresh keeps the clock and the limits honest, and on a
narrow terminal segments drop in a fixed order (housekeeping first, model and context last)
instead of wrapping. Made to be edited - the shipped line is a starting point.

## Install

```sh
imprnt plugin add statusline
```

This copies the plugin into your project's `plugins/statusline/` and wires it. The plugin's
`imp-settings.json` carries the `statusLine` setting, and `imp` forwards it to every session it
launches via `--settings`. Nothing is ever written into your Claude settings files, and plain
`claude` stays untouched.

Not using `imp`? Point the `statusLine` key in your own `settings.json` at
`node plugins/statusline/statusline.js`.

## Customize

The line is whatever `statusline.js` prints. Claude Code pipes session JSON on stdin (model, git
branch, context window, cost, rate limits, and more - the full field list is at
https://code.claude.com/docs/en/statusline), and the script picks its segments. Edit
`src/statusline.ts` in the repo and rebuild, or edit the shipped `statusline.js` in place. To keep
the shipped default pristine, copy the plugin into `plugins/_personal/` and wire your copy instead.

## Remove

```sh
imprnt plugin rm statusline
```

Add `--purge` to also delete `plugins/statusline/`. The setting rides each launch, so removal is
complete - there is no settings entry to clean up.
