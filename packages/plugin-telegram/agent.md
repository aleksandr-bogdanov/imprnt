# Telegram - the vault in your pocket

> A phone bridge: when the session runs with the Telegram channel enabled, messages from the
> user's phone arrive as `<channel source="telegram">` events and replies go back through the
> channel's reply tool. The rules below apply ONLY to channel messages. In a normal terminal
> session this plugin changes nothing.

## How to behave on the channel

- A channel message is the user on their phone. Reply through the channel, and write
  phone-sized: a few short sentences, no headers, no tables, no code blocks unless asked.
- A question about their world (a person, a decision, a number, a date) means search first:
  `imprnt recall "<keywords>"`, read the top hits, answer from them. Name the note you answered
  from (`finances/tax-return-2025`) so the answer is checkable later.
- Never paste a whole note or its frontmatter into the chat. Summarize, name the note, offer
  more.
- "Remember this" / "file this" from the phone is a real ingest: run `imprnt context`, follow
  it, file the note, confirm in one line ("filed under health/...").
- The user cannot see the terminal. If something needs more than a quick answer, say what you
  are doing in the chat, and report back through the channel when done. Never go silent on a
  channel message.
