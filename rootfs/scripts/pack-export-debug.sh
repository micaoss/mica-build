#!/bin/sh
# PLAN-086 S2: take the debug information out of the shipped binaries, and keep
# it where a reader can still resolve a core dump with it.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the
# reasoning lives. Operates on /rootfs -- the tree that goes into mksquashfs --
# and writes /out/debug/, which the `artifact` stage exports to
# _out/<board>/debug/.
#
# WHAT IS A CANDIDATE, and it is not "every ELF". RFCT-346 measured the root:
# 1,022 user-space ELF files, of which THIRTEEN carry any `.debug*`, `.symtab`
# or `.strtab` at all, and every one of the thirteen is built by this
# repository -- podman, netavark, apid, micad, crun, mica-mqttd, mica-mqtt-broker,
# rauc-update, rauc-verify, quadlet, aardvark-dns, catatonit, conmon. Debian
# ships its own binaries stripped, so the other 1,009 have nothing to take. The
# scan is written over the whole tree anyway, because a candidate LIST would be
# a second place to edit, and it would go stale the day a producer changes.
#
# KERNEL MODULES ARE NOT CANDIDATES and are excluded twice: by path, and by ELF
# type. A module's `.symtab` is what the module loader resolves its relocations
# against, so stripping one produces a module that no longer loads --
# PLAN-086's risk table says to treat them separately, and this is that
# separation. The path rule is what the tree's layout makes obvious; the type
# rule is what still holds for a relocatable object somewhere else. Both counts
# are printed, so neither can be the only one doing any work without that being
# visible.
#
# THE MATCH IS THE GNU BUILD ID, and it is asserted rather than assumed. A
# debug file that cannot be tied back to the binary it came from is worse than
# no debug file: it looks like diagnosability and resolves nothing. Each
# exported file is named `.build-id/<xx>/<rest>.debug`, which is where gdb and
# every other consumer of separated debug information looks. The note survives
# `strip` (it is allocated) and survives `--only-keep-debug`, and both facts are
# checked here on every file rather than trusted once. A binary with debug
# sections and no build-id is a REFUSAL, not a skip: it is a binary this
# repository would ship and could not afterwards debug.
#
# TARGET-AWARE TOOLS. This stage runs on the BUILD platform while /rootfs is
# the board's, so the host `objcopy` and `strip` are the wrong ones -- GNU
# binutils is configured per target, and the native tools would refuse the
# board's ELF rather than rewrite it correctly. MICA_ARCH picks the cross prefix;
# both prefixed toolchains are installed in the stage, so the apt layer is
# shared between the two architectures instead of keyed on one.
set -eu

: "${MICA_ARCH:?pack-export-debug.sh needs MICA_ARCH to choose the target binutils}"
case "${MICA_ARCH}" in
amd64) PREFIX=x86_64-linux-gnu- ;;
arm64) PREFIX=aarch64-linux-gnu- ;;
*)
    echo "error: MICA_ARCH=${MICA_ARCH} names no binutils this stage installs. The stripping has to be done by the TARGET's objcopy: the host's is built for one target, and falling back to it would either refuse this root's ELF or rewrite a foreign binary by the wrong convention" >&2
    exit 1
    ;;
esac
OBJCOPY="${PREFIX}objcopy"
STRIP="${PREFIX}strip"
READELF="${PREFIX}readelf"
for t in "${OBJCOPY}" "${STRIP}" "${READELF}"; do
    command -v "${t}" >/dev/null 2>&1 ||
        { echo "error: ${t} is not on PATH. rootfs/compose/90-pack.Dockerfile installs binutils-x86-64-linux-gnu and binutils-aarch64-linux-gnu into this stage for exactly this script" >&2; exit 1; }
done

DEBUG_DIR=/out/debug
MANIFEST="${DEBUG_DIR}/manifest.tsv"
LIST=/tmp/pack-export-debug.elf
rm -rf "${DEBUG_DIR}"
mkdir -p "${DEBUG_DIR}"

