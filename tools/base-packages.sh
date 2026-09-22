#!/usr/bin/env bash
# The Debian packages mica-system-base pins for later stages: the upstream rows of locks/mica-system-base.lock.
#
#   bash tools/base-packages.sh check
#       rootfs/packages/presets.json names only packages the upstream rows list
#   bash tools/base-packages.sh fetch --arch A
#       every row of that architecture into _out/cache/debian/<sha256>.deb, hashed and read for its
#       control fields (kept beside it as <sha256>.control), which must be the row's
#   bash tools/base-packages.sh select --arch A --packages "<local package> ..."
#       the rows those local packages need on the Base root, as TSV: package, version, Debian
#       architecture, sha256, url, and the local packages that need it
#
# locks/mica-system-base.lock is the lock of the pinned mica-system-base
# release, committed unchanged (tools/locks.py checks its rows, `verify` its
# release). These packages are never in the Base root; a product installs the
# ones its selection needs, and this tree pins none of them itself.
#
# THE ROOTS. Each row names the roots of Base's upstream.pkgs it is pinned for;
# a package is in a root's closure exactly when that root is listed. `select`
# reads the Depends and Pre-Depends of the selected archives (the pool index):
# a dependency the Base root's dpkg status or the pool does not satisfy must be
# a root, and the whole closure of every such root is installed. A dependency
# that is neither is refused by name: such a package is proposed for Base's
# upstream.pkgs. The selected rows' own dependencies are then checked against
# the Base root and the selection, so a closure that does not install is
# refused here rather than in dpkg.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
CACHE="${REPO_ROOT}/_out/cache/debian"
STATUS_CACHE="${REPO_ROOT}/_out/cache/base-status"

die() { echo "base-packages.sh: error: $*" >&2; exit 1; }
arch_arg() { case "${1:-}" in amd64 | arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac; }

# Every upstream row, checked by tools/locks.py, as TSV: package, architecture, version, sha256, url, roots.
rows() { # [arch]
    bash "${HERE}/../bin/bun.sh" src/cli.ts locks rows upstream mica-system-base | awk -F'\t' -v want="${1:-}" 'want == "" || $3 == want { print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7 }'
}

cmd="${1:-}"
[ "$#" -eq 0 ] || shift
ARCH=""; PACKAGES=""
while [ "$#" -gt 0 ]; do
    case "$1" in
    --arch) ARCH="${2:-}"; shift 2 ;;
    --packages) PACKAGES="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
    esac
done

case "${cmd}" in
check)
    n="$(rows | wc -l)"
    [ "${n}" -gt 0 ] || die "locks/mica-system-base.lock has no upstream row"
    presets="${REPO_ROOT}/rootfs/packages/presets.json"
    jq -e 'type == "object" and ([to_entries[] | .value | (keys | sort) == ["system", "user"]
        and ([.system[], .user[]] | all(test("^[A-Za-z0-9@_.-]+\\.(service|socket|timer|path)$")))] | all)' "${presets}" >/dev/null ||
        die "${presets} is not {<package>: {system: [<unit> ...], user: [<unit> ...]}}"
    for p in $(jq -r 'keys[]' "${presets}"); do
        rows | cut -f1 | grep -Fx -- "${p}" >/dev/null || die "${presets} presets units of ${p}, which no upstream row of locks/mica-system-base.lock lists"
    done
    echo "base-packages.sh: rootfs/packages/presets.json names only upstream rows of locks/mica-system-base.lock (${n} rows)"
    ;;
fetch)
    arch_arg "${ARCH}"
    mkdir -p "${CACHE}" "${REPO_ROOT}/_out"
    WORK="$(mktemp -d "${REPO_ROOT}/_out/.base-packages.XXXXXX")"
    trap 'rm -rf "${WORK}"' EXIT
    rows "${ARCH}" >"${WORK}/rows"
    : >"${WORK}/check"
    while IFS=$'\t' read -r name _ version sha url _; do
        cached="${CACHE}/${sha}.deb"
        if ! [ -f "${cached}" ] || [ "$(sha256sum "${cached}" | cut -d' ' -f1)" != "${sha}" ]; then
            code="$(curl -sS -L -o "${cached}.part" -w '%{http_code}' --retry 3 --max-time 1800 "${url}" || echo 000)"
            [ "${code}" = 200 ] || { rm -f "${cached}.part"; die "downloading ${url} answered ${code} (000: not reached)"; }
            [ "$(sha256sum "${cached}.part" | cut -d' ' -f1)" = "${sha}" ] || { rm -f "${cached}.part"; die "${url} hashes to other bytes than the pinned ${sha}"; }
            mv "${cached}.part" "${cached}"
        fi
        printf '%s\t%s\t%s\n' "${sha}" "${name}" "${version}" >>"${WORK}/check"
    done <"${WORK}/rows"
    image="$(bash "${HERE}/../bin/bun.sh" src/cli.ts from --ref mica-build-env:base)"
    # mica-build-side: container-block -- dpkg-deb reads the control fields in mica-build-env:base.
    docker run --rm --label ai-agent=true --network none -v "${CACHE}:/cache" -v "${WORK}:/work:ro" -e "ARCH=${ARCH}" "${image}" bash -c '
        set -euo pipefail
        while IFS="	" read -r sha name version; do
            dpkg-deb -f "/cache/${sha}.deb" >"/cache/${sha}.control.part"
            got="$(dpkg-deb -f "/cache/${sha}.deb" Package)	$(dpkg-deb -f "/cache/${sha}.deb" Version)"
            arch="$(dpkg-deb -f "/cache/${sha}.deb" Architecture)"
            [ "${got}" = "${name}	${version}" ] && { [ "${arch}" = "${ARCH}" ] || [ "${arch}" = all ]; } ||
                { echo "base-packages.sh: error: ${sha}.deb is ${got} ${arch}; the lock says ${name} ${version} ${ARCH}" >&2; exit 1; }
            mv "/cache/${sha}.control.part" "/cache/${sha}.control"
        done </work/check'
    # mica-build-side: host
    echo "base-packages.sh: $(grep -c . "${WORK}/rows") ${ARCH} upstream archive(s) of locks/mica-system-base.lock verified into ${CACHE#"${REPO_ROOT}"/}"
    ;;
