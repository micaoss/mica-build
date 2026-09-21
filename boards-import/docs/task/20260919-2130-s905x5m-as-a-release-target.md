# 20260919-2130-s905x5m-as-a-release-target What opening s905x5m for release costs

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-19 21:30

## The question

`boards/s905x5m/board.env` carries `BOARD_RELEASE_TARGET=0`; the other three
boards carry `1`, and `mica-build` derives publish and indexed from it. What
does flipping it cost? Measured, not estimated. Nothing is flipped here: the
decision is the user's.

## 1. What the flag costs in inputs: one package bump

Measured against a clean clone with the flag flipped and nothing else changed.

    component  board     inputs bea2041aea98 -> f8e72bac1a07   REBUILDS
    component  kernel    unchanged  ffa2ecc280c9              reused by digest
    component  uboot     unchanged  485ebd3eb2f5              reused by digest
    component  firmware  unchanged  bfafea529122              reused by digest

    producer   board@s905x5m  80b6ca1d8466 -> 10d2746bec18    mica-board-s905x5m
    every other producer                                       unchanged

`board.env` is a file of the `board` component (`outputs.tsv`) and the
`FOR_EACH` instance file of the board producer, so the flip costs exactly one
version bump, `mica-board-s905x5m` `0.1.0-2` -> `0.1.0-3`, and one component
rebuild. It does **not** reach the bluetooth producer: that producer's
`PREPARE_INPUTS` is `boards/s905x5m/Makefile boards/s905x5m/bsp.env
boards/s905x5m/userland`, and `board.env` is in none of them.

## 2. The U-Boot, and a correction to how it was read

The recorded property is right --
[20260916-0620](20260916-0620-s905x5m-uboot-not-reproducible.md), confirmed
twice -- but "every s905x5m release will show the loader as changed" does not
follow from it. Reuse is decided by INPUTS, not by bytes (`tools/reuse.sh`
compares the component's `mica.inputs` against the board's latest release), so
a release whose U-Boot inputs did not move republishes the same digest without
rebuilding, and nothing differs. The flip itself is an instance: it does not
touch the U-Boot inputs, so the first release after it reuses the loader
unchanged.

What is true is narrower and permanent: a release whose U-Boot inputs DID move
rebuilds it, and that rebuild is never byte-identical. The inputs are
`boards/s905x5m/loader`, `bsp.env`, the board `Makefile`, `common/uboot`,
`common/scripts`, `common/trust`, the two vendor git rows, the toolchain
source rows, the bsp image digest and the boot certificate.

The cost when it does move, from the published component of
`s905x5m.20260916-0857`: four of its twelve files differ and the rest are
identical and deduplicated by the registry.

    uboot/u-boot.bin.signed          3321856
    uboot/u-boot.bin.sd.bin.signed   3322368
    uboot-package/update.img        10267648
    uboot-package/update.img.sha256       77
                                 = 16911949 bytes, 16.13 MiB per such release

Frequency is a function of how much the loader is touched, not of the calendar:
in the week of 2026-09-16 its inputs moved three times (the bsp switch, the
packer platform, the mirror hook); in a week that does not touch the loader it
moves zero times.

## 3. What else is true of this board and not of cx3576

- **It has no `evidence.json`.** The three release targets each carry one;
  s905x5m does not, and `mica-build`'s release manifest REQUIRES it: it reads
  `board-evidence.json`, validates `schemaVersion` 2, the board name, a known
  `bootAssurance`, a non-empty `qualification`, at least one `evidenceRef` and
  `physicalBoundaries`, and the manifest's `bootAssurance` comes from it
  (`mica-build:build/src/release-manifest.ts`). This is the one piece of work
  that must precede a flip, it is in this repository, and it is a document to
  be written honestly rather than a gate to be passed: what is tested, what is
  not, and where the physical boundaries are.
- 15 kernel patches against cx3576's 6, one of which
  (`0018-common-drivers-build-time-from-source-date-epoch.patch`) exists only
  to stop a vendor Makefile stamping wall-clock time into the kernel.
