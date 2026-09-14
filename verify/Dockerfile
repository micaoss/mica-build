# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# The image verify runs the full verifier in on a host that has no bun.
#
#   bash verify/run.sh --verify --board cx3576   (on a host with no bun)
#   make os-verify-cx3576
#
# Not built by `make build-env`, which builds the four mica-build-* compiler
# images: .github/workflows/ci.yml's suites job installs no bun and runs no
# build-env, so an image produced there would be missing at exactly the moment it
# is needed. verify/run.sh builds this on demand instead, once, and only when
# it has both to take the container route and to run `--verify`.
#
# IMAGE_MICA_BUILD_BASE alone cannot carry the verifier: verify drives docker itself --
# src/tools.ts reads the image with sgdisk, mtools, debugfs, unsquashfs and
# veritysetup out of IMAGE_ALPINE_3_21 -- and the pinned bun image carries no
# docker client, so inside it every route ends at `docker: command not found`.
# base-images.env pins IMAGE_DOCKER_CLI_28: a client, by digest.
#
# Two pins, no third thing. Both FROMs are digests handed in as build arguments
# by verify/run.sh through tools/from.sh, the one resolver, which
# refuses a tag. Nothing is installed here -- no apk, no apt, no curl -- so this
# image is exactly the pinned bun image plus two files out of the pinned client
# image, and "what did the verifier run on" is answerable from two digests.
#
# The client is static, which is what lets an alpine-built binary run on a
# debian-based bun image; checked rather than assumed, `ldd` reports "Not a valid
# dynamic program". A dynamically linked client would need musl and this COPY
# would produce an image that fails at exec time with a message about an
# interpreter, three steps away from the cause.

ARG MICA_DOCKER_CLI_IMAGE=invalid-must-be-passed
ARG MICA_BUN_IMAGE=invalid-must-be-passed

FROM ${MICA_DOCKER_CLI_IMAGE} AS cli

FROM ${MICA_BUN_IMAGE}
# /usr/local/bin, which is where the client image itself keeps it and where the
# bun image's PATH already looks. Copied to its own path rather than /usr/bin so
# that it cannot shadow anything the base ships.
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker

# AND THE BUILDX PLUGIN, from the same pinned image. `docker buildx` is not a
# subcommand of the client above -- it is a separate binary the client finds by
# looking in its plugin directories -- so the client alone answered
# `docker: unknown command: docker buildx`, and `build/run.sh --build-rootfs`
# refused the container route outright rather than failing once per stage inside
# src/stages.ts. That refusal is what PLAN-080 backlog B5 lifts, and this is the
# COPY it names.
#
# THE DIRECTORY IS THE CLIENT'S OWN, not ~/.docker/cli-plugins: the client
# searches /usr/local/libexec/docker/cli-plugins before any per-user path, and a
# per-user path would depend on which HOME the container ran with -- `--user` is
# passed on some routes here and not others.
#
# Static, like the client, which is what lets an alpine-built binary run on this
# debian-based base; the same `ldd` answer, "Not a valid dynamic program".
# Measured 2026-09-07: `github.com/docker/buildx v0.29.1`.
#
# NOT A HOST MOUNT OF THE HOST'S PLUGIN DIRECTORY, which was the other way to
# make this work and is rejected in PLAN-080 section 11: it puts a second host
# binary inside a pinned image, and the pin exists so that what runs is a
# recorded value. This copies from the digest already in the FROM above, so the
# image is still exactly two pins and no third thing.
COPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# Asserted at BUILD time, not left for the verifier to discover. A COPY whose
# source moved upstream produces an image that is missing the one thing this
# file exists to add, and the failure would then surface inside a verify run as
# a route that could not find docker -- which is the exact sentence this image
# was built to stop printing.
#
# `docker buildx version` and not `ls` on the plugin: the plugin directory is a
# convention the client implements, so a file that landed in the right place
# under a name the client does not recognise would pass a file test and still
# leave `docker buildx` unknown. Asking the client is asking the thing that has
# to find it.
RUN docker --version && docker buildx version && bun --version
