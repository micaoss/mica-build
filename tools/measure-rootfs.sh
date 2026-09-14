#!/usr/bin/env bash
# PLAN-086 S1: measure the root a board actually ships, from the artifact it ships.
#
# Every later slice of PLAN-086 states its result as a DELTA -- S2 strips debug
# sections, S3 selects an explicit runtime, S4 drops the static hardware
# database -- and a delta needs a baseline that was measured rather than
# remembered. This is that measurement, and it is a script rather than a
# paragraph so that the next slice re-runs it instead of re-deriving it.
#
# WHAT IT READS: `_out/<board>/factory-root.oci`, the packed root exported as an
# OCI image by rootfs/compose/90-pack.Dockerfile. That archive is the tree that
# went into mksquashfs -- after the tree surgery, after the shadow relocation --
# so it is the root that ships and not one adjacent to it. The squashfs itself
# would need unsquashfs, which this host does not have; the OCI layer is a plain
# tar and needs nothing but tar and jq.
#
# WHY NOT `du -sxm /` IN THE BUILD, which 90-pack already does for TOTAL_MB:
# that number is a filesystem's idea of occupancy -- block-rounded, and it
# counts a hard-linked inode once per LINK in some du versions and once per
# inode in others. The plan's table is in payload bytes, counting hard links
# once, and the two answers differ by megabytes on a root whose coreutils and
# busybox are link farms. This counts inodes, and prints the naive sum beside
# the deduplicated one so the size of that effect is visible rather than
# assumed.
#
# NOTHING HERE WRITES TO THE IMAGE OR TO THE POOL. It extracts into
# `_out/<board>/measure-root/`, which it owns and clears on entry, and prints a
# report to stdout.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"

PRODUCT=""
KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
    --product) PRODUCT="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --help|-h)
        sed -n '2,26p' "${BASH_SOURCE[0]}"
        echo
        echo "usage: bash tools/measure-rootfs.sh --product NAME [--keep]"
        exit 0
        ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
    esac
done
[ -n "${PRODUCT}" ] || { echo "error: --product is required. Products: $(bash "${REPO_ROOT}/tools/product.sh" --list | tr '\n' ' ')" >&2; exit 2; }

OUT_DIR="${REPO_ROOT}/_out/products/${PRODUCT}/build"
OCI="${OUT_DIR}/factory-root.oci"
[ -f "${OCI}" ] ||
    { echo "error: ${OCI} does not exist, so there is no packed root to measure. Build it with 'make os-rootfs PRODUCT=${PRODUCT}'." >&2; exit 1; }

WORK="${OUT_DIR}/measure-root"
rm -rf "${WORK}"
mkdir -p "${WORK}"

# THE LAYER, resolved through the OCI index rather than guessed from the blob
# listing. `factory-root` is `FROM scratch` plus one COPY, so the manifest
# carries exactly one layer; more than one means the stage grew a step and the
# tree this script measured would be only part of it.
blob() { tar -xOf "${OCI}" "blobs/${1/://}"; }
manifest_digest="$(tar -xOf "${OCI}" index.json | jq -r '.manifests[0].digest')"
manifest="$(blob "${manifest_digest}")"
layers="$(printf '%s' "${manifest}" | jq -r '.layers[].digest')"
layer_count="$(printf '%s\n' "${layers}" | grep -c '^sha256:')"
[ "${layer_count}" -eq 1 ] ||
    { echo "error: ${OCI} carries ${layer_count} layers; factory-root is a single-COPY scratch stage and must have exactly one. Measuring layer 1 alone would report a fraction of the root as the whole of it." >&2; exit 1; }

# The media type decides the decompressor, rather than tar's own sniffing: this
# blob arrives on a PIPE, where GNU tar declines to autodetect and says
# "Archive is compressed. Use -z option" -- on stderr, with tar's exit status,
# which under `set -e` looks exactly like a root that would not extract.
media="$(printf '%s' "${manifest}" | jq -r '.layers[0].mediaType')"
case "${media}" in
*+gzip) blob "${layers}" | gzip -dc | tar -x -C "${WORK}" --numeric-owner ;;
*+zstd) blob "${layers}" | zstd -dc | tar -x -C "${WORK}" --numeric-owner ;;
*tar)   blob "${layers}" | tar -x -C "${WORK}" --numeric-owner ;;
*) echo "error: ${OCI}'s layer is '${media}', which this script cannot open." >&2; exit 1 ;;
esac

