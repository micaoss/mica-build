# cx3576: Rockchip RK3576, signed FIT boot through U-Boot. This board owns its
# whole build: the kernel (kernel/Dockerfile, kernel/configure.sh,
# kernel/build.sh, the hooks under kernel/hooks/), U-Boot (loader/Dockerfile
# and the loader policy beside it), the upstream source pins (its rows of
# ../../locks/upstream.lock) and
# the names of its files (bsp.env); the inputs every board shares come from
# ../../common/. Also here: flashing the complete signed image over
# rkdeveloptool, the macOS flashing tool and the CJK source check.
#
#   make kernel      -> $(BSP_OUT)/kernel/{dev,prod}/{Image,config,System.map,kernel.release,modules.tar,<dtb>,regdb-certs.pem}
#   make uboot-mica   -> $(BSP_OUT)/uboot-mica/ (u-boot-rockchip.bin, the FIT tools, mica.config)
BOARD := cx3576

# ---- the kernel and U-Boot builds of this board ----
include bsp.env
BSP_OUT ?= ../../_out/$(BOARD)

# EVERY BASE IMAGE COMES FROM ../../locks/mica-build-env.lock, resolved in the
# recipe and not with $(shell ...), so a broken pin stops make with from.sh's
# own message instead of reaching docker as an empty argument.
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


# The same public certificate bundles to every builder. Kernel and U-Boot
# builds never mint keys; the certificates come from the assembly, which
# alone holds the private keys.
VERITY_TRUST_CERT ?= ../../meta/verity/signer.cert.pem
FIT_TRUST_CERT ?=
TRUST_STAGE := ../../common/trust/stage.sh

# BUILDX_CACHE=<absolute directory>: common/scripts/buildx.sh caches the
# builds' third-party prefix stage there (CI); unset, it is a plain buildx build.

.PHONY: kernel kernel-profile-test uboot-mica firmware clean
# One kernel per image profile, each forcing its own mica.profile token
# (common/kernel/set-profile.sh), from one compile: dev is built whole and prod
# relinked in the same tree -> $(BSP_OUT)/kernel/dev/ and $(BSP_OUT)/kernel/prod/.
# kernel-profile-test builds prod alone, clean, and requires every file of it to
# be byte-identical to the relinked prod of `make kernel`.
KERNEL_BUILDX = TRUST_DIR="$$(bash $(TRUST_STAGE) "$(VERITY_TRUST_CERT)" "$(BSP_OUT)/verity-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	KERNEL_REPO="$$($(PIN) git $(BOARD)-kernel url)" && KERNEL_COMMIT="$$($(PIN) git $(BOARD)-kernel commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-kernel source --build-context common=../../common \
	  --build-context mica-common=../../common/kernel --build-context "mica-trust=$$TRUST_DIR" \
	  --build-arg KERNEL_REPO=$$KERNEL_REPO --build-arg KERNEL_COMMIT=$$KERNEL_COMMIT \
	  --build-arg KERNEL_GIT_NAME=$(BOARD)-kernel $(MIRROR_ARG) \
	  --build-arg KERNEL_EXPECT=$(KERNEL_EXPECT) --build-arg KERNEL_CONFIG=$(KERNEL_CONFIG) \
	  --build-arg KERNEL_DTB=$(KERNEL_DTB) --build-arg KERNEL_DTB_ARTIFACT=$(KERNEL_DTB_ARTIFACT) \
	  -f kernel/Dockerfile --target artifact $$IMG
kernel:
	$(KERNEL_BUILDX) -o $(BSP_OUT)/kernel .

kernel-profile-test:
	@test -s $(BSP_OUT)/kernel/prod/Image || { echo "error: $(BSP_OUT)/kernel/prod/ holds no Image; run make kernel first" >&2; exit 1; }
	rm -rf $(BSP_OUT)/kernel-profile-test
	$(KERNEL_BUILDX) --build-arg KERNEL_PROFILES=prod -o $(BSP_OUT)/kernel-profile-test .
	bash ../../common/kernel/profile-test.sh $(BSP_OUT)/kernel/prod $(BSP_OUT)/kernel-profile-test/prod

