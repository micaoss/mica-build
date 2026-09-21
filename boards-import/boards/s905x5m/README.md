# S905X5M signed-file development port

BM201 / X88 Pro X5M, Amlogic S7D, arm64. The current delivery boots a signed
Mica OS deployment from SD using the paired Mica OS U-Boot installed in eMMC boot0.
The SD image is not a standalone bootloader image. Physical qualification is
pending; `BOARD_RELEASE_TARGET=0` remains set. See the
[board dossier](../../docs/boards/s905x5m.md) and [firmware operations](loader/README.md).

## Build inputs

Use the pinned builder images described in [build design](../../mica:docs/design/build.md).
Supply the public certificates the assembly (`mica-build`) generated with its
keys; this repository holds and generates no private key:

```bash
make s905x5m-kernel VERITY_TRUST_CERT="$PWD/meta/verity/signer.cert.pem"
make s905x5m-uboot FIT_TRUST_CERT="$PWD/meta/boot/signer.cert.pem"
make s905x5m-fit-tools
```

Kernel and firmware builders receive only public certificates. BSP outputs are
under `_out/{kernel,uboot,userland}`. U-Boot exports the final
control DTB and FIT tools; its gate verifies that the required key is embedded
in the BL33 bytes recovered from the exported FIP.

Build the selected root packages, then compose the independent root:

```bash
selected=$(bash rootfs/packages/resolve.sh --board s905x5m --profile dev \
    --radios 'wifi bluetooth' --without "${MICA_ROOTFS_WITHOUT:-}" \
    --components "${MICA_ROOTFS_COMPONENTS:-}")
selected=${selected//$'\n'/ }
while read -r producer directory arches packages enablement; do
    wanted=0
    for package in ${packages//,/ }; do
        case " $selected " in *" $package "*) wanted=1 ;; esac
    done
    [ "$wanted" = 1 ] || continue
    case ",$arches," in *,all,*) arch=all ;; *,arm64,*) arch=arm64 ;; *) continue ;; esac
    bash tools/deb/build.sh --producer "$producer" --arch "$arch"
done < <(bash tools/deb/producers.sh)
bash tools/deb/repo.sh --arch arm64
make os-rootfs-s905x5m MICA_META_DIR="$PWD/tmp/s905x5m-keys"
```

The Bluetooth producer builds its own bridge; the board package contains only
root-side hardware/storage policy. Kernel modules and radio firmware belong to
the authenticated kernel support image. Build `mica-init` using
`bash tools/deploy-pool.sh --lifecycle arm64 DIR` (the static executables out of the pinned `mica-lifecycle` archive).

Use `bash build/run.sh --components --help` to package `root`, `kernel`,
`firmware`, two distinct `deployment` generations, and an `archive`. Set
`--board s905x5m` for kernel and firmware; the firmware input is
`_out/uboot/u-boot.bin.signed`. Each image record contains its
signed envelope and absolute kernel/root component directories.

```bash
make os-image-s905x5m-sd \
    MICA_IMAGE_RECORDS=/absolute/path/records.json \
    MICA_METADATA_PUBLIC_KEYS="$(cat tmp/s905x5m-keys/updates/public.key)" \
    MICA_FIRMWARE_PACKAGE=/absolute/path/firmware-component \
    MICA_IMAGE_OUT=/absolute/path/new-image-directory
make os-verify-s905x5m-sd \
    MICA_VERIFY_IMAGE=/absolute/path/mica-s905x5m-YYYYMMDD-HHmmss.img \
    MICA_METADATA_PUBLIC_KEY_FILES="$PWD/tmp/s905x5m-keys/updates/public.key"
```

Keep `firmware.bin` and its signed `firmware.json` beside the timestamped image.
Offline verification checks this paired artifact; boot0 installation is checked
separately by native device readback. Ordinary component updates never write it.

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
mounted at `/var/lib/bluetooth` by the shared Bluetooth package.

`MICA_ROOTFS_COMPONENTS=bm201-front-panel` includes the optional executable
clock/link-status service. It is off by default and reads `/run/mica/timezone`.

## Verification

```bash
make os-build-test os-verify-test os-rootfs-manifest-test
make os-fit-records-test os-s905x5m-hwinit-test
make os-repart-test MICA_BOARD=s905x5m \
    MICA_VERIFY_IMAGE=/absolute/path/factory.img \
    MICA_VERIFY_ROOT_IMAGE=/absolute/path/rootfs.img
make docs-verify
```

The repart gate uses an isolated loop image. Current physical acceptance still
requires cold boot, watchdog handoff, serial/HDMI, Ethernet, USB, Wi-Fi, Bluetooth,
DATA quotas and persistence, signed updates/fallback, and shutdown on a BM201.
