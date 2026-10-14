# Building CX3576-Z (Rockchip RK3576)

The board's bootloader and kernel are built here. Each component is a buildkit
Dockerfile producing finished artifacts under `_out/`, where every build
product of the repository is; nothing here builds or modifies the Mica OS
rootfs, which `rootfs/` owns.

The Dockerfiles are ORCHESTRATION. The build steps themselves are
scripts beside them -- `common/scripts/` for what the two builders share,
`<component>/build.sh` for the rest -- and every edit to a vendor tree is a patch
listed in that component's `patches/series`.

`Makefile` in this directory drives every target. The repo root delegates to it:
`make cx3576-<target>` runs `make -C boards/cx3576 <target>`.

## Layout

- `loader/` — mainline U-Boot v2026.07 + rkbin blobs -> `u-boot-rockchip.bin` (eMMC sector 64).
  `make cx3576-firmware` (`uboot-mica`) builds the A/B variant with the redundant environment
  and the `boot.scr` contract into `_out/cx3576/uboot-mica/`, the one the Mica OS image takes
- `kernel/` — armbian rk-6.1-rkr5.1 (6.1.115): config baseline, in-tree dts, patches -> `Image`, `modules.tar`, `rk3576-src.dtb`.
  The config must satisfy `common/kernel/mica-required.fragment`
- `common/scripts/` — the steps the kernel and U-Boot builders share: dependency
  install, pinned source fetch, series-driven patch application. The U-Boot
  target reaches them through the `bsp-scripts` build context, which is why its
  own build context can stay `loader/`
- `package/` — the board package: its `hwinit/` programs and units and the
  hardware facts of `init/` they read

The Mica OS image consumes `uboot-mica/` and `kernel/` from `_out/`,
defaulting to that directory and overridable with `BSP_OUT`.

## Flashing

Flashing is an operator procedure, not tree content: the assembly builds components and products and carries no
flashing tooling. The `rkdeveloptool` procedure for Loader and Maskrom mode,
the read-back that precedes the reset, and the native macOS build of the tool
are in `mica:docs/hardware/cx3576.md`, `mica:docs/user/flashing.md` and
`mica:docs/boards/cx3576/rkdeveloptool/`. The committed vendor loader
`loader/MiniLoaderAll.bin` (with its sha256) is what a Maskrom recovery pushes
first; it is never embedded in the image and is not a U-Boot build input.

Upstream provenance and the deliberate deviations from it are recorded in
`mica:docs/boards/cx3576-bsp-sync.md`.
