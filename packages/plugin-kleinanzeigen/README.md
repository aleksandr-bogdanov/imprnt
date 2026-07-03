# imprnt-plugin-kleinanzeigen

A watcher for your Kleinanzeigen message box. It mirrors incoming buyer messages, sorts each one with
deterministic code (regex + arithmetic, **zero LLM**), drafts replies from per-listing fact sheets, and
sends you a phone-sized digest. You tweak a draft and run `send`. It never sends on its own.

It's the first **watcher-class** plugin: code reads the hostile inbox, the model only ever drafts the
handful of messages the rules can't place, and the send button stays human. An inbox full of scammers
and lowballers is exactly where you do NOT want a resident agent with account access — a regex can't be
social-engineered. (See `Plans/05-kleinanzeigen-watcher.md` in the repo for the full design.)

## What it does, on one real day

Fifteen buyer messages on two router listings, one afternoon (replayed here with the synthetic
fixture personas — invented names, addresses, listing ids):

```
Kleinanzeigen — 9000000001: 14 new · 9000000002: 1 new
⚠ Timo Falkner [scam: paypal, name-mismatch, instant-full-price] — no draft, do not reply
Frank Bergmann [offer 70€ (below floor)] — your call
Erik [faq] — needs you: confirm artikelnummer
Nima [faq] — needs you: confirm artikelnummer, cable
Pavel [faq] — needs you: confirm age
Karla [pickup] draft: "Hi, Abholung ist möglich in Musterstadt. Wann würde es dir passen? ..."
Chitwan [interest] draft: "Hi, ja, Acme BT-200 Bluetooth-Lautsprecher ist noch verfügbar. ..."
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

## Authentication (live, automatic)

The message-box gateway authenticates with `Authorization: Bearer <access_token>`, a JWT the web app
holds. Rather than make you export cookies on a short-lived token, `sync` reads it straight from your
logged-in browser on this Mac — Arc by default, then Chrome / Brave / Edge. It copies the cookie DB
(including the `-wal` file so a just-refreshed token isn't missed), decrypts with the key from your
macOS Keychain (you approve a Keychain prompt the first time), and pulls the `access_token`. Local,
on-demand, your own session — nothing leaves the machine. Stay logged into kleinanzeigen.de in the
browser and `sync` just works.

Overrides, for non-Arc / headless / CI:
- `KLEINANZEIGEN_TOKEN=<jwt>` — use this Bearer token directly (skip the browser read).
- `KLEINANZEIGEN_COOKIES=<file>` — a file holding `access_token=<jwt>` (or a raw JWT).

Caveat: a `launchd`/cron run has no GUI to approve the Keychain prompt. Grant "Always Allow" once
(or use `KLEINANZEIGEN_TOKEN`) for scheduled syncs. The token is short-lived, so scheduled use leans
on the browser staying logged in and the Keychain grant persisting.

## Environment variables

- `KLEINANZEIGEN_FIXTURES` — a directory of conversation JSON. When set, `sync` reads from there instead
  of the network, so the whole pipeline runs offline. The shipped `fixtures/` is a fully synthetic
  sample inbox (invented names, addresses, listing ids).
- `KLEINANZEIGEN_TOKEN` / `KLEINANZEIGEN_COOKIES` — the auth overrides above.
- `WATCHER_NOTIFY_CMD` — the channel for `notify`. The digest is piped to this command's stdin. Examples:
  `curl -s -d @- "https://api.telegram.org/bot$TOKEN/sendMessage?chat_id=$CHAT&text="` (Telegram bot),
  `ntfy publish mytopic`, or `terminal-notifier`. Unset → the digest prints to stdout.

## Fact sheets

Each listing gets a `listings/<id>.yaml` with the answers buyers ask (start from the shipped
`listings/example.yaml`). A FAQ is answered from these WITHOUT the model. An empty field is honest
"not confirmed yet" — the rater turns it into a `needs_fact` in the digest rather than guessing.
Fill it once; every future FAQ on that field answers itself.

```yaml
listing: 1234567890
model: Acme BT-200 Bluetooth-Lautsprecher
artikelnummer:            # empty -> "needs you: confirm artikelnummer" until you fill it
price: 95
floor: 80                 # an offer below this is flagged, never auto-accepted
pickup_area: Musterstadt
```

Real fact sheets carry your live listing ids and your private price floors — keep them out of git
(only `example.yaml` is tracked or shipped).

## Wiring the live transport (the `probe` step)

Kleinanzeigen has no public API, so the endpoint shapes come from a logged-in capture, once:

```sh
# 1. Log into kleinanzeigen.de, open Messages, devtools → Network → "Save all as HAR with content".
# 2. Point probe at it — it extracts the gateway base + your userId and writes endpoints.json:
node kleinanzeigen.js probe --har ~/Downloads/www.kleinanzeigen.de.har
# 3. Done. Live sync reads the auth token from your browser session (see Authentication):
node kleinanzeigen.js sync
```

`endpoints.json` holds your numeric userId — never commit it. The repo's dev tree gitignores it, but
an npm-installed copy ships no `.gitignore` (npm strips those from tarballs): if you ever git-init
the vault, add ignore rules for `endpoints.json`, `mirror/`, and `listings/` yourself. The **read
path is fully wired**
(list + per-conversation detail for full bodies). **Send** needs one more capture: `replyPath` in
`endpoints.json` is null until you capture the POST that fires when you send a message (devtools →
Network), because guessing a POST shape risks mis-sending. Until then `send` refuses live and you can
use `KLEINANZEIGEN_DRY_RUN=1` to rehearse. Sync/send fail loud with guidance, never a silent no-op.

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
    <key>WATCHER_NOTIFY_CMD</key><string>curl -s -d @- "https://api.telegram.org/bot.../sendMessage?..."</string>
    <!-- For headless runs where the Keychain can't prompt, set KLEINANZEIGEN_TOKEN to a current JWT. -->
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
bun test           # incl. the end-to-end fixture-inbox pipeline
bunx tsc --noEmit  # typecheck
```

Zero runtime dependencies. The fact-sheet parser, the rater, and the mirror reader are all hand-rolled
to keep it dependency-free. License MIT.
