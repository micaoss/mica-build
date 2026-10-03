# stages/compose/scripts — the shell the Dockerfiles call

Every `RUN` body longer than one command is a file here. A caller reaches its
own the same way:

```dockerfile
RUN --mount=type=bind,source=stages/compose/scripts,target=/mica-scripts \
    sh /mica-scripts/<name>.sh
```

The callers are `../10-compose.Dockerfile` and the finalizer
`../90-pack.Dockerfile` -- the `pack-*` files, the package-manager capture and
purge, and the shadow-date pin, which close and pack the assembled root. Every
file names its caller in its header.

## Each init's steps

What depends on the product's init is never a branch in a shared script: each
init has its own directory, `systemd/` and `openrc/`, of steps named
`<position>-<nn>-<name>.sh`, and `init-steps.sh <init> <position> [<record>]`
runs one init's steps at one position in name order (hashing each into the
record when given). A position with no step for an init does nothing there.

| Position | Called from | systemd | OpenRC |
|---|---|---|---|
| `compose` | `../compose-install.sh`, after dpkg | the multicast-DNS decision | -- |
| `closed` | `../90-pack.Dockerfile`, before the purge | remove the hardware database; reconcile enablement with the presets | remove the runlevel links no package owns |
| `tree` | after `pack-tree-surgery.sh` | the resolver link and systemd's state; assert the var binds and the extension directory | the resolver link; assert mica-mounts' binds |
| `shadow` | after `pack-assert-shadow-chain.sh` | the reconciler unit, enabled and ordered | the reconciler script, in its runlevel and ordered |

`<init>/kept-commands` names the commands of the init the package-manager purge
must leave in the root.

## Why a bind mount and not a `COPY`

A `COPY` would put the script *in the image*. The mount exists only for the
duration of its `RUN` and leaves nothing behind — neither the files nor the
`/mica-scripts` directory. That is measured, not assumed: uefi-x64 built with and
without the mount gives the same `rootfs-verity.img` sha256, cold or cache-hot.

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
