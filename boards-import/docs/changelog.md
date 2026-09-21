# Changelog

## 2026-09-21 09:11 [fix]

`s905x5m.20260920-1536` shipped a kernel whose forced command line is not the
one the same release's `board.env` declares: the logo round added
`fbcon=logo-pos:center,logo-count:1 vt.global_cursor_default=0` to `board.env`
and not to `kernel/config/signed-boot.fragment`, which is where this board
keeps `CONFIG_CMDLINE`. Measured in the published component, both profiles. On
a FIT board the built-in line is what the device boots with, so it is not
cosmetic, and the assembly refuses to package it
(`mica-build:build/src/kernel-package.ts:149`, correct as written). The
fragment now carries the declared line and
`boards/s905x5m/tests/kernel-cmdline-test.sh` holds the two equal -- cx3576
had that test and this board did not, which is the whole gap. A new release is
required for the fix to reach anything. Recorded in
`docs/task/20260921-0911-s905x5m-forced-line-and-its-declaration.md`.

## 2026-09-20 17:30 [progress]

The lock vectors are mica's, at the commit `tools/vectors.pin` names, with
`tests/vectors/excluded.tsv` declaring the paths this repository does not
carry and one reason each. `tests/vectors-sync-test.sh` (`make
vectors-sync-test`, CI beside `make deps` because it is the one gate that
reaches the network) fetches that commit and refuses any other difference in
either direction, compared as blobs; `expected.tsv` is rebuilt from canonical
rather than copied, and all five of its refusals were observed before it was
recorded. The refresh found the copy was canonical at `f742615` minus 14
files with EIGHT fixtures still naming `x64`, the board this repository
retired on 2026-09-16. `tools/check-lock.sh` gained the `data` row
(release-lock.md 1.2.4, not base-only) and a `vectors-pin` mode for the pin
format, and the `repos/` vectors -- carried and skipped by the only thing
that read them -- are declared rather than counted. 82 assertions to 95, 64
vectors to 74. Recorded in
`docs/task/20260920-1730-the-vectors-are-read-from-mica-at-a-pin.md`.

## 2026-09-20 17:00 [progress]

The shared kernel floor is a file row of every board bundle:
`common/kernel/mica-required.fragment` ships beside the config it resolved,
as `kernel/mica-required.fragment` on the UEFI boards and under
`kernel/dev/` and `kernel/prod/` on the FIT boards, one `outputs.tsv` row
each. mica-build asserts the floor against the config of the bundle it fetched
at its pin (`build/src/kernel-package.ts`) and keeps no copy of the symbol
list -- the reader this replaces carried one and decayed. Both halves of the
fragment are asserted there, the `=y` lines and the `# ... is not set`
lines, so the gap found earlier today is not rebuilt one repository further
out; a stale bundle fails its own floor instead of passing quietly. The off
half also ran on cx3576 and s905x5m for the first time in CI 35521519448 and
holds on both, although their vendor inputs carry six of the nine symbols
`=y` before the floor is merged over them. Recorded in
`docs/task/20260920-1700-the-floor-travels-with-the-config.md`.

## 2026-09-20 16:00 [progress]

A `# CONFIG_X is not set` line in a kernel fragment is a REQUEST: kconfig
grants it unless something enabled `select`s the symbol, and nothing in this
repository asked afterwards whether it had been granted. Both halves of the
shared floor are now asserted over the resolved config --
`common/kernel/floor-check.sh` and both UEFI kernel Dockerfiles refuse any
`CONFIG_X=` line for a symbol a fragment records off -- with
`tests/floor-check-fixtures.sh` (eight fixtures) as the negative half in
`make check`. Run over the two recorded resolved configs it found twenty
denied requests. One is a shared floor line: `CGROUP_NET_CLASSID=y` on
uefi-x64, selected by `NET_CLS_CGROUP=y` from that board defconfig, which
uefi-arm64, s905x5m and cx3576 do not set; the classifier is now named off,
which is the two-line change to that board config. Of the nineteen on
uefi-arm64, deleting all of them moved exactly one symbol
(`MDIO_BCM_UNIMAC`, `m` to `y`), so eighteen were inert and one was partly
granted; it is now written as `CONFIG_MDIO_BCM_UNIMAC=m` and that board
recorded config is byte-identical to `uefi-arm64.20260920-1536`. Recorded in
`docs/task/20260920-1600-a-fragment-off-line-is-a-request.md`.

