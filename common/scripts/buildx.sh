#!/usr/bin/env bash
# `docker buildx build` for a kernel or U-Boot build, with the CI cache of its
# third-party prefix when BUILDX_CACHE names a cache directory.
#
#   bash common/scripts/buildx.sh <cache name> <prefix stage> <docker buildx build arguments...>
#
# Without BUILDX_CACHE this is exactly `docker buildx build <arguments>`. With
# it, the prefix stage (the toolchain and the upstream source, nothing of this
# repository) is built first, reading the cache from
# $BUILDX_CACHE/<cache name> and writing it to $BUILDX_CACHE.new/<cache name>;
# then the full build runs with that prefix as its only cache. Every step that
# takes this repository's inputs -- patches, configuration, the kernel-config
# gates, the compile -- runs every time, so a cache never shortens a build's
# checks and the outputs are the same without it.
set -euo pipefail
[ "$#" -ge 3 ] || { echo "usage: bash common/scripts/buildx.sh <cache name> <prefix stage> <docker buildx build arguments...>" >&2; exit 1; }
name="$1"; prefix="$2"; shift 2
[[ "${name}" =~ ^[a-z0-9-]+$ ]] || { echo "error: '${name}' is not a cache name" >&2; exit 1; }
if [ -z "${BUILDX_CACHE:-}" ]; then
    exec docker buildx build "$@"
fi
case "${BUILDX_CACHE}" in /*) ;; *) echo "error: BUILDX_CACHE='${BUILDX_CACHE}' is not an absolute directory" >&2; exit 1 ;; esac

# The prefix pass exports nothing: the full build's -o/--output, --target and
# -t/--tag are left out.
full=("$@")
pass=()
while [ "$#" -gt 0 ]; do
    case "$1" in
    -o | --output | --target | -t | --tag) shift 2 ;;
    -o=* | --output=* | --target=* | -t=* | --tag=*) shift ;;
    *) pass+=("$1"); shift ;;
    esac
done
src="${BUILDX_CACHE}/${name}"
dest="${BUILDX_CACHE}.new/${name}"
mkdir -p "$(dirname "${dest}")"
from=()
[ ! -d "${src}" ] || from=(--cache-from "type=local,src=${src}")
echo "buildx.sh: ${name}: the ${prefix} stage, cache ${src} -> ${dest}"
docker buildx build "${pass[@]}" --target "${prefix}" ${from[@]+"${from[@]}"} \
    --cache-to "type=local,dest=${dest},mode=max" --output type=cacheonly
echo "buildx.sh: ${name}: the full build on the cached ${prefix} stage"
docker buildx build "${full[@]}" --cache-from "type=local,src=${dest}"