- two extra producers and four extra packages (`mica-s905x5m-bluetooth`,
  `mica-s905x5m-wifi`, `mica-s905x5m-wireless`, `mica-bm201-front-panel`);
  cx3576 has no `extras/` at all. Nine packages in its pool against cx3576's
  four, so nine version-guard surfaces against four.
- the only producer in the repository with a `PREPARE` hook that COMPILES
  vendor sources (`boards/s905x5m/extras/bluetooth`), and the only package
  whose version has been bumped by edits elsewhere in the board -- three times
  in the week of 2026-09-16.
- every `source` row of `locks/upstream.lock` is this board's: three vendor
  toolchains and the closed-source i386 Amlogic packer. cx3576 needs none.
- CI cost per full build, from run 35469299367: kernel 1027 s and U-Boot 262 s
  against cx3576's 703 s and 131 s -- 1289 s against 834 s, 55 % more runner
  time per release.
- its kernel fetch needs `--http1` and `--submodules`; the vendor host stalls
  on HTTP/2.
- no `flash/` directory and no `make flash-*` targets: cx3576 has a maskrom
  path with tooling and tests, s905x5m's recovery path is the `update.img`
  container and `aml_sdc_burn`.

## What is NOT a reason to withhold the flip

Physical qualification. `mica:docs/boards/support-tiers.md` puts cx3576 and
s905x5m at the same tier with "physical rows not tested" for both, and cx3576
is a release target. Opening a board for release does not claim it works on
hardware; the evidence document is where that distinction is stated, which is
why writing it is the prerequisite rather than testing the hardware.

## Done 2026-09-19: flipped, with the evidence document written first

User decision, relayed through the coordinator: open s905x5m and publish it.
Landed in one commit, in the order the investigation said it had to happen.

- `boards/s905x5m/evidence.json` written. It is the prerequisite nobody had
  named: `mica-build`'s release manifest requires it and derives the product's
  `bootAssurance` from it. I1, the same conservative grade as cx3576 at the
  same tier, with exactly one evidence reference -- the board-independent
  signed file-image check, which is all I1 requires and all this board has --
  and the physical boundaries taken from `mica:docs/design/manufacturing.md`
  section 6, with this board's recovery path (Amlogic USB burning through
  `aml_sdc_burn` and the `update.img` container) in place of cx3576's rockusb.
  Its `qualification` states what is NOT established: no s905x5m image had been
  published before, the physical rows are untested, RFCT-922 is open, and the
  loader does not rebuild byte-identically.
- `BOARD_RELEASE_TARGET=1`.
- `mica-board-s905x5m` `0.1.0-2` -> `0.1.0-3` (epoch 1789855200), the declared
  cost measured above and authorised in advance. Re-measured after the edit
  against `1d8b274`: still exactly one producer moved. The board component's
  inputs went `bea2041aea98` -> `3161951a9587` (the flag and the new file);
  `kernel`, `uboot` and `firmware` are unchanged and are reused by digest.

**What this does not claim.** It does not claim the board works on hardware.
The physical rows stay untested and RFCT-922 stays open, exactly as cx3576's
do; cx3576 has been a release target at this same support tier all along, which
is the precedent this rests on. Opening a board for release means its images
are built and published; the evidence document is the statement of what has and
has not been tested, which is why it was written before the flag was flipped
and not after.

## The gate that would have caught it, added here

`tests/board-contract-test.sh` now refuses a board with
`BOARD_RELEASE_TARGET=1` and no `evidence.json`, and checks the document
against the shape the assembly reads (`tests/evidence-schema.py`, mirroring
`mica-build:build/src/release-manifest.ts`). The reason is the failure mode,
not tidiness: the assembly validates at `--release assemble`, which runs after
that product's archives and images are built, so without this gate the first
s905x5m product build would have died after the expensive part. The check is a
pre-check and says so; where it and the assembly disagree, the assembly wins.

## The loader does not reach a device through an update, on any board

Answered by `mica-build` on 2026-09-19 and corrected in
[20260916-0620](20260916-0620-s905x5m-uboot-not-reproducible.md): archive kinds
are computed over the root and kernel object families only, the deployment
descriptor has no firmware member, and `cx3576.20260916-1653` published a root
PARTIAL across a release in which its `uboot` component moved. So this board
loses nothing on the releases that rebuild its loader -- not archive kinds, not
partials. Two numbers are now in play and they measure different things:
16.13 MiB is the COMPONENT bytes that differ when the loader rebuilds, and
3.17 MiB is `u-boot.bin.signed` inside every published factory image. Neither
is an update-archive cost; there is no update-archive cost.

