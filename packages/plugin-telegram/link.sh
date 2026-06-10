#!/bin/sh
# The phone link: imp in the lair with the Telegram channel enabled, Mac kept awake while it
# runs (caffeinate -i, macOS only; elsewhere it just launches). Stop with Ctrl-C. Extra args
# pass through to claude.
set -eu
CHANNEL="plugin:telegram@claude-plugins-official"
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i imp lair --channels "$CHANNEL" "$@"
fi
exec imp lair --channels "$CHANNEL" "$@"