## 2026-09-20 [progress]

Measured while costing the boot logo, and it corrects a shorthand rather than
only adding a number: a LOCAL CROSS build of the uefi-arm64 kernel reproduced
byte for byte what a NATIVE arm64 runner published
(`kernel.uefi-arm64.20260916-0857`, `Image` 24537600). So cross-versus-native
is not the variable that decides whether two builds agree -- whether they use
the same pinned toolchain is. The emulated-on-target pool agreed with the
native one, mica-core's Rust disagreed with a DIFFERENT cross toolchain, and
this agrees with the SAME bsp compiler used as a cross.


## 2026-09-20 [progress]

First hardware observation of Mica OS on cx3576, read out of the console
capture rather than summarised: the vendor loader verified this project's key
on real silicon (`sha256,rsa2048:mica+ OK` for kernel, fdt and ramdisk), the
signed command line carried `dm_verity.require_signatures=1` and
`mica.profile=prod`, native init selected and verified its deployment, and
`mica-health.service` confirmed it. The kernel identifies itself as `6.1.115`
built by the bsp toolchain with `#1 SMP @1577836800` -- the `kernel.release`
`cx3576.20260917-1007` published, pinned by `mica-build`'s
`cx3576.20260919-2356`, so the run binds to published bytes. `evidence.json`
records the observation and stays I1: the capture is a loader-initiated warm
reset, so it is neither the cold-boot nor the warm-boot qualification row, and
the enforcement half of I3 -- an unsigned FIT refused on the same bench -- is
not observed. Recorded in
`docs/task/20260920-cx3576-first-hardware-capture.md`, which also lists what
the capture does not establish.


## 2026-09-19 [progress]

`s905x5m.20260919-2259`, this board's first release as a release target, from
`a15dbf8`. The board component rebuilt and now carries `evidence.json`, the
kernel rebuilt BYTE-IDENTICALLY (14 of 14 layers, so the mirror hook moved its
inputs and not its output), the U-Boot rebuilt and differs in exactly the four
files of the vendor-signing defect, and the firmware was reused by digest. Two
method corrections came out of the round and are recorded as method: a version
bump propagates along declared dependencies and an inputs hash cannot see a
version pinned in a sibling producer's control template, so the package gate
is what answers "what does this bump cost"; and what a release will reuse is
asked by comparing component inputs against the LATEST RELEASE, not against
the working tree's parent.


## 2026-09-19 [progress]

s905x5m is a release target (`BOARD_RELEASE_TARGET=1`, user decision). Its
`evidence.json` was written first, because `mica-build`'s release manifest
requires one and derives the product's boot assurance from it: I1, the same
grade as cx3576 at the same support tier, with the physical boundaries of this
board's Amlogic USB recovery path and a qualification that states plainly what
is not established -- no image published before, physical rows untested,
RFCT-922 open, and a loader that does not rebuild byte-identically. The flag
costs five package versions, not the one the inputs diff predicted:
`mica-board-s905x5m` `0.1.0-3`, and with it `mica-s905x5m-wireless`,
`mica-s905x5m-wifi` and `mica-bm201-front-panel` `0.1.0-4` and
`mica-s905x5m-bluetooth` `0.1.0-7`, because three control templates pin a
cross-producer dependency by literal version and an inputs hash cannot see a
version written into a sibling producer's control file. The kernel, U-Boot and
firmware components are unchanged and reused by digest. None of this
claims the board works on hardware.


## 2026-09-19 [progress]

A mirrored tree whose manifest resolves but whose chunk does not now names the
chunk and its status -- `the mirror has the manifest of <name> <commit> but not
its chunk <i> of <n> (curl 22, HTTP 404, ...)` -- and
`tests/mirror-hook-test.sh` keeps the case that produces it. It is the real one:
the restored mirror 404s on `uefi-x64-kernel` `.pack.00` because the two UEFI
trees do not share a pack after all (different pack digests; only their first
chunk hashes the same, stored under the arm64 name). The hook routes around
nothing -- no sibling name, no digest fallback, no special case for chunk 00 --
it falls back to the clone and says why.


## 2026-09-19 [progress]

