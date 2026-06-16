---
title: Statusline
description: "A status panel at the bottom of every imp session: model, branch, context, cost, rate limits, clock."
---

> **In one line.** A four-row panel at the bottom of your imp session that shows the model, git state, context fill, cost, rate-limit windows, and the time.

## What it's for

A long session loses track of where it stands. The status line keeps the numbers in front of you: which model is running, how full the context window is, what you have spent, how close you are to a rate limit, and the clock.

## How it works

This is a harness plugin. It renders four aligned rows:

```
model  Fable 5 · session taxes-deep-dive · dir imprint-vault · git main ↑2 ⊡1
cost   $0.42 · elapsed 1h12m · lines +156/-23
ctx    ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  48% · effort high
limits 5h  24% →18:00 · 7d  41% →Thu · vault 247 notes, 3 review · ☀ 22° · 14:05
```

Color is a single alarm ramp: every percentage and the gauge go amber past 60 and red past 85, so a calm session is nearly monochrome and any color is news. On a narrow terminal each row drops segments in a fixed order rather than wrapping. There is no user command. Claude Code pipes session data to the script and the script prints the line.

The shipped panel is a starting point. The line is whatever `plugins/statusline/statusline.js` prints, so you can edit the segments. To keep the default pristine, copy the plugin into `plugins/_personal/` and wire your copy instead.

## Install

```sh
imprnt plugin add statusline
```

This copies the plugin into `plugins/statusline/` and wires it. `imp` forwards the `statusLine` setting to every session it launches, so nothing is written into your Claude settings and plain `claude` stays untouched. Remove with `imprnt plugin rm statusline` (add `--purge` to delete the folder too).
