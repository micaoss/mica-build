# ssd202d

A SigmaStar SSD202D (MStar infinity2m) gateway of Mica OS: 2x Cortex-A7, 128 MiB DDR3, 128 MiB SPI NAND with the
root on UBI, 100 Mbit Ethernet and a Silicon Labs EFR32MG21 radio module on a UART. The boot ROM runs the vendor
IPL, which loads the SPL; the SPL loads U-Boot from its raw region, and U-Boot boots the FIT from UBI. The board
definition (`board.env`), the flash layout (`flash.tsv`), the kernel build (`kernel/`), U-Boot (`loader/`) and the
board package (`package/`) are here. `make ssd202d-kernel`, `make ssd202d-firmware` and `make board-pool` build
its kernel, its U-Boot and its package.

The boot trust is none: the vendor IPL does not verify what it loads, and U-Boot checks the FIT's hashes without a
signature. The kernel embeds the dm-verity trust certificate of the deployment it will boot (`VERITY_TRUST_CERT`,
default `meta/verity/signer.cert.pem`) and requires a signed root.

The flash (`flash.tsv`) starts with 2 MiB of the vendor's, kept verbatim: the CIS, which holds the flash
parameters and the partition table the boot ROM and the vendor IPL read, and the vendor IPL, the chain's only DDR
init. The loader region after it is this board's: the SPL in the two IPL_CUST slots at 0x200000 and 0x260000,
U-Boot proper twice (0x2C0000 and 0x380000) and two spare blocks. UBI starts at 0x480000. The first 22 blocks
(0x0-0x2BFFFF) are programmed without bad-block skipping and checked on read-back, with the flash's on-die ECC on:
a skipped block would move what follows away from where the partition table puts it.

A loader update (the recovery package) rewrites the whole loader region front to back, both SPL slots and both
U-Boot copies included. The vendor IPL tries the slot at 0x200000 first and falls back to 0x260000 when its
checksum fails, so a power loss while either slot is written leaves the other one good, as long as each slot is
verified on its own.

The vendor region is a local build input, never committed: `ssd202d-vendor-0x000000-0x1fffff.bin`, 2,097,152
bytes, sha256 `17367762dfe109f10c06c63183df991f2c98da3dd097c16f7ce59815e8733ff2` (on the bench host under
`/srv/ybo/hub/ssd202d-bringup/vendor/`). It is SigmaStar and Tuya code under an unknown licence: an image that
carries it is not redistributed without clearance. A build names the file in `MICA_SSD202D_VENDOR_FILE`; without
it, or with any other file, the flash image is refused. The image's `flash.json` records the 22 raw blocks.

The kernel is mainline 6.12 (the `ssd202d-kernel` row of `locks/upstream.lock`) with the SSD20xD drivers and SoC
device trees mainline lacks carried from linux-chenxing as `kernel/patches/`, one per driver or area, each naming
its origin and licence. The board's device tree (`kernel/dts/`) is compiled inside the kernel build.