A mirror miss now says why. `mirror_get` records `curl <exit>, HTTP <code>,
<n> redirect(s), <final url>`, a miss prints it and a hit that followed a
redirect says so, because "not mirrored" alone is how the mirror could stop
answering between 2026-09-17 (11 of 11 fetches mirrored) and 2026-09-19 (0 of
11) with every run green. Both halves of the contract have always followed
redirects -- one `mirror_get` with `-L` serves the digest lookups and the pack
chunks alike -- and `tests/mirror-hook-server.py` now proves it by answering a
`/r/` prefix with a 302 and fetching an archive and a two-chunk pack through
it.


## 2026-09-19 [progress]

The board-independent radio packages stay in each board's pool, recorded with
its reason in `docs/task/20260919-1945-shared-radio-packages-stay-per-board.md`:
a board release is self-contained, and the duplication a consumer sees
(`mica-bluetooth`, `mica-wifi` and `mica-wifi-ap`, identical in `cx3576` and
`s905x5m`) is collapsed where two boards are composed, which is the only place
that sees both. The equality is by construction -- no producer of these takes a
board input of any kind -- and the one vector that could have broken it was
measured away: built on an amd64 host they are byte-identical to the archives
the arm64 runners published. A board that ever needs different radio bytes gets
a different package name, as `mica-s905x5m-bluetooth` already does.


## 2026-09-18 [progress]

The git half of the mirror hook follows mica-res's rebuilt resource service:
`common/scripts/fetch-source.sh` asks for `upstream/git/<name>/<commit>.json`
and its `.pack.<NN>` chunks without the retired `d/` prefix;
`res.micaos.dev` redirects them to the R2 download host and `mirror_get`
follows. Archives are still looked up at `blob/<sha256[0:2]>/<sha256>`, which
only `res.micaos.dev` answers, so `MICA_MIRROR` is unchanged.
`tests/mirror-hook-test.sh` serves the new layout (25 assertions).

## 2026-09-17 [progress]

`boards/cx3576/flash/assets/splash.png` shows the **Mica OS** icon above its
wordmark instead of the retired **YBO - Hub OS** text. mica-res's
`mica/brand/logo/mica-os-icon-dark.svg` (360 px wide, at +656+184) and
`mica-os-wordmark-dark.svg` (600 px wide, at +536+552) are rasterised with
`rsvg-convert` and composited on a 1672x941 radial gradient from
`rgb(6,76,95)` to black (radii 760x480) with ImageMagick, and saved as 8-bit
truecolour without alpha or timestamps (`debian:trixie-slim`, `librsvg2-bin`,
`imagemagick`). `mklogo.py` derives a 720x405 logo of 223 colours from it. The
bench collector's expected-logo prompt names Mica OS, and `tests/publish-test.sh`
finds the reference lock checker at `../mica` beside this checkout instead of
the retired `/srv/ybolab` path.

## 2026-09-16 [progress]

Every builder fetches through `common/scripts/fetch-archive.sh` and
`common/scripts/fetch-source.sh`, which try mica-res's mirror before a pinned
row's own URL: `blob/<sha256[0:2]>/<sha256>` for a `source` row, and for a `git`
row the `mica/git-pack/v1` manifest, its chunks in order and `git index-pack`.
A lock URL is never rewritten -- it is in the component inputs hash -- so
`MICA_MIRROR` is a fetch-time environment variable and is nowhere in
`tools/inputs.sh`. Wrong bytes from the mirror are refused rather than fetched
again; a 404, a refused connection and a timeout all mean "not mirrored" and
cost one three-second connect. `tests/mirror-hook-test.sh` (25 assertions,
`make check`) serves the contract locally, and a real `uefi-x64` source stage
with the mirror set but unreachable *from this build host's container egress*
-- it answers from GitHub runners -- fell back after 3.178 s.
`mica-s905x5m-bluetooth` is `0.1.0-6`: the board Makefile carries the mirror
argument and that file is in its `PREPARE_INPUTS`. Decided the same day and
recorded in the task: `PREPARE_INPUTS` is not narrowed. One bump on one package
per board-Makefile edit is the accepted cost; an under-declared input would be
a package shipped stale and found by a device rather than by CI.

## 2026-09-16 [progress]

The s905x5m recovery packer runs on `linux/amd64`, not `linux/386`: the pinned
`aml_image_v2_packer` is a statically linked i386 binary an x86-64 kernel runs
directly, and packing the published `20260916-0857` U-Boot artifacts on amd64
reproduces that release's `update.img` and `aml_sdc_burn.ini` byte for byte. It
is also deterministic, so `update.img` follows the two signed U-Boot binaries
rather than being a second reproducibility defect. That removes the only
`linux/386` platform in the repository. There is no 64-bit vendor packer to pin
instead, and `aml-imgpack.py` packs `AML_RES!` resource images, not this
`0x27b51956` container.

