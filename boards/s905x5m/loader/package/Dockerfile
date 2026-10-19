# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Package the section-3 s905x5m U-Boot artifacts as an Amlogic v2 container.

ARG MICA_IMAGE_DEBIAN_TRIXIE
# linux/amd64 and not linux/386: the pinned packer is a statically linked i386
# binary, so an x86-64 kernel runs it through IA-32 emulation with no 32-bit
# userland anywhere. The uboot component is x86-64 by contract (src/boards/inputs.ts
# records `builder amd64`, build.yml pins the job to an x86-64 runner), so on
# CI this stage is native; on any other builder it is emulated as the i386
# stage was: the same inputs pack to the same update.img either way.
FROM --platform=linux/amd64 ${MICA_IMAGE_DEBIAN_TRIXIE} AS packer

ARG PACKER_URL
ARG PACKER_SHA256

# Fetched by BuildKit at its pinned sha256 (the s905x5m-aml-image-v2-packer source
# row): nothing is installed into this image, so the packer runs on exactly the
# pinned Debian image.
ADD --chmod=0755 --checksum=sha256:${PACKER_SHA256} ${PACKER_URL} /usr/local/bin/aml_image_v2_packer
RUN echo "${PACKER_SHA256}  /usr/local/bin/aml_image_v2_packer" | sha256sum -c -

FROM packer AS package-base

COPY . /package
RUN /package/test-manifest.sh /package

WORKDIR /work
COPY config/aml_sdc_burn.ini /work/aml_sdc_burn.ini
COPY config/platform.conf /work/platform.conf
COPY blobs/usb_flow.aml /work/usb_flow.aml
COPY blobs/_aml_dtb.PARTITION /work/_aml_dtb.PARTITION
COPY blobs/SHA256SUMS /work/SHA256SUMS
COPY blobs/recovery-gpt.bin /work/recovery-gpt.bin
COPY --from=uboot-artifacts DDR.USB /work/DDR.USB
COPY --from=uboot-artifacts u-boot.bin.signed /work/bootloader.PARTITION
COPY --from=uboot-artifacts u-boot.bin.sd.bin.signed /work/aml_sdc_burn.UBOOT

FROM package-base AS bootloader-package

COPY config/bootloader.cfg /work/image.cfg
RUN /package/pack-and-verify.sh /work /output

FROM scratch AS bootloader-artifact
COPY --from=bootloader-package /output/update.img /
COPY --from=bootloader-package /work/aml_sdc_burn.ini /

FROM package-base AS emmc-recovery-package
COPY config/emmc-recovery.cfg /work/image.cfg
COPY config/emmc-system-burn.ini /work/aml_sdc_burn.ini
RUN cp recovery-gpt.bin gpt.bin && /package/pack-and-verify.sh /work /output recovery
FROM scratch AS emmc-recovery-artifact
COPY --from=emmc-recovery-package /output/update.img /
COPY --from=emmc-recovery-package /work/aml_sdc_burn.ini /
