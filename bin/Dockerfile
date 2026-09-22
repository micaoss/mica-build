# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# Build acceptance needs real file capabilities and the RockUSB test transport.
# Base and CLI digests are resolved by src/cli.ts from. Debian packages use
# the base's archive; record the resolved versions for inspection.
ARG MICA_DOCKER_CLI_IMAGE=invalid-must-be-passed
ARG MICA_BUN_IMAGE=invalid-must-be-passed
FROM ${MICA_DOCKER_CLI_IMAGE} AS cli
FROM ${MICA_BUN_IMAGE}
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN apt-get update && apt-get install -y --no-install-recommends python3 libcap2-bin && \
    mkdir -p /etc/mica-build && \
    dpkg-query -W python3 libcap2-bin libcap2 > /etc/mica-build/build-tools.tsv && \
    rm -rf /var/lib/apt/lists/* && \
    command -v getcap && command -v setcap && python3 --version && \
    docker --version && docker buildx version && bun --version
