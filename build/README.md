# `build` — the TypeScript build driver for the image pipeline

The typed **geometry** of a board, **`Bun.$` wrappers** for the external toolset
the image assemblers drive — sgdisk, mtools, dd, mkimage, veritysetup, e2fsprogs
and rauc — and the two image assemblers and the update-bundle builder on top of
them. No runtime dependencies: `typescript` and `@types/bun` are dev-only, and
`bun test` needs neither.

Nothing here runs on the device. The image ships no bun.

## Where the board model comes from, and why it is not here

`verify/src/board-env.ts` parses `boards/<board>/board.env` as **data** —
never sourcing it, never reading `process.env`, refusing by name everything a
shell would have executed — and `board.ts` turns that into partitions, roles,
bootloader and the board lists, keeping *declared empty* apart from *absent*.

`build` **imports that**, across the two packages, through exactly one file:
`src/verify-package.ts`. One copy of the parser, no workspace and no lockfile
coupling: bun and `tsc` both resolve a relative specifier into a sibling
package's `src/` directly, and `build`'s typecheck follows its imports, so the
two packages are checked *against each other* on every run of either suite. Two
parsers that must agree about the same bytes would not be — and a copy is not
wrong when it is made, it reads as self-evidently correct long after one of its
reasons changed.

A relative `..` **module specifier** is safe where a counted directory path is
not, and `src/paths.ts` says why: `resolve(dir, '..')` always produces a path, so
a miscount surfaces later as an empty directory; a wrong module specifier is
"Cannot find module", at import, before any test runs. It is the loud kind.
`paths.ts` still anchors `verify` itself, so the message names which of the
two packages moved.

`src/verify-package.test.ts` asserts the claim rather than restating it:

- the imported module **is** `verify/src/board.ts`, by object identity — bun
  keys its module cache on the resolved path, so a copy would give an
  equal-looking function that is a different object;
- exactly **one** file in `src/` names the other package;
- **no** file in `src/` defines `parseBoardEnv`, `modelBoard`,
  `evaluateArithmetic` or a second `KNOWN_ROLES`.

The third is the one that holds. The tempting shortcut when an assembler needs
one more field is to read `board.env` "just here".

## The geometry, and what it adds over the model

`src/geometry.ts`. The model answers a **lint's** question: what is declared,
what is not, never stopping at the first fault. An **assembler** asks a different
one — give me the sector for sgdisk and the MiB for dd, or end the build. Three
differences follow, and each is that difference:

**One number per fact, in every unit.** A start is declared in MiB on one
partition, in sectors on another and in all three on a third: cx3576 writes
`LOADER_START_SECTOR=64` alone, `BOOT_A_START_MIB`/`_START_SECTOR`/
`_OFFSET_BYTES` together, and x64 computes all three with `$(( ))`. A
`Placement` carries `bytes`, `sectors` and `mib`, derived from whichever the file
spelled, against the board's **own** `SECTOR_SIZE` and `MIB_BYTES` rather than
against 512 and 1048576 written down again. Where two declared units disagree it
records a fault and keeps the file's first word rather than blending them — the
schema lint *reports* that contradiction, this refuses to *use* it.

**BigInt, not number.** `board.ts` reads its integers with `Number(t)`.
`board-env.ts` evaluates `$(( ))` in BigInt for a reason it states — "these are
byte offsets; past 2⁵³ a double stops being exact, and a size that is silently
one byte out is the class of defect this package exists to make visible" — and
that reason stops applying the moment a double touches the value. Every quantity
here is re-read from the string and kept as a `bigint`.

**Required means throws.** `require`/`requireInt` name the key **and the file**.
Under `set -u` a shell says `BOOT_A_START_MIB: unbound variable` and names
neither; a consumer reading `${X:-}` instead says nothing at all.

What it does **not** do: the derived layout. That depends on the rootfs that was
actually built, and its arithmetic differs per BOOT CHAIN rather than per board:
`src/layout-cx3576.ts` for the U-Boot board, `src/layout-uefi.ts` for the UEFI
ones. Not a `case` in this file either way.

