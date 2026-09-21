#!/usr/bin/env bash
# The inputs' readers without GitHub: tools/check-lock.sh over the
# specification's vectors (tests/vectors/, a copy of
# mica:docs/design/release-lock/vectors/), tools/locks.sh over the
# committed locks and over file:// releases, tools/from.sh, tools/upstream.sh
# and the syntax pin of every Dockerfile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="${REPO_ROOT}/tools/check-lock.sh"
LOCKS="${REPO_ROOT}/tools/locks.sh"
FROM="${REPO_ROOT}/tools/from.sh"
UPSTREAM="${REPO_ROOT}/tools/upstream.sh"
VECTORS="${REPO_ROOT}/tests/vectors"
TAB=$'\t'
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
mkdir -p "${REPO_ROOT}/tmp"
T="$(mktemp -d "${REPO_ROOT}/tmp/locks-test.XXXXXX")"
trap 'rm -rf "${T}"' EXIT

# Every vector in the table, with no skip: the repos/ family used to be carried
# and skipped here for want of a tools/repos.sh, which is coverage that counts
# and asserts nothing. It is declared in tests/vectors/excluded.tsv instead, so
# a row this loop cannot run is now a difference the sync test refuses.
VECTOR_ROWS=0
while IFS="${TAB}" read -r vector want rule mode; do
    case "${vector}" in '#'*) continue ;; esac
    VECTOR_ROWS=$((VECTOR_ROWS + 1))
    case "${vector}" in
    pins/*) got="$(bash "${CHECK}" pins "${VECTORS}/${vector}" "${mode}" 2>&1 || true)" ;;
    *) got="$(bash "${CHECK}" "${vector%%/*}" "${VECTORS}/${vector}" 2>&1 || true)" ;;
    esac
    expected=valid
    [ "${want}" = valid ] || expected="refused ${rule}"
    if [ "${got}" = "${expected}" ]; then pass "vector ${vector}: ${expected}"; else fail "vector ${vector}: '${got}', want '${expected}'"; fi
done <"${VECTORS}/expected.tsv"
[ "${VECTOR_ROWS}" -gt 0 ] || fail "tests/vectors/expected.tsv named no vector, so the loop above asserted nothing"

expect() { # <0|1> <case> <needle> <command>...
    local want="$1" name="$2" needle="$3" rc=0 out
    shift 3
    out="$("$@" 2>&1)" || rc=$?
    if { [ "${want}" = 0 ] && [ "${rc}" = 0 ]; } || { [ "${want}" = 1 ] && [ "${rc}" != 0 ]; }; then
        if [ "${out#*"${needle}"}" != "${out}" ]; then pass "${name}"; return; fi
    fi
    fail "${name}: wanted exit ${want} with \"${needle}\", got ${rc}: ${out}"
}

expect 0 "the committed locks are well formed" "is well formed" bash "${LOCKS}" check

# A fixture release of mica-build-env served from file://, and a locks/ taken from it.
RELEASE="$(awk -F"\t" '$1 == "release" { print $3 }' "${REPO_ROOT}/locks/mica-build-env.lock")"
publish() { # <dir> <lock file>: the release assets
    mkdir -p "$1"
    cp "$2" "$1/mica-build-env.lock"
    (cd "$1" && sha256sum mica-build-env.lock >SHA256SUMS)
}
consumer() { # <dir> <lock file> <trust>: a locks/ directory
    mkdir -p "$1/pins"
    cp "$2" "$1/mica-build-env.lock"
    cp "${REPO_ROOT}/locks/upstream.lock" "$1/upstream.lock"
    printf '# mica-pin v1\nREPOSITORY=mica-build-env\nRELEASE=%s\nSHA256SUMS=%s\n' "${RELEASE}" "$3" >"$1/pins/mica-build-env.pin"
}
verify() { MICA_LOCKS_DIR="$1" MICA_LOCKS_RELEASES="file://${T}/releases" bash "${LOCKS}" verify; }
D="${T}/releases/mica-build-env/releases/download/${RELEASE}"
publish "${D}" "${REPO_ROOT}/locks/mica-build-env.lock"
TRUST="$(sha256sum "${D}/SHA256SUMS" | cut -d' ' -f1)"

consumer "${T}/good" "${REPO_ROOT}/locks/mica-build-env.lock" "${TRUST}"
expect 0 "verify: a lock that is its release's asset" "verified" verify "${T}/good"
consumer "${T}/trust" "${REPO_ROOT}/locks/mica-build-env.lock" "$(printf 'f%.0s' {1..64})"
expect 1 "verify: a pin recording another SHA256SUMS hash" "hashes to" verify "${T}/trust"
consumer "${T}/altered" "${REPO_ROOT}/locks/mica-build-env.lock" "${TRUST}"
sed -i 's/^image\tupstream\tubuntu:24.04\tamd64/# removed/' "${T}/altered/mica-build-env.lock"
expect 1 "verify: a lock altered after the release" "does not name" verify "${T}/altered"
consumer "${T}/norelease" "${REPO_ROOT}/locks/mica-build-env.lock" "${TRUST}"
sed -i 's/^RELEASE=.*/RELEASE=20990101-0000/' "${T}/norelease/pins/mica-build-env.pin"
sed -i "s/^release\tmica-build-env\t${RELEASE}/release\tmica-build-env\t20990101-0000/" "${T}/norelease/mica-build-env.lock"
expect 1 "verify: a release that cannot be downloaded" "downloading SHA256SUMS" verify "${T}/norelease"
X="${T}/releases/mica-build-env/releases/download/20990101-0001"
publish "${X}" "${REPO_ROOT}/locks/mica-build-env.lock"
echo "0000000000000000000000000000000000000000000000000000000000000000  extra.tar.gz" >>"${X}/SHA256SUMS"
consumer "${T}/extra" "${REPO_ROOT}/locks/mica-build-env.lock" "$(sha256sum "${X}/SHA256SUMS" | cut -d' ' -f1)"
sed -i 's/^RELEASE=.*/RELEASE=20990101-0001/' "${T}/extra/pins/mica-build-env.pin"
sed -i "s/^release\tmica-build-env\t${RELEASE}/release\tmica-build-env\t20990101-0001/" "${T}/extra/mica-build-env.lock"
expect 1 "verify: a SHA256SUMS listing more than the lock" "rather than exactly" verify "${T}/extra"
consumer "${T}/offline" "${REPO_ROOT}/locks/mica-build-env.lock" "${TRUST}"
printf '# mica-pin v1\nREPOSITORY=mica-build-env\nRELEASE=offline\nSHA256SUMS=%s\nCHECKOUT=/srv/mica-build-env\n' "${TRUST}" >"${T}/offline/pins/mica-build-env.pin"
sed -i "s/^release\tmica-build-env\t${RELEASE}/release\tmica-build-env\toffline/; s#ghcr.io/micaoss/#local/#; /^image\tmica-build-env/s#ghcr.io/micaoss/#local/#" "${T}/offline/mica-build-env.lock"
sed -i "/^image\tmica-build-env/s#ghcr\.io/micaoss/#local/#" "${T}/offline/mica-build-env.lock"
expect 1 "check: an offline pin under CI" "checkout-in-ci" env CI=true MICA_LOCKS_DIR="${T}/offline" bash "${LOCKS}" check
consumer "${T}/nopin" "${REPO_ROOT}/locks/mica-build-env.lock" "${TRUST}"
rm "${T}/nopin/pins/mica-build-env.pin"
expect 1 "check: a lock without its pin" "lock-without-pin" env MICA_LOCKS_DIR="${T}/nopin" bash "${LOCKS}" check