## 2026-09-16 [progress]

`mica-s905x5m-bluetooth` is `0.1.0-4` (epoch 1789545600): the bsp switch edited
`boards/s905x5m/Makefile`, which that producer declares in `PREPARE_INPUTS`, so its
inputs moved while its version did not and the guard refused it in CI. Measured
against the published pool of `s905x5m.20260916-0558`, it is the only producer of
any board whose inputs the switch moved; the other seven packages of that board
rebuild byte-identical under the bsp toolchain, as do cx3576's four. Third time in
one day that the version guard has caught an input change a human would have
shipped (the `tools/deb/producers.sh` pipe-hygiene edit, mica-core's `mica-apid`
after a lint edit, and this Makefile edit reaching a package through
`PREPARE_INPUTS`).

## 2026-09-16 [progress]

The kernel, U-Boot and loader builders build FROM the mica-build-env `bsp` image
(release `20260916-0735`, pinned by digest in `locks/mica-build-env.lock`) instead
of installing a toolchain from the Ubuntu archive snapshot: no build of this
repository fetches an apt byte any more, and the 502/503 outage of
snapshot.ubuntu.com earlier today is exactly the failure this removes.
`common/scripts/apt-install.sh`, `tools/apt-snapshot.sh` and the three
`ubuntu-<suite>` rows of `locks/upstream.lock` are gone; the toolchain enters the
kernel and U-Boot inputs as the image digest (`tools/inputs.sh`), and the cross
packages come with the image's amd64 variant rather than from
`KERNEL_CROSS_PACKAGES`, which is retired with them. The three vendor toolchains
of the s905x5m U-Boot stay `source` rows fetched at their pinned sha256.

## 2026-09-16 [progress]

The generic systems are named by their firmware class (user decision 2026-09-16):
`boards/x64` is `boards/uefi-x64` and `boards/virt-arm64` is `boards/uefi-arm64`;
the hardware boards keep their names. The packages are new names with fresh
declared versions, `mica-board-uefi-x64` and `mica-board-uefi-arm64` at `0.1.0-1`
(not bumps of the old ones); `boards/boards.tsv`, each board's `outputs.tsv`, the
kernel config and required file names, the `<board>-kernel` git rows of
`locks/upstream.lock`, the tests, the READMEs and `evidence.json` follow. Every
identity stays as it was -- the partition GUIDs, the filesystem UUIDs and the ESP
volume ids are the same boards under new names.

uefi-arm64 is now the generic UEFI/ACPI arm64 image and a release target
(`BOARD_RELEASE_TARGET=1`). Its kernel keeps virtio and adds what a generic UEFI
machine needs to reach its root before any module can load: NVMe, AHCI/SATA, SCSI
disk, USB mass storage behind xHCI/EHCI, PCIe port services, HID, ACPI, DMI and
the EFI and PL031 clocks. The physical NIC families (Intel, Realtek, Broadcom,
Mellanox, Aquantia) and their PHYs are modules: networking is not on the path to
the root. SD/eMMC is deliberately absent -- a machine that boots from a platform
MMC controller is a hardware board, not this image.
`kernel/config/uefi-arm64.required` now holds mica-build's list (read from the
built config of its bundle, every entry `builtin`) together with that hardware
set, and `tools/kernel-config-test.sh` holds the resolved config to it.

## 2026-09-16 [progress]

Board release tags are `<board>.<YYYYMMDD-HHMM>` (user decision 2026-09-16, mica
`docs/decisions/2026-09-16-scoped-tags-use-a-dot.md`; spec f742615). No
compatibility form: `tools/check-lock.sh` splits a release row at its last dot, so
a slash leaves the release out of form and is refused as `field-value`
(`tests/vectors/lock/refused/release-slash.lock`). `tools/deb/registry.sh` matches
and splits the tag on the dot, `release.yml`'s scope job parses it, and
`tools/reuse.sh` and `tools/deb/version-guard.sh` resolve "the board's latest
release" by the `<board>.` prefix. The spec vectors were re-copied at the dot form;
`tests/publish-test.sh` and `tests/version-guard-test.sh` tag their fixtures with
it, and the version-guard test now declares the version it asserts. Pins are
unchanged (`RELEASE` and `SCOPE` stay separate fields).

