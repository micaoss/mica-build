# s905x5m: Amlogic S7D on the BM201, signed FIT boot through U-Boot, SD boot.
# This board owns its whole build: the kernel (kernel/Dockerfile,
# kernel/configure.sh, kernel/build.sh, the hooks under kernel/hooks/), U-Boot
# (loader/Dockerfile and the loader policy beside it), the upstream source pins
# (its rows of ../../locks/upstream.lock) and the names of its files (bsp.env); the inputs every board
# shares come from ../../common/. Also here: the Bluetooth bridge userland and
# the Amlogic recovery package (the FIT packager image is the assembly's,
# built by its product driver over the bundle's tools).
#
#   make kernel   -> $(BSP_OUT)/kernel/{dev,prod}/{Image,modules.tar,<dtb>,config,kernel.release,System.map,regdb-certs.pem}
#   make uboot    -> $(BSP_OUT)/uboot/ (the signed U-Boot, DDR.USB, the FIT tools)
BOARD := s905x5m

# ---- the kernel and U-Boot builds of this board ----
include bsp.env
BSP_OUT ?= ../../_out/$(BOARD)

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


VERITY_TRUST_CERT ?= ../../meta/verity/signer.cert.pem
FIT_TRUST_CERT ?=
TRUST_STAGE := ../../common/trust/stage.sh

# BUILDX_CACHE=<absolute directory>: common/scripts/buildx.sh caches the
# builds' third-party prefix stage there (CI); unset, it is a plain buildx build.

.PHONY: kernel kernel-profile-test uboot firmware clean
# One kernel per image profile, each forcing its own mica.profile token
# (common/kernel/set-profile.sh), from one compile: dev is built whole and prod
# relinked in the same tree -> $(BSP_OUT)/kernel/dev/ and $(BSP_OUT)/kernel/prod/.
# kernel-profile-test builds prod alone, clean, and requires every file of it to
# be byte-identical to the relinked prod of `make kernel`.
KERNEL_BUILDX = TRUST_DIR="$$(bash $(TRUST_STAGE) "$(VERITY_TRUST_CERT)" "$(BSP_OUT)/verity-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	KERNEL_REPO="$$($(PIN) git $(BOARD)-kernel url)" && KERNEL_COMMIT="$$($(PIN) git $(BOARD)-kernel commit)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-kernel source --label ai-agent=true -t ai-agent/mica-$(BOARD)-kernel \
	  --build-context common=../../common \
	  --build-context mica-common=../../common/kernel --build-context "mica-trust=$$TRUST_DIR" \
	  --build-arg KERNEL_REPO=$$KERNEL_REPO --build-arg KERNEL_COMMIT=$$KERNEL_COMMIT \
	  --build-arg KERNEL_GIT_NAME=$(BOARD)-kernel $(MIRROR_ARG) \
	  --build-arg KERNEL_EXPECT=$(KERNEL_EXPECT) --build-arg KERNEL_CONFIG=$(KERNEL_CONFIG) \
	  --build-arg "KERNEL_FRAGMENTS=$(KERNEL_FRAGMENTS)" \
	  --build-arg KERNEL_DTB=$(KERNEL_DTB) --build-arg KERNEL_DTB_ARTIFACT=$(KERNEL_DTB_ARTIFACT) \
	  -f kernel/Dockerfile --target artifact $$IMG
kernel:
	$(KERNEL_BUILDX) -o $(BSP_OUT)/kernel .

kernel-profile-test:
	@test -s $(BSP_OUT)/kernel/prod/Image || { echo "error: $(BSP_OUT)/kernel/prod/ holds no Image; run make kernel first" >&2; exit 1; }
	rm -rf $(BSP_OUT)/kernel-profile-test
	$(KERNEL_BUILDX) --build-arg KERNEL_PROFILES=prod -o $(BSP_OUT)/kernel-profile-test .
	bash ../../common/kernel/profile-test.sh $(BSP_OUT)/kernel/prod $(BSP_OUT)/kernel-profile-test/prod

# Only public FIT trust enters the firmware builder. The vendor toolchains are
# source rows (name:arch), handed in as <ARG>_URL_<arch> and <ARG>_SHA256_<arch>;
# ARM publishes no aarch64-host build of the Linux toolchain.
UBOOT_TOOLCHAINS := ARM_GNU_TOOLCHAIN:s905x5m-arm-gnu-toolchain:amd64 ARM_GNU_TOOLCHAIN:s905x5m-arm-gnu-toolchain:arm64 \
	ARM_LINUX_TOOLCHAIN:s905x5m-arm-linux-toolchain:amd64 \
	RISCV_TOOLCHAIN:s905x5m-riscv-toolchain:amd64 RISCV_TOOLCHAIN:s905x5m-riscv-toolchain:arm64
