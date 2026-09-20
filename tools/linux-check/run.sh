#!/bin/bash
# Run this repository's checks on Linux, in Docker, without leaving a byte in
# the checkout.
#
#   tools/linux-check/run.sh packages/plugin-hub/test/box-worn.test.ts ...
#       The one to reach for, and the reason this exists: those files only, in
#       about twelve seconds, with the package's own test settings. Paths are
#       relative to the repository root and must live in one package.
#
#   tools/linux-check/run.sh
#       typecheck, test and build every package, which is what CI runs. Fifteen
#       minutes, so it belongs before a push, not in a loop.
#
#   tools/linux-check/run.sh --shell
#       a prompt in the prepared container, for poking at a failure.
#
#   tools/linux-check/run.sh --rebuild [...]
#       build the image again first. Needed after editing the Dockerfile.
#
# WHAT THE TWO SECURITY FLAGS DO. bubblewrap builds the agent's box out of an
# unprivileged user namespace, and Docker's default profile blocks that twice
# over: seccomp refuses the namespace, and the masked paths under /proc stop a
# fresh proc being mounted inside it. Turning both off puts the container back
# to what an ordinary Linux virtual machine looks like, which is exactly what
# the CI runner is, so the box checks here behave the way they behave there.
# The cost is isolation between the container and this machine, not fidelity:
# nothing is run as root, no capability is added and --privileged is not used.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
image=imprnt-linux-check
cache=imprnt-linux-check-bun-cache

rebuild=0
if [ "${1-}" = "--rebuild" ]; then
  rebuild=1
  shift
fi

if [ "$rebuild" = 1 ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "linux-check: building $image"
  docker build -t "$image" "$here"
fi

flags=(
  --rm
  --init
  --security-opt seccomp=unconfined
  --security-opt systempaths=unconfined
  # Linux Postgres puts its shared buffers in /dev/shm and the suite runs many
  # clusters at once. Docker's 64M default is not enough for that.
  --shm-size=1g
  -v "$root:/src:ro"
  # Keeps package downloads out of the image and off the checkout, so the
  # install on a second run is a cache read.
  -v "$cache:/opt/check/.bun/install/cache"
)

if [ "${1-}" = "--shell" ]; then
  exec docker run -it "${flags[@]}" "$image" bash
fi

# What failed, minus what a container makes impossible. The list is
# container-limits.txt, and every entry that fired is printed, because a
# subtraction nobody sees is a subtraction nobody can argue with.
#
# Both runs end here. A check a container cannot pass does not become passable
# by being named on the command line, and a red the tool already knows about is
# exactly the red that teaches somebody to stop reading the tool.
verdict() {
  local log=$1 status=$2
  local failed=() known=() unknown=() name hit pattern reason line
  while IFS= read -r name; do
    [ -n "$name" ] && failed+=("$name")
  done < <(grep -oaE '\(fail\) .*' "$log" | sed -E 's/^\(fail\) //; s/ \[[0-9.]+m?s\]$//' | sort -u)
  for name in ${failed+"${failed[@]}"}; do
    hit=""
    while IFS=$'\t' read -r pattern reason; do
      case "$pattern" in ""|"#"*) continue ;; esac
      case "$name" in *"$pattern"*) hit=$reason; break ;; esac
    done < "$here/container-limits.txt"
    if [ -n "$hit" ]; then known+=("$name -- $hit"); else unknown+=("$name"); fi
  done

  local kn=${#known[@]} un=${#unknown[@]} kword=failures oword=others
  if [ "$kn" = 1 ]; then kword=failure; fi
  if [ "$un" = 1 ]; then oword=other; fi

  echo
  echo "linux-check: $kn $kword a container cannot avoid, $un $oword"
  for line in ${known+"${known[@]}"}; do echo "  known : $line"; done
  for line in ${unknown+"${unknown[@]}"}; do echo "  REAL  : $line"; done
  if [ "$status" -ne 0 ] && [ "${#unknown[@]}" -eq 0 ] && [ "${#failed[@]}" -gt 0 ] \
     && ! grep -qaE '^Failed:.*#(typecheck|build)' "$log"; then
    echo "linux-check: nothing failed that this box can tell you about."
    return 0
  fi
  return "$status"
}

# Run the container, keep a copy of what it said, and read the verdict off it.
capture() {
  local status code=0
  set +e
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  verdict "$log" "$status" || code=$?
  exit "$code"
}

log=$(mktemp -t linux-check) || exit 1
trap 'rm -f "$log"' EXIT

if [ "$#" -eq 0 ]; then
  # --continue, so one red task does not hide the rest. The whole reason to run
  # this is to see every difference at once.
  capture docker run "${flags[@]}" "$image" bunx turbo run typecheck test build --continue
fi

# Narrow run. Every path must sit in the same package, because a test run
# carries that package's own settings (its timeout, its environment) and there
# is no honest way to run two packages' settings at once.
package=""
for path in "$@"; do
  case "$path" in
    packages/*/*) owner=${path#packages/}; owner="packages/${owner%%/*}" ;;
    *) echo "linux-check: $path is not under packages/<name>/" >&2; exit 2 ;;
  esac
  if [ -z "$package" ]; then
    package=$owner
  elif [ "$package" != "$owner" ]; then
    echo "linux-check: $path is in $owner, not $package. One package per run." >&2
    exit 2
  fi
done

inside=()
for path in "$@"; do
  inside+=("${path#"$package/"}")
done

capture docker run "${flags[@]}" "$image" \
  bash -c 'cd "/work/$1" && shift && exec bun run --silent test "$@"' \
  linux-check "$package" "${inside[@]}"