## 2026-09-16 [progress]

Every producer's revision is bumped (epoch 1789516800): the pipe-hygiene commit
edited `tools/deb/producers.sh`, which the package inputs hash covers as packaging
tooling, so the version guard refused the unchanged versions in CI -- the guard
working as designed. `mica-board-*`, `mica-wifi`, `mica-wifi-ap` and
`mica-bluetooth` are `0.1.0-2`; the s905x5m extras `mica-s905x5m-bluetooth`,
`mica-s905x5m-wireless`, `mica-s905x5m-wifi` and `mica-bm201-front-panel` are
`0.1.0-3`, with their literal cross-producer pins moved with them.

## 2026-09-15 [progress]

Early-exiting readers on the right of a pipe, the defect class mica docs found in
its own gate. Fixed here: `tools/deb/registry.sh` held `printf | grep -qxF` as the
membership test for the release tag -- under `pipefail` it reports failure exactly
when the tag is found and the writer still has bytes to write, so a release whose
HEAD carried several tags could fail on the tag it had -- now a loop; and the
`| head -n1` pipelines of `tools/component.sh`, `tools/deb/producers.sh`,
`tools/kernel-config-test.sh`, `tools/new-board.sh`, `tests/board-contract-test.sh`
(`grep -m1`), `tools/deb/oci.sh` (an `awk ... exit` over the header file),
`boards/cx3576/tests/{kernel-cmdline-test,gadget-configfs-test}.sh` and
`boards/cx3576/tests/bench/collect.sh` (three), where a second match would kill the
producer with SIGPIPE. `tests/shell-lint.sh` now also scans a library sourced by a
file that sets pipefail -- registry.sh was out of its scope, which is why the defect
survived there.

## 2026-09-15 [progress]

cx3576 flashing, three fixes found while writing the product documentation's
flashing guide: `loader/MiniLoaderAll.bin.sha256` named `uboot/MiniLoaderAll.bin`,
so `make flash-maskrom` failed at its checksum step before reaching
`rkdeveloptool db`; `flash/rkdeveloptool/build-macos.sh` installed the built
binary in `boards/cx3576/tools/` while the Makefile looks in
`boards/cx3576/flash/tools/` (now the build's output, and git-ignored); and
`BUILD.md` and `flash/rkdeveloptool/README.md` still named `make flash` and
`make flash-rootfs-offline`, targets this board no longer has. The flashing
section now describes the two targets it has, the image they take and the
geometry preflight.

## 2026-09-15 [progress]

CI reuses kernel and U-Boot components (user decision on the kernel speed report,
proposal 2): the plan no longer builds a kernel or uboot component whose inputs
hash equals the one the board's latest published release carries
(`tools/reuse.sh`); that release is the proof the component builds. A push or
pull request that changes a file the component jobs run but the inputs hash does
not cover (`BUILD_FILES` in `build.yml`: the workflows, the root `Makefile`, the
lock, pin and output tools, `tools/inputs.sh`, `tools/reuse.sh`) builds every
component without moving any component's inputs; so does a run with no base
commit (a manual run) and a push whose previous head is not an ancestor of the new
one (a force-push). A multi-commit push is compared from its previous head, so
every commit in it counts.

## 2026-09-15 [progress]

The GitHub release listing of `tools/reuse.sh` and `tools/deb/version-guard.sh`
sends the workflow's `GITHUB_TOKEN` when one is handed in: anonymous API calls
from the shared runner addresses were refused with 403 in CI. The locks and
artifacts are still read anonymously.

## 2026-09-15 [progress]

virt-arm64 kernel trimmed to mica-build's QEMU virt guest (its evaluation of
the speed report, 2026-09-15): the board fragment switches off at their menus the
physical platforms, SoC buses and peripherals, USB, radios, wired Ethernet
hardware, display, sound, media, extra input, SCSI/ATA/NVMe/MMC, unattached virtio
devices, filesystems nothing mounts and crypto accelerators. The resolved config
goes from 3272 built-in and 1134 module symbols to 1319 and 75; the kernel ships
71 modules instead of 1273. `kernel/config/virt-arm64.required` lists the guest's
symbols (`builtin` =y, `runtime` =y or =m), held by `tools/kernel-config-test.sh`;
`common/kernel/mica-required.fragment` is unchanged.

