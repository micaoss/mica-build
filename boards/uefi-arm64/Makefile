# uefi-arm64: a UEFI board. This board owns its kernel build: kernel/Dockerfile
# (whose context is kernel/: config/), the upstream source pin (its row of
# ../../locks/upstream.lock) and the architecture table below; the inputs every board
# shares come from ../../common/. There is no U-Boot and no rootfs target
# here: a UEFI machine's firmware provides the boot chain, so the only thing
# this board compiles is its kernel.
#
#   make kernel          -> $(BSP_OUT)/kernel/{bzImage|Image,modules.tar,config,kernel.release}
#   make kernel-config   -> re-records kernel/config/$(BOARD).config from this build
BOARD := uefi-arm64

# ---- the kernel and U-Boot builds of this board ----
BSP_OUT ?= ../../_out/$(BOARD)

# EVERY BASE IMAGE COMES FROM ../../locks/mica-build-env.lock. The Dockerfile declares its
# FROM argument with NO default, so a recipe that forgot to pass one fails at
# `docker buildx build` with "base name should not be blank" rather than
# building against a floating tag. Called in the recipe and not assigned with
# $(shell ...): a `:=` assignment runs the command while make PARSES the file,
# discards its exit status and leaves the variable empty on failure.
FROM_SH := ../../tools/from.sh
BSP_ARG := MICA_BUILD_BSP=mica-build-env:bsp

# THE UPSTREAM TREES AND ARCHIVES come from ../../locks/upstream.lock, read by
# tools/upstream.sh in the recipe, so a missing pin stops make with its own
# message instead of reaching docker as an empty argument.
PIN := bash ../../tools/upstream.sh

# THE FETCH-TIME MIRROR. MICA_MIRROR is passed through to the builders, which
# try mica-res's copy of a pinned object before the row's own URL and ignore it
# when it does not answer (common/scripts/mirror.sh). It is deliberately absent
# from tools/inputs.sh: the bytes a build gets are the same either way, and a
# lock URL is never rewritten.
MIRROR_ARG := $(if $(MICA_MIRROR),--build-arg MICA_MIRROR=$(MICA_MIRROR))


# The same public certificate bundle to every builder. Kernel builds never
# mint keys; the certificate comes from the assembly, which alone holds the
# private key.
VERITY_TRUST_CERT ?= ../../meta/verity/signer.cert.pem
TRUST_STAGE := ../../common/trust/stage.sh

# BUILDX_CACHE=<absolute directory>: common/scripts/buildx.sh caches the
# builds' third-party prefix stage there (CI); unset, it is a plain buildx build.

# The architecture table of the family: what a UEFI kernel of each
# architecture is called, where Kbuild leaves it, which defconfig it starts
# from and what the toolchain needs to cross to it. Keyed by the board's
# MICA_ARCH, read here from board.env because that file is the one statement
# of a board's architecture. A missing or unknown value is refused by name.
MICA_ARCH := $(shell sed -n 's/^MICA_ARCH=//p' board.env)
ifeq ($(MICA_ARCH),amd64)
KERNEL_ARGS := --build-arg KERNEL_ARCH=amd64 --build-arg KERNEL_DEFCONFIG=x86_64_defconfig \
  --build-arg KERNEL_IMAGE=bzImage --build-arg KERNEL_IMAGE_PATH=arch/x86/boot/bzImage \
  --build-arg KERNEL_MAKE_ENV=
else ifeq ($(MICA_ARCH),arm64)
KERNEL_ARGS := --build-arg KERNEL_ARCH=arm64 --build-arg KERNEL_DEFCONFIG=defconfig \
  --build-arg KERNEL_IMAGE=Image --build-arg KERNEL_IMAGE_PATH=arch/arm64/boot/Image \
  --build-arg "KERNEL_MAKE_ENV=ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu-"
else
$(error ../board.env declares MICA_ARCH='$(MICA_ARCH)'; this kernel build is for amd64 or arm64)
endif

KERNEL_BUILD = TRUST_DIR="$$(bash $(TRUST_STAGE) "$(VERITY_TRUST_CERT)" "$(BSP_OUT)/verity-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	KERNEL_SOURCE="$$($(PIN) git $(BOARD)-kernel url)" && KERNEL_VERSION="$$($(PIN) git $(BOARD)-kernel ref)" && \
	KERNEL_COMMIT="$$($(PIN) git $(BOARD)-kernel commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-kernel src --build-context mica-common=../../common/kernel \
	  --build-context "mica-trust=$$TRUST_DIR" --build-context mica-scripts=../../common/scripts \
	  --build-arg BOARD=$(BOARD) --build-arg KERNEL_SOURCE=$$KERNEL_SOURCE \
	  --build-arg KERNEL_VERSION=$$KERNEL_VERSION --build-arg KERNEL_COMMIT=$$KERNEL_COMMIT \
	  --build-arg KERNEL_GIT_NAME=$(BOARD)-kernel $(MIRROR_ARG) $(KERNEL_ARGS) \
	  -f kernel/Dockerfile $$IMG \
	  $(if $(KERNEL_BUILDER),--builder $(KERNEL_BUILDER))

.PHONY: kernel kernel-config firmware clean
kernel:
	$(KERNEL_BUILD) --target artifact -o $(BSP_OUT)/kernel kernel
	@ls -la $(BSP_OUT)/kernel/

# Re-record kernel/config/$(BOARD).config from the fragments and the pinned
# source. It writes into the source tree on purpose: the recorded config IS a
# source file -- the reviewed build input the `kernel` target refuses to
# differ from -- so refreshing it is an edit that gets committed and read in
# a diff, which is the entire mechanism.
kernel-config:
	$(KERNEL_BUILD) --target config -o kernel/config kernel
	@echo "recorded: kernel/config/$(BOARD).config ($$(grep -c . kernel/config/$(BOARD).config) lines)"

# A UEFI board ships no boot firmware of its own; make firmware is a no-op
# so that make firmware over every board asks each family the same thing.
firmware:
	@echo "$(BOARD): no firmware to build (UEFI)"
clean:
	rm -rf $(BSP_OUT)
# ---- the board's own targets ----

.PHONY: all
all: kernel