entries="$(find "${WORK}" -mindepth 1 | wc -l)"
[ "${entries}" -gt 1000 ] ||
    { echo "error: the extracted root holds ${entries} path(s). Every size below would be a fraction of the real one and every 'is X absent' reading would be true of an empty directory." >&2; exit 1; }

# ---------------------------------------------------------------- identity

echo "== identity =="
printf 'board\t%s\n' "${BOARD}"
printf 'tree-stamp\t%s\n' "$(bash "${REPO_ROOT}/tools/version.sh")"
arch="$(grep -m1 '^MICA_ARCH=' "${REPO_ROOT}/_out/boards/${BOARD}/board.env" | cut -d= -f2 | tr -d '"' || true)"
[ -n "${arch}" ] ||
    { echo "error: _out/boards/${BOARD}/board.env declares no MICA_ARCH, so the pool this root was composed from cannot be named." >&2; exit 1; }
printf 'arch\t%s\n' "${arch}"
pool_manifest="${REPO_ROOT}/_out/debs/${arch}/manifest.txt"
if [ -f "${pool_manifest}" ]; then
    printf 'pool-stamp\t%s\n' "$(grep -v '^#' "${pool_manifest}" | cut -f2 | sed 's/^.*+//' | sort -u | tr '\n' ' ')"
fi
for key in SQUASHFS_BYTES IMAGE_BYTES VERITY_ROOT_HASH VERITY_DATA_BLOCKS; do
    [ -f "${OUT_DIR}/rootfs-verity.env" ] || continue
    printf '%s\t%s\n' "${key}" "$(grep -m1 "^${key}=" "${OUT_DIR}/rootfs-verity.env" | cut -d= -f2)"
done
printf 'factory-root-sha256\t%s\n' "$(sha256sum "${OCI}" | cut -d' ' -f1)"
printf 'factory-root-bytes\t%s\n' "$(stat -c %s "${OCI}")"
[ -f "${OUT_DIR}/rootfs-report.txt" ] &&
    printf 'report-TOTAL_MB\t%s\n' "$(grep -m1 '^TOTAL_MB ' "${OUT_DIR}/rootfs-report.txt" | cut -d' ' -f2)"
if [ -f "${WORK}/usr/share/mica/manifest.tsv" ]; then
    printf 'packages-shipped\t%s\n' "$(grep -vc '^#' "${WORK}/usr/share/mica/manifest.tsv")"
    printf 'packages-local\t%s\n' "$(grep -c '^mica' "${WORK}/usr/share/mica/manifest.tsv")"
fi

# ------------------------------------------------------------------ payload
#
# `%D:%i` is the inode identity and `%s` the apparent size. Sorting unique on
# the identity alone is what counts a hard-linked file once; the naive sum below
# it is the same set without that step, so the difference IS the hard-link
# effect rather than a claim about it.

echo
echo "== payload (regular files) =="
inodes="$(find "${WORK}" -xdev -type f -printf '%D:%i\t%s\n' | sort -u -k1,1)"
all_sizes="$(find "${WORK}" -xdev -type f -printf '%s\n')"
dedup_bytes="$(printf '%s\n' "${inodes}" | awk -F'\t' '{s+=$2} END{print s+0}')"
naive_bytes="$(printf '%s\n' "${all_sizes}" | awk '{s+=$1} END{print s+0}')"
printf 'regular-file-bytes-dedup\t%s\n' "${dedup_bytes}"
printf 'regular-file-bytes-naive\t%s\n' "${naive_bytes}"
printf 'regular-file-MiB-dedup\t%s\n' "$(awk -v b="${dedup_bytes}" 'BEGIN{printf "%.2f", b/1048576}')"
printf 'hardlink-saving-bytes\t%s\n' "$((naive_bytes - dedup_bytes))"
printf 'regular-files\t%s\n' "$(printf '%s\n' "${all_sizes}" | grep -c '^')"
printf 'distinct-inodes\t%s\n' "$(printf '%s\n' "${inodes}" | grep -c '^')"
printf 'symlinks\t%s\n' "$(find "${WORK}" -xdev -type l | wc -l)"
printf 'directories\t%s\n' "$(find "${WORK}" -xdev -type d | wc -l)"