## 2026-09-15 [progress]

Kernel and U-Boot builds (user decisions on the kernel speed report). FIT boards
compile their kernel once: dev is built whole, prod only moves the forced command
line (`common/kernel/set-profile.sh`) and relinks the Image in the same tree, with
the modules, device tree and regulatory certificates of that build;
`KBUILD_BUILD_VERSION=1` keeps the relink's version string. `make <board>-kernel-profile-test`
builds prod alone and requires every file byte-identical to the relinked one
(`common/kernel/profile-test.sh`). Every kernel and U-Boot builder installs its
toolchain from the Ubuntu archive snapshot 20260915T000000Z, pinned by the sha256
of each suite's signed InRelease in the `ubuntu-<suite>` source rows of
`locks/upstream.lock` (`tools/apt-snapshot.sh`, `common/scripts/apt-install.sh`,
part of the kernel and U-Boot inputs); the s905x5m recovery packer is fetched by
`ADD --checksum` into the pinned Debian image with nothing installed. The profile
test found the s905x5m kernel was not reproducible at all: three vendor
`common_drivers` Makefiles compiled a wall-clock `BUILD_TIME`; kernel patch 0018
takes it from `SOURCE_DATE_EPOCH`.

## 2026-09-15 [progress]

The s905x5m Bluetooth userland builds in the mica-build-env `c` image, pinned by
digest in `locks/mica-build-env.lock`, instead of installing Debian's
build-essential unpinned on `debian:trixie-slim`, so its compiler cannot move under
an unchanged `mica-s905x5m-bluetooth` version (the payload is byte-identical to the
0.1.0-1 build); the pool job's userland prefix cache is gone with that stage. A
control template pins another producer's package by its literal version
(`@VERSION@` only within one producer). `mica-s905x5m-bluetooth`,
`mica-s905x5m-wireless`, `mica-s905x5m-wifi` and `mica-bm201-front-panel` are
0.1.0-2 (epoch 1789473600).

## 2026-09-15 [progress]

Package versions (user decision, mica `docs/decisions/2026-09-15-package-versions.md`):
a package is locked by its declared version and a release never changes it. Each
producer declares `VERSION` and `SOURCE_DATE_EPOCH` in `version.env` beside its
control templates (`boards/<board>/package/version.env` for the board producer);
every producer starts at `0.1.0-1`, epoch 1789430400. The root `VERSION`,
`tools/deb/version.sh`, `VERSION_FROM` and the `Mica-Source-Commit` field are gone.
`tools/deb/package-inputs.sh` no longer hashes build-env images and takes a hook's
inputs from `PREPARE_INPUTS`; `tools/deb/version-guard.sh`, run in `build.yml`'s pool
job for every board in CI and for the release's board, refuses changed inputs
without a bump, a lower version and an unchanged version whose bytes moved. Pool
manifests carry only `mica.source-repo` and `mica.arch` (layers: title,
`mica.inputs`), so an unchanged pool keeps its digest. The package gate checks each
archive against its declared version instead of one git stamp. This replaces the
identity-rebuild reuse of the entry below (`tools/deb/reuse.sh`,
`tests/package-reuse-test.sh` removed); `tests/version-guard-test.sh` (`make
version-guard-test`) covers it.

## 2026-09-15 [progress]

Package reuse by inputs (user decision): a board release keeps an unchanged
package at its published version and bytes instead of re-versioning it. Each pool
layer carries its producer's inputs hash as `mica.inputs`
(`tools/deb/package-inputs.sh`). In a board release's pool job,
`tools/deb/reuse.sh` reads the board's latest release, downloads the archives of
every producer whose inputs are unchanged at their layer digests, holds them to
that lock's package rows, rebuilds the producer as their identity
(`MICA_DEB_IDENTITY`: Version, Mica-Source-Commit, SOURCE_DATE_EPOCH) on an
empty-cache builder and takes them only when byte-identical, and writes
`reused.tsv`; a missing, mismatching or unreproduced archive stops the release.
The package gate holds reused archives to those rows like imports, the publisher
accepts them from their own commit and, when every archive is reused and the
layers are the previous pool's, puts that pool manifest under the new tag. No lock
row or specification change. `tests/package-reuse-test.sh` (`make
package-reuse-test`): reused, rebuilt, pool digest kept, and three refusals.

