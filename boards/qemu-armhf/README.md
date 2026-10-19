# qemu-armhf

QEMU's 32-bit Arm virt machine (`-M virt,highmem=off -cpu cortex-a15`) of Mica OS, booted by U-Boot from NOR
flash with the root on UBI: the board definition (`board.env`), the flash layout (`flash.tsv`), the kernel build
(`kernel/`), U-Boot (`loader/`), the board package (`package/`), the board evidence (`evidence.json`) and the
boot test (`tests/boot/`). `make qemu-armhf-kernel`, `make qemu-armhf-firmware` and `make board-pool` build its
kernel, its U-Boot and its package; `make -C boards/qemu-armhf boot-test` boots the kernel and U-Boot under
QEMU from a flash image.

The boot trust is none: QEMU hands U-Boot its control device tree, so no key can be embedded in it, and U-Boot
checks the FIT's hashes without a signature. The kernel embeds the dm-verity trust certificate of the
deployment it will boot (`VERITY_TRUST_CERT`, default `meta/verity/signer.cert.pem`) and requires a signed
root.

Its one product, `qemu-armhf.basic` (`products/basic/product.env`), runs OpenRC and is published.