# Fixed FIT policy with explicit public boot trust; no private signing input.
# The context is the board's uboot/ directory (its policy scripts, patches,
# tests and the vendor loader); the shared fetch and patch scripts arrive
# through the `bsp-scripts` context so the context need not widen to the
# whole board directory with its committed firmware.
uboot-mica:
	TRUST_DIR="$$(bash $(TRUST_STAGE) "$(FIT_TRUST_CERT)" "$(BSP_OUT)/fit-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	UBOOT_REPO="$$($(PIN) git $(BOARD)-uboot url)" && UBOOT_COMMIT="$$($(PIN) git $(BOARD)-uboot commit)" && \
	RKBIN_REPO="$$($(PIN) git $(BOARD)-rkbin url)" && RKBIN_COMMIT="$$($(PIN) git $(BOARD)-rkbin commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-uboot source --label ai-agent=true -t ai-agent/mica-$(BOARD)-uboot \
	  --build-context bsp-scripts=../../common/scripts \
	  --build-context mica-common=../../common/uboot --build-context "mica-boot-trust=$$TRUST_DIR" \
	  --build-arg UBOOT_REPO=$$UBOOT_REPO --build-arg UBOOT_COMMIT=$$UBOOT_COMMIT \
	  --build-arg RKBIN_REPO=$$RKBIN_REPO --build-arg RKBIN_COMMIT=$$RKBIN_COMMIT \
	  --build-arg UBOOT_GIT_NAME=$(BOARD)-uboot --build-arg RKBIN_GIT_NAME=$(BOARD)-rkbin $(MIRROR_ARG) \
	  --build-arg DDR_BLOB=$(DDR_BLOB) --build-arg BL31_BLOB=$(BL31_BLOB) \
	  --build-arg UBOOT_DEFCONFIG=$(UBOOT_DEFCONFIG) \
	  -f loader/Dockerfile --target artifact-mica $$IMG \
	  -o $(BSP_OUT)/uboot-mica loader

firmware: uboot-mica
clean:
	rm -rf $(BSP_OUT)
# ---- the board's own targets ----

.PHONY: all rkdeveloptool-macos flash-maskrom flash-mica source-check

# The complete factory image is assembled from independently signed components.
MICA_OUT ?= ../../_out/image
MICA_IMAGE ?= $(lastword $(sort $(wildcard $(MICA_OUT)/mica-cx3576-*.img)))

TOOLS_DIR ?= flash/tools
THIRD_DIR ?= flash
RKDEVELOPTOOL_LOCAL := $(TOOLS_DIR)/rkdeveloptool
RKDEVELOPTOOL ?= $(if $(wildcard $(RKDEVELOPTOOL_LOCAL)),$(RKDEVELOPTOOL_LOCAL),rkdeveloptool)
VENDOR_MINILOADER := loader/MiniLoaderAll.bin
# Prefer coreutils sha256sum (Linux hosts and CI, no Perl needed); fall back
# to Perl/macOS shasum. Both accept the same `-c` checkfile format.
SHA256 := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo "shasum -a 256")

all: kernel uboot-mica

# Build the native macOS flashing tool.
rkdeveloptool-macos:
	$(THIRD_DIR)/rkdeveloptool/build-macos.sh

# Reject CJK text in source and configuration files; Markdown is documentation.
source-check:
	@if git grep --untracked -I -n -P '(*UTF)[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}]' \
		-- . ':(exclude)*.md'; then \
		echo 'error: CJK text is not allowed in source files' >&2; \
		exit 1; \
	else \
		rc=$$?; test "$$rc" -eq 1 || exit "$$rc"; \
	fi

# Full-system installation only. The board remains in Loader mode on any failure.
flash-mica:
	@test -n "$(MICA_IMAGE)" || { echo 'error: no timestamped cx3576 image found; set MICA_IMAGE explicitly' >&2; exit 1; }
	bash flash/scripts/verify-flash.sh --check "$(MICA_IMAGE)"
	$(RKDEVELOPTOOL) wl 0 "$(MICA_IMAGE)"
	RKDEVELOPTOOL='$(RKDEVELOPTOOL)' bash flash/scripts/verify-flash.sh "$(MICA_IMAGE)"
	$(RKDEVELOPTOOL) rd

flash-maskrom:
	@test -n "$(MICA_IMAGE)" || { echo 'error: no timestamped cx3576 image found; set MICA_IMAGE explicitly' >&2; exit 1; }
	bash flash/scripts/verify-flash.sh --check "$(MICA_IMAGE)"
	$(SHA256) -c loader/MiniLoaderAll.bin.sha256
	$(RKDEVELOPTOOL) db $(VENDOR_MINILOADER)
	$(MAKE) flash-mica MICA_IMAGE="$(MICA_IMAGE)" RKDEVELOPTOOL="$(RKDEVELOPTOOL)"
