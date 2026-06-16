---
title: Telegram
description: Reach your vault from your phone. Text a bot, the answer comes from your notes.
---

> **In one line.** Run a session in the lair with a Telegram bot wired in, and you can text your vault a question from anywhere and get the answer back, while your notes never leave your machine.

## What it's for

Your vault sits on your home machine. This plugin lets you reach it from your phone. You text the bot a question ("what do I know about the access-platform cutover?") or a fact to file ("remember: the dentist moved to the 24th"), and a session running at home searches the vault and texts the answer back. The vault stays home. Only the conversation transits Telegram.

## How it works

This is a bridge plugin built on Claude Code channels (a research preview). A long-lived imp session runs in the lair with the channel enabled. Messages from your phone arrive as channel events and replies go back through the channel. The plugin wraps the official Telegram channel with the vault-side behavior rules: recall first, answer in phone-sized replies, never paste a whole note.

## Commands

```sh
# start the link: runs the lair with the channel, keeps the Mac awake while up
sh plugins/telegram/link.sh
```

This runs the session under `caffeinate` so the machine stays awake. Stop with Ctrl-C. It is a command you run when you leave the desk, never a daemon.

## Install

```sh
imprnt plugin add telegram
```

That wires the behavior fragment. Then the one-time channel setup, in any Claude Code session: create a bot with [BotFather](https://t.me/BotFather), install the official channel plugin, give it the token, and pair your phone with `/telegram:access`. Set the access policy to allowlist so only you can reach the session. Remove with `imprnt plugin rm telegram`.

## Honest constraints

- The session answers only while it is running on an awake machine. A message sent while the link is down arrives when you next start it. There is no way to cold-start a local session from the phone.
- Telegram bot chats are not end-to-end encrypted. Your questions and the answers transit Telegram's servers, so keep the bot private and the allowlist on.
- The official channel (v0.0.6) has a bug that pins a CPU core when two pollers share a token. The plugin ships `fix-cpu-leak.mjs` to re-apply the community fix. Run it after install and after any channel-plugin update.
