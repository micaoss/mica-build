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
- `rootfs/` — Alpine demo rootfs (overlay under `alpine/rootfs/`, installed onto `/`)
  + WiFi firmware blobs (AP6275S / AIC8800 dual SKU); the demo image itself
  ships only the verified AIC8800D80 U02 blobs
- `scripts/` — the steps the kernel and U-Boot builders share: dependency
  install, pinned source fetch, series-driven patch application. The U-Boot
  target reaches them through the `bsp-scripts` build context, which is why its
  own build context can stay `uboot/`
- `init/` — board hardware facts consumed by the `hwinit`
  systemd units
- `Dockerfile.alpine` — assembles the flashable Alpine debug/demo disk image (extlinux boot)

The Alpine image is the board smoke-test path. The Mica OS image consumes
`uboot-mica/` and `kernel/` from `_out/`, defaulting to that directory and
overridable with `BSP_OUT`.

## Flashing

Four ways onto the board, and which one applies is decided by the state the
board is already in, not by preference.

| Method | Use when | Command | Writes |
|---|---|---|---|
| **Loader** | U-Boot boots and its rockusb gadget enumerates | `make flash-mica` | the whole disk |
| **Maskrom** | U-Boot is absent or broken, board enumerates as Maskrom | `make flash-maskrom` | the whole disk, after pushing the pinned vendor loader |
| **`ums`** | you are at the U-Boot console | `ums 0 mmc 0`, then `dd` from the host | whatever the host writes |
| **raw `dd`** | the eMMC or SD is reachable directly | `dd` to the block device | whatever you write |

**Which image.** Both make targets write the product image the assembly built:
`MICA_IMAGE` defaults to the newest `_out/image/mica-cx3576-*.img` of this
checkout and names another build otherwise. The raw `.img` is what they take; a
compressed one is rejected by the preflight below. These targets are here rather
than at the top level because this Makefile is the only place in the tree that
knows how to talk to the board.

Both write with `rkdeveloptool wl 0`, then read the **whole** image back
off the board and compare it byte for byte against the file they wrote
(`scripts/verify-flash.sh`), and only then issue `rd` to reboot. A difference
stops the run before the reset, with the board still in loader mode. The boot
area is read back first and on its own, because a partial or corrupt write
there is the one failure that bricks the board past the recovery key.
**Keep power and USB connected until `rd` returns** — every flash target says
so, because a board interrupted mid-write comes back in Maskrom.

`make flash-maskrom` is the recovery path: it checks `loader/MiniLoaderAll.bin`
against its committed sha256, pushes it with `rkdeveloptool db`, and then
flashes exactly as above. The loader is pinned rather than rebuilt, so recovery
does not depend on the build that broke.

**`ums` runs from U-Boot only, never from Maskrom.** The BootROM speaks the
0x471/0x472 protocol and nothing else, so there is no mass-storage mode to
enter before U-Boot is running. `CONFIG_CMD_USB_MASS_STORAGE=y` is set in
`generic-rk3576_defconfig`, so the command is present once U-Boot is.

**There is no `update.img`, deliberately.** The RK packaging format would need
`afptool` and `rkImageMaker`, which are closed-source SDK binaries this tree
would have to vendor, and it buys nothing: the product image is a whole-disk image
carrying every partition, and `rkdeveloptool wl 0` writes it in one step from
both Loader and Maskrom.

Before the write and again before the readback, `flash/scripts/verify-flash.sh
--check` holds the image to the board's geometry: exactly 1299 MiB, both GPTs
with their checksums, the three partitions at their recorded sectors, and the
`RKNS` loader magic at byte 32768.

Upstream provenance and the deliberate deviations from it are recorded in
`docs/boards/cx3576-bsp-sync.md`.
