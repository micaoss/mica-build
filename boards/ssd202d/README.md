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

The vendor region is a local build input, never committed: `ssd202d-vendor-0x000000-0x1fffff.bin`, 2,097,152
bytes, sha256 `17367762dfe109f10c06c63183df991f2c98da3dd097c16f7ce59815e8733ff2` (on the bench host under
`/srv/ybo/hub/ssd202d-bringup/vendor/`). It is SigmaStar and Tuya code under an unknown licence: an image that
carries it is not redistributed without clearance. Until the assembly takes it, the region's source in
`flash.tsv` is `-` (erased), and a flash image of this board must not be programmed.

This is the board's skeleton (docs/plan/20261021-0027-ssd202d-board-bring-up.md): `kernel/`, `loader/` and
`tests/boot/` are still the ones cloned from `qemu-armhf`, until the kernel port and the loader replace them. The
board is not a release target (`BOARD_RELEASE_TARGET=0`); its one product, `ssd202d.basic`
(`products/basic/product.env`), runs OpenRC.
