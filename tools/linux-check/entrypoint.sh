#!/bin/bash
# Copy the working tree in, install into the container, run what was asked.
#
# /src is the checkout, mounted read-only, and nothing ever writes to it. The
# copy leaves out node_modules, .git, dist and .turbo, so the host's macOS
# binaries are never visible to Linux and the container always installs its
# own. That is also why an install takes a little time on every run: it is the
# price of the two trees never touching.
set -euo pipefail

started=$SECONDS

if [ ! -d /src ]; then
  echo "linux-check: nothing mounted at /src" >&2
  exit 2
fi

mkdir -p /work
tar -C /src -cf - \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.turbo \
  --exclude=dist \
  . | tar -C /work -xf -
cd /work

bun install --frozen-lockfile

echo "linux-check: setup took $((SECONDS - started))s"
echo "linux-check: $(uname -s) $(uname -m), bun $(bun --version), model binary $(claude --version 2>/dev/null || echo 'MISSING')"
echo "linux-check: $(postgres --version) from $(dirname "$(command -v postgres)")"
echo "linux-check: running: $*"

exec "$@"
