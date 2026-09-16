# rootfs/scripts — the shell the Dockerfiles call

Every `RUN` body longer than one command is a file here. A caller reaches its
own the same way:

```dockerfile
RUN --mount=type=bind,source=rootfs/scripts,target=/mica-scripts \
    sh /mica-scripts/<name>.sh
```

Two kinds of caller, and every file below names its own in its header:

- **the finalizer**, `../compose/90-pack.Dockerfile` — the `pack-*` files, the
  package-manager capture and purge, and the shadow-date pin. These close and
  pack the assembled root and are the bulk of this directory.
- **a package producer** — `rauc-assert-no-tls-stack.sh`, run by
  `pkgs/rauc/deb/rauc`. A producer runs the repository's own file rather
  than restating it, so the rule and the payload cannot come apart. (The CA
  generation script moved to `micaoss/mica-system-base` with the producer that
  runs it.)

## Why a bind mount and not a `COPY`

A `COPY` would put the script *in the image*. The mount exists only for the
duration of its `RUN` and leaves nothing behind — neither the files nor the
`/mica-scripts` directory. That is measured, not assumed: uefi-x64 built with and
without the mount gives the same `rootfs-verity.img` sha256 cache-hot.

Cache-hot was the only way that measurement could be made when it was taken: a
**cold** uefi-x64 build did not reproduce itself at all — two cold builds of one
untouched tree gave `1b3f5e50…` and `7aad6efd…`. Three surfaces carrying
build-host state have since been removed and a cold uefi-x64 pair now agrees, which
`../README.md`, "Determinism, and what it took to get there", records with the
measurement. The gate for a change here is still the content diff recorded
there, because a hash cannot attribute a difference.

`/mica-scripts` is at the top level rather than under `/tmp` on purpose. If the
mount ever did leak, a stray directory at `/` is something `ls /` on the packed
root shows and the image verifier's layout checks would notice; the same leak
under `/tmp` would be invisible.

## How the build arguments get in

Docker puts every `ARG` that has a value into the `RUN`'s **environment**, so
the shell reads them from there — and so does any child of that shell. Nothing
is passed explicitly on the `RUN` line, because nothing needs to be: the script
inherits `MICA_RADIOS`, `MICA_ARCH` and the rest exactly as an inline body
would see them.

The failing side matches too. An `ARG` declared with no value is *unset* in the
environment, not empty, so a `set -u` on it fails inside the script with the
same message it would fail with inline. Each script names the arguments it
reads in its header.

## Which comments live here

The prose that explains what the image *is* — which package is in the allowlist
and why, which unit is deliberately not enabled — stays with the `FROM`, `ARG`
and `COPY` it describes, or in the package producer that now owns the paths.

The comments that explain lines of shell live here with their code, and here
they are real comments. Inside a `RUN` body they are not: the Dockerfile parser
deletes a whole-line comment *before* it joins the continuations, so such a
line never reaches the shell at all — which is why one can sit in the middle of
a `&&` chain without breaking it.

## What stays in the Dockerfile

- **Package lists.** A build's package set *is* the image; reading it should not
  require opening a second file. `apt-get install` lines stay in the Dockerfile.
- **Single-command `RUN`s.** `RUN rm -f /etc/ssh/ssh_host_*` gains nothing from
  a hop through a file.

## The seam is the `RUN` boundary

One `RUN` is exactly one script — none merged, none split. The callers choose
those boundaries for reasons they document; the pack stage says outright that
it is "in three steps so each can carry its own explanation and cache
independently".

## These scripts are POSIX `sh`, and must stay that way

They run under the container's `/bin/sh`, which is dash on Debian. In
particular **do not add `set -o pipefail`**: dash has no such option, and
several of these scripts use `producer | grep -q` — a form that is correct
without that option and inverts its own answer with it. `os-shell-pipefail-lint`
scans only files that enable it, which is why these are outside its scope by
construction rather than by exemption.

## Verifying a change here

`sh -n` catches syntax. For a change that is meant to be a *refactor*, the check
that matters is that bash parses the old and new bodies to the same tree:

```sh
canon() { bash -c "__c__() {
$(cat "$1")
}
declare -f __c__"; }
diff <(canon old.sh) <(canon new.sh)
```

`declare -f` re-prints a function from bash's parse tree, so indentation, line
breaks and comments are gone and anything that survives is program structure.
It reaches the cx3576-only paths an uefi-x64 build never executes, which is what
makes it the check for a refactor.
