# ssd202d: a SigmaStar SSD202D gateway, FIT boot through U-Boot from SPI NAND over UBI. This directory owns the
# kernel (kernel/Dockerfile, its fragment and recorded config, the device tree under kernel/dts/), U-Boot
# (loader/Dockerfile, mica-ubi-boot.c and its patch), the flash layout (flash.tsv), its upstream source pins (its
# rows of ../../locks/upstream.lock) and the names its builds take (bsp.env); the facts the builds share with the
# assembly are board.env's. The inputs every board shares come from ../../common/. Until the loader replaces it,
# loader/ is the one cloned from qemu-armhf.
#
#   make kernel          -> $(BSP_OUT)/kernel/{dev,prod}/{zImage,config,System.map,kernel.release,modules.tar,
#                           mstar-infinity2m-ssd202d-ybo-gw.dtb,mica-required.fragment}
#   make kernel-config   -> re-records kernel/config/$(BOARD).config from this build
#   make uboot-mica      -> $(BSP_OUT)/uboot-mica/ (u-boot.bin, its config, the FIT tools); make firmware too
BOARD := ssd202d
include bsp.env
BSP_OUT ?= ../../_out/$(BOARD)

FROM_SH := ../../bin/mica-tools from
BSP_ARG := MICA_BUILD_BSP=mica-build-env:bsp
PIN := bash ../../bin/mica-tools upstream get
MIRROR_ARG := $(if $(MICA_MIRROR),--build-arg MICA_MIRROR=$(MICA_MIRROR))
VERITY_TRUST_CERT ?= ../../meta/verity/signer.cert.pem
TRUST_STAGE := ../../bin/bun.sh src/cli.ts trust-stage

# board.env's facts the builds take, each a plain KEY=value or KEY="value" line; a missing one is refused here.
env = $(shell sed -n 's/^$(1)="\{0,1\}\([^"]*\)"\{0,1\}$$/\1/p' board.env)
KERNEL_FEATURES := $(call env,KERNEL_FEATURES)
BOARD_CMDLINE_ARGS := $(call env,BOARD_CMDLINE_ARGS)
BOOT_TRUST := $(call env,BOOT_TRUST)
UBOOT_UBI_MTD := $(call env,UBOOT_UBI_MTD)
FIT_UBI_ADDRESS := $(call env,FIT_UBI_ADDRESS)
FIT_UBI_LIMIT := $(call env,FIT_UBI_LIMIT)
$(foreach key,KERNEL_FEATURES BOARD_CMDLINE_ARGS BOOT_TRUST UBOOT_UBI_MTD FIT_UBI_ADDRESS FIT_UBI_LIMIT,$(if $($(key)),,$(error board.env declares no $(key))))

KERNEL_BUILD = TRUST_DIR="$$(bash $(TRUST_STAGE) "$(VERITY_TRUST_CERT)" "$(BSP_OUT)/verity-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	KERNEL_SOURCE="$$($(PIN) git $(BOARD)-kernel url)" && KERNEL_VERSION="$$($(PIN) git $(BOARD)-kernel ref)" && \
	KERNEL_COMMIT="$$($(PIN) git $(BOARD)-kernel commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-kernel src --build-context mica-common=../../common/kernel \
	  --build-context "mica-trust=$$TRUST_DIR" --build-context mica-scripts=../../common/scripts \
	  --build-arg KERNEL_SOURCE=$$KERNEL_SOURCE --build-arg KERNEL_VERSION=$$KERNEL_VERSION \
	  --build-arg KERNEL_COMMIT=$$KERNEL_COMMIT --build-arg KERNEL_GIT_NAME=$(BOARD)-kernel $(MIRROR_ARG) \
	  --build-arg "KERNEL_FEATURES=$(KERNEL_FEATURES)" --build-arg "KERNEL_CMDLINE=$(BOARD_CMDLINE_ARGS)" \
	  --build-arg KERNEL_DEFCONFIG=$(KERNEL_DEFCONFIG) --build-arg KERNEL_EXPECT=$(KERNEL_EXPECT) \
	  -f kernel/Dockerfile $$IMG

.PHONY: all kernel kernel-config uboot-mica firmware clean
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

firmware: uboot-mica

clean:
	rm -rf $(BSP_OUT)
