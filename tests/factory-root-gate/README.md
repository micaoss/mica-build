# `tests/factory-root-gate` — is the OCI export the tree that ships?

The invariant: *the image the smoke run executes in is byte-for-byte the tree
the device ships*. Every other smoke-run result rests on that assumption, and
nothing else in the tree checks it. The two trees come from two exports of one
stage, so nothing about their agreement is structural; a smoke run inside a
*different* tree is a measurement of something that never boots.

`make os-factory-root-gate` is the target (docker-requiring, like
`os-verify-cx3576`), and the deep lane of `.github/workflows/privileged.yml`
is the step, which is the only place it can run on cx3576.

It needs a matched pair — `factory-root.oci` and `rootfs-verity.img` from one
build — and it says so and exits non-zero when it has neither, rather than
skipping. `MICA_BOARD` selects the board; `x64` is the default.

## What it is

| file | runs where | what it does |
| --- | --- | --- |
| `gate.sh` | the host | resolves the pinned tool image and runs the other two inside it |
| `inner.sh` | the container | unpacks both trees and compares them five ways; **exits non-zero on any difference** |
| `mutate.sh` | the container | breaks each of those five comparisons in turn — nine mutations — and requires each to go red, then to go silent again on revert |

The five: **metadata** (mode, uid, gid, path), **content** (the bytes of every
regular file and the target of every symlink), **device nodes** (type, major,
minor), **file capabilities**, **hardlinks**.

`mutate.sh` is not optional and `gate.sh` runs it every time. On a healthy root
every one of the five can only ever be observed agreeing, and two of them have
nothing behind them at all: the roots here carry no file capability and — on
arm64 — no multiply-linked file, so those two compare an empty file with an
empty file. Without the mutation pass, both lines are positive results that
cannot fail.

## Device nodes, and why `diff -r` is not what compares the content

Until RFCT-356 the content comparison was `diff -r --no-dereference` over the
two trees, and **diff cannot read a device node**. For each of the eight
character devices under `/dev` it printed

```
File .../sq/dev/null is a character special file while file .../ocix/dev/null is a character special file
```

— eight lines that say only that diff declined to look — and the gate counted
them as eight differences and announced `FIDELITY: 1 of 4 comparisons differ`,
which reads as *the smoke run measured nothing*. It said that on **every** arm64
run, for a reason that was never about the root.

Neither cheap way out was available. Filtering those lines would filter a
genuine difference phrased the same way — a device node that changed type or
major:minor is *exactly* what diff phrases that way. Dropping `/dev` would stop
comparing eight entries that are part of the root, and the other comparisons do
not cover them: `%M` in the metadata inventory carries the type character, so a
`/dev/null` shipped as a regular file was already caught, but one shipped with
`/dev/zero`'s minor is identical on mode, owner, link count and (absent)
content.

So the content comparison is handed only what diff can read — a hash per
regular file, a target per symlink — and the device nodes get their own
comparison of type, major and minor, enumerated with `stat` because
`find -printf` has no directive for either number.

## Running it

```sh
MICA_BOARD=x64 bash rootfs/build.sh     # produces _out/x64/{rootfs-verity.img,factory-root.oci}
make os-factory-root-gate                    # MICA_BOARD selects the board; x64 by default
bash tests/factory-root-gate/gate.sh _out/x64   # the same thing, said longhand
```

Needs docker. It reads `_out/<board>/` and writes only under
`_out/<board>/gate-work/`; it never touches the artifacts it compares.

## Why it runs in a container

Neither side is readable on the build host — there is no `unsquashfs` and no
`getcap`. Both sides run in the same pinned `IMAGE_ALPINE_3_21` with
`verify/src/tools.ts`'s package list, which is what makes a difference a
difference between the two trees rather than between two versions of
`squashfs-tools`.

## What it measures

| board | entries | with content | device nodes | caps | hardlinks |
| --- | --- | --- | --- | --- | --- |
| x64 | 9,240 | not re-measured | not re-measured | 0 | 6 |
| cx3576 | 4,546 | 3,902 | 8 | 0 | 0 |
| virt-arm64 | 5,742 | 4,768 | 8 | 0 | 0 |

Identical on both sides, on all five comparisons, on each of the two arm64
boards, with all nine mutations driven from the failing side. Every count moves
whenever a file enters or leaves the root, so re-derive them rather than
trusting this table. The full record, including the reproducibility
measurements this harness does *not* cover, is `rootfs/README.md`,
"Determinism, and what it took to get there".

The x64 row is the pre-RFCT-356 measurement of the two comparisons that change
did not move, and it is honest about the two it did: no x64 root can be composed
on this host without a full amd64 pool, so the content and device-node figures
have not been taken there. x64 is the only board whose root carries a
multiply-linked file — klibc, one binary under six names — which is why
`mutate.sh`'s hardlink case has a second form for the roots that carry none.