U-Boot comes from the MStar fork: the `ssd202d-uboot` row pins https://github.com/fifteenhex/u-boot.git
`mstar_rebase_mainline_20220624_dongshanpi_picow` at 6e1a42f610d861acc32331f6c66a0f0b7a5a0264 (2022.07-rc3). Mainline
U-Boot has no MStar support (no mach-mstar), and this is the tree the bench board boots. `loader/patches/` adds the GD5F1GM7 SPI NAND to the SPL, an SPL method that loads U-Boot proper raw
(copy A at 0x2C0000, else B at 0x380000, skipping bad blocks, booting the first whose CRCs hold) in place of the
fork's SPL_UBI, and the Mica FIT boot over UBI. The environment lives nowhere. The build packs `loader.bin`, the
whole loader region: the SPL (with the vendor IPL's `IPLC` header) at +0x0 and +0x60000, `u-boot.img` at +0xC0000
and +0x180000, the rest erased. The fork has no `fdt_add_pubkey`, so the FIT host tools are built from mainline
U-Boot (the `ssd202d-uboot-tools` row). The board is not a release target (`BOARD_RELEASE_TARGET=0`); its one product, `ssd202d.basic`
(`products/basic/product.env`), runs OpenRC.

## Flashing

The image is the raw 128 MiB main area (no OOB, on-die ECC on): `make product PRODUCT=ssd202d.basic` with
`MICA_SSD202D_VENDOR_FILE` set writes `_out/products/ssd202d.basic/image/mica-ssd202d-<stamp>.img` and its
`flash.json`. It carries the vendor region, so it stays on the bench. A board is written in three parts, cut from
the image:

```sh
img=_out/products/ssd202d.basic/image/mica-ssd202d-<stamp>.img
dd if="$img" of=vendor.bin bs=128k count=16                # 0x000000-0x1FFFFF, compared, never written
dd if="$img" of=loader.bin bs=128k skip=16 count=20        # 0x200000-0x47FFFF, the loader region
dd if="$img" of=ubi.bin bs=128k skip=36 count=<used>       # 0x480000-, the PEBs up to the last one not erased
```

The rules (`flash.json`): the first 22 blocks (0x0-0x2BFFFF: the vendor region and both SPL slots) are written
in place and read back, and a bad block among them is a refusal, not a skip. The loader region's slots (SPL A and
B, U-Boot A and B) are each written from their own start, skipping bad blocks inside the slot. The UBI region is
erased whole and written skipping bad blocks; UBI formats the erased PEBs on attach.

**In system** (the board reaches a U-Boot with `mtd` and the network: the bench U-Boot or this board's own), over
TFTP from the serial console. U-Boot's `mtd erase` and `mtd write` skip bad blocks, so the raw rule is held by
checking first that no bad block lies below 0x2C0000:

```
mtd bad spi-nand0
setenv ipaddr <board>; setenv serverip <tftp server>
tftp 0x21000000 vendor.bin; mtd read spi-nand0 0x24000000 0x0 0x200000; cmp.b 0x21000000 0x24000000 0x200000
tftp 0x21000000 loader.bin
mtd erase spi-nand0 0x200000 0x280000
mtd write spi-nand0 0x21000000 0x200000 0x60000
mtd write spi-nand0 0x21060000 0x260000 0x60000
mtd write spi-nand0 0x210c0000 0x2c0000 0xc0000
mtd write spi-nand0 0x21180000 0x380000 0xc0000
mtd read spi-nand0 0x24000000 0x200000 0x60000; cmp.b 0x21000000 0x24000000 0x60000
mtd read spi-nand0 0x24000000 0x260000 0x60000; cmp.b 0x21060000 0x24000000 0x60000
mtd read spi-nand0 0x24000000 0x2c0000 0xc0000; cmp.b 0x210c0000 0x24000000 0xc0000
mtd read spi-nand0 0x24000000 0x380000 0xc0000; cmp.b 0x21180000 0x24000000 0xc0000
tftp 0x22000000 ubi.bin
mtd erase spi-nand0 0x480000 0x7b80000
mtd write spi-nand0 0x22000000 0x480000 ${filesize}
mtd read spi-nand0 0x24000000 0x480000 ${filesize}; cmp.b 0x22000000 0x24000000 ${filesize}
reset
```

Every `cmp.b` must report the whole length equal; stop at the first that does not. A bad block at or below
0x2BFFFF stops the procedure.

**Out of system** (no U-Boot comes up): SNANDer for MStar (openipc/snander-mstar with the bench's fixes) through a
CH341A on the SoC's debug I2C, `-p mstar`. It writes in place without skipping bad blocks, so it is only for a
flash with none in the parts it writes:

```
snander -p mstar -a 0x200000 -w loader.bin -v
snander -p mstar -a 0x480000 -l 0x7b80000 -e
snander -p mstar -a 0x480000 -w ubi.bin -v
```

A board whose vendor region was lost takes `vendor.bin` at 0x0 the same way, first.