# The sections a `strip` takes and an `--only-keep-debug` keeps. PRESENCE, not
# bytes: `readelf -SW` prints sizes in hex and this stage's awk is mawk, which
# has no strtonum -- a hex sum spelled wrong reports every ELF as having nothing
# to strip, which is a green over a root carrying 43 MB of it. What the report
# needs is the file size before and after, and `stat` gives that in decimal.
removable_sections() {
    "${READELF}" -SW "$1" 2>/dev/null | awk '
        $2 ~ /^\.(debug|zdebug)/ || $2 == ".symtab" || $2 == ".strtab" { n++ }
        END { print n + 0 }'
}

# The GNU build-id, out of `readelf -n`.
#
# The pattern is NOT anchored at the start of the line, and that is the whole
# difference between this working and reporting every binary as having no
# build-id. Under `-W` readelf puts the value on the SAME line as the note
# type, after a tab -- `NT_GNU_BUILD_ID (unique build ID bitstring)\t    Build
# ID: 1bde...` -- and wraps it onto its own line only in the narrow format. An
# anchored pattern matches the narrow output, so it would go green anywhere it
# was tried by hand at a terminal and find nothing here.
#
# stderr is discarded because `readelf -n` on a file produced by
# --only-keep-debug says "Unable to find program interpreter name": that file's
# PT_INTERP section is NOBITS by construction, and the note this reads is
# unaffected.
build_id() {
    "${READELF}" -nW "$1" 2>/dev/null |
        sed -n 's/.*Build ID:[[:space:]]*\([0-9a-f][0-9a-f]*\).*/\1/p' | head -n1
}

