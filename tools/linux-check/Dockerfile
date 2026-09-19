# The Linux the checks meet in CI, on a laptop.
#
# Everything the CI workflow installs on its clean Ubuntu runner is installed
# here in the same order and at the same versions: the same bun, bubblewrap for
# the kernel box, the Postgres binaries the throwaway clusters need, and the
# real model binary the refusal checks probe. Nothing from the host is baked in,
# so a directory that happens to exist on a development machine and not on a
# bare runner is missing here too, which is the whole point.
#
# The image carries no repository content. The run script copies the working
# tree in and installs into the container, so no byte a run writes lands in the
# checkout and the host's macOS node_modules is never visible to Linux.

FROM ubuntu:24.04

# postgresql-16 is what a clean ubuntu-24.04 runner provides, and it puts all
# four of initdb, pg_ctl, psql and postgres in /usr/lib/postgresql/16/bin, which
# is one of the directories test/helpers/cluster.ts resolves from.
# bubblewrap is the kernel box. git is a real dependency of the sync checks,
# which build local repositories and run commands against them. npm is one too:
# two packaging checks run `npm pack` to see what a release would ship, and a
# runner has npm already while a bare Ubuntu does not.
#
# What is deliberately NOT here: sudo and systemd. A runner has both, so adding
# them looks like fidelity, and it may well be. It is not in this image because
# the failure list in README.md was measured without them, and an image whose
# clean-tree output nobody has read is worse than one with three named reds.
# README.md carries that as the next thing to measure.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      npm \
      postgresql-16 \
      procps \
      unzip \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

# initdb refuses to run as root, and bubblewrap needs an unprivileged user to
# create its user namespace, so the run never happens as root.
ARG UID=1001
ARG GID=1001
RUN groupadd -g "$GID" check \
 && useradd -m -d /opt/check -u "$UID" -g "$GID" -s /bin/bash check \
 && mkdir -p /work \
 && chown check:check /work \
 # The kernel check reads this marker to decide whether user lingering is on,
 # and a runner has it for its own account. Without the file the check reports
 # a finding no real machine in this household has, and one check goes red for
 # a reason that says nothing about the code.
 && mkdir -p /var/lib/systemd/linger \
 && touch /var/lib/systemd/linger/check
USER check
WORKDIR /opt/check
ENV HOME=/opt/check

# The version the workflow pins. A mismatch here would report a bun difference
# as a code difference.
ARG BUN_VERSION=1.3.14
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"

# The refusal checks probe a real model binary, so the image carries the same
# version the workflow installs rather than a stub.
ARG MODEL_CLI_VERSION=2.1.275
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/model-install.sh \
 && bash /tmp/model-install.sh "$MODEL_CLI_VERSION" \
 && rm -f /tmp/model-install.sh \
 && "$HOME/.local/bin/claude" --version

# The run script mounts a named volume here. Docker takes a new volume's
# ownership from the directory it covers, so this one has to exist and belong
# to the unprivileged user or every install fails on a temporary file.
RUN mkdir -p /opt/check/.bun/install/cache

ENV PATH="/opt/check/.bun/bin:/opt/check/.local/bin:/usr/lib/postgresql/16/bin:${PATH}" \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bunx", "turbo", "run", "typecheck", "test", "build"]
