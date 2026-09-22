#!/usr/bin/env bash
# The flashing formats of a product: the board declares them, mica-build executes their packers.
#
#   bash tools/image-kinds.sh kinds <board dir> [<kind>...]
#       the image kinds a product packs, one row each: <kind> TAB <packer> TAB <runtime image> TAB <suffix>. The board's
#       images.tsv is checked; the named kinds (default: every declared kind) must be declared, and disk is always one
#   bash tools/image-kinds.sh updates <board dir> [<kind>...]
#       the update kinds a product publishes, rows as above, with full always one; nothing when the board declares no update row
#   bash tools/image-kinds.sh pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]
#       packs and verifies every kind into <product out>/kinds/mica-<product>-<version>.<suffix> and writes
#       <product out>/kinds.tsv: <kind> TAB <file relative to the product out> TAB <sha256>
#
# THE BOARD DECLARES (user decisions 2026-09-15). <board dir>/images.tsv, carried
# in the board component: `# mica-boards images v1`, then rows
# `image <kind> <packer> <runtime image> <suffix>` (flashing formats) and
# `update <kind> builtin - <suffix>` (update packages). An image <packer> is
# `builtin` (this tree's own raw disk image, for `disk` only) or a path inside
# the board's packer component; <runtime image> is an image selector of locks/
# (src/cli.ts from), or `-` for a builtin row; <suffix> is the output file's
# suffix. `disk` is mandatory: every other image kind derives from it. The
# update kinds are full (root, kernel and signed descriptor), root and kernel,
# all built and signed here; once a board declares update rows, full is one.
#
# THE INTERFACE. A packer is run as `<packer> pack <input> <output>` and then
# `<packer> verify <input> <output>` in its runtime image, with --network none,
# the input read-only and no key material mounted. The input directory holds
# disk.img (the signed canonical image), <partition>.img for every GPT
# partition (its bytes out of disk.img), layout.json (layout version, sector
# size and count, disk and partition GUIDs, ranges), board/ (the assembled board
# tree) and product.json (product, release, profile). verify must unpack the
# output and prove every byte it writes to storage equals disk.img.
#
# --release packs every non-builtin kind twice and refuses differing bytes, and
# refuses an output over 2 GiB (a GitHub release asset limit); any failure fails
# the product.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
die() { echo "image-kinds.sh: error: $*" >&2; exit 1; }

kinds() { # image|update <board dir> [<kind>...]
    local class="$1" board="$2"
    shift 2
    python3 - "${class}" "${board}/images.tsv" "$@" <<'PY' || exit 1
import re, sys
cls, path, wanted = sys.argv[1], sys.argv[2], sys.argv[3:]
def die(message):
    sys.exit(f'image-kinds.sh: error: {message}')
try:
    lines = open(path).read().split('\n')
except OSError:
    die(f'{path} does not exist; the board component declares its flashing and update formats there (mica-boards images v1)')
if lines[0] != '# mica-boards images v1':
    die(f'{path} is not mica-boards images v1')
rows = {'image': {}, 'update': {}}
for n, line in enumerate(lines[1:], 2):
    if line == '' or line.startswith('#'):
        continue
    f = line.split('\t')
    if len(f) != 5 or f[0] not in rows:
        die(f'{path}:{n} is not image|update <kind> <packer> <runtime image> <suffix>')
    row, kind, packer, runtime, suffix = f
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', kind) or not re.fullmatch(r'[a-z0-9][a-z0-9.]*', suffix):
        die(f'{path}:{n} names a kind or suffix out of form')
    if row == 'image':
        if (packer == 'builtin') != (kind == 'disk'):
            die(f'{path}:{n}: the builtin image packer is the raw disk image and packs disk only')
        if packer != 'builtin' and not re.fullmatch(r'[A-Za-z0-9_+-][A-Za-z0-9._+-]*(/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*', packer):
            die(f'{path}:{n}: the packer {packer} is not a relative path in the packer component')
        if packer != 'builtin' and runtime == '-':
            die(f'{path}:{n}: the {kind} packer names no runtime image')
    else:
        if kind not in ('full', 'root', 'kernel'):
            die(f'{path}:{n}: the update kind {kind} is not full, root or kernel')
        if packer != 'builtin' or runtime != '-':
            die(f'{path}:{n}: an update row is update <kind> builtin - <suffix>; update packages are built and signed by mica-build')
    if kind in rows[row]:
        die(f'{path} declares the {row} kind {kind} twice')
    if suffix in {r[3] for r in rows['image'].values()} | {r[3] for r in rows['update'].values()}:
        die(f'{path} gives two kinds the suffix {suffix}')
    rows[row][kind] = (kind, packer, runtime, suffix)
if 'disk' not in rows['image']:
    die(f'{path} declares no disk image kind; every other image kind derives from the canonical disk image')
if rows['update'] and 'full' not in rows['update']:
    die(f'{path} declares update kinds without full; root and kernel packages are variants of the full package')
declared, base = rows[cls], {'image': 'disk', 'update': 'full'}[cls]
for kind in wanted:
    if kind not in declared:
        die(f'the {cls} kind {kind} is not declared by {path} (declared: {" ".join(sorted(declared)) or "none"})')
chosen = sorted(set(wanted) | {base}) if wanted else sorted(declared)
for kind in chosen:
    print('\t'.join(declared[kind]))
PY
}