Every shipped board reads clean — 0 geometry faults, 0 model faults — and the
per-board assertions are spelled out with the values copied from the files.
**Anything that passes on cx3576 alone is half tested**: the parser once passed
cx3576 141/141 while x64 was wholly unreadable.

## The cx3576 assembler

`src/mkimage-cx3576.ts`, with `src/layout-cx3576.ts`, `src/boot-cx3576.ts` and
`src/pin-seeded-times.ts` under it and `src/mkimage-cx3576-cli.ts` over it.

Assembly is **byte-reproducible with itself**: the same inputs and the same
board definition give the same image, every run.

**Byte-identity cannot see a dropped refusal**, which is why the tests matter
more than the hash. An assembler that quietly lost the boot-attempts range still
produces identical bytes for every good input and passes perfectly; what it
stopped catching is a board that needs re-flashing. So all thirty-three refusals
are driven from the failing side — `HARNESS.md` names the mutation for every one.

### The derived layout

`src/layout-cx3576.ts`. Two modes, and **the mode is selected by whether
`MICA_ROOTFS_SLOT_MIB` was supplied at all, never by its value**, so a release
that pins the same number as the built-in default still gets the strict mode.
Deciding by value would agree on every number and disagree about which mode a
release build is in, and the mode is what decides whether an oversized rootfs is
a build failure or a silently bigger image no flashed device can take an update
for.

| | |
|---|---|
| **pinned** | the geometry is FROZEN at the pin; an oversized rootfs is a build failure, by how much |
| **floor** | `max(floor, alignUp(ceil(payload × 125 / 100), 16))`, and the slot grows with the content |

Everything in that file is **pure**. The arithmetic decides where DATA starts,
and one MiB out produces an image that assembles, verifies, boots and cannot take
an update on a device flashed with the other number — a bug that, reached only
through an assembly, is found by diffing 1.3 GiB. Reached from a test it is
driven in milliseconds at a payload one MiB under a pin, one MiB over it, and
exactly on the alignment boundary.

### `-a ${GPT_ALIGN_SECTORS}`, the one difference that is not cosmetic

Every flag-order and unit difference between the two assemblers' sgdisk calls is
byte-identical but one: **`-a 1` where a start is sector 64.** Without it sgdisk
relocates that start to sector 2048, silently, exit 0 — and cx3576's loader is at
sector 64.

`boards/cx3576/board.env` spells out what happens next: systemd-repart
"discards every region of the disk that no partition entry covers", on the first
boot while growing DATA, so "the device boots once and comes up in maskrom on the
next power-on". An image in that state passes every structural check and boots on
a bench.

So the assembler **reads the loader back out of the finished table** and asserts
its start, its length and the four bytes at its first sector. Asking sgdisk for a
layout proves nothing about the layout. Driven red three ways — alignment
omitted, `-a 2048`, `-a 4096` — and the three do not fail alike, which is
recorded rather than smoothed over.

### `pin_seeded_times`

`src/pin-seeded-times.ts`. It sits with the assembler rather than with the
wrappers because it is not a utility — it is one argument kept in one place:
which of an inode's four timestamps are the producer's data and which are the
assembler's noise, why the inode set has to come from the bitmap rather than
from a walk of the source tree, and why debugfs's stderr rather than its exit
status is the failure signal. The three primitives it stands on are wrapped in
`src/tools/e2fsprogs.ts`; the free-inode parse and the atime/ctime generation are
here.

Two claims, both asserted: two filesystems whose seeds differ only in atime and
ctime come out byte-identical after the pass — **and differ without it**, which
is the half that stops a pass that does nothing from satisfying the first.

### What decides the output bytes

Every decision that reaches the output bytes is pinned rather than left to the
environment: the pinned alpine, a written-out apk package list, `cp -a` and
`find … -exec touch` run **inside** that container, and mcopy handed the staged
files in the order a C-locale glob produces them.

