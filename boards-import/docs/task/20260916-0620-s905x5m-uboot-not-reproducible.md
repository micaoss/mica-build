# 20260916-0620-s905x5m-uboot-not-reproducible The s905x5m U-Boot is not reproducible

- **status**: open
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-16 06:20

## Description

Two builds of the s905x5m `uboot` component from the same inputs produce
different bytes. Measured between the releases `s905x5m/20260915-1926` and
`s905x5m.20260916-0558`: the component's inputs hash (`tools/inputs.sh uboot`)
was unchanged, the toolchain came from the same pinned Ubuntu snapshot
(`locks/upstream.lock` `ubuntu-<suite>` rows, `20260915T000000Z`) and the same
pinned vendor trees, and no commit between the two releases touched
`boards/s905x5m/loader/` or `common/uboot/`. Three files came out different:

- `uboot/u-boot.bin.signed` (6c41bdd55a80... -> 1572ae396fe4...)
- `uboot/u-boot.bin.sd.bin.signed` (3aff13826d4b... -> 325dd5ee0655...)
- `uboot-package/update.img` (be7dfe9d3d64... -> 42a868b5f068...), and its
  `update.img.sha256` with it -- the recovery container packs the two binaries
  above, so it follows them rather than being a second defect.

Everything else of that release matched byte for byte: the `board`, `kernel`
and `firmware` components of all four boards, and cx3576's `uboot`.

Why it surfaced only now: a board release reuses an unchanged component by
digest (`tools/reuse.sh`), so the s905x5m `uboot` component was published once
and re-tagged at every later release without being rebuilt. The dot-form
cut-over made the reader select releases by the `<board>.` prefix, so the
slash-form releases were invisible and the component was built again -- the
first second build of it since it was created.

Same class as the s905x5m kernel defect fixed by kernel patch 0018
(`common_drivers` Makefiles compiled a wall-clock `BUILD_TIME`, so even two
clean kernel builds differed). The suspects here are the vendor U-Boot build
embedding a build time, a build host or a `git describe` result, and the FIT
or signing step recording a timestamp.

## ActiveForm

Finding what the s905x5m U-Boot build embeds that is not its inputs

## Dependencies

- **blocked by**: the uefi rename round (in progress)
- **blocks**: nothing today -- `boards/s905x5m/board.env` has
  `BOARD_RELEASE_TARGET=0`, so no product is built from this board

## Notes

2026-09-16 06:20: opened from the dot-form cut-over comparison; reported to the
coordinator (uj991oa2). The artifacts published in `s905x5m.20260916-0558` are
valid and signed; they are simply not reproducible from their inputs, so a
later rebuild cannot be proven to be the same U-Boot.

Where to start: build `make -C boards/s905x5m uboot` twice in a row on one host
and diff the two `_out/s905x5m/uboot/` trees (the build is about 2.5 minutes
locally), then bisect the difference with `strings`/`cmp` as patch 0018 was
found. A byte-identity check like `make <board>-kernel-profile-test` should
come out of it, so the answer is kept.

## Update 2026-09-16 16:43: update.img is confirmed downstream, not a defect

The packer was measured directly (see
[20260916-1643](20260916-1643-s905x5m-packer-without-i386.md)): the pinned
`aml_image_v2_packer` is deterministic, and packing the published
`20260916-0857` U-Boot artifacts with this repository's `config/` and `blobs/`
reproduces that release's `update.img` byte for byte. So `update.img` differs
between builds only because `u-boot.bin.signed` and `u-boot.bin.sd.bin.signed`
do, and the open question stays exactly where it was: the two signed binaries.

## Consequence for reuse: this component will always show as changed

For as long as the vendor signing is non-deterministic, the s905x5m `uboot`
component can never rebuild byte-identically, so any release that rebuilds it
publishes different bytes than the one before. That is not a defect in
`tools/reuse.sh`: reuse is decided by the inputs hash, and an unchanged hash
still reuses the published component by digest without rebuilding it. Only a
release whose inputs moved -- a loader change, a new pinned toolchain image --
pays it, and then the difference is expected and must not be chased as a reuse
bug.

**It costs nothing in an update archive, on this board or any other, and an
earlier sentence here said otherwise.** Corrected on 2026-09-19 from
`mica-build`'s code and its published archives: an archive kind is computed
over the root and kernel object families only
(`mica-build:build/src/component-archive.ts`), the deployment descriptor has no
firmware member, and a parsed `MICAUPD1` holds exactly a signed descriptor,
two roothash signatures, `boot.itb`, `support.img` and `rootfs.img`. The loader
sits in `firmware/` beside the archive and enters the factory image only, so a
moved loader cannot force a `full` archive and cannot suppress a partial --
`cx3576.20260916-1653` published a root PARTIAL across a release in which its
`uboot` component moved. What the rebuild costs is COMPONENT bytes, 16.13 MiB
of the twelve files, on the releases whose loader inputs moved; it is not an
update-archive cost. And the corollary is not a property of this board: no
device on any board receives a new U-Boot through an update archive at all --
firmware moves offline only.

## Method note: compare layer bytes, not manifest digests

Every comparison in this record and in
[20260916-1643](20260916-1643-s905x5m-packer-without-i386.md) is a comparison
of the OCI **layer** digests of two published components, not of their manifest
digests. A manifest carries the release string, so its digest moves at every
release even when every byte of every layer is identical; comparing manifests
would report all four boards as changed. The second observation of this defect
(between `s905x5m.20260916-0558` and `s905x5m.20260916-0857`, across the
build-env `bsp` toolchain switch) was made this way: the same three files, plus
`update.img.sha256`, differ and the other eight layers of the component --
including all five U-Boot host tools and `u-boot.dtb` -- are identical.
