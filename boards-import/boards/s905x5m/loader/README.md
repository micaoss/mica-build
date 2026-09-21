# S905X5M Mica OS firmware

The BM201 firmware builds CoreELEC U-Boot at
`5f7ac2b1dc4df2f466ed88c3958a8675873f8a1a`. The active series is platform/display
patches 0001–0007 plus native signed-file patch 0019 and public FIT tool patch
0020. Patches 0008–0018 describe retired script/menu/installer behavior and are
not applied by the current Dockerfile.

## Build and trust

```bash
make s905x5m-uboot FIT_TRUST_CERT=/absolute/path/public-boot-certificates.pem
make s905x5m-uboot-package
```

The build accepts one to eight RSA-2048 public certificates. It does not consume
private Mica OS signing keys. The required configuration key is embedded with
`required-mode=any`, allowing explicitly provisioned key overlap. The final
export gate decompresses BL33 from each FIP and compares it with the rebuilt
U-Boot containing the final control FDT.

Outputs under `_out/uboot/` include `u-boot.bin.signed`,
`u-boot.bin.sd.bin.signed`, `DDR.USB`, `u-boot.dtb`, `config` and host FIT tools.
The `.signed` suffix describes the vendor boot-chain packaging; physical
hardware-rooted enforcement is not claimed by this development port.

## Current boot contract

Mica OS firmware executes from eMMC boot0. The hardware boot partition begins with
a target-generated 512-byte Amlogic header. The signed Mica OS firmware manifest
covers the following payload, bounded to 4 MiB minus that header. The native
runtime locates the unique eMMC boot0 device and verifies those exact bytes.
The Mica OS loader refuses an automatic boot when its hardware source is not boot0.

The selected system is SD `mmc 0`, with the exact three-partition layout in
`../../board.env`. FIRMWARE holds two CRC-protected 64 KiB data records at
120/124 MiB; it does not supply U-Boot environment commands. SYSTEM holds signed
file deployments. No persistent environment, cfgload, raw-slot script or old
installer participates in this path.

The standard one-second countdown and native console remain available. The boot
transaction arms the S7D Meson watchdog for 60 seconds before consuming a trial,
checks the partition layout, writes the inactive record, invalidates the block
cache and reads it back before loading the selected FIT. Three trials exhaust
a candidate; a failed confirmed image is retired. Invalid records or unavailable
watchdog/SD enter the local recovery console without launching a kernel.

Fixed FIT memory addresses are kernel `0x08000000`, FDT `0x18000000`,
initramfs `0x20000000`, and loaded FIT `0x28000000`. The Image header and maximum
extents are checked during packaging, outside S7D secure memory and logo ranges.
The signed kernel forces the Mica OS verity/init command line. Its watchdog DT
selects userspace feeding at 60 seconds; the driver applies NOWAYOUT so native
init and systemd can take over the armed device. The deployment ID
is handed off through `/chosen/mica,deployment-id`.

## Recovery package

`make s905x5m-uboot-package` packages the existing three BSP artifacts into
`_out/uboot-package/update.img`, with the manual
`aml_sdc_burn.ini` sidecar and SHA-256 record. It does not rebuild firmware or
write a device. The package round-trip gate checks exact bootloader bytes.

Use the board's vendor USB/manual recovery transport to install this firmware;
retain a matching recovery package before bench work. The payload must not be
written at SD sector 64 or over an eMMC hardware header. A complete eMMC OS
installer is a separate milestone. Ordinary Mica OS root/kernel updates do not
perform bootloader maintenance, and the generic firmware-maintain command
refuses this board until a dedicated Amlogic maintenance transport is qualified.

Physical installation, boot0 selection, watchdog handoff and peripheral behavior
remain subject to the [board dossier](../../docs/boards/s905x5m.md).
