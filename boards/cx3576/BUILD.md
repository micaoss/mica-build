# Building CX3576-Z (Rockchip RK3576)

The board's bootloader and kernel are built here. Each component is a buildkit
Dockerfile producing finished artifacts under `_out/` (RFCT-343
moved them there from `out/` beside this file, so every build product in the
repository is under one directory); nothing here builds or modifies the Mica OS
rootfs, which `rootfs/` owns.

The Dockerfiles are ORCHESTRATION. Since RFCT-345 the build steps themselves are
scripts beside them -- `scripts/` for what the two builders share,
`<component>/build.sh` for the rest -- and every edit to a vendor tree is a patch
listed in that component's `patches/series`. The gate on that move was byte
identity: all eleven artefacts came back unchanged.

`Makefile` in this directory drives every target. The repo root delegates to it:
`make cx3576-<target>` runs `make -C bsp <target>`.

## Layout

- `uboot/` — mainline U-Boot v2026.07 + rkbin blobs -> `u-boot-rockchip.bin` (eMMC sector 64).
  `make uboot` builds the v1/Alpine debug variant into `_out/uboot/`; `make uboot-mica`
  builds the A/B variant with the redundant environment and the `boot.scr` contract
  into `_out/uboot-mica/`, which is the one the Mica OS image takes
- `kernel/` — armbian rk-6.1-rkr5.1 (6.1.115): config baseline, in-tree dts, patches -> `Image`, `modules.tar`, `rk3576-src.dtb`.
  The config must satisfy `common/kernel/mica-required.fragment`
- `scripts/` — the steps the kernel and U-Boot builders share: dependency
  install, pinned source fetch, series-driven patch application. The U-Boot
  target reaches them through the `bsp-scripts` build context, which is why its
  own build context can stay `uboot/`
- `init/` — board hardware facts consumed by the `hwinit`
  systemd units

The Mica OS image consumes `uboot-mica/` and `kernel/` from `_out/`,
defaulting to that directory and overridable with `BSP_OUT`.

## Flashing

Flashing is an operator procedure, not tree content (user decision,
2026-09-22): the assembly builds components and products and carries no
flashing tooling. The `rkdeveloptool` procedure for Loader and Maskrom mode,
the read-back that precedes the reset, and the native macOS build of the tool
are in `mica:docs/hardware/cx3576.md`, `mica:docs/user/flashing.md` and
`mica:docs/boards/cx3576/rkdeveloptool/`. The committed vendor loader
`loader/MiniLoaderAll.bin` (with its sha256) is what a Maskrom recovery pushes
first; it is never embedded in the image and is not a U-Boot build input.

Upstream provenance and the deliberate deviations from it are recorded in
`docs/boards/cx3576-bsp-sync.md`.