is_elf() {
    [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}

# ET_REL, which `readelf -h` spells `Type: REL (Relocatable file)`.
is_relocatable() {
    "${READELF}" -hW "$1" 2>/dev/null |
        awk '$1 == "Type:" && $2 == "REL" { found = 1 } END { exit(found ? 0 : 1) }'
}

find /rootfs -xdev -type f | LC_ALL=C sort | while IFS= read -r f; do
    is_elf "${f}" || continue
    echo "${f}"
done >"${LIST}"

printf '#path\tbuild-id\tdebug\tbytes-before\tbytes-after\tsha256-after\n' >"${MANIFEST}"

elf_n=0
module_path_n=0
module_type_n=0
stripped_n=0

# A redirect and not a pipe. `find ... | while read` would run the body in a
# subshell and leave every counter below at zero in the parent, so the report at
# the bottom would say "0 files" over a root that had just been stripped
# correctly -- and would say the same over one nothing had touched.
while IFS= read -r f; do
    elf_n=$((elf_n + 1))
    rel="${f#/rootfs}"
    case "${rel}" in
    /usr/lib/modules/*) module_path_n=$((module_path_n + 1)); continue ;;
    esac
    if is_relocatable "${f}"; then
        module_type_n=$((module_type_n + 1))
        continue
    fi
    [ "$(removable_sections "${f}")" != 0 ] || continue

    id="$(build_id "${f}")"
    [ -n "${id}" ] ||
        { echo "error: ${rel} carries debug sections and no GNU build-id note, so a debug file split out of it could not be tied back to it. Every consumer of separated debug information -- gdb, a core-dump resolver, a symbolicator -- matches on that note, and without one this export would produce a file that looks like diagnosability and resolves nothing. Build it with --build-id, or ship it stripped by its own producer" >&2; exit 1; }
    case "${id}" in
    ???*) ;;
    *) echo "error: ${rel} reports the build-id '${id}', which is too short to split into the .build-id/<xx>/<rest> layout every debug consumer looks in" >&2; exit 1 ;;
    esac

    dbg="${DEBUG_DIR}/.build-id/$(printf '%s' "${id}" | cut -c1-2)/$(printf '%s' "${id}" | cut -c3-).debug"
    [ ! -e "${dbg}" ] ||
        { echo "error: ${rel} has build-id ${id}, and another shipped binary has already exported its debug file to ${dbg#"${DEBUG_DIR}"/}. Two different paths reporting one build-id means a reader resolving either of them gets the other's symbols" >&2; exit 1; }
    mkdir -p "$(dirname "${dbg}")"

    before="$(stat -c%s "${f}")"
    "${OBJCOPY}" --only-keep-debug "${f}" "${dbg}"
    chmod 0644 "${dbg}"
    "${STRIP}" --strip-all "${f}"
    after="$(stat -c%s "${f}")"

    # The three facts this export is worth nothing without, checked on every
    # file rather than once on a sample: the binary still IS one, its identity
    # did not move, and the debug file carries the same identity.
    is_elf "${f}" ||
        { echo "error: ${STRIP} left ${rel} without an ELF header" >&2; exit 1; }
    after_id="$(build_id "${f}")"
    [ "${after_id}" = "${id}" ] ||
        { echo "error: ${rel} had build-id ${id} and reports '${after_id}' after stripping. That note is allocated and must survive; a moved identity means the exported debug file no longer names this binary" >&2; exit 1; }
    dbg_id="$(build_id "${dbg}")"
    [ "${dbg_id}" = "${id}" ] ||
        { echo "error: the debug file split out of ${rel} reports build-id '${dbg_id}', not ${id}. That note is the only thing tying the two together" >&2; exit 1; }
    remaining="$(removable_sections "${f}")"
    [ "${remaining}" = 0 ] ||
        { echo "error: ${rel} still carries ${remaining} removable debug/symbol section(s) after ${STRIP} --strip-all" >&2; exit 1; }

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "${rel}" "${id}" "${dbg#"${DEBUG_DIR}"/}" "${before}" "${after}" \
        "$(sha256sum "${f}" | cut -d' ' -f1)" >>"${MANIFEST}"
    stripped_n=$((stripped_n + 1))
done <"${LIST}"

rows="$(grep -vc '^#' "${MANIFEST}" || true)"
[ "${rows}" = "${stripped_n}" ] ||
    { echo "error: ${stripped_n} binaries were stripped and the manifest carries ${rows} row(s). The manifest is what the image contract reads to match a debug file to a shipped binary, so a short one leaves a stripped binary with no recorded match" >&2; exit 1; }

# A ZERO IS A FAILURE, and this is the only place that can say so. Every
# assertion downstream is a NEGATIVE -- "no debug sections remain in the packed
# root" -- and a negative is satisfied by a scan that looked at nothing. If this
# repository's producers ever start shipping stripped binaries with no debug
# output of their own, that is a LOSS of diagnosability and it has to be
# decided, not discovered later as an empty export directory.
[ "${stripped_n}" -gt 0 ] ||
    { echo "error: no shipped user-space binary in this root carried a debug or static symbol section, so nothing was exported and _out/<board>/debug/ is empty. This repository builds thirteen binaries that do (RFCT-346); a root with none means either that the scan above is not reading the tree, or that the producers have started stripping without exporting -- and then the image ships with no separated debug information at all" >&2; exit 1; }

# The other half, and the assertion PLAN-086's acceptance clause spells out:
# the packed root contains no removable user-space debug sections. Re-scanned
# from the tree rather than inferred from the loop above, so it is a statement
# about /rootfs and not about what this script believes it did to it.
left=""
while IFS= read -r f; do
    rel="${f#/rootfs}"
    case "${rel}" in
    /usr/lib/modules/*) continue ;;
    esac
    if is_relocatable "${f}"; then continue; fi
    [ "$(removable_sections "${f}")" != 0 ] || continue
    left="${left} ${rel}"
done <"${LIST}"
[ -z "${left}" ] ||
    { echo "error: the packed root still carries removable user-space debug sections in:${left}" >&2; exit 1; }

rm -f "${LIST}"
echo "debug: ${stripped_n} of $((elf_n - module_path_n - module_type_n)) user-space ELF file(s) carried debug or static symbol sections and were stripped"
echo "debug: left alone -- ${module_path_n} file(s) under /usr/lib/modules and ${module_type_n} relocatable object(s) elsewhere, out of ${elf_n} ELF files in the tree; a module's symbols are what its relocations resolve against"
echo "debug: exported $(find "${DEBUG_DIR}/.build-id" -type f -name '*.debug' | wc -l) debug file(s) under /out/debug/.build-id, matched by GNU build-id"
awk -F'\t' '/^#/ { next } { b += $4; a += $5 } END { printf "debug: shipped binaries %d -> %d bytes (-%d)\n", b, a, b - a }' "${MANIFEST}"