cmd="${1:-}"; [ "$#" -eq 0 ] || shift
case "${cmd}" in
updates)
    [ "$#" -ge 1 ] && [ -d "$1" ] || die "usage: bash tools/image-kinds.sh updates <board dir> [<kind>...]"
    kinds update "$@"
    ;;
kinds)
    [ "$#" -ge 1 ] && [ -d "$1" ] || die "usage: bash tools/image-kinds.sh kinds <board dir> [<kind>...]"
    rows="$(kinds image "$@")"
    # Every runtime image is an image row of locks/.
    while IFS=$'\t' read -r kind packer runtime _; do
        [ "${runtime}" = - ] || bash "${HERE}/../bin/bun.sh" src/cli.ts from --ref "${runtime}" >/dev/null ||
            die "the ${kind} packer runs in ${runtime}, which no image row of locks/ names (see above)"
    done <<<"${rows}"
    printf '%s\n' "${rows}"
    ;;
pack)
    [ "$#" -ge 5 ] || die "usage: bash tools/image-kinds.sh pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]"
    out="$(cd "$1" && pwd)"; board="$(cd "$2" && pwd)"; product="$3"; version="$4"; profile="$5"
    shift 5
    release=0
    if [ "${1:-}" = --release ]; then release=1; shift; fi
    rows="$(bash "$0" kinds "${board}" "$@")"
    sums="${out}/image/SHA256SUMS"
    [ -s "${sums}" ] || die "${sums} does not exist; the image component was not built"
    read -r disk_sha disk_name <"${sums}"
    [ -n "${disk_name}" ] && [ "$(sha256sum "${out}/image/${disk_name}" | cut -d' ' -f1)" = "${disk_sha}" ] ||
        die "${out}/image/${disk_name:-?} is not the image ${sums} names"

    # The input directory: the signed canonical image, its partitions and layout, the board tree and the product.
    input="${out}/pack-input"
    rm -rf "${input}" "${out}/kinds" "${out}/kinds.tsv"
    mkdir -p "${input}" "${out}/kinds"
    ln "${out}/image/${disk_name}" "${input}/disk.img" 2>/dev/null || cp "${out}/image/${disk_name}" "${input}/disk.img"
    cp -a "${board}" "${input}/board"
    python3 - "${input}" "$(sed -n 's/^LAYOUT_VERSION=//p' "${board}/board.env")" "${product}" "${version}" "${profile}" <<'PY'
import json, os, struct, sys, uuid
input, layout_version, product, version, profile = sys.argv[1:6]
disk = os.path.join(input, 'disk.img')
sector = 512
with open(disk, 'rb') as f:
    f.seek(sector)
    header = f.read(92)
    if header[:8] != b'EFI PART':
        sys.exit(f'image-kinds.sh: error: {disk} carries no GPT at LBA 1')
    first, last, disk_guid, entries_lba, count, size = struct.unpack('<QQ16sQII', header[40:88])
    f.seek(entries_lba * sector)
    table = f.read(count * size)
    partitions = []
    for i in range(count):
        e = table[i * size:(i + 1) * size]
        type_guid, guid, start, end = struct.unpack('<16s16sQQ', e[:48])
        if type_guid == b'\0' * 16:
            continue
        name = e[56:128].decode('utf-16le').rstrip('\0')
        image = f'{name}.img'
        if not name or '/' in name or image in ('disk.img', 'layout.json', 'product.json') or any(p['image'] == image for p in partitions):
            sys.exit(f'image-kinds.sh: error: partition {i + 1} of {disk} is named {name!r}, which names no partition image')
        f.seek(start * sector)
        remaining = (end - start + 1) * sector
        with open(os.path.join(input, image), 'wb') as out:
            while remaining:
                block = f.read(min(remaining, 1 << 24))
                out.write(block)
                remaining -= len(block)
        partitions.append({'number': i + 1, 'name': name, 'image': image, 'type_guid': str(uuid.UUID(bytes_le=type_guid)),
                           'guid': str(uuid.UUID(bytes_le=guid)), 'first_lba': start, 'last_lba': end})