echo
echo "== payload by top-level directory (bytes, hard links counted once) =="
find "${WORK}" -xdev -type f -printf '%D:%i\t%s\t%P\n' \
    | sort -u -k1,1 \
    | awk -F'\t' '{split($3,p,"/"); s[p[1]]+=$2} END{for (d in s) printf "%s\t%d\n", d, s[d]}' \
    | sort -k2,2nr

# --------------------------------------------------------------- named sets
#
# The three sets PLAN-086's S1 verification clause names -- boot inputs, debug
# sections and the hardware database -- each measured over the SAME
# inode-deduplicated set as the total above, so they are subsets of it and can
# be subtracted from it without double counting.

set_bytes() { # set_bytes <path>...
    local total=0 path
    for path in "$@"; do
        [ -e "${WORK}${path}" ] || continue
        total=$((total + $(find "${WORK}${path}" -xdev -type f -printf '%D:%i\t%s\n' \
            | sort -u -k1,1 | awk -F'\t' '{s+=$2} END{print s+0}')))
    done
    printf '%s' "${total}"
}

echo
echo "== static hardware database =="
for path in /usr/lib/udev/hwdb.bin /etc/udev/hwdb.bin /usr/lib/udev/hwdb.d /etc/udev/hwdb.d /usr/bin/systemd-hwdb; do
    if [ -e "${WORK}${path}" ]; then
        printf 'present\t%s\t%s\n' "${path}" "$(set_bytes "${path}")"
    else
        printf 'absent\t%s\t0\n' "${path}"
    fi
