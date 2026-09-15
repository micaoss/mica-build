#!/usr/bin/env bash
# tools/image-kinds.sh over a fake board packer: the builtin disk kind, the packer interface (input
# directory, pack, verify), the product subset, the release double pack and size limit, and every refusal.
#
#   bash tests/image-kinds-test.sh      (make os-image-kinds-test; docker, no network)
set -euo pipefail
cd "$(dirname "$0")/.."
SCRATCH="$(pwd)/tmp/image-kinds-test.$$"
mkdir -p "${SCRATCH}"
trap 'chmod -R u+w "${SCRATCH}" 2>/dev/null; rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
refuses() { # <label> <fragment> <image-kinds.sh args...>
    local label="$1" fragment="$2" out
    shift 2
    if out="$(bash tools/image-kinds.sh "$@" 2>&1)"; then
        fail "${label}: accepted"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then
        pass "${label}: refused naming '${fragment}'"
    else
        fail "${label}: refused, but not naming '${fragment}': ${out}"
    fi
}

OUT="${SCRATCH}/product"
BOARD="${SCRATCH}/board"
# A signed canonical image stand-in: 8 MiB with a GPT of two partitions whose bytes differ.
mkdir -p "${OUT}/image"
python3 - "${OUT}/image/mica-fixture-20260915-000000.img" <<'PY'
import struct, sys, uuid, zlib
path, sector, sectors = sys.argv[1], 512, 16384
disk = bytearray(sector * sectors)
parts = [(b'esp', 2048, 4095, 0x11), (b'system', 4096, 16000, 0x22)]
entries = bytearray(128 * 128)
for i, (name, first, last, fill) in enumerate(parts):
    disk[first * sector:(last + 1) * sector] = bytes([fill]) * ((last - first + 1) * sector)
    entries[i * 128:i * 128 + 128] = struct.pack('<16s16sQQQ72s', uuid.UUID('0fc63daf-8483-4772-8e79-3d69d8477de4').bytes_le,
                                                 uuid.UUID(int=i + 1).bytes_le, first, last, 0, name.decode().encode('utf-16le'))
header = struct.pack('<8sIIIIQQQQ16sQIII', b'EFI PART', 0x10000, 92, 0, 0, 1, sectors - 1, 34, sectors - 34,
                     uuid.UUID(int=0xd15c).bytes_le, 2, 128, 128, zlib.crc32(entries))
disk[sector:sector + 92] = header
disk[2 * sector:2 * sector + len(entries)] = entries
open(path, 'wb').write(disk)
PY
(cd "${OUT}/image" && sha256sum mica-fixture-20260915-000000.img >SHA256SUMS)

# The fake packer: its output is one JSON line (layout, partition digests, product) then disk.img; verify
# proves the bytes after that line are disk.img and each partition image is its range. MODE varies it.
mkdir -p "${BOARD}/packer"
printf 'LAYOUT_VERSION=3\n' >"${BOARD}/board.env"
cat >"${BOARD}/packer/fake.sh" <<'FAKE'
#!/bin/sh
set -eu
mode="$(cat /input/board/packer/mode)"
case "$1" in
pack)
    [ "${mode}" != fail-pack ] || exit 3
    if [ "${mode}" = huge ]; then truncate -s 2147483649 "$3"; exit 0; fi
    python3 - "$2" "$3" "${mode}" <<'PY'
import hashlib, json, os, sys, time
input, output, mode = sys.argv[1:4]
layout = json.load(open(f'{input}/layout.json'))
head = {'layout': layout, 'parts': {p['image']: hashlib.sha256(open(f'{input}/{p["image"]}', 'rb').read()).hexdigest() for p in layout['partitions']},
        'product': json.load(open(f'{input}/product.json')), 'board': sorted(os.listdir(f'{input}/board'))}
if mode == 'nondeterministic':
    head['time'] = time.time_ns()
with open(output, 'wb') as out:
    out.write((json.dumps(head, sort_keys=True) + '\n').encode())
    out.write(open(f'{input}/disk.img', 'rb').read())
PY
    ;;
verify)
    [ "${mode}" != broken-verify ] || { echo "fake verify: byte 0 differs" >&2; exit 1; }
    [ "${mode}" != huge ] || exit 0
    python3 - "$2" "$3" <<'PY'
import hashlib, json, sys
input, output = sys.argv[1:3]
data = open(output, 'rb').read()
head, body = data.split(b'\n', 1)
disk = open(f'{input}/disk.img', 'rb').read()
assert body == disk, 'storage bytes differ from disk.img'
for p in json.loads(head)['layout']['partitions']:
    assert hashlib.sha256(disk[p['first_lba'] * 512:(p['last_lba'] + 1) * 512]).hexdigest() == json.loads(head)['parts'][p['image']], p['image']
PY
    ;;
*) exit 2 ;;
esac
FAKE
chmod 0755 "${BOARD}/packer/fake.sh"
images() { # <rows...>
    printf '# mica-boards images v1\n' >"${BOARD}/images.tsv"
    printf '%s\n' "$@" >>"${BOARD}/images.tsv"
}
DISK=$'image\tdisk\tbuiltin\tmica-build-env:base\timg'
FAKE=$'image\tfake-flash\tpacker/fake.sh\tmica-build-env:base\tfake.bin'
pack() { bash tools/image-kinds.sh pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev "$@"; }