## 2026-09-15 [progress]

`images.tsv` declares update packages too: every board has `image disk builtin -
img` and `update full|root|kernel builtin - micaupd|root.micaupd|kernel.micaupd`.
`board-contract-test`: an image disk builtin row and an update full row, builtin
only on disk among images, update kinds full, root and kernel (all builtin), `-` as
the runtime image of a builtin row and a build-env image row otherwise, kinds and
suffixes unique within each row type.

## 2026-09-15 [progress]

Workflow outputs travel as uniquely named tars (`tools/ci-outputs.sh`), uploaded
as `<scope>-<name>` and downloaded with `merge-multiple`: a board release's single
pool artifact failed `build / pools` because `download-artifact` extracts a single
matching artifact into the path itself, and the components check silently took an
undownloaded kernel for a reused one. The components check now expects exactly the
tars the plan built, and `ci.yml` also runs the one-board path (`build-board`, x64).

## 2026-09-15 [progress]

Flashing formats (user decision): every board declares what it is flashed with in
`boards/<board>/images.tsv` (`# mica-boards images v1`; rows `image <kind> <packer>
<runtime image> <suffix>`), carried in its board component and covered by its
inputs hash. All four boards declare `image disk builtin mica-build-env:base img`.
`IMAGE_KINDS` is gone from `board.env`; `board-contract-test` requires the disk row
with `builtin`, no other `builtin` kind, unique kinds and suffixes, and runtime
images named by `locks/mica-build-env.lock`.

## 2026-09-15 [progress]