expect 0 "from.sh: the rust index by digest" "ghcr.io/micaoss/mica-build-env:rust." bash "${FROM}" --ref rust
expect 0 "from.sh: the arm64 base manifest by digest" "ghcr.io/micaoss/mica-build-env@sha256:" bash "${FROM}" --arch=arm64 --ref base
expect 0 "from.sh: an upstream image by its original reference" "docker.io/moby/buildkit:v0.33.0@sha256:" bash "${FROM}" --upstream moby/buildkit:v0.33.0
expect 1 "from.sh: an image the lock does not list" "taken only from mica-build-env's upstream rows" bash "${FROM}" --upstream registry:2
expect 1 "from.sh: a mica-build-env image the lock does not name" "has no image row" bash "${FROM}" --ref python

expect 0 "from.sh: build arguments for an upstream and a build-env image" "--build-arg" bash "${FROM}" A=upstream:ubuntu:24.04 B=mica-build-env:base
expect 1 "from.sh: a build argument naming neither source" "is not <ARG_NAME>" bash "${FROM}" A=ubuntu:24.04

expect 0 "upstream.sh: a git row's commit" "c6157104418d012823413c02f9222f3fe123dd25" bash "${UPSTREAM}" git cx3576-kernel commit
expect 0 "upstream.sh: a source row's sha256 for one architecture" "7bd7fdeb93481f60271f7d3fb39e41ed7599c9a2f7d03cd1313585ca1f75952d" bash "${UPSTREAM}" source s905x5m-riscv-toolchain arm64 sha256
expect 1 "upstream.sh: a tree the lock does not pin" "pins no git tree" bash "${UPSTREAM}" git cx3576-kernel-next commit
expect 1 "upstream.sh: an architecture a source row does not have" "pins no source" bash "${UPSTREAM}" source s905x5m-arm-linux-toolchain arm64 url

# A board release's scope must be a name; the vectors cover the other scoped refusals.
sed "s#^release\tmica-boards\tuefi-x64[.]#release\tmica-boards\tUEFI-X64.#" "${VECTORS}/lock/valid/mica-boards.uefi-x64.lock" >"${T}/badscope.lock"
expect 1 "check-lock.sh: a scope that is not a name" "refused field-value" bash "${CHECK}" lock "${T}/badscope.lock"

# Every `# syntax=` line names the docker/dockerfile:1 image of the lock's upstream rows, by its digest.
want="$(bash "${FROM}" --upstream docker/dockerfile:1)"
want="docker/dockerfile:1@${want#*@}"
bad=0
while IFS= read -r file; do
    line="$(head -n1 "${REPO_ROOT}/${file}")"
    case "${line}" in '# syntax='*) [ "${line#\# syntax=}" = "${want}" ] || { bad=1; fail "${file}: ${line} is not # syntax=${want}"; } ;; esac
done < <(git -C "${REPO_ROOT}" ls-files '*Dockerfile*' | grep -v '\.dockerignore$')
[ "${bad}" = 1 ] || pass "every Dockerfile syntax line is docker/dockerfile:1 at the lock's digest"

echo "RESULT: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" = 0 ]
