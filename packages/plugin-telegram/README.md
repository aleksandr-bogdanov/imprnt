# imprnt-plugin-telegram

Your vault, reachable from your phone. A long-lived imp session runs in the lair with Claude
Code's Telegram channel enabled. You text your bot from anywhere, the session searches the vault
on your machine and texts the answer back. The vault never leaves the machine. Only the
conversation does.

Built on Claude Code **channels** (research preview, v2.1.80+, claude.ai or Console auth, needs
[Bun](https://bun.sh)). This plugin wraps the official `telegram@claude-plugins-official` channel
with the vault-side behavior rules and a start command.

## Install

```sh
imprnt plugin add telegram
```

That wires the behavior fragment (recall-first, phone-sized replies, never paste a whole note).
Then the one-time channel setup, in any Claude Code session:

1. Create a bot: open [BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, copy the
   token.
2. Install the official channel plugin:
   `/plugin install telegram@claude-plugins-official`
   (if it is not found, run `/plugin marketplace add anthropics/claude-plugins-official` first),
   then `/reload-plugins`.
3. Give it the token: `/telegram:configure <token>` (or export `TELEGRAM_BOT_TOKEN` in your shell
   instead, per the imprnt secrets rule - either way it never lands in the project).
4. Start the link (below), text the bot anything, and pair: `/telegram:access pair <code>`, then
   `/telegram:access policy allowlist` so only you can reach the session.

## Use

```sh
sh plugins/telegram/link.sh
```

This runs `imp lair --channels plugin:telegram@claude-plugins-official` under `caffeinate -i`
(macOS), so the Mac stays awake while the link is up. Stop with Ctrl-C. It is a command you run
when you leave the desk, never a daemon: nothing starts by being installed.

Then text the bot from your phone: "what do I know about the access-platform cutover?",
"remember: the dentist moved to the 24th". The session recalls, answers, files.

## Honest constraints

- The session answers only while it is running on an awake machine. A message sent while the
  link is down arrives when you next start it (Telegram holds undelivered bot updates for a
  while), and there is no way to cold-start a local session from the phone.
- Telegram bot chats are not end-to-end encrypted. The vault stays home, but your questions and
  the answers transit Telegram's servers. Keep the bot private and the allowlist on.
- A permission prompt pauses the session until approved. Run the lair with your usual allow
  rules so recall/read paths do not prompt, or approve from the terminal when you are back.
- Channels are a research preview: the `--channels` syntax may change, and only
  Anthropic-allowlisted channel plugins can register, which is why this plugin wraps the
  official one instead of shipping its own.

## Known issue: the official channel leaks 100%-CPU pollers

The official `telegram@claude-plugins-official` channel (v0.0.6) has a bug that this
plugin inherits, since only Anthropic-allowlisted channels can register and we wrap
that one. When two pollers share a bot token (a second session, or a previous server
that did not exit), one gets a 409 Conflict, its retry backoff collapses to 0ms, and
the `bun server.ts` process pins a CPU core. Wedged like that it cannot service
SIGTERM, so it survives its session as an orphan and a new one stacks up per session.
Symptom: loud fans and several `bun server.ts` processes at ~100% CPU. Upstream:
[issue #2229](https://github.com/anthropics/claude-plugins-official/issues/2229)
(open, no fixed release).

`fix-cpu-leak.mjs` re-applies the community fix (authoritative SIGTERM -> 3s ->
SIGKILL eviction, plus poll counters that reset only on a real inbound update so the
backoff cannot collapse). It is idempotent and version-agnostic, so run it after the
first install and after any channel-plugin update (a plugin update rewrites the cache
file and drops the patch):

```sh
node plugins/telegram/fix-cpu-leak.mjs          # patch every installed version in place
node plugins/telegram/fix-cpu-leak.mjs --reap   # also SIGKILL any orphaned pollers (ppid 1)
node plugins/telegram/fix-cpu-leak.mjs --check  # report only, change nothing
```

It only ever edits the official plugin's `server.ts` under
`~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/`, and refuses to
write a half-patched file if upstream changed the code (which may mean the fix shipped).
Reap orphans by hand between sessions with `pkill -9 -f "telegram/.*/server.ts"`.

## Remove

```sh
imprnt plugin rm telegram
```

Add `--purge` to delete `plugins/telegram/`. To remove the channel itself:
`/plugin uninstall telegram@claude-plugins-official`, and delete
`~/.claude/channels/telegram/.env` if you configured the token there.