json.dump({'schema': 'mica/layout/v1', 'layout_version': layout_version, 'sector_size': sector,
           'sectors': os.path.getsize(disk) // sector, 'disk_guid': str(uuid.UUID(bytes_le=disk_guid)),
           'first_usable_lba': first, 'last_usable_lba': last, 'partitions': partitions},
          open(os.path.join(input, 'layout.json'), 'w'), indent=2, sort_keys=True)
json.dump({'product': product, 'release': version, 'profile': profile}, open(os.path.join(input, 'product.json'), 'w'), indent=2, sort_keys=True)
PY
    chmod -R a-w "${input}"
    trap 'chmod -R u+w "${input}" 2>/dev/null; rm -rf "${input}" "${out}/kinds.tsv.part" "${out}/kinds/.twice"' EXIT

    run() { # <runtime image> <packer> <verb> <output dir> <file>
        # mica-build-side: container-block -- the packer runs in its declared runtime image, offline, over a read-only input.
        docker run --rm --label ai-agent=true --network none --user "$(id -u):$(id -g)" \
            -v "${input}:/input:ro" -v "$4:/output" "$1" "/input/board/$2" "$3" /input "/output/$5"
        # mica-build-side: host
    }
    : >"${out}/kinds.tsv.part"
    while IFS=$'\t' read -r kind packer runtime suffix; do
        file="mica-${product}-${version}.${suffix}"
        if [ "${packer}" = builtin ]; then
            ln "${input}/disk.img" "${out}/kinds/${file}" 2>/dev/null || cp "${input}/disk.img" "${out}/kinds/${file}"
        else
            [ -x "${board}/${packer}" ] || die "the ${kind} packer ${packer} is no executable file of the board's packer component"
            image="$(bash "${HERE}/../bin/bun.sh" src/cli.ts from --ref "${runtime}")"
            run "${image}" "${packer}" pack "${out}/kinds" "${file}" || die "the ${kind} packer failed to pack ${file} (see above)"
            [ -f "${out}/kinds/${file}" ] || die "the ${kind} packer wrote no ${file}"
            run "${image}" "${packer}" verify "${out}/kinds" "${file}" || die "the ${kind} packer's verify refused ${file}: its bytes on storage are not disk.img (see above)"
            if [ "${release}" = 1 ]; then
                mkdir -p "${out}/kinds/.twice"
                run "${image}" "${packer}" pack "${out}/kinds/.twice" "${file}" || die "the second ${kind} pack of ${file} failed (see above)"
                cmp -s "${out}/kinds/${file}" "${out}/kinds/.twice/${file}" || die "the ${kind} packer is not deterministic: two packs of ${file} differ"
                rm -rf "${out}/kinds/.twice"
            fi
        fi
        if [ "${release}" = 1 ] && [ "$(stat -c %s "${out}/kinds/${file}")" -gt $((2 * 1024 * 1024 * 1024)) ]; then
            die "${file} is $(stat -c %s "${out}/kinds/${file}") bytes, over the 2 GiB a release asset may be"
        fi
        printf '%s\tkinds/%s\t%s\n' "${kind}" "${file}" "$(sha256sum "${out}/kinds/${file}" | cut -d' ' -f1)" >>"${out}/kinds.tsv.part"
        echo "image-kinds.sh: ${kind} -> kinds/${file}"
    done <<<"${rows}"
    mv "${out}/kinds.tsv.part" "${out}/kinds.tsv"
    ;;
*)
    die "usage: bash tools/image-kinds.sh kinds|updates <board dir> [<kind>...] | pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]"
    ;;
esac