`cp -a` is the one worth stating. It is `--preserve=all`, which includes
**xattrs**; `mke2fs -d` copies xattrs into the image; and this host runs SELinux
while the alpine container does not. Staging on the host would write security
labels into EPHEMERAL that the image is not supposed to carry.

Sizes go to sgdisk in sectors throughout. `+NS` and `+NM` are byte-identical at
512-byte sectors, and the suite re-runs that comparison rather than trusting the
sentence.

## The UEFI assembler

`src/mkimage-uefi.ts`, with `src/layout-uefi.ts`, `src/grub-uefi.ts` and the same
`src/pin-seeded-times.ts` under it and `src/mkimage-uefi-cli.ts` over it. Fourteen
refusals, each driven from the failing side with a positive control beside it.

It serves BOTH UEFI boards -- x64 and virt-arm64 -- which differ in three facts:
the grub target, the removable-media file name, and the package carrying the
module tree. `src/toolsets.ts` holds them as a table keyed on `MICA_ARCH` and
checks each board's own `ESP_REQUIRED_FILES` against it, so a board declaring
`MICA_ARCH=arm64` beside `BOOTX64.EFI` is refused rather than assembled into an
image no firmware boots.

### Why this is not `mkimage-cx3576.ts` with a board parameter

That assembler is U-Boot — a loader at a fixed sector, a redundant environment
pair, a compiled `boot.scr` and geometry assertions about all three — and none of
it exists on a UEFI machine. What the two share is shared as **modules and
files** (`src/geometry.ts`, `src/pin-seeded-times.ts`, `src/tools/`, the board
definitions) and not as a `case`.

`src/layout-uefi.ts` sits beside `src/layout-cx3576.ts` for the same reason, and
the difference is arithmetic rather than style: x64 applies its headroom
percentage to the payload's **byte count** and ceilings to MiB afterwards, where
cx3576 ceilings first. Measured — the two agree on all 2048 whole-MiB payloads
and disagree on thousands of others. x64 also has **no pinned slot mode at all**:
`MICA_ROOTFS_SLOT_MIB` never reaches its layout.

### The ESP cluster floor, and why its position is the check

The board says 64 MiB and the size is a **correctness** constraint. Below 65525
clusters a filesystem is not FAT32 no matter what `-F 32` said, and `mkfs.vfat`
does not refuse: at 32 MiB it produces an image mtools reads happily and OVMF
leaves out of its device list entirely, dropping the machine to the UEFI shell.

The check parses **free** clusters where the specification defines the type by
**total**. On an empty filesystem free is total minus the root directory's one
cluster — measured 129021 against 129022 — so it is conservative by exactly one
*where it stands*. After the `mcopy` it would be a free-space check wearing a
FAT-specification message: 117119 once the ESP tree is staged. So it runs before
anything is copied in, and `HARNESS.md` carries both numbers.

### The whole table, read back

There is no `checkLoaderLanded` here because there is no loader. Instead every
partition is read back out of the assembled GPT and compared against the spec,
and that is not decoration: measured, `-a 4096` over the real x64 geometry moves
the ESP to sector 4096 **and shrinks it to 129024 sectors**, and exits 0. On
cx3576 the same flag makes sgdisk refuse the table outright. The two boards' third
alignment case is a different failure, so on this board the read-back is the only
thing that would report it.

### `cp -a` on the host

The x64 assembler stages the factory `/var` on the HOST and runs everything else
in its container, where the cx3576 assembler stages it inside. `cp -a` is
`--preserve=all`, which includes xattrs; `mke2fs -d` copies xattrs into the
image; and this host runs SELinux while neither container does — so moving that
one step changes EPHEMERAL's bytes.

## The bundle builder

`src/bundle.ts` with `src/bundle-cli.ts` over it: it builds and **signs** the
RAUC update bundle a device installs. Thirty-one refusals, each driven from the
failing side with a positive control beside it.