uboot:
	TRUST_DIR="$$(bash $(TRUST_STAGE) "$(FIT_TRUST_CERT)" "$(BSP_OUT)/fit-trust")" && \
	IMG="$$(bash $(FROM_SH) $(BSP_ARG))" && \
	UBOOT_REPO="$$($(PIN) git $(BOARD)-uboot url)" && UBOOT_COMMIT="$$($(PIN) git $(BOARD)-uboot commit)" && \
	TOOLCHAINS="$$(for row in $(UBOOT_TOOLCHAINS); do \
	  set -- $$(echo "$$row" | tr : ' '); \
	  url="$$($(PIN) source $$2 $$3 url)" && sha="$$($(PIN) source $$2 $$3 sha256)" || exit 1; \
	  echo "--build-arg $${1}_URL_$$3=$$url --build-arg $${1}_SHA256_$$3=$$sha"; \
	done)" && \
	bash ../../common/scripts/buildx.sh $(BOARD)-uboot source --label ai-agent=true -t ai-agent/mica-$(BOARD)-uboot \
	  --build-context mica-common=../../common/uboot --build-context "mica-boot-trust=$$TRUST_DIR" \
	  --build-context bsp-scripts=../../common/scripts \
	  --build-arg UBOOT_REPO=$$UBOOT_REPO --build-arg UBOOT_COMMIT=$$UBOOT_COMMIT \
	  --build-arg UBOOT_GIT_NAME=$(BOARD)-uboot $(MIRROR_ARG) $$TOOLCHAINS \
	  -f loader/Dockerfile $$IMG \
	  -o $(BSP_OUT)/uboot loader

# What the family builds; a board adds its own (s905x5m: uboot-package).
firmware: uboot
clean:
	rm -rf $(BSP_OUT)
# ---- the board's own targets ----

.PHONY: uboot-package uboot-package-test userland

# The recovery package is this board's firmware too.
firmware: uboot-package

DEBIAN_ARG := MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim
USERLAND_ARG := MICA_BUILD_C=mica-build-env:c
UBOOT_ARTIFACTS := $(BSP_OUT)/uboot/u-boot.bin.signed \
	$(BSP_OUT)/uboot/u-boot.bin.sd.bin.signed \
	$(BSP_OUT)/uboot/DDR.USB
UBOOT_PACKAGE_DIR := $(BSP_OUT)/uboot-package

userland:
	IMG="$$(bash $(FROM_SH) $(USERLAND_ARG))" && \
	docker buildx build --label ai-agent=true --platform linux/arm64 --target artifact \
	  -f userland/Dockerfile $$IMG -o $(BSP_OUT)/userland userland

# Packaging is a separate consumer of the section-3 U-Boot artifact interface.
# It deliberately does not rebuild U-Boot: first produce the three artifacts
# with `make uboot`, then package exactly those bytes.
uboot-package-test:
	bash loader/package/test-manifest.sh loader/package

uboot-package: uboot-package-test
	@set -eu; \
	for artifact in $(UBOOT_ARTIFACTS); do \
		[ -s "$$artifact" ] || { \
			printf 'error: missing U-Boot artifact: %s\\n' "$$artifact" >&2; \
			printf '%s\\n' '       run make uboot before make uboot-package' >&2; \
			exit 1; \
		}; \
	done; \
	mkdir -p "$(BSP_OUT)"; \
	tmp_output="$$(mktemp -d $(BSP_OUT)/.uboot-package.XXXXXX)"; \
	trap 'rm -rf "$$tmp_output"' 0 1 2 3 15; \
	IMG="$$(bash $(FROM_SH) $(DEBIAN_ARG))"; \
	PACKER_URL="$$($(PIN) source s905x5m-aml-image-v2-packer all url)"; \
	PACKER_SHA256="$$($(PIN) source s905x5m-aml-image-v2-packer all sha256)"; \
	docker buildx build --label ai-agent=true -t ai-agent/mica-s905x5m-recovery --platform linux/amd64 --target bootloader-artifact \
		--build-arg "PACKER_URL=$$PACKER_URL" --build-arg "PACKER_SHA256=$$PACKER_SHA256" \
		--build-context uboot-artifacts=$(BSP_OUT)/uboot \
		-f loader/package/Dockerfile $$IMG \
		-o "$$tmp_output" loader/package; \
	test -s "$$tmp_output/update.img"; \
	cmp -s loader/package/config/aml_sdc_burn.ini "$$tmp_output/aml_sdc_burn.ini"; \
	(cd "$$tmp_output" && sha256sum update.img > update.img.sha256); \
	rm -rf "$(UBOOT_PACKAGE_DIR)"; \
	mv "$$tmp_output" "$(UBOOT_PACKAGE_DIR)"; \
	trap - 0 1 2 3 15; \
	ls -l "$(UBOOT_PACKAGE_DIR)/update.img"; \
	cat "$(UBOOT_PACKAGE_DIR)/update.img.sha256"
