# The Linux check, locally

CI runs every change on a clean Ubuntu runner, and waiting twenty minutes for
it is how a macOS-versus-Linux difference is usually found. This runs the same
checks on the same Linux, in Docker, on the machine you are already sitting at.

```sh
tools/linux-check/run.sh packages/plugin-hub/test/box-worn.test.ts   # a few files, ~12 s
tools/linux-check/run.sh                                             # everything CI runs, ~15 min
tools/linux-check/run.sh --shell                                     # a prompt inside it
tools/linux-check/run.sh --rebuild                                   # after editing the Dockerfile
```

**The first line is the one to use.** Name the files you just touched and Linux
answers in about twelve seconds, which is the difference between checking on
Linux and meaning to. The bare call is the full suite and belongs before a
push.

Docker has to be running. The first call builds the image. Nothing is written
to the checkout: the tree is mounted read-only, copied into the container
without `node_modules`, `.git`, `dist` or `.turbo`, and installed there, so the
macOS binaries in your `node_modules` are never visible to Linux and no run can
leave a file behind. Downloaded packages live in a Docker volume, not in the
repository.

## What it costs, measured

Measured on an eight-core Apple machine with Docker Desktop, against the tree
CI checked in run 35474317537.

| | here | for comparison |
|---|---|---|
| **five test files, image cached** | **12 s** (1 s of it copy and install) | 13 s for the same five on macOS |
| full run, image cached | 15 min 17 s | CI 20 min 43 s wall, its hub suite 20 min 9 s |
| image build from scratch | about 2 min, once | |

A narrow run costs about what the same files cost natively, which is the whole
argument for it. The full run is not faster than the Mac, it is a second
opinion from a different operating system.

## What it tells you

Every run ends with the same two-line verdict: how many failures are ones a
container cannot avoid, and how many are anything else. The first kind are
named in `container-limits.txt` with their reason, printed in full, and
subtracted from the exit code. The second kind are printed as `REAL` and the
run exits non-zero.

A narrow run gets the same treatment as a full one. A check that cannot pass in
a container does not become passable by being named on the command line.

## What it stands in for

The image installs what the CI workflow installs, at the versions the workflow
pins: bun 1.3.14, bubblewrap, the Postgres 16 binaries the throwaway clusters
resolve, the real model binary the refusal checks probe, and npm, which a
runner has and a bare Ubuntu does not.

Against the tree above, CI reported 1642 checks, 12 skipped, none failing. Not
one of them is missing here. What differs, measured against that same run:

- **23 checks that CI runs are skipped here**, each printing its own reason.
  All of them want a live systemd user manager.
- **5 checks that CI passes fail here.** Three are named in
  `container-limits.txt`, explained, and subtracted. The remaining two are not
  explained yet: `RUN-14 the two kernel findings` and `SPEC §1 the install
  script applies the schema`.
- **1 failure has no name to match on** and so cannot be subtracted either.

So a full run on a clean tree currently prints three `REAL` lines that CI is
green on. They are not regressions, and until each one has a verified reason
they are not going into `container-limits.txt` either, because a line in that
file is a claim about the container, not a way to make output quieter.

The obvious next step, tried and not yet measured: a runner also has `sudo` and
the `systemctl` binary on the path, and two of those three reds probe exactly
that. Installing both in the image is one line, and it plausibly moves the 23
skips as well. It is not in this image because the numbers above were measured
without it, and an image whose clean-tree output nobody has read is worse than
one with three named reds.

## What it cannot stand in for

- **Anything that needs a live systemd user manager.** A container cannot boot
  one without `--privileged`, which this refuses to take. That is the 23 skips
  and two of the subtracted failures. The honest cost: those checks are not
  covered here at all. The Mac and CI cover them.
- **A real process table.** A container's whole process list is single digits,
  so the boxing check that proves an unboxed process sees hundreds cannot run.
  It is the third name in that file.
- **The processor.** The container is arm64 on an Apple machine, the runner is
  x86_64. Nothing in this suite is known to turn on that, and the run above
  found no difference that did, but timing is a different measurement on a
  different chip and a genuinely architecture-dependent bug would hide here.
- **The other operating system.** This says nothing about macOS. Run the suite
  on the Mac as well.

## The two security flags, and why

bubblewrap builds the agent's box out of an unprivileged user namespace, and
Docker's default profile blocks that twice: seccomp refuses the namespace, and
the masked paths under `/proc` stop a fresh `proc` being mounted inside it. The
run script passes `--security-opt seccomp=unconfined` and
`--security-opt systempaths=unconfined`, which puts the container back to what
an ordinary Linux virtual machine looks like. That is what the CI runner is, so
the box checks behave here the way they behave there. What the flags cost is
isolation between the container and your machine, not fidelity to CI. Nothing
runs as root, no capability is added, and `--privileged` is not used, although
it was measured and would work.

## One thing it is hungry for

A full run builds many throwaway Postgres clusters and installs a full
`node_modules` inside the container. Docker's virtual disk grows to match, and
on a Mac that is nearly full a run can fill it. If Docker starts reporting
unreadable image layers, that is what happened: `docker system prune` and a
restart of Docker Desktop are the way back.