**The rebuild comparison is the PAYLOAD, not the file.** The squashfs at the head
of the bundle is a pure function of the inputs; the bytes after it are
deliberately not — rauc salts the bundle's own dm-verity hash tree at random and
the CMS signature carries a `signingTime`, so the `hash` field `rauc info`
reports moves on every run while the payload digest does not. `HARNESS.md`
carries the recipe and the live one-byte control.

### Two refusals worth naming

**The empty credit read.** Reading the boot-attempt credits out of `boot.cmd`
with a grep-and-loop shape —

```sh
done < <(grep -oE 'BOOT_[AB]_LEFT [0-9]+' "${BOOT_CMD}" | awk '{print $2}')
```

— passes having compared nothing when `boot.cmd` is missing or carries no
credit: grep produces no stdout and the loop body never runs.
`requireBootAttempts` refuses an empty read by name and returns the credits it
saw, so a caller can say **four** rather than "exit 0". It can only turn a
vacuous pass into a refusal.

The assembler's copy of the same range check is covered by accident —
`checkBootCmdTokens` runs next and refuses a `boot.cmd` with no `rauc.slot=`. The
bundle path has no second guard, which is why the refusal lives there rather than
in the range check both share.

**A host route that cannot carry the shipped rauc.** The bundle toolset gets its
rauc by `docker cp`, and declares `provenance: 'shipped'` — which is what
`src/tools/rauc.ts` checks before it will write a bundle at all. On the host
route there is nothing to copy a binary into, so that claim would be made about
whatever `rauc` PATH resolved to first. `openBundleToolbox` measures the route
and refuses the mismatch by name, before anything is written. A bundle built by
rauc 1.8 is refused by a device running 1.13, and a format difference does not
announce itself kindly.

### What decides the bytes

- **The mcopy order** — `Image rk3576-src.dtb boot.scr mica-verity-a.env
  mica-verity-b.env` — because that is the order they land in the FAT directory.
  A written-out list in both places; nothing globs.
- **No `-i` and no slot label on `mkfs.vfat`.** One image, two possible
  destinations: the payload is installed into whichever boot slot is inactive,
  so it must not carry that slot's FAT identity. `--invariant` is what keeps the
  volume id off the wall clock instead.
- **Every staged file touched to `FILE_MTIME` before `mcopy`**, because `mcopy
  -m` takes each entry's mtime from its source.
- **rauc's `--mksquashfs-args`, verbatim.** rauc drives mksquashfs itself and
  without them stamps the payload with the wall clock, the build container's uid
  map and a thread count.

### Both bootloaders, one module

The bundle's two branches differ only in what a boot slot holds — a compiled
`boot.scr` plus both slots' verity env files on U-Boot, the kernel, the initrd
and a GRUB cmdline fragment on grub — and that is a board fact. So this is one
module with one branch on `RAUC_BOOTLOADER`, and `--bundle` takes a board where
`--mkimage-cx3576` and `--mkimage-uefi` are separate arms. The grub branch's refusals
are driven from the failing side; **no x64 bundle has been built**, because this
tree has no x64 rootfs to bundle.

## The toolbox: how an external tool is run

`src/toolbox.ts` is one function with two routes, which is `verify/run.sh`'s
shape for bun, one level down. Every caller passes an argv and reads a status,
and none can tell which route answered.

**The container is the normal route, not a degraded one.** Requiring the toolset
on the host would make the build a host-configuration problem. Measured on this
host: no sgdisk, no mcopy, no mdir, no minfo, no mkimage, and an e2fsprogs that
is 1.46.5 — **on `PATH` and unable to write `-O ^orphan_file`**, which is exactly
why `pin_seeded_times` runs container-side. So the route is chosen by probing
*capability*, not presence.

**Per toolset, never per tool.** An image half written by the host's sgdisk and
half by the container's mcopy has no answer to "which tool wrote these bytes",
and that is the property the assemblers rest on. The capability probe is an `&&`
chain across seven binaries for the same reason.