# kinds: the declaration and the product subset.
images "${DISK}" "${FAKE}"
[ "$(bash tools/image-kinds.sh kinds "${BOARD}" | cut -f1 | tr '\n' ' ')" = "disk fake-flash " ] && pass "every declared kind by default" || fail "kinds default: $(bash tools/image-kinds.sh kinds "${BOARD}" 2>&1)"
[ "$(bash tools/image-kinds.sh kinds "${BOARD}" disk | cut -f1 | tr '\n' ' ')" = "disk " ] && pass "a product subset of disk only" || fail "kinds disk"
[ "$(bash tools/image-kinds.sh kinds "${BOARD}" fake-flash | cut -f1 | tr '\n' ' ')" = "disk fake-flash " ] && pass "disk is always one of the product's kinds" || fail "kinds fake-flash"
refuses "a kind the board does not declare" "the image kind floppy is not declared" kinds "${BOARD}" floppy
images "${FAKE}"
refuses "a board without disk" "declares no disk kind" kinds "${BOARD}"
images "${DISK}" $'image\tfake-flash\tbuiltin\tmica-build-env:base\tfake.bin'
refuses "builtin for another kind than disk" "packs disk only" kinds "${BOARD}"
images "${DISK}" "${FAKE}" "${FAKE}"
refuses "a kind declared twice" "declares the kind fake-flash twice" kinds "${BOARD}"
images "${DISK}" $'image\tfake-flash\tpacker/fake.sh\tupstream:no-such-image:1\tfake.bin'
refuses "a runtime image no lock names" "runs in upstream:no-such-image:1" kinds "${BOARD}"
images "${DISK}" $'image\tfake-flash\t../fake.sh\tmica-build-env:base\tfake.bin'
refuses "a packer outside the packer component" "is not a relative path" kinds "${BOARD}"
rm "${BOARD}/images.tsv"
refuses "a board with no images.tsv" "images.tsv does not exist" kinds "${BOARD}"

# pack: the builtin disk and the fake packer through the interface.
images "${DISK}" "${FAKE}"
echo ok >"${BOARD}/packer/mode"
if out="$(pack --release 2>&1)"; then
    body="$(tail -c +"$(( $(head -n1 "${OUT}/kinds/mica-fixture-20260915-0000.fake.bin" | wc -c) + 1 ))" "${OUT}/kinds/mica-fixture-20260915-0000.fake.bin" | sha256sum | cut -d' ' -f1)"
    head="$(head -n1 "${OUT}/kinds/mica-fixture-20260915-0000.fake.bin")"
    { cmp -s "${OUT}/kinds/mica-fixture-20260915-0000.img" "${OUT}/image/mica-fixture-20260915-000000.img" &&
      [ "${body}" = "$(cut -d' ' -f1 "${OUT}/image/SHA256SUMS")" ] &&
      jq -e '.layout.partitions | map(.image) == ["esp.img", "system.img"]' <<<"${head}" >/dev/null &&
      jq -e '.layout.layout_version == "3" and .layout.sector_size == 512 and .layout.sectors == 16384' <<<"${head}" >/dev/null &&
      jq -e '.product == {product: "fixture", release: "20260915-0000", profile: "dev"} and (.board | index("images.tsv"))' <<<"${head}" >/dev/null &&
      [ "$(cut -f1,2 "${OUT}/kinds.tsv" | tr '\n' ' ')" = "disk	kinds/mica-fixture-20260915-0000.img fake-flash	kinds/mica-fixture-20260915-0000.fake.bin " ]; } &&
        pass "pack --release: disk is the canonical image, the packer got disk.img, partitions, layout, board and product, verified and packed twice" ||
        fail "pack output: ${head} ${body} $(cat "${OUT}/kinds.tsv")"
else
    fail "pack --release: ${out}"
fi
if out="$(pack disk 2>&1)" && [ "$(cut -f1 "${OUT}/kinds.tsv")" = disk ] && [ ! -e "${OUT}/kinds/mica-fixture-20260915-0000.fake.bin" ]; then
    pass "a product subset packs only its kinds"
else
    fail "pack disk: ${out}"
fi
echo fail-pack >"${BOARD}/packer/mode"
refuses "a failing pack" "failed to pack" pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev
[ ! -e "${OUT}/kinds.tsv" ] && pass "a failed pack leaves no kinds.tsv" || fail "a failed pack left kinds.tsv"
echo broken-verify >"${BOARD}/packer/mode"
refuses "a verify that finds other bytes" "verify refused" pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev
echo nondeterministic >"${BOARD}/packer/mode"
if bash tools/image-kinds.sh pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev >/dev/null 2>&1; then pass "a nondeterministic packer passes outside a release"; else fail "a nondeterministic packer failed outside a release"; fi
refuses "a nondeterministic packer in a release" "is not deterministic" pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev --release
echo huge >"${BOARD}/packer/mode"
refuses "an output over 2 GiB in a release" "over the 2 GiB" pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev --release
echo ok >"${BOARD}/packer/mode"
chmod 0644 "${BOARD}/packer/fake.sh"
refuses "a packer that is not executable" "is no executable file" pack "${OUT}" "${BOARD}" fixture 20260915-0000 dev

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