## Correction: the flip cost five packages, not one

The measurement above -- one producer moved, so one bump -- was right about
INPUTS and wrong about the cost, and CI run 35471981026 is where that showed:

    FAIL: mica-s905x5m-wireless arm64: depends on the local package
    mica-board-s905x5m as 'mica-board-s905x5m (= 0.1.0-2)', which is neither
    unversioned nor that package's exact pool version (= 0.1.0-3)

An inputs hash sees the bytes a producer reads; it cannot see a version
written into a SIBLING producer's control template. Three of this board's
control files pin a cross-producer dependency by literal version (the
same-producer ones use `@VERSION@`), so bumping the board package forces:

    mica-board-s905x5m            0.1.0-2 -> 0.1.0-3   the flag
    mica-s905x5m-wireless   \
    mica-s905x5m-wifi        >    0.1.0-3 -> 0.1.0-4   their control pins the board package
    mica-bm201-front-panel  /
    mica-s905x5m-bluetooth        0.1.0-6 -> 0.1.0-7   its control pins mica-s905x5m-wireless

Five packages across three producers, epoch 1789855200 for all three. Verified
locally before pushing again: `make pool POOL_BOARD=s905x5m POOL_ARCH=arm64`
and `make package-gate --board s905x5m --arch arm64`, 64/64 checks.

The lesson for the next board-package bump, which is why this is recorded
rather than just fixed: **a version bump propagates along declared
dependencies, and `tools/deb/package-inputs.sh` does not model that.** The
package gate does, and it is the thing to run -- not the inputs diff -- when
asking what a bump costs.

## And the second thing CI caught: outputs.tsv

`boards/s905x5m/outputs.tsv` did not list `evidence.json`, so the components
job refused the staged board component -- "unexpected evidence.json" -- after
the kernels were built. cx3576 lists it; the new board did not, because the
file is new here.

Fixed by the row, and gated so it cannot recur: `board-contract-test` now
compares the `file board` rows of every board's `outputs.tsv` (minus the
generated `trust/`) against the files that board directory actually carries.
It needs no certificates and no build, so it runs in `make check` in no time,
where CI could only see it after the expensive part. Verified by removing the
row again: the gate names the file.

Two CI rounds, two gates added, and both failures had the same shape -- a
declaration somewhere else in the tree that a local measurement did not model.
The inputs hash did not model a version pinned in a sibling's control file;
`make check` did not model the component file list. Both do now.

## The release, and the second method correction

`s905x5m.20260919-2259` from `a15dbf8`, `SHA256SUMS` sha256
`99425cc8495035d5922c322dd6114b4eee55bd991be085e5198eaa71729c99e6`, verified
anonymously.

    board     REBUILT  9 layers (evidence.json is new)
    kernel    REBUILT  and byte-identical, 14 of 14 layers
    uboot     REBUILT  4 of 12 files differ, the known vendor-signing set
    firmware  REUSED   inputs bfafea529122 unchanged

The prediction in this record said kernel, uboot and firmware would all be
reused. It was measured against `1d8b274`, a working commit from the same
hour, and `tools/reuse.sh` compares against the board's LATEST RELEASE. The
mirror hook had changed `common/scripts` since `s905x5m.20260916-0857`, and
`common/scripts` is in the kernel and uboot component inputs, so both rebuilt
-- correctly.

**The rule, as method rather than as an incident: to ask what a release will
reuse, compare the component inputs against the latest release, not against
the working tree's parent.** A prediction measured against the wrong baseline
is not a weaker prediction; it is an accurate answer to a different question.

Both rebuilds were free where it matters: the kernel came out byte-identical,
so the toolchain and the mirror change moved its inputs and not its output,
and the U-Boot differs in exactly the four files of
[20260916-0620](20260916-0620-s905x5m-uboot-not-reproducible.md) -- the other
eight layers, including all five host tools, are identical.