**A session, not a container per call.** Measured: `docker run --rm <alpine>
true` ≈ 320 ms, `docker exec` into a running one ≈ 40 ms, and the package install
is ≈ 1.3 s on top of *every* run. A `Toolbox` opens once — image resolved,
container started, packages installed, **every declared tool asserted present** —
and each call is an exec into it. That is also what makes a container-side step
ordinary rather than special-cased: `pin_seeded_times`' `dumpe2fs` and `debugfs`
are two more calls into the same session.

**Every tool asserted at open**, because alpine splits `debugfs` and `dumpe2fs`
out of `e2fsprogs` into `e2fsprogs-extra` and `apk add e2fsprogs` succeeds while
providing neither. Without the assertion that gap surfaces as "debugfs: not
found" forty steps into an assembly.

**Identity mounts**, not `/w` or `/work`. `verify/run.sh` states the rule —
short names for containers that *run a script* and build their paths inside,
identity for containers *handed paths from outside* — and every tool here is the
second kind. It matters twice over when bun is itself in a container: a container
started from inside one is a **sibling**, created by the same daemon, so every
`-v` it passes is resolved against the **host** filesystem. And a bind mount of a
path the daemon cannot see does not fail — it succeeds and delivers an empty
directory (measured, `/tmp`, on this host, still true).

### The toolsets

`src/toolsets.ts`. Every image is a **key** of `build-env-image.lock` or `base-images.env`,
resolved through `tools/from.sh --ref`; no floating tags. Every package list is
written out rather than tidied: which package provided `mkfs.vfat` or
`grub-efi-amd64-bin` decides bytes, and the two assemblers use different base
images on purpose.

| toolset | image key | provides |
|---|---|---|
| `cx3576-assembly` | `upstream:alpine:3.24.1` | sgdisk, mkfs.vfat, mcopy, mdir, minfo, mke2fs, dumpe2fs, debugfs, mkimage, dd, truncate |
| `uefi-assembly-<arch>` | `upstream:debian:trixie-slim` | the same, plus grub-mkstandalone, minus mkimage |
| `verity` | `upstream:alpine:3.24.1` | veritysetup |
| `coreutils` | `upstream:alpine:3.24.1` | dd, truncate — usually the **host** route |
| `bundle` | `upstream:debian:trixie-slim` | rauc (carried in), mksquashfs, mcopy, mkimage, jq |

`coreutils` earns its place by being the one that normally runs on the host: a
seam with one reachable route is a seam nobody is checking, and both are live in
every run of the suite.

## The wrappers, and the fact that their failure signals differ

`src/tools/`. `toolbox.run()` returns the status and both streams and interprets
**nothing**; each wrapper knows its own tool. That is not fastidiousness — the
signals genuinely differ, and three of them are other than what a caller would
assume.

| tool | how it reports failure |
|---|---|
| `sgdisk` | exit status — **and** `--verify` prints problems with exit 0 |
| `dd` | exit status; it writes its summary to **stderr on success** |
| `mkfs.vfat` | exit status — and `-F 32` writes a FAT32 boot sector over a filesystem that is not FAT32 and exits 0 |
| `mtools` | exit status; an **empty** `mdir` listing is refused |
| `mkimage` | exit status; `SOURCE_DATE_EPOCH` is read from the environment and falls back to the wall clock |
| `veritysetup` | exit status — and `format`'s answer is a root hash on stdout, so an unreadable one is a failure whatever it exited |
| `mke2fs` | exit status; `E2FSPROGS_FAKE_TIME` from the environment |
| `dumpe2fs` | exit status, plus a header this parser must actually understand |
| `debugfs` | **its stderr** — three failure shapes exit 0 |
| `rauc` | exit status — and writing a bundle is refused by *provenance*, before it runs |

**sgdisk is driven with one argv shape**, and that is only safe if the
alternatives are not differences — so they are measured, and the suite re-runs
the comparison rather than recording a claim:

| difference | result |
|---|---|
| flag order `new/name/type/guid` vs `new/type/guid/name` | byte-identical |
| `+131072S` vs `+64M` at 512-byte sectors | byte-identical |
| `--clear` on a freshly truncated (all-zero) file | byte-identical |
| `-a 1` where every start is already MiB-aligned | byte-identical |
| `-a 1` where a start is sector **64** | **not** the same: 64 vs 2048, silently, exit 0 |

The last row is cx3576's loader, and it is why `readPartition` exists: asking
sgdisk for a layout proves nothing about the layout.

**debugfs is the one whose obvious failure signal is the wrong one.** Against
debugfs 1.47.1 an unknown command exits 1, so a renamed command is not the silent
case. What is silent is a bad *argument* (rc 0, "File not found by ext2_lookup"),
an image that is not a filesystem (rc 0, "Bad magic number"), an image that is
not there (rc 0) — and an **empty command file**, rc 0 with a clean stderr, which
neither signal carries and which is what a free-inode-range parse that understood
nothing would produce. All seven cases are in that file's header and each is
driven.

**rauc will not write a bundle with a rauc this tree did not build.** A bundle
built in a bookworm container by rauc 1.8 is refused by a device running 1.13,
and a format difference does not announce itself kindly. So `bundle()` refuses a
toolset whose `provenance` is not `'shipped'`, by name, before any bytes exist.
Reading is allowed on either — which is how the wrapper is exercised in a
checkout where `make os-rauc` has not run.

## Running

```sh
make os-build-test          # the whole suite
bash build/run.sh        # the same thing
bash build/run.sh --help
bash build/run.sh src/geometry.test.ts   # extra arguments go to `bun test`

bash build/run.sh --mkimage-cx3576           # assemble the cx3576 image
bash build/run.sh --mkimage-cx3576 --help
bash build/run.sh --mkimage-uefi --board x64          # assemble the x64 image
bash build/run.sh --mkimage-uefi --board x64 --help
bash build/run.sh --bundle               # build and SIGN the update bundle
bash build/run.sh --bundle 1.2.3         # ... at a version
bash build/run.sh --bundle --help

bash build/run.sh --build-rootfs --board x64 --plan \
    --arg BOARD_RADIOS= --arg RAUC_VERSION=1.14   # decide the order and the tags
```

`make os-image-cx3576` and `make os-bundle-cx3576` are the top-level routes
into `--mkimage-cx3576` and `--bundle`.

`--build-rootfs` is the numbered-Dockerfile driver (`src/stages.ts` decides,
`src/stages-cli.ts` runs). It takes the directory to build through
`--stages-dir` and knows nothing else about it; `rootfs/build.sh` points
it at `rootfs/compose/`, which holds `10-compose` and `90-pack`.

`--without NAME` is **stage selection** — it leaves an `<n>-feature-NAME` file
out, refuses a name no feature file matches rather than silently building the
full image, and refuses to decline a file that is not a feature. **Nothing
passes it today.** The composition directory contains no feature files at all,
so a decline reaches the image through the *resolution* instead, as fewer
package names: the product's `FEATURES` (`products/<name>/product.env`,
read by `tools/product.sh`) is handed to `rootfs/packages/resolve.sh`, which
refuses an unmatched feature name for the same reason this flag did.

`--mkimage-cx3576`, `--mkimage-uefi --board x64` and `--bundle` are **modes**, each recognised
only in first position: anywhere else one would be forwarded to `bun test`,
which ignores an unknown flag and reports a green suite in answer to a request
to assemble an image. That is `verify/run.sh`'s rule, and it is driven here
for all four modes — `bash build/run.sh filter --mkimage-uefi --board x64` exits 1 by name,
as do the other three.

