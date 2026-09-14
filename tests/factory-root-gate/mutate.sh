#!/bin/bash
# Can inner.sh's five comparisons fail? Runs INSIDE the tool container, against
# the trees inner.sh already extracted.
#
#   bash mutate.sh <work-dir>
#
# A comparison that has only ever been seen agreeing is not a check, and this
# campaign has found six or more passes of exactly that kind in code that had
# been green for months. Each mutation below is applied to the OCI side ALONE,
# the comparison it targets is re-run and required to go red, the mutation is
# reverted, and the comparison is re-run and required to go silent -- so a pass
# here means the check fired AND that it is not now permanently red.
#
# THE CAPABILITY CASE IS THE ONE THAT MATTERS MOST. This root carries ZERO file
# capabilities, so inner.sh's caps comparison compares an empty file with an
# empty file and prints agreement. Without the mutation below, that line says
# "nothing looked" while reading as "no capability was lost". The arm64 roots
# put the hardlink comparison in the same position -- neither cx3576 nor
# virt-arm64 carries a single multiply-linked file -- which is why case 9 has
# two forms and says which one it used.
#
# gate.sh always runs this. It is not an optional second pass.
set -euo pipefail

work="${1:?usage: mutate.sh <work>}"
sq="${work}/sq"
oci="${work}/ocix"
[ -d "${sq}" ] && [ -d "${oci}" ] || {
    echo "error: ${sq} and ${oci} are not both there; run inner.sh first" >&2
    exit 1
}

fails=0
inventory() { ( cd "$1" && find . -mindepth 1 -printf '%M %U %G %P\n' | LC_ALL=C sort ); }
caps() { ( cd "$1" && getcap -r . 2>/dev/null | LC_ALL=C sort ); }
links() { ( cd "$1" && find . -type f -links +1 -printf '%n %P\n' | LC_ALL=C sort ); }
devices() { ( cd "$1" && find . -mindepth 1 \( -type b -o -type c \) -exec stat -c '%F %t %T %n' {} + | LC_ALL=C sort ); }
content() {
    (
        cd "$1"
        find . -mindepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
        find . -mindepth 1 -type l -printf 'symlink %P -> %l\n' | LC_ALL=C sort
    )
}

# Each is inner.sh's comparison, spelled the same way. `content` and `devices`
# are copies of its helpers rather than a `diff -r` over the trees: diff cannot
# read a device node, so a `diff -r` here would report the eight under /dev as
# differing whatever this file did to them, and every case below would go red
# without having proved anything about the mutation it made.
meta_cmp() { diff -q <(inventory "${sq}") <(inventory "${oci}"); }
content_cmp() { diff -q <(content "${sq}") <(content "${oci}"); }
devices_cmp() { diff -q <(devices "${sq}") <(devices "${oci}"); }
caps_cmp() { diff -q <(caps "${sq}") <(caps "${oci}"); }
links_cmp() { diff -q <(links "${sq}") <(links "${oci}"); }

# $1 label, $2 comparison name, $3.. the comparison to run
expect_differs() {
    if "${@:3}" >/dev/null 2>&1; then
        echo "  !! $1: the $2 comparison still agreed. It cannot see this, so every run of"
        echo "     it so far has been a check that could not fail."
        fails=$((fails + 1))
    else
        echo "  ok $1: the $2 comparison went red"
    fi
}
expect_agrees() {
    if "${@:3}" >/dev/null 2>&1; then
        echo "  ok $1: reverted, $2 agrees again"
    else
        echo "  !! $1: NOT reverted -- $2 is still red, so the run above proved nothing"
        fails=$((fails + 1))
    fi
}

target="${oci}/usr/bin/mica-deploy"
[ -f "${target}" ] || {
    echo "error: ${target} is not in the export, so there is nothing to mutate here." >&2
    echo "       The mandatory native deployment package is absent from this factory root." >&2
    exit 1
}

echo "== 1. a single mode bit =="
orig_mode="$(stat -c %a "${target}")"
chmod 0700 "${target}"
expect_differs "mode 0${orig_mode} -> 0700" "metadata" meta_cmp
chmod "0${orig_mode}" "${target}"
expect_agrees "mode" "metadata" meta_cmp

echo "== 2. a single gid =="
orig_gid="$(stat -c %g "${target}")"
chown ":42" "${target}"
expect_differs "gid ${orig_gid} -> 42" "metadata" meta_cmp
chown ":${orig_gid}" "${target}"
expect_agrees "gid" "metadata" meta_cmp

echo "== 3. a renamed path =="
mv "${target}" "${target}-renamed"
expect_differs "usr/bin/mica-deploy -> usr/bin/mica-deploy-renamed" "metadata" meta_cmp
mv "${target}-renamed" "${target}"
expect_agrees "rename" "metadata" meta_cmp

echo "== 4. a single byte =="
cp -a "${target}" "${work}/mica-deploy.orig"
printf 'x' | dd of="${target}" bs=1 seek=64 conv=notrunc status=none
expect_differs "one byte at offset 64" "content" content_cmp
# Restored by copy rather than by writing the byte back: a revert that left the
# mode or the mtime changed would make the next check pass for the wrong reason.
cp -a "${work}/mica-deploy.orig" "${target}"
expect_agrees "byte" "content" content_cmp

