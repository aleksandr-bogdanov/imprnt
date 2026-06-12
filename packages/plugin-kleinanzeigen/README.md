# imprnt-plugin-kleinanzeigen

A watcher for your Kleinanzeigen message box. It mirrors incoming buyer messages, sorts each one with
deterministic code (regex + arithmetic, **zero LLM**), drafts replies from per-listing fact sheets, and
sends you a phone-sized digest. You tweak a draft and run `send`. It never sends on its own.

It's the first **watcher-class** plugin: code reads the hostile inbox, the model only ever drafts the
handful of messages the rules can't place, and the send button stays human. An inbox full of scammers
and lowballers is exactly where you do NOT want a resident agent with account access — a regex can't be
social-engineered. (See `Plans/05-kleinanzeigen-watcher.md` in the repo for the full design.)

## What it does, on one real day

Sixteen buyer messages on two router listings, one afternoon:

```
Kleinanzeigen — 3432924231: 14 new · 3432924164: 1 new
⚠ David Thiess [scam: paypal, name-mismatch, instant-full-price] — no draft, do not reply
Frank Pürschel [offer 70€ (below floor)] — your call
Erik [faq] — needs you: confirm artikelnummer
Nima [faq] — needs you: confirm artikelnummer, cable
Pavel [faq] — needs you: confirm age
Karla [pickup] draft: "Hi, Abholung ist möglich in Berlin. Wann würde es dir passen? ..."
Chitwan [interest] draft: "Hi, ja, FRITZ!Box 6660 Cable ist noch verfügbar. ..."
...
```

The scammer is caught by three named tells, no model involved. The five "what's the Artikelnummer?"
questions surface what you need to confirm once (then they self-answer forever). The pickups and
interest get ready-to-send drafts. You spent zero tokens to get here.

## Commands

| Command | What it does |
|---|---|
| `node kleinanzeigen.js sync` | Refresh the mirror from the message box. **The only command that touches the network.** Offline with `KLEINANZEIGEN_FIXTURES=<dir>`. |
| `node kleinanzeigen.js rate` | Classify each conversation. Pure regex, zero LLM. |
| `node kleinanzeigen.js notify` | Compose the digest, ship it via `$WATCHER_NOTIFY_CMD` (stdout if unset). |
| `node kleinanzeigen.js send <conv> "<text>" [--force]` | Post ONE reply. Refuses a scam-rated conversation without `--force`. |
| `node kleinanzeigen.js probe` | (run once, logged in) discover live endpoints → `endpoints.json`. |
| `node check.js` | Integrity: mirror staleness, missing fact sheets. Found by `imprnt check --all`. |

## Environment variables

- `KLEINANZEIGEN_COOKIES` — path to your session cookie jar. Needed by `probe` and live `sync`. Fails
  loud and names itself when a wire call needs it and it's missing. Never stored in the repo or vault.
- `KLEINANZEIGEN_FIXTURES` — a directory of conversation JSON. When set, `sync` reads from there instead
  of the network, so the whole pipeline runs offline. The shipped `fixtures/` is a real captured inbox.
- `WATCHER_NOTIFY_CMD` — the channel for `notify`. The digest is piped to this command's stdin. Examples:
  `curl -s -d @- "https://api.telegram.org/bot$TOKEN/sendMessage?chat_id=$CHAT&text="` (Telegram bot),
  `ntfy publish mytopic`, or `terminal-notifier`. Unset → the digest prints to stdout.

## Fact sheets

Each listing gets a `listings/<id>.yaml` with the answers buyers ask. A FAQ is answered from these
WITHOUT the model. An empty field is honest "not confirmed yet" — the rater turns it into a `needs_fact`
in the digest rather than guessing. Fill it once; every future FAQ on that field answers itself.

```yaml
listing: 3432924231
model: FRITZ!Box 6660 Cable
artikelnummer:            # empty -> "needs you: confirm artikelnummer" until you fill it
price: 90
floor: 75                 # an offer below this is flagged, never auto-accepted
pickup_area: Berlin
```

## Wiring the live transport (the `probe` step)

Kleinanzeigen has no public API, so the real endpoints can only be captured from a logged-in session.
Until you do that, the plugin runs fully offline against fixtures. To wire it live:

```sh
export KLEINANZEIGEN_COOKIES=~/.config/kleinanzeigen/cookies.json
node kleinanzeigen.js probe        # prints what to capture from the web message box
```

Open the message box in a browser with devtools → Network, note the conversation-list,
conversation-detail, and send-reply requests, and write them into `endpoints.json`. Until that file
exists, `sync` and `send` fail loud and point you here — they never silently pretend to work.

## Scheduling (you opt in; nothing is a daemon)

A launchd agent that syncs, rates, and notifies every 15 minutes (macOS). The send step is never
scheduled — it's yours.

```xml
<!-- ~/Library/LaunchAgents/com.imprnt.kleinanzeigen.plist -->
<dict>
  <key>Label</key><string>com.imprnt.kleinanzeigen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>cd /path/to/vault/plugins/kleinanzeigen && node kleinanzeigen.js sync && node kleinanzeigen.js rate && node kleinanzeigen.js notify</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KLEINANZEIGEN_COOKIES</key><string>/Users/you/.config/kleinanzeigen/cookies.json</string>
    <key>WATCHER_NOTIFY_CMD</key><string>curl -s -d @- "https://api.telegram.org/bot.../sendMessage?..."</string>
  </dict>
</dict>
```

`launchctl unload ~/Library/LaunchAgents/com.imprnt.kleinanzeigen.plist` is the off switch. The watcher
only runs when launchd fires it; nothing is resident.

## Install

```sh
imprnt plugin add kleinanzeigen
```

Copies the plugin into `plugins/kleinanzeigen/` and wires `@plugins/kleinanzeigen/agent.md` into
`CLAUDE.local.md`. Add per-listing fact sheets under `listings/`, then schedule (or run) the commands.

## Remove

```sh
imprnt plugin rm kleinanzeigen           # unwire
imprnt plugin rm kleinanzeigen --purge   # unwire + delete plugins/kleinanzeigen/
```

Plus remove the launchd plist if you added one. Removal leaves no trace in the vault.

## Building (contributors)

```sh
bun install
bun run build      # src/*.ts -> kleinanzeigen.js + check.js (node banner)
bun test           # 37 tests, incl. the real-inbox pipeline
bunx tsc --noEmit  # typecheck
```

Zero runtime dependencies. The fact-sheet parser, the rater, and the mirror reader are all hand-rolled
to keep it dependency-free. License MIT.