The two assemblers are two arms of one dispatch rather than one arm with a
`--board` flag, for the reason the two assembler sections above give: the boards
share a layout format and a slot model and nothing about their boot chains. One
writes a U-Boot loader at a fixed sector, the other builds a standalone EFI
binary, and a mistake in either would otherwise be a mistake in both. `--bundle`
DOES take a board, and that is not an inconsistency: its two branches differ only
in what a boot slot holds, and that is a board fact.

`run.sh` finds bun — on the host, or failing that in the container pinned as
`mica-build-env:base` — installs the dev dependencies if `node_modules/` is absent,
typechecks `src/` (which typechecks `verify`'s sources too, because they are in
the program), runs the suite, and then checks the suite actually ran.

**This package needs docker, and `verify` does not.** It drives the real
toolset, and on any host that does not carry all of it natively that means
containers. `run.sh` refuses by name when there is no docker client, and again
when the client cannot reach a daemon. Nothing is skipped: a tool reachable
neither way is a failure, not a gap.

**bun is not required on the host.** Without one, `run.sh` takes the pinned-bun
container route — and mounts the host's docker client (a static Go binary) and
`/var/run/docker.sock` at their own paths, so the toolbox can still start
*sibling* containers from in there. Both routes run the whole suite, and the one
taken is announced on the first line of output:

```
build: 1.4.0 at /srv/bkd/runtime/bun
build: 1.4.0 in oven/bun:1@sha256:5ff6… (no bun on this host)
```

`MICA_BUILD_CONTAINER=1` forces that route where a host bun exists, which is how
the two are compared; `MICA_BUILD_BUN` names a binary instead; setting both is
refused. `MICA_BUILD_TOOLBOX=host|container` forces a *toolbox's* route the same
way, one level down.

## Layout

```
run.sh                     the entry point; the only place that decides how bun is invoked
src/verify-package.ts      the one place build reaches into verify
src/paths.ts               where the package sits, anchored rather than counted
src/geometry.ts            board.env -> the typed geometry an assembler asks questions in
src/images.ts              an image key -> its reference, through from.sh and nothing else
src/toolbox.ts             THE SEAM: how an external tool is run, host or pinned container
src/toolsets.ts            the toolsets, each package list written out rather than tidied
src/testing.ts             the timeouts the container-driving tests need, and the measurements
src/tools/sgdisk.ts        the GPT
src/tools/mtools.ts        mkfs.vfat, mcopy, mmd, mdir, minfo
src/tools/dd.ts            raw placement, and truncate
src/tools/mkimage.ts       the U-Boot boot script
src/tools/e2fsprogs.ts     mke2fs, dumpe2fs, debugfs
src/tools/veritysetup.ts   the dm-verity hash tree
src/tools/rauc.ts          the update bundle
src/layout-cx3576.ts       cx3576's DERIVED layout: slot sizing, and the chain down to DATA
src/boot-cx3576.ts         boot.cmd's guards and the per-slot verity env, both pure
src/pin-seeded-times.ts    which inode timestamps are data and which are the assembler's noise
src/mkimage-cx3576.ts          the cx3576 assembler
src/mkimage-cx3576-cli.ts      the host half: where the inputs are, and the -latest symlink
src/layout-uefi.ts         the UEFI DERIVED layout -- a second arithmetic, not a second spelling
src/grub-uefi.ts           grub.cfg's three guards and the per-slot cmdline fragment, all pure
src/mkimage-uefi.ts        the UEFI assembler: x64 and virt-arm64, three facts apart
src/mkimage-uefi-cli.ts    its host half; --board says which UEFI board
src/bundle.ts              the signed RAUC update bundle, both bootloaders
src/bundle-cli.ts          its host half: the signing material, the epoch name, -latest
src/stages.ts              a directory of numbered Dockerfiles -> order, tags, args, and what is declined
src/stages-cli.ts          the only file here that runs docker buildx
src/**/*.test.ts           the suite; every refusal has a positive control beside it
```

`HARNESS.md` carries how each guard is driven from the failing side and the two
bash oracles for the geometry.