select)
    arch_arg "${ARCH}"
    index="${REPO_ROOT}/_out/debs/${ARCH}/Packages"
    [ -s "${index}" ] || die "${index} does not exist; index the pool first (bash tools/pool.sh index --arch ${ARCH})"
    # The Base root's dpkg status, read out of its platform manifest without running it.
    ref="$(bash "${HERE}/../bin/bun.sh" src/cli.ts from --ref "mica-system-base:rootfs@${ARCH}")"
    status="${STATUS_CACHE}/${ref##*@}"
    if [ ! -s "${status}" ]; then
        mkdir -p "${STATUS_CACHE}"
        cid="$(docker create --label ai-agent=true --platform "linux/${ARCH}" "${ref}" /bin/true)"
        docker cp "${cid}:/var/lib/dpkg/status" "${status}.part" >/dev/null
        docker rm "${cid}" >/dev/null
        mv "${status}.part" "${status}"
    fi
    rows "${ARCH}" | python3 -c '
import sys
cache, index, status, wanted = sys.argv[1:5]

def paragraphs(text):
    for block in text.strip().split("\n\n"):
        fields, key = {}, None
        for line in block.splitlines():
            if line[:1] in (" ", "\t") and key:
                fields[key] += " " + line.strip()
            elif ": " in line or line.endswith(":"):
                key, _, value = line.partition(":")
                fields[key] = value.strip()
        if fields:
            yield fields

def names(field):
    return [[alt.strip().split()[0].split(":")[0] for alt in group.split("|")] for group in field.split(",") if group.strip()]

def provides(fields):
    return {fields["Package"]} | {p[0] for p in names(fields.get("Provides", ""))}

satisfied = set()
for p in paragraphs(open(status).read()):
    if p.get("Status", "").endswith(" installed"):
        satisfied |= provides(p)
local = {p["Package"]: p for p in paragraphs(open(index).read())}
lock = {}
for line in sys.stdin:
    name, _, version, sha, url, roots = line.rstrip("\n").split("\t")
    control = next(paragraphs(open(f"{cache}/{sha}.control").read()))
    lock[name] = dict(control=control, version=version, sha=sha, url=url, roots=set(roots.split(",")))
all_roots = set().union(*(row["roots"] for row in lock.values())) if lock else set()
depends = lambda fields: names(fields.get("Pre-Depends", "") + "," + fields.get("Depends", ""))
selected = wanted.split()
for name in selected:
    if name not in local:
        sys.exit(f"base-packages.sh: error: {name} is not in the pool index {index}")
base = set(satisfied)
# The roots the selected archives need: a dependency neither the Base root nor the pool satisfies.
needed, missing = {}, []
for name in selected:
    for group in depends(local[name]):
        if any(alt in base or alt in local for alt in group):
            continue
        root = next((alt for alt in group if alt in all_roots), None)
        if root is None:
            missing.append(name + " needs " + " | ".join(group))
            continue
        needed.setdefault(root, set()).add(name)
if missing:
    sys.exit("base-packages.sh: error: neither the Base root, the pool nor a root of the upstream rows of locks/mica-system-base.lock provides: " + "; ".join(sorted(set(missing))) + ". Propose such a package for the upstream.pkgs of mica-system-base")
# The closure of every needed root, each row with the local packages it is installed for.
chosen = {}
for alt, row in lock.items():
    for root in row["roots"] & needed.keys():
        chosen.setdefault(alt, set()).update(needed[root])
# The closure installs: every dependency of a chosen row is on the Base root, in the pool or chosen.
installed = base | {p for name in selected for p in provides(local[name])}
for alt in chosen:
    installed |= provides(lock[alt]["control"])
unmet = [alt + " needs " + " | ".join(group) for alt in chosen for group in depends(lock[alt]["control"])
         if not any(dep in installed or dep in local for dep in group)]
if unmet:
    sys.exit("base-packages.sh: error: the closures of the roots " + ", ".join(sorted(needed)) + " in locks/mica-system-base.lock do not install on the Base root: " + "; ".join(sorted(unmet)))
for alt in sorted(chosen):
    row = lock[alt]
    print("\t".join([alt, row["version"], row["control"]["Architecture"], row["sha"], row["url"], ",".join(sorted(chosen[alt]))]))
' "${CACHE}" "${index}" "${status}" "${PACKAGES}"
    ;;
*)
    die "usage: bash tools/base-packages.sh check | fetch --arch A | select --arch A --packages \"...\""
    ;;
esac
