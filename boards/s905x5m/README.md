# S905X5M signed-file development port

BM201 / X88 Pro X5M, Amlogic S7D, arm64. The current delivery boots a signed
Mica OS deployment from SD using the paired Mica OS U-Boot installed in eMMC boot0.
The SD image is not a standalone bootloader image. Physical qualification is
pending. The board dossier is
`mica:docs/boards/s905x5m.md`; the firmware operations are [loader/README.md](loader/README.md).

## Build

The kernel and U-Boot receive only the public certificates of the deployment
they will boot:

```bash
make s905x5m-kernel VERITY_TRUST_CERT="$PWD/meta/verity/signer.cert.pem"
make s905x5m-firmware FIT_TRUST_CERT="$PWD/meta/boot/signer.cert.pem"
make board-pool
make product PRODUCT=s905x5m.basic
make product-verify PRODUCT=s905x5m.basic
```

U-Boot exports the final control DTB and FIT tools; its gate verifies that the
required key is embedded in the BL33 bytes recovered from the exported FIP.
Kernel modules and radio firmware belong to the authenticated kernel support
image; the board package carries only root-side hardware and storage policy.
Keep `firmware.bin` and its signed `firmware.json` beside the image: offline
verification checks this paired artifact, boot0 installation is checked by
native device readback, and ordinary component updates never write it.

## Layout and boot

The GPT contains FIRMWARE (sector 64 through 128 MiB), SYSTEM (128–1152 MiB),
and DATA (1152 MiB onward, initially 256 MiB). DATA alone grows. Native 64 KiB
records are at absolute 120 and 124 MiB. The SD FIRMWARE partition contains
records and zero padding; the bootloader stays outside the SD system image.

A one-second native countdown permits serial/USB keyboard console entry without
consuming an attempt. Automatic boot requires eMMC boot0 firmware and SD `mmc 0`,
arms the Meson watchdog for 60 seconds, persists and reads back the selected
attempt, verifies its FIT, and supplies `mica,deployment-id` to native init.

## Radios and optional panel

`MICA_ROOTFS_WITHOUT=bluetooth` omits the bridge. `MICA_ROOTFS_WITHOUT=wifi`
omits the station driver/services while preserving Bluetooth SDIO transport.
Declining both leaves the radio rail initializer unselected. Bluetooth pairing
keys and the derived controller address use protected `DATA/state/bluetooth`,
mounted at `/var/lib/bluetooth` by Base's mica-bluetooth.

Every product carries the BM201 front panel (`mica-bm201-front-panel`, in
`manifests/board.pkgs`): the clock and link-status service. It reads `/run/mica/timezone`.

## Verification

```bash
make board-check
make os-fit-records-test
make product-verify PRODUCT=s905x5m.basic
```

Physical acceptance requires cold boot, watchdog handoff, serial/HDMI, Ethernet,
USB, Wi-Fi, Bluetooth, DATA quotas and persistence, signed updates and fallback,
and shutdown on a BM201.