done
printf 'hwdb-bytes\t%s\n' "$(set_bytes /usr/lib/udev/hwdb.bin /etc/udev/hwdb.bin /usr/lib/udev/hwdb.d /etc/udev/hwdb.d)"
printf 'hwdb-source-files\t%s\n' "$(find "${WORK}/usr/lib/udev/hwdb.d" "${WORK}/etc/udev/hwdb.d" -type f -name '*.hwdb' 2>/dev/null | wc -l)"
printf 'udev-rules-files\t%s\n' "$(find "${WORK}/usr/lib/udev/rules.d" "${WORK}/etc/udev/rules.d" -type f -name '*.rules' 2>/dev/null | wc -l)"
printf 'udev-rules-querying-hwdb\t%s\n' "$(grep -rl 'IMPORT{builtin}="hwdb' "${WORK}/usr/lib/udev/rules.d" "${WORK}/etc/udev/rules.d" 2>/dev/null | wc -l)"
printf 'udev-hwdb-query-clauses\t%s\n' "$(grep -rho 'IMPORT{builtin}="hwdb[^"]*"' "${WORK}/usr/lib/udev/rules.d" "${WORK}/etc/udev/rules.d" 2>/dev/null | wc -l)"
printf 'kernel-module-index-bytes\t%s\n' "$(find "${WORK}/usr/lib/modules" -type f -name 'modules.*' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"

echo
echo "== boot inputs retained inside the root =="
for path in /boot /usr/lib/mica/board; do
    printf '%s\t%s\n' "${path}" "$(set_bytes "${path}")"
done
printf 'boot-bytes\t%s\n' "$(set_bytes /boot /usr/lib/mica/board)"

# ELF sections. `.symtab`/`.strtab` are the static symbol table a `strip` would
# take; `.debug*` is what a `--only-keep-debug` split would move out. Kernel
# modules are counted SEPARATELY and never folded into the user-space number:
# stripping a module's symbols breaks loading, so those bytes are not an S2
# target and a single total would overstate the candidate by tens of megabytes.
echo
echo "== ELF debug and static symbol sections =="
# An ELF magic test that is not a `grep -q` on the right of a pipe: under
# `set -o pipefail` that construct reports the pipeline as FAILED exactly when
# the pattern is found, because -q exits at the first match and the producer
# dies of SIGPIPE. tests/shell-pipefail-lint.sh refuses it by name.
is_elf() {
    [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}
# `readelf -SW` prints section sizes in hex. This host's awk is mawk, which has
# no strtonum, so the conversion is spelled out rather than assumed: a missing
# builtin fails the whole `awk` program, and under a pipeline that would have
# reported every ELF as zero debug bytes -- a green "nothing to strip" over a
# root with 43 MiB of it.
HEX2DEC='function hex2dec(s,  i, c, v, d) {
    v = 0; s = tolower(s)
    for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1); d = index("0123456789abcdef", c) - 1
        if (d < 0) continue
        v = v * 16 + d
    }
    return v
}'
elf_list="$(find "${WORK}" -xdev -type f -printf '%D:%i\t%P\n' | sort -u -k1,1 | cut -f2)"
user_debug=0; mod_debug=0; user_elf=0; mod_elf=0
while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    f="${WORK}/${rel}"
    is_elf "${f}" || continue
    bytes="$(readelf -SW "${f}" 2>/dev/null | awk "${HEX2DEC}"'
        $2 ~ /^\.(debug|zdebug)/ || $2 == ".symtab" || $2 == ".strtab" { s += hex2dec($6) }
        END { print s+0 }')"
    case "/${rel}" in
    /usr/lib/modules/*) mod_debug=$((mod_debug + bytes)); mod_elf=$((mod_elf + 1)) ;;
    *)                  user_debug=$((user_debug + bytes)); user_elf=$((user_elf + 1)) ;;
    esac
done <<EOF
${elf_list}
EOF
printf 'user-space-elf-files\t%s\n' "${user_elf}"
printf 'user-space-debug-bytes\t%s\n' "${user_debug}"
printf 'user-space-debug-MiB\t%s\n' "$(awk -v b="${user_debug}" 'BEGIN{printf "%.2f", b/1048576}')"
printf 'kernel-module-elf-files\t%s\n' "${mod_elf}"
printf 'kernel-module-debug-bytes\t%s\n' "${mod_debug}"

# ------------------------------------------------- ELF and non-ELF consumers
#
# A library with no DT_NEEDED referrer is a CANDIDATE and not proof of dead
# content -- PLAN-086's risk table says so, and this prints the candidate list
# rather than a removal list for exactly that reason. The non-ELF surfaces
# beside it are the places a consumer hides from ELF metadata entirely.

echo
echo "== ELF dependency surface =="
needed_all="$(mktemp)"; sonames="$(mktemp)"
trap 'rm -f "${needed_all}" "${sonames}"' EXIT
while IFS= read -r rel; do
    [ -n "${rel}" ] || continue
    f="${WORK}/${rel}"
    is_elf "${f}" || continue
    case "/${rel}" in /usr/lib/modules/*) continue ;; esac
    readelf -dW "${f}" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' >>"${needed_all}"
    case "${rel##*/}" in
    *.so|*.so.*) readelf -dW "${f}" 2>/dev/null | sed -n 's/.*(SONAME).*\[\(.*\)\]/\1/p' >>"${sonames}" ;;
    esac
done <<EOF
${elf_list}
EOF
printf 'distinct-NEEDED-names\t%s\n' "$(sort -u "${needed_all}" | grep -c '^' || true)"
printf 'shipped-SONAMEs\t%s\n' "$(sort -u "${sonames}" | grep -c '^' || true)"
unreferenced="$(comm -23 <(sort -u "${sonames}") <(sort -u "${needed_all}"))"
printf 'SONAMEs-with-no-DT_NEEDED-referrer\t%s\n' "$(printf '%s\n' "${unreferenced}" | grep -c '^' || true)"
printf '%s\n' "${unreferenced}" | sed 's/^/  candidate\t/'

echo
echo "== non-ELF consumer surfaces (file counts) =="
for path in /usr/lib/systemd/system /usr/lib/systemd/system-generators /etc/systemd/system \
            /usr/share/dbus-1 /etc/dbus-1 /usr/lib/tmpfiles.d /usr/lib/sysusers.d \
            /etc/pam.d /usr/lib/udev/rules.d /usr/lib/firmware /usr/share/ca-certificates \
            /usr/share/zoneinfo /usr/lib/mica /usr/share/doc; do
    printf '%s\t%s\t%s\n' "${path}" \
        "$(find "${WORK}${path}" -type f 2>/dev/null | wc -l)" \
        "$(set_bytes "${path}")"
done

echo
echo "measured: ${WORK} (${entries} paths)"
[ "${KEEP}" -eq 1 ] || rm -rf "${WORK}"
