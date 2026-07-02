# imprnt-plugin-statusline

A customizable status line for your imp sessions:

```
model  Fable 5 · session taxes-deep-dive · dir imprint-vault · git main ↑2 ⊡1
cost   $0.42 · elapsed 1h12m · lines +156/-23
ctx    ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  48% · effort high
limits 5h  24% →18:00 · 7d  41% →Thu · vault 247 notes, 3 review · ☀ 22° · 14:05
```

Four rows that align into a table (the leading labels share one gutter): identity, spend, engine,
world. Labels are muted slate, values are bright ink, and color is a single alarm ramp - every
percentage and the gauge go amber past 60 and red past 85, so a calm session is nearly monochrome
and any color is news. The gauge is a meter face: its amber and red bands stay faintly visible
even when empty. Numbers pad to fixed width so nothing jitters between refreshes, `thinking`
renders only when off, and reset times are a clock today or a weekday otherwise. Truecolor (Tokyo
Night ink) when the terminal advertises it, base ANSI otherwise, bare text under NO_COLOR. Percentages and the bar
go yellow past 60 and red past 85, a 30-second refresh keeps the clock, weather, and limits
honest, and on a narrow terminal each row drops segments in a fixed order (housekeeping first,
load-bearing last) instead of wrapping. Made to be edited - the shipped panel is a starting
point.

## Weather and the network

The weather segment is the only part of the panel that touches the network. When its cache is
older than 15 minutes, a detached curl geolocates the machine by public IP (https://ipwho.is) and
asks https://open-meteo.com for the current weather, both over HTTPS, no keys, cached in your tmp
dir. No vault or session data is sent - the services see your public IP, as any HTTP request
does, and the panel itself only ever reads the cache, never the network. Set
`IMPRNT_STATUSLINE_NO_NET=1` to keep the script fully offline (the segment just disappears), or
delete the segment from the script.

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
