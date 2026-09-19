# Operations

Use `imprnt hub check <registry> <machine>` for findings and `imprnt hub status <registry> <machine>` for wanted and observed services. A machine can be omitted only when exactly one is declared. `imprnt hub metrics <registry>` reads the shared store.

Install the database with `imprnt hub install <registry> database`. The registry must name an explicit `install.admin_argv` for the database administrator. This stage creates the database and runtime roles, applies migrations, and writes `[store]` once. It does not activate services or change database access policy.

Use `imprnt hub install <registry> services <hub-entry>` to install that machine's declared services, including its resident hub. `imprnt hub install <registry> entry <sync-entry>` installs just the selected entry and its schedule for sync rehearsal. On Linux the service account needs lingering enabled by the administrator with `loginctl enable-linger <service-account>`. macOS uses login agents; this does not provide startup before login.

`imprnt hub recover <registry> agent:<id>` replaces the selected agent session and releases its claims without restarting its runner or siblings. Authorized chat senders can use `/recover <agent-id>` or `/восстановить <agent-id>` for an agent belonging to the same person. `imprnt hub recover <registry> door:<id>` requests an operator-only door restart that reads the current token file. Requests and applications are recorded in the control sheet and diary.

A door whose registry names a `hub.cutover_batch` that is not complete yet waits instead of exiting. It serves and pulls nothing, and its diary and stderr carry one `start:cutover-incomplete` line naming the batch. It becomes ready by itself once the handoff completes that batch, so the unit needs no restart and no `reset-failed`.

Read failures and delivery failures retain their safe cause and route in state and diary. Failed install, start, and restart actions name their operation and target in the diary and service stderr. Child stderr inherits the service destination.

On Linux select the declared entry's journal with `journalctl --user --unit imprnt-hub-<entry>.service --no-pager`. Scheduled entries also have `imprnt-hub-<entry>.timer`. On macOS read `<state_dir>/service-log/<entry>.out.log` and `<state_dir>/service-log/<entry>.err.log`; the directory is private. Native checks query and remove only their own randomly suffixed fixture units.
