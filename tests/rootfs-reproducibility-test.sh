#!/usr/bin/env bash
# Focused source and filesystem fixtures for the rootfs reproducibility boundary.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
failures=0

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

prepare_tree() {
    local tree=$1
    mkdir -p "$tree/etc" "$tree/usr/sbin" "$tree/var/cache/ldconfig" \
        "$tree/var/lib/systemd" "$tree/var/log" "$tree/rootfs-report.pkglogs"
    printf 'packages\n' > "$tree/rootfs-report.txt"
    printf '127.0.0.1 localhost\n' > "$tree/etc/hosts"
    printf 'loader-cache-fixture\n' > "$tree/etc/ld.so.cache"
    printf '#!/bin/sh\nexit 0\n' > "$tree/usr/sbin/ldconfig"
    chmod 0755 "$tree/usr/sbin/ldconfig"
}

run_surgery_case() {
    local label=$1
    local with_aux=$2
    local tree="$WORK/$label/rootfs"
    local out="$WORK/$label/out"
    local script="$WORK/$label/pack-tree-surgery.sh"
    mkdir -p "$out"
    prepare_tree "$tree"
    if [ "$with_aux" = 1 ]; then
        printf 'optimizer-cache-fixture\n' > "$tree/var/cache/ldconfig/aux-cache"
    fi
    sed -e "s|/rootfs|$tree|" -e "s|/out|$out|" \
        "$ROOT/rootfs/scripts/pack-tree-surgery.sh" > "$script"
    chmod 0755 "$script"
    if ! "$script" > "$WORK/$label.log" 2>&1; then
        fail "pack-tree-surgery rejected the $label fixture"
        return
    fi
    [ ! -e "$tree/var/cache/ldconfig/aux-cache" ] || fail "$label retained aux-cache"
    [ "$(cat "$tree/etc/ld.so.cache")" = loader-cache-fixture ] || fail "$label changed ld.so.cache"
    [ -x "$tree/usr/sbin/ldconfig" ] || fail "$label lost executable ldconfig"
}

prepare_runtime() {
    local runtime=$1
    mkdir -p "$runtime/etc" "$runtime/usr/sbin" "$runtime/var/cache/ldconfig"
    printf 'loader-cache-fixture\n' > "$runtime/etc/ld.so.cache"
    printf '#!/bin/sh\nexit 0\n' > "$runtime/usr/sbin/ldconfig"
    chmod 0755 "$runtime/usr/sbin/ldconfig"
}

run_pack_case() {
    local label=$1
    local expected=$2
    local fragment=$3
    local runtime="$WORK/$label/runtime"
    local out="$WORK/$label/out"
    local script="$WORK/$label/pack-squashfs.sh"
    mkdir -p "$out"
    prepare_runtime "$runtime"
    case "$label" in
    *aux*) printf 'optimizer-cache-fixture\n' > "$runtime/var/cache/ldconfig/aux-cache" ;;
    *empty-cache*) : > "$runtime/etc/ld.so.cache" ;;
    *no-ldconfig*) rm "$runtime/usr/sbin/ldconfig" ;;
    esac
    sed -e "s|/runtime|$runtime|" -e "s|/out|$out|" \
        "$ROOT/rootfs/scripts/pack-squashfs.sh" > "$script"
    chmod 0755 "$script"
    if SQUASHFS_TIME=1577836800 MICA_PACK_ARGS="$WORK/$label.args" \
        PATH="$WORK/bin:$PATH" "$script" > "$WORK/$label.log" 2>&1; then
        if [ "$expected" = refuse ]; then
            fail "pack-squashfs accepted $label"
        fi
    else
        if [ "$expected" = pass ]; then
            fail "pack-squashfs rejected $label"
        elif ! grep -Fq "$fragment" "$WORK/$label.log"; then
            fail "pack-squashfs refusal for $label omitted '$fragment'"
        fi
    fi
}

