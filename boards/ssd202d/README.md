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
init. The loader region after it is this board's, 0x200000-0x37FFFF: one SPL in the first IPL_CUST slot
(0x200000), the second slot (0x260000) left erased, one U-Boot proper (0x2C0000, four blocks) and two spare
blocks. UBI starts at 0x380000. The first 22 blocks (0x0-0x2BFFFF: the vendor region and both IPL_CUST slots) are
programmed without bad-block skipping and checked on read-back, with the flash's on-die ECC on: a skipped block
would move what follows away from where the partition table puts it, and U-Boot proper's start with it.

The vendor IPL loads the first IPL_CUST slot and turns to the second (`Load Backup IPL_CUST from SPINAND`) only
when the first's header or checksum fails; an erased second slot is simply no backup. There is one SPL and one
U-Boot proper, so a loader update (the recovery package) that loses power before it is verified leaves a board
that needs a programmer.

The vendor region is a local build input, never committed: `ssd202d-vendor-0x000000-0x1fffff.bin`, 2,097,152
bytes, sha256 `17367762dfe109f10c06c63183df991f2c98da3dd097c16f7ce59815e8733ff2` (on the bench host under
`/srv/ybo/hub/ssd202d-bringup/vendor/`). It is SigmaStar and Tuya code under an unknown licence: an image that
carries it is not redistributed without clearance. A build names the file in `MICA_SSD202D_VENDOR_FILE`; without
it, or with any other file, the flash image is refused. The image's `flash.json` records the 22 raw blocks.

The kernel is the board's snapshot in https://github.com/micaoss/mica-linux (the `ssd202d-kernel` row of
`locks/upstream.lock`, `mica/ssd202d-<date>`): mainline stable 6.12 with the SSD20xD drivers and SoC device trees
mainline lacks carried from linux-chenxing, one commit per driver or area, each naming its origin and licence, and
the board's device tree as its own commit, compiled inside the kernel build.

U-Boot comes from the MStar fork: the `ssd202d-uboot` row pins the board's tree in
https://github.com/micaoss/mica-uboot (`mica/ssd202d-spinand`, pinned by commit, no dated snapshots), https://github.com/fifteenhex/u-boot.git
`mstar_rebase_mainline_20220624_dongshanpi_picow` at 6e1a42f610d861acc32331f6c66a0f0b7a5a0264 (2022.07-rc3) with the
board's commits on top. Mainline U-Boot has no MStar support (no mach-mstar), and this is the tree the bench board
boots. The board's commits add the GD5F1GM7 SPI NAND to the SPL, an SPL method that loads U-Boot proper raw
(from 0x2C0000, skipping bad blocks, booting it only when its CRCs hold) in place of the fork's SPL_UBI, and the
Mica FIT boot over UBI. The environment lives nowhere. The build packs `loader.bin`, the whole loader region: the
SPL (with the vendor IPL's `IPLC` header) at +0x0, `u-boot.img` at +0xC0000, the rest erased. The fork has no `fdt_add_pubkey`, so the FIT host tools are built from mainline
U-Boot (the `ssd202d-uboot-tools` row, mica-uboot's mirror `u-boot/v2026.07`). The board is not a release target (`BOARD_RELEASE_TARGET=0`); its one product, `ssd202d.basic`
(`products/basic/product.env`), runs OpenRC.

## Flashing

The image is the raw 128 MiB main area (no OOB, on-die ECC on): `make product PRODUCT=ssd202d.basic` with
`MICA_SSD202D_VENDOR_FILE` set writes `_out/products/ssd202d.basic/image/mica-ssd202d-<stamp>.img` and its
`flash.json`. It carries the vendor region, so it stays on the bench. A board is written in three parts, cut from
the image:

```sh
img=_out/products/ssd202d.basic/image/mica-ssd202d-<stamp>.img
dd if="$img" of=vendor.bin bs=128k count=16                # 0x000000-0x1FFFFF, compared, never written
dd if="$img" of=loader.bin bs=128k skip=16 count=12        # 0x200000-0x37FFFF, the loader region
dd if="$img" of=ubi.bin bs=128k skip=28 count=<used>       # 0x380000-, the PEBs up to the last one not erased
```

The rules (`flash.json`): the first 22 blocks (0x0-0x2BFFFF: the vendor region and both IPL_CUST slots) are
written in place and read back, and a bad block among them is a refusal, not a skip. U-Boot proper is written from
its own start, skipping bad blocks inside its region. The UBI region is erased whole and written skipping bad
blocks; UBI formats the erased PEBs on attach.

**In system** (the board reaches a U-Boot with `mtd` and the network: the bench U-Boot or this board's own), over
TFTP from the serial console. U-Boot's `mtd erase` and `mtd write` skip bad blocks, so the raw rule is held by
checking first that no bad block lies below 0x2C0000:

```
mtd bad spi-nand0
setenv ipaddr <board>; setenv serverip <tftp server>
tftp 0x21000000 vendor.bin; mtd read spi-nand0 0x24000000 0x0 0x200000; cmp.b 0x21000000 0x24000000 0x200000
tftp 0x21000000 loader.bin
mtd erase spi-nand0 0x200000 0x180000
mtd write spi-nand0 0x21000000 0x200000 0x60000
mtd write spi-nand0 0x210c0000 0x2c0000 0x80000
mtd read spi-nand0 0x24000000 0x200000 0x60000; cmp.b 0x21000000 0x24000000 0x60000
mtd read spi-nand0 0x24000000 0x2c0000 0x80000; cmp.b 0x210c0000 0x24000000 0x80000
tftp 0x22000000 ubi.bin
mtd erase spi-nand0 0x380000 0x7c80000
mtd write spi-nand0 0x22000000 0x380000 ${filesize}
mtd read spi-nand0 0x24000000 0x380000 ${filesize}; cmp.b 0x22000000 0x24000000 ${filesize}
reset
```

Every `cmp.b` must report the whole length equal; stop at the first that does not. A bad block at or below
0x2BFFFF stops the procedure.

**Out of system** (no U-Boot comes up): SNANDer for MStar (openipc/snander-mstar with the bench's fixes) through a
CH341A on the SoC's debug I2C, `-p mstar`. It writes in place without skipping bad blocks, so it is only for a
flash with none in the parts it writes:

```
snander -p mstar -a 0x200000 -w loader.bin -v
snander -p mstar -a 0x380000 -l 0x7c80000 -e
snander -p mstar -a 0x380000 -w ubi.bin -v
```

A board whose vendor region was lost takes `vendor.bin` at 0x0 the same way, first.