Board components (user decision, mica 1cd0fdd): a board release publishes its
components as separate artifacts, `<component>.<board>.<YYYYMMDD-HHMM>` --
board, kernel, and uboot and firmware where the board has them
(`tools/component.sh`) -- each annotated with `mica.component` and `mica.inputs`,
the sha256 of everything that determines it (`tools/inputs.sh`). A component
whose inputs equal the same component of the board's latest release is reused by
digest and not built (`tools/reuse.sh`, `tools/publish-components.sh`). The lock's
board rows are `board <board> <component> <arch> <reference>`; `outputs.tsv` names
`file <component> <path>`; `mica-kernel-<board>` is retired. `build.yml` builds
each board's kernel natively on its architecture's runner and U-Boot on x86-64
(the FIT host tools the assembly runs there; s905x5m's i386 packer).

## 2026-09-15 [progress]

Releases are per board (user decision): `gh release create <board>/<YYYYMMDD-HHMM>`
builds, gates and publishes that board alone -- `pool.<board>.<arch>.<YYYYMMDD-HHMM>`,
`board.<board>.<YYYYMMDD-HHMM>` and a `mica-boards.lock` whose release row is
`<board>/<YYYYMMDD-HHMM>`. `boards/boards.tsv` lists the supported boards, one
row each (architecture, boot backend); `boards/<board>/outputs.tsv` names the
board's pool packages and bundle files and travels in its bundle. `tools/boards.sh`
reads them for `build.yml` (the plan job), `make pool POOL_BOARD=`, the package
gate (`--board`), the publishers, `release-lock.sh`, `make offline` and
`board-contract-test`. CI keeps building every board.

## 2026-09-15 [progress]

Release lock (mica:docs/design/release-lock.md). Inputs are in `locks/`:
`locks/mica-build-env.lock` with `locks/pins/mica-build-env.pin` (mica-build-env
`20260915-0138`) gives every image, build-env images by name and third-party
images by their upstream rows (`tools/from.sh`); `locks/upstream.lock` pins the
kernel, U-Boot and rkbin trees as git rows and the s905x5m toolchains and
packer as source rows (`tools/upstream.sh`). `build-env-image.lock`,
`build-env-release`, `base-images.env`, every `sources.env` and the UEFI
`kernel/versions.env` are gone; the UEFI kernels check their tag's commit.
`tools/check-lock.sh` implements the file rules, `tests/locks-test.sh` runs it
over the specification's vectors. A release carries `mica-boards.lock`
(release, pool, package and board rows) and `SHA256SUMS` only
(`tools/release-lock.sh`), written after every pool and bundle reads back
anonymously; both publishers refuse a tag holding another manifest digest.

## 2026-09-14 [progress]

The project name is mica everywhere in the tree: the shared inputs are
`common/kernel/mica-required.fragment` and `common/uboot/mica-records.h`; the
build contexts `mica-common`, `mica-trust` and `mica-boot-trust`; the verity
anchor `certs/mica-verity-anchor.pem`; the U-Boot policy `MICA_FILE_BOOT`
(`loader/mica-file-boot.c`, `loader/build-mica.sh`, stage `artifact-mica`),
its environment key `mica_entries` and the `/chosen/mica,deployment-id`
property; the cx3576 targets `uboot-mica` and `flash-mica`; the buildx
builders `mica-<arch>`. The FIT boards build one kernel per image profile
(`kernel/dev/`, `kernel/prod/`), each forcing `mica.profile=<profile>` on its
command line. The build-env images are those of mica-build-env
`20260914-1129` (`build-env-image.lock` and `build-env-release` replaced
whole).

## 2026-09-14 [progress]

Workspace rules and mica-build-env `20260914-0128`
(`20260914-0514-workspace-rules-and-build-env`). The images come from
`build-env-image.lock` (verified against the release's `SHA256SUMS`,
recorded in `build-env-release`) and `base-images.env`, through
`tools/from.sh`; the `build-env/` source pin, `tools/deps.sh` and `deps/` are
gone. Packaging, the package gate and the publisher are this repository's own
under `tools/deb/` and pack in `IMAGE_MICA_BUILD_BASE`. Releases are
`gh release create <YYYYMMDD-HHMM>`: `release.yml` builds that tag and
publishes `pool.<arch>.<release>` and `board.<board>.<release>`; `ci.yml` runs
the gates and, through the reusable `build.yml`, the BSP build on x64 (cross)
and one native pool job per architecture with its package gate. The cx3576
kernel hook reads the boot-logo master at `flash/assets/splash.png`, where the
board layout moved it (the kernel build had failed since).

## 2026-09-14 [progress]

The boot split, step 3: the inputs this repository took from the `mica-boot`
source pin are its own, and the pin is gone. `families/common/kernel/` holds
`mica-required.fragment`, `kernel-config-test.sh` and `export-regdb-certs.py`;
`families/common/uboot/` `mica-records.h` and `embed-fit-trust.sh`;
`families/common/package/` `fstab.in` and `copyright` (taken from
`mica-boot` 302d9cc `common/`; only comments naming paths and key provenance
changed). `families/common/trust/stage.sh` is the
certificate-only half of the former `verity-tool.sh stage`: it validates a
public certificate bundle in the pinned OpenSSL image and stages it for the
kernel and U-Boot builds; signing and every private key belong to the
assembly, and nothing here generates keys. `tests/trust-stage-test.sh`
(`make trust-stage-test`, docker) covers it.

## 2026-09-13 07:40 [progress]

Phase 1 of `mica:20260913-0416-board-product-build-architecture`, board
contract v2 and the family layer. Every `board.env` declares
`BOARD_FEATURES`, `BOARD_FAMILY` and `IMAGE_KINDS`; the package manifests
moved here from the assembly as `<board>/manifests/` and travel in the
`mica-kernel-<board>` bundle; `bsp/containers.env` is gone (the product
decides features). `families/` holds what the boards of one SoC line
share: `uefi` (x64, virt-arm64: one kernel Dockerfile), `rockchip`
(cx3576) and `amlogic` (s905x5m), each with its Dockerfiles, configure and
build scripts and source pins; a board keeps its configuration, device
tree, patches, firmware and the hooks the family calls, and names its
files in `bsp/bsp.env` (`families/README.md`). Proof: every board's kernel
rebuilt through its family byte-identical to a build of the same pins
before the change (config, release, modules, System.map, DTB; the
s905x5m `Image` carries a 25-byte vendor build stamp that differs between
any two builds, and its `modules.tar` now pins mtimes and order like the
other families'); cx3576 and s905x5m U-Boot likewise.
`tests/board-contract-test.sh` asserts the contract in `make check`.

## 2026-09-13 19:30 [progress]

Created from `boards/{x64,virt-arm64,cx3576,s905x5m}/` of `mica-build`
(each kept through `git subtree split`, briefly a repository of its own,
then brought in here with that history under `<board>/`). The BSP builds
take the boot tooling from the `mica-boot` source pin at `boot/` and the
shared inputs from `boot/common`; a `mica-kernel-<board>` producer per board
packs the BSP outputs for the assembly. Published together as
`build-<commit12>` (`20260913-1600-split-boot-and-boards`).