check_no_cache_contract() {
    python3 - "$1" <<'PY'
import re
import sys

text = open(sys.argv[1], encoding='utf-8').read()
assert 'case "${MICA_ROOTFS_NO_CACHE-0}" in' in text
assert re.search(r'\n0\)\s*;;\s*\n1\) ROOTFS_CACHE_ARGS=\(--no-cache\)\s*;;', text)
assert "it must be exactly 0 or 1" in text
call = re.search(r'bash "\$REPO_ROOT/build/run\.sh" --build-rootfs \\\n(?P<args>.*?)2>&1 \| tee "\$log"', text, re.S)
assert call
args = call.group('args')
assert '${ROOTFS_CACHE_ARGS[@]+"${ROOTFS_CACHE_ARGS[@]}"}' in args
assert args.index('ROOTFS_CACHE_ARGS') < args.index('DRIVER_ARGS')
PY
}

check_initramfs_contract() {
    python3 - "$1" <<'PY'
import sys

text = open(sys.argv[1], encoding='utf-8').read()
required = [
    'find . -exec touch -h -d @1577836800 {} +',
    'find . -print0 | LC_ALL=C sort -z | cpio --null --reproducible --owner=0:0 -o -H newc --quiet',
    "find \"$DEST\" -type f -printf '%P\\n' | LC_ALL=C sort > /output/initramfs.files",
]
for item in required:
    assert item in text, item
PY
}

mkdir -p "$WORK/bin"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$@" > "$MICA_PACK_ARGS"' 'touch "$2"' \
    > "$WORK/bin/mksquashfs"
chmod 0755 "$WORK/bin/mksquashfs"

run_surgery_case aux-present 1
run_surgery_case aux-already-absent 0

run_pack_case final-clean pass ''
run_pack_case final-aux refuse aux-cache
run_pack_case final-empty-cache refuse ld.so.cache
run_pack_case final-no-ldconfig refuse ldconfig

if ! check_no_cache_contract "$ROOT/rootfs/build.sh"; then
    fail 'rootfs/build.sh lacks the validated stages --no-cache bridge'
fi
for invalid in '' 2 true; do
    if MICA_PRODUCT=x64-minimal MICA_ROOTFS_NO_CACHE="$invalid" bash "$ROOT/rootfs/build.sh" \
        > "$WORK/no-cache-invalid.log" 2>&1; then
        fail "rootfs/build.sh accepted MICA_ROOTFS_NO_CACHE='$invalid'"
    elif ! grep -Fq 'it must be exactly 0 or 1' "$WORK/no-cache-invalid.log"; then
        fail "rootfs/build.sh gave no bounded refusal for MICA_ROOTFS_NO_CACHE='$invalid'"
    fi
done
cp "$ROOT/rootfs/build.sh" "$WORK/build-no-bridge.sh"
sed -i 's/ROOTFS_CACHE_ARGS/REMOVED_CACHE_ARGS/g' "$WORK/build-no-bridge.sh"
if check_no_cache_contract "$WORK/build-no-bridge.sh" 2>/dev/null; then
    fail 'no-cache contract accepted a removed invocation bridge'
fi

if ! check_initramfs_contract "$ROOT/boot/initramfs.sh"; then
    fail 'initramfs deterministic archive contract is incomplete'
fi
for mutation in reproducible ordering epoch; do
    cp "$ROOT/boot/initramfs.sh" "$WORK/initramfs-$mutation.sh"
    case "$mutation" in
    reproducible) sed -i 's/ --reproducible//' "$WORK/initramfs-$mutation.sh" ;;
    ordering) sed -i 's/LC_ALL=C sort -z/cat/' "$WORK/initramfs-$mutation.sh" ;;
    epoch) sed -i 's/@1577836800/@1700000000/' "$WORK/initramfs-$mutation.sh" ;;
    esac
    if check_initramfs_contract "$WORK/initramfs-$mutation.sh" 2>/dev/null; then
        fail "initramfs contract accepted missing $mutation control"
    fi
done

if [ "$failures" -ne 0 ]; then
    echo "ROOTFS_REPRODUCIBILITY_FAIL failures=$failures" >&2
    exit 1
fi
printf 'ROOTFS_REPRODUCIBILITY_PASS\n'
