# qemu-armhf: QEMU's 32-bit Arm virt machine, FIT boot through U-Boot from NOR flash over UBI. This directory
# owns the kernel (kernel/Dockerfile, its fragment and recorded config, QEMU's device tree under kernel/dts/),
# U-Boot (loader/Dockerfile, mica-ubi-boot.c and its patch), the flash layout (flash.tsv), the boot test
# (tests/boot/) and its upstream source pins (its rows of ../../locks/upstream.lock); the inputs every board
# shares come from ../../common/. It has no board.env and is not a listed board (../boards.tsv): the facts
# its builds take are the variables below.
#
#   make kernel          -> $(BSP_OUT)/kernel/{dev,prod}/{zImage,config,System.map,kernel.release,modules.tar,
#                           qemu-virt.dtb,mica-required.fragment}
#   make kernel-config   -> re-records kernel/config/$(BOARD).config from this build
#   make uboot-mica      -> $(BSP_OUT)/uboot-mica/ (u-boot.bin, its config, the FIT tools)
#   make boot-test [TRIES=<n>]  boots both under QEMU from a flash image (tests/boot/run.sh)
BOARD := qemu-armhf
BSP_OUT ?= ../../_out/$(BOARD)

FROM_SH := ../../bin/mica-tools from
BSP_ARG := MICA_BUILD_BSP=mica-build-env:bsp
PIN := bash ../../bin/mica-tools upstream get
MIRROR_ARG := $(if $(MICA_MIRROR),--build-arg MICA_MIRROR=$(MICA_MIRROR))
VERITY_TRUST_CERT ?= ../../meta/verity/signer.cert.pem
TRUST_STAGE := ../../bin/bun.sh src/cli.ts trust-stage

# The kernel features merged beside core (common/kernel/features.tsv) and the command line the kernel forces:
# ubi.mtd names the flash.tsv region UBI attaches, mtdparts cuts QEMU's one flash device into flash.tsv's regions.
KERNEL_FEATURES := storage-ubi
BOARD_CMDLINE_ARGS := console=ttyAMA0 ro dm_verity.require_signatures=1 panic=5 rdinit=/init ubi.mtd=ubi mtdparts=0.flash:1M(u-boot),63M(boot-rest),64M(ubi)
# U-Boot: no FIT signature is checked (QEMU hands it its control device tree, so no key can be embedded in
# it); the UBI region is its second NOR bank, and a FIT is read into the buffer at FIT_UBI_ADDRESS, at most
# FIT_UBI_LIMIT bytes, clear of the FIT's load addresses (0x42000000 0x43000000 0x43100000). There is no
# loader watchdog: the kernel arms the machine's i6300esb.
BOOT_TRUST := none
UBOOT_UBI_MTD := nor1
FIT_UBI_ADDRESS := 0x44000000
FIT_UBI_LIMIT := 33554432

KERNEL_BUILD = TRUST_DIR="$$(bash $(TRUST_STAGE) "$(VERITY_TRUST_CERT)" "$(BSP_OUT)/verity-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	KERNEL_SOURCE="$$($(PIN) git $(BOARD)-kernel url)" && KERNEL_VERSION="$$($(PIN) git $(BOARD)-kernel ref)" && \
	KERNEL_COMMIT="$$($(PIN) git $(BOARD)-kernel commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-kernel src --build-context mica-common=../../common/kernel \
	  --build-context "mica-trust=$$TRUST_DIR" --build-context mica-scripts=../../common/scripts \
	  --build-arg KERNEL_SOURCE=$$KERNEL_SOURCE --build-arg KERNEL_VERSION=$$KERNEL_VERSION \
	  --build-arg KERNEL_COMMIT=$$KERNEL_COMMIT --build-arg KERNEL_GIT_NAME=$(BOARD)-kernel $(MIRROR_ARG) \
	  --build-arg "KERNEL_FEATURES=$(KERNEL_FEATURES)" --build-arg "KERNEL_CMDLINE=$(BOARD_CMDLINE_ARGS)" \
	  -f kernel/Dockerfile $$IMG

.PHONY: all kernel kernel-config uboot-mica boot-test clean
all: kernel uboot-mica

kernel:
	$(KERNEL_BUILD) --target artifact -o $(BSP_OUT)/kernel kernel

# The recorded config is a source file the kernel's gate refuses to differ from; refreshing it is an edit.
kernel-config:
	$(KERNEL_BUILD) --target config -o kernel/config kernel
	@echo "recorded: kernel/config/$(BOARD).config ($$(grep -c . kernel/config/$(BOARD).config) lines)"

uboot-mica:
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	UBOOT_REPO="$$($(PIN) git $(BOARD)-uboot url)" && UBOOT_COMMIT="$$($(PIN) git $(BOARD)-uboot commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-uboot source \
	  --build-context bsp-scripts=../../common/scripts --build-context mica-common=../../common/uboot \
	  --build-arg UBOOT_REPO=$$UBOOT_REPO --build-arg UBOOT_COMMIT=$$UBOOT_COMMIT \
	  --build-arg UBOOT_GIT_NAME=$(BOARD)-uboot $(MIRROR_ARG) \
	  --build-arg BOOT_TRUST=$(BOOT_TRUST) --build-arg UBI_MTD=$(UBOOT_UBI_MTD) \
	  --build-arg FIT_UBI_ADDRESS=$(FIT_UBI_ADDRESS) --build-arg FIT_UBI_LIMIT=$(FIT_UBI_LIMIT) \
	  -f loader/Dockerfile --target artifact-mica $$IMG \
	  -o $(BSP_OUT)/uboot-mica loader

boot-test:
	bash tests/boot/run.sh $(BSP_OUT)/kernel/dev $(BSP_OUT)/uboot-mica/u-boot.bin $(BSP_OUT)/boot-test $(TRIES)

clean:
	rm -rf $(BSP_OUT)
