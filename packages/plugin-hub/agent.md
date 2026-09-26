# hub - the household chat hub, version 3

> The fragment an operator session loads to know what the hub is, where its data lives and which commands to run. Wire it in with one `@plugins/hub/agent.md` line in `CLAUDE.local.md`. Delete the line to turn it off.

## What it is

People talk to their agents on Discord or Telegram, and no message is ever lost or silently ignored. One Postgres on the machine that runs the hub is the record and the queue. The operating system's service manager runs every process (systemd user units on Linux, launchd agents on macOS). An agent produces text, the machinery delivers it. A notification wakes a runner, and nothing polls on a timer.

The registry is the whole configuration: a hand-edited TOML file that lists every machine, person, credential, preset, agent and process. Nothing runs because it is on disk. It runs because it is on that list, and the hub notices an edit on its own tick with no restart.

## Where things live

- The registry: the path every unit is started with. On the owner's Pi it is `/srv/imprnt-hub/registry.toml`. The example with every key explained is `packages/plugin-hub/src/registry/registry.example.toml`.
- The store: the Postgres database `hub.store_url` names. Every role's password sits in `hub.secrets_dir` (`<hub.state_dir>/secrets` when unset), written by the database install, readable by the hub's account and by no agent's box.
- Chat logs: `<hub.state_dir>/<person>/chatlog/<agent>/<date>.jsonl`, one line per message in both directions, written by the door before anything is sent.
- Each person's tree: `[[people]].tree`, with the vault under `[[people]].vault`. An agent's box reaches its own person's tree and nothing else.
- Another machine's paths: a `[[machines]]` entry carries its own `state_dir`, `secrets_dir`, `store_url` (the hub machine's tailnet address) and `imprnt`; a person's tree, vault and instruction files there sit under `[[people]].on.<machine>`, a credential's file under `[[credentials]].on.<machine>`, and a repository's checkout under `[[repositories]].on.<machine>`. On a Mac the model login is a file made for the runner once with `claude auth login` pointed at that file's directory, never the owner's keychain item and never a copy of one. Every process reads the file for its own machine. `hub.store_machine` names the machine whose copy is the one: every hub writes the digest of its copy to the `registry` sheet, a spoke whose copy differs or whose authority has not written claims nothing (`check` says `registry-stale` or `registry-unseen`). An attachment's bytes go into the store's `media` table with the door's receipt, and a spoke's runner writes them into its own inbox before it feeds the row. The procedure for a runner on the owner's Mac is in `docs/operations.md`.
- Service logs: `journalctl --user --unit imprnt-hub-<entry>.service --no-pager` on Linux, `<hub.state_dir>/service-log/<entry>.{out,err}.log` on macOS.
- The spec and the operations notes: `packages/plugin-hub/docs/SPEC.md` and `packages/plugin-hub/docs/operations.md`.

## Commands

Every command takes the registry file. `imprnt hub` reaches them through the core's module dispatch. A core older than that dispatch prints its own help instead, and then the same verbs run as `node plugins/hub/hub.mjs <verb> <registry> [target]`.

- `check <registry> [machine]`: every finding for that machine, one line each with the fix as text. Exit 1 when there is one. Run it after any registry edit or when a chat is silent.
- `status <registry> [machine]`: wanted versus observed for every process the registry lists.
- `metrics <registry>`: the stamp metrics off the shared store.
- `install <registry> database | services <hub-entry> | entry <entry> | zone | --dry`: the database and its roles, then the units. Rerun `services` after an upgrade so the units carry what the new build expects.
- `recover <registry> agent:<id> | door:<id>`: replace one agent's session and release its claims, or restart a door so it reads its current token file.
- `relayout <registry>`: rewrite a registry written as one inline array per table into the header-per-entry layout the editor works on. Refuses a file that carries comments.

In a chat, an authorised sender can type `/recover <agent>`, `/dispatch <agent> <task>` and `/agent adopt|retire ...`. The board, reachable on the tailnet only, shows the same state and may edit the registry.

The board has six pages, all built for a phone first: machines, people, chats, usage, findings and metrics. A card on the people page carries a sentence rather than a word: the finding's own words when `check` holds one about the agent or its door, how many messages it is answering when a turn is open, and `idle` otherwise. The chats page reads the door's chat log files on the board's own machine and no store row: every agent with its newest line, and one agent's chat newest day first and newest line first, two hundred lines a page with the older days a plain link away, text rendered as text with bold, code, fenced blocks and bare links kept. The usage page reads the turn records: per agent, turns, tokens and price today and over the last seven UTC days, plus every credential's newest plan window reading in the sheet's own words, and a nothing is printed as `-`, never as a zero.

A `[[run]]` entry of `kind = "watch"` is a program with no hands: on its schedule (`daily at 07:00` is a clock time on its machine, rendered as a calendar event on both service managers) it fetches one source with an `api-key` credential, compares with the `watch:<entry>` state sheet from the sweep before, and writes one notice into one person's chat through that person's agent's door. The one source is `source = "sentry"`: new issues at or over `notify_events`, issues whose event count moved a power of ten, and issues still open `reminder_days` after the watch first saw them, one line each, capped at thirty lines. A morning with nothing to say posts nothing and still writes its success stamp, so `job-stale` fires only when the sweep stops landing. A refused key or a bad answer exits 1 with `watch-failed: <entry>: <cause>` and leaves the sheet as it was. No model reads what it fetched.

## Rules that always hold

- Never rewrite the registry by parsing and serialising it: comments are the only notes anybody has. Edit lines, or use the hub's own editor, which changes one line and proves the file still says what was asked.
- Every hub process that opens the store runs with `BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1`. The units and `imprnt hub` set it. A script run by hand with `bun run` needs it on the command line.
- A message is answered exactly once, and every wait a person sees in a chat says why, from a closed list of reasons. A silence with no known reason is a `check` finding, never a vague sentence.
- The Pi is the box that runs the household. The Mac is where checks run and where a change is proved before it is merged. Nothing here writes to the Pi's live files without a command the report names.