# The device node the next three cases move, chosen off the export rather than
# named: `/dev/null` is the obvious candidate and naming it would make this file
# refuse on the first root that does not carry one. Its type, major, minor, mode
# and owner are read first, because every revert below has to put back all five
# -- a node restored with the right major and the wrong mode leaves METADATA red
# for the rest of the run and the failure would be read as the mutation's.
dev="$(cd "${oci}" && find . -mindepth 1 -type c -printf '%P\n' | LC_ALL=C sort | sed -n '1p')"
if [ -z "${dev}" ]; then
    # A root that ships no device node (devtmpfs makes them; the composed
    # roots carry none) leaves the device comparison with an empty file on
    # each side. Prove it can go red anyway: a node ADDED to one side is a
    # difference it must see, and the export is then put back as it was.
    echo "== 5. no device node in the export: one added to one side =="
    mknod -m 0666 "${oci}/dev/mica-gate-probe" c 1 3
    expect_differs "dev/mica-gate-probe added (1:3)" "device" devices_cmp
    rm -f "${oci}/dev/mica-gate-probe"
    expect_agrees "added device removed" "device" devices_cmp
    echo "== 6-7. skipped: the export carries no device node to move or remove =="
fi
if [ -n "${dev}" ]; then
node="${oci}/${dev}"
dev_mode="$(stat -c %a "${node}")"
dev_uid="$(stat -c %u "${node}")"
dev_gid="$(stat -c %g "${node}")"
dev_major="$((0x$(stat -c %t "${node}")))"
dev_minor="$((0x$(stat -c %T "${node}")))"
restore_dev() {
    rm -f "${node}"
    mknod -m "0${dev_mode}" "${node}" c "${dev_major}" "${dev_minor}"
    chown "${dev_uid}:${dev_gid}" "${node}"
}

echo "== 5. a device node's minor =="
# THE ONE NOTHING ELSE CAN SEE. Same path, same type, same mode, same owner,
# same link count, no bytes on either side -- so metadata, content, capabilities
# and hardlinks all agree across this, and a root whose /dev/null carried
# /dev/zero's minor would return zeros to every reader that opened it.
rm "${node}"
mknod -m "0${dev_mode}" "${node}" c "${dev_major}" "$((dev_minor + 1))"
chown "${dev_uid}:${dev_gid}" "${node}"
expect_differs "${dev} ${dev_major}:${dev_minor} -> ${dev_major}:$((dev_minor + 1))" "device" devices_cmp
restore_dev
expect_agrees "minor" "device" devices_cmp

echo "== 6. a device node exported as a regular file =="
# The failure this looks like in practice: a stage that copied the tree through
# something that cannot carry a device node leaves an empty regular file at the
# path. inner.sh's metadata comparison sees this one too -- `%M` carries the
# type character -- and it is asserted HERE as well because that is the
# comparison that must not be the only one looking: the device list is what
# still holds when a future inventory stops printing a mode symbolically.
rm "${node}"
: > "${node}"
chmod "0${dev_mode}" "${node}"
chown "${dev_uid}:${dev_gid}" "${node}"
expect_differs "${dev} character device -> empty regular file" "device" devices_cmp
restore_dev
expect_agrees "regular file" "device" devices_cmp

echo "== 7. a device node that is not there at all =="
rm "${node}"
expect_differs "${dev} removed" "device" devices_cmp
restore_dev
expect_agrees "removal" "device" devices_cmp
fi

echo "== 8. a file capability =="
# The one this root cannot demonstrate on its own, added to the OCI side only,
# so the comparison has something to notice for the first time.
setcap cap_net_raw+ep "${target}"
expect_differs "cap_net_raw+ep added to usr/bin/mica-deploy" "capabilities" caps_cmp
setcap -r "${target}"
expect_agrees "capability" "capabilities" caps_cmp

echo "== 9. a hardlink =="
# `| sed -n '1p'` and not `| head -1`: this file sets pipefail, and head exits
# as soon as it has its line, so the producer dies of SIGPIPE and the whole
# substitution reports failure -- under `set -e`, an exit with no message at
# all. It happened here. tests/shell-pipefail-lint.sh exists for the grep -q
# form of the same trap.
#
# TWO FORMS, because the roots differ and the comparison has to be driven on
# both. x64 ships klibc as one binary under six names, so there a link can be
# BROKEN -- the failure the comparison exists to catch. The arm64 roots carry no
# multiply-linked file at all, which puts this comparison exactly where the
# capability one is: an empty list against an empty list, agreeing because
# neither side has anything. There a link is MADE instead. `links` is a diff of
# two sorted lists, so a run that can see a row appear can see one disappear;
# what neither form tolerates is the comparison never having been driven.
linked="$(cd "${oci}" && find . -type f -links +1 -printf '%P\n' | LC_ALL=C sort | sed -n '1p')"
if [ -n "${linked}" ]; then
    inode="$(stat -c %i "${oci}/${linked}")"
    sibling="$(cd "${oci}" && find . -inum "${inode}" -printf '%P\n' | { grep -vx "${linked}" || true; } | sed -n '1p')"
    [ -n "${sibling}" ] || { echo "  !! ${linked} claims >1 link and no sibling was found" >&2; exit 1; }
    rm "${oci}/${linked}"
    cp -a "${oci}/${sibling}" "${oci}/${linked}"
    expect_differs "hardlink ${linked} <-> ${sibling} broken into two files" "hardlink" links_cmp
    rm "${oci}/${linked}"
    ln "${oci}/${sibling}" "${oci}/${linked}"
    expect_agrees "hardlink" "hardlink" links_cmp
else
    echo "  -- this root carries no multiply-linked file; making one instead of breaking one"
    ln "${target}" "${target}-link"
    expect_differs "usr/bin/mica-deploy given a second name" "hardlink" links_cmp
    rm "${target}-link"
    expect_agrees "hardlink" "hardlink" links_cmp
fi

echo
if [ "${fails}" -eq 0 ]; then
    echo "MUTATION: all five comparisons were driven from the failing side and fired"
else
    echo "MUTATION: ${fails} check(s) could not be made to fail, so inner.sh's agreement"
    echo "          on them means nothing."
    exit 1
fi
