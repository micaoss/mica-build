#!/usr/bin/env bash
# The build outputs a workflow job hands to the next, as tar files with unique
# names, so a download of one artifact and of several look the same.
#
#   bash tools/ci-outputs.sh pack <name> <path under _out>...   _out/<name>.tar holding those paths
#   bash tools/ci-outputs.sh unpack <dir> <expected name>...    every <name>.tar in <dir> into _out/;
#                                                               each expected one must be there
#
# build.yml and release.yml upload each tar as the artifact <name> and download
# with merge-multiple, which puts every tar flat in one directory whether one
# artifact matched or many. A missing expected tar is an error, never taken for a
# reused component or an absent architecture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "ci-outputs.sh: error: $*" >&2; exit 1; }
cd "${REPO_ROOT}"

case "${1-}" in
pack)
    [ "$#" -ge 3 ] || die "usage: bash tools/ci-outputs.sh pack <name> <path under _out>..."
    name="$2"; shift 2
    [[ "${name}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "'${name}' is not an artifact name"
    for p in "$@"; do [ -e "_out/${p}" ] || die "_out/${p} does not exist"; done
    tar -cf "_out/${name}.tar" -C _out "$@"
    echo "ci-outputs.sh: _out/${name}.tar ($*)"
    ;;
unpack)
    [ "$#" -ge 2 ] || die "usage: bash tools/ci-outputs.sh unpack <dir> <expected name>..."
    dir="$2"; shift 2
    for name in "$@"; do [ -f "${dir}/${name}.tar" ] || die "${dir}/${name}.tar is missing; the job that builds ${name} did not hand it over"; done
    mkdir -p _out
    found=0
    for t in "${dir}"/*.tar; do
        [ -e "${t}" ] || continue
        tar -xf "${t}" -C _out
        found=$((found + 1))
        echo "ci-outputs.sh: ${t##*/} into _out/"
    done
    [ "${found}" -gt 0 ] || die "${dir} holds no output tar"
    ;;
*) die "usage: bash tools/ci-outputs.sh pack <name> <path>... | unpack <dir> <expected name>..." ;;
esac
