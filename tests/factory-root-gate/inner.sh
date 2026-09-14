#!/bin/bash
# The five comparisons. Runs INSIDE the pinned tool container; gate.sh starts it.
#
# mica-build-side: container -- gate.sh runs this with `docker run ... sh -c 'apk add ...
# && bash inner.sh'`; neither unsquashfs nor getcap is readable on the build host.
#
#   bash inner.sh <out-dir> <work-dir>
#
# rootfs/compose/90-pack.Dockerfile packs `pack`'s /rootfs into a squashfs and
# exports the same /rootfs as an OCI image. The smoke run executes binaries in
# the second and the device ships the first, so if the two are not one tree the
# smoke run is a check on something adjacent to the artifact.
#
# Five comparisons and not one: a listing cannot see a byte; a byte comparison
# cannot see a mode, a uid or a gid; neither can see a file capability, which
# lives in an xattr that has to survive a buildkit layer export to reach either
# side; none of the three can see a hardlink becoming two files; and none of the
# four can see the major and minor of a device node, which is the whole of what
# a device node is. A COPY that changed what it staged moves a mode or a path
# before it moves a byte.
#
# Any difference exits non-zero: a script that printed the differing rows and
# exited 0 would be a report and not a gate.
set -euo pipefail

out="${1:?usage: inner.sh <out> <work>}"
work="${2:?usage: inner.sh <out> <work>}"
img="${out}/rootfs-verity.img"
envf="${out}/rootfs-verity.env"
oci="${out}/factory-root.oci"
for f in "${img}" "${envf}" "${oci}"; do
    [ -s "${f}" ] || { echo "error: ${f} is missing or empty" >&2; exit 1; }
done
rm -rf "${work}"; mkdir -p "${work}"
differing=0

# The image is squashfs + an appended verity hash tree + padding to a whole MiB.
# Truncated to the size pack-verity.sh recorded, because unsquashfs handed the
# padded file mostly copes, and mostly-coping is worse than failing.
bytes="$(sed -n 's/^SQUASHFS_BYTES=//p' "${envf}" | tail -n1)"
[ -n "${bytes}" ] || { echo "error: no SQUASHFS_BYTES in ${envf}" >&2; exit 1; }
head -c "${bytes}" "${img}" > "${work}/rootfs.squashfs"

echo "== extract =="
unsquashfs -n -xattrs -d "${work}/sq" "${work}/rootfs.squashfs" > "${work}/unsquashfs.log" 2>&1
echo "squashfs: $(tail -1 "${work}/unsquashfs.log")"

mkdir -p "${work}/blobs" "${work}/ocix"
tar -xf "${oci}" -C "${work}/blobs"
layer=""
n=0
for blob in $(find "${work}/blobs/blobs" -type f | LC_ALL=C sort); do
    if tar -tf "${blob}" >/dev/null 2>&1; then layer="${blob}"; n=$((n + 1)); fi
done
[ "${n}" -eq 1 ] || {
    echo "error: expected exactly one layer blob in ${oci}, found ${n}. More than one means the" >&2
    echo "       export gained a layer nobody asked for; none means this is reading the wrong" >&2
    echo "       directory, and every listing below would then be empty and every diff green." >&2
    exit 1
}
tar -xpf "${layer}" -C "${work}/ocix" --numeric-owner --xattrs --xattrs-include='*'
echo "oci layer: ${layer##*/}"

# Both sides are walked the SAME way, from the extracted trees, rather than from
# two tools' own listing formats. The formats differ in ways that would have to
# be normalised, and a normalisation is somewhere for a difference to be lost.
# `-mindepth 1` excludes the root directory itself, which is why the count here
# is one lower than `unsquashfs -lln`'s and than M5's table: 9,240 against 9,241.
inventory() { ( cd "$1" && find . -mindepth 1 -printf '%M %U %G %P\n' | LC_ALL=C sort ); }
caps() { ( cd "$1" && getcap -r . 2>/dev/null | LC_ALL=C sort ); }
links() { ( cd "$1" && find . -type f -links +1 -printf '%n %P\n' | LC_ALL=C sort ); }
devices() { ( cd "$1" && find . -mindepth 1 \( -type b -o -type c \) -exec stat -c '%F %t %T %n' {} + | LC_ALL=C sort ); }
# The entries that HAVE content: a regular file has bytes and a symlink has a
# target, and a directory, a device node, a fifo and a socket have neither. The
# bytes are named by their hash rather than compared in place so that the
# comparison is a diff of two files, the shape `caps` and `links` already use.
content() {
    (
        cd "$1"
        find . -mindepth 1 -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
        find . -mindepth 1 -type l -printf 'symlink %P -> %l\n' | LC_ALL=C sort
    )
}

echo
echo "== metadata: mode, uid, gid, path, over every entry =="
inventory "${work}/sq" > "${work}/sq.meta"
inventory "${work}/ocix" > "${work}/oci.meta"
echo "squashfs entries: $(wc -l < "${work}/sq.meta")"
echo "oci entries:      $(wc -l < "${work}/oci.meta")"
if diff -u "${work}/sq.meta" "${work}/oci.meta" > "${work}/meta.diff"; then
    echo "METADATA: identical"
else
    echo "METADATA: $(grep -c '^[+-][^+-]' "${work}/meta.diff") differing rows -- ${work}/meta.diff"
    head -20 "${work}/meta.diff"
    differing=$((differing + 1))
fi

echo
echo "== content: the bytes of every regular file, the target of every symlink =="
# `diff -r --no-dereference` over the two trees was what this was until
# RFCT-356, and diff cannot do it: it cannot READ a device node. For each of the
# eight character devices under /dev it printed `File .../dev/null is a
# character special file while file .../dev/null is a character special file`
# and exited 1 -- eight lines that say only that diff declined to look -- so
# CONTENT was red on every arm64 root for a reason that was never about the
# root, and FIDELITY below then said the smoke run measured nothing. Neither way
# out was available: filtering those lines would have filtered a real difference
# phrased the same way, and a device node that changed type or major:minor is
# exactly what diff phrases that way; and excluding /dev would have stopped
# comparing eight entries that are part of the root. The device nodes are
# compared below instead, by the property they actually have, and diff is handed
# what it can read.
#
# Symlinks are compared by their TARGET and never followed: /etc/shadow ->
# /run/mica/shadow is dangling by design, and following it would compare nothing
# on both sides and call that agreement -- which is what `--no-dereference`
# bought here before, and `%l` buys now.
content "${work}/sq" > "${work}/sq.content"
content "${work}/ocix" > "${work}/oci.content"
echo "squashfs: $(wc -l < "${work}/sq.content") entries with content; oci: $(wc -l < "${work}/oci.content")"
if diff -u "${work}/sq.content" "${work}/oci.content" > "${work}/content.diff"; then
    echo "CONTENT: identical"
else
    echo "CONTENT: $(grep -c '^[+-][^+-]' "${work}/content.diff") differing rows -- ${work}/content.diff"
    head -20 "${work}/content.diff"
    differing=$((differing + 1))
fi

echo
echo "== device nodes: type, major, minor =="
# A major and a minor are invisible to all four of the others. `%M` in the
# inventory carries the type character, so a /dev/null exported as a regular
# file is caught there -- but a /dev/null exported as character 1:5 has the same
# mode, the same owner, the same link count and the same (absent) content as the
# real one, and a root whose /dev/null is /dev/zero returns zeros to every
# reader instead of end-of-file. `stat` and not `find -printf`, which has no
# directive for either number.
devices "${work}/sq" > "${work}/sq.devs"
devices "${work}/ocix" > "${work}/oci.devs"
echo "squashfs: $(wc -l < "${work}/sq.devs") device node(s); oci: $(wc -l < "${work}/oci.devs")"
if diff -u "${work}/sq.devs" "${work}/oci.devs" > "${work}/devs.diff"; then
    echo "DEVICES: identical"
else
    echo "DEVICES: differ -- ${work}/devs.diff"; cat "${work}/devs.diff"
    differing=$((differing + 1))
fi

echo
echo "== file capabilities =="
# Recorded rather than trusted: caps are xattrs, and an xattr a layer export
# drops is a binary that silently loses a privilege it needs. On this root the
# answer is ZERO on both sides, so this line means nothing on its own --
# mutate.sh is what makes it a statement. verify says the same about the
# packed image, and for the same reason.
caps "${work}/sq" > "${work}/sq.caps"
caps "${work}/ocix" > "${work}/oci.caps"
echo "squashfs: $(wc -l < "${work}/sq.caps") entries; oci: $(wc -l < "${work}/oci.caps") entries"
if diff -u "${work}/sq.caps" "${work}/oci.caps" > "${work}/caps.diff"; then
    echo "CAPS: identical"
else
    echo "CAPS: differ -- ${work}/caps.diff"; cat "${work}/caps.diff"
    differing=$((differing + 1))
fi

echo
echo "== hardlinks =="
# A link count is invisible to every check above: two files with identical mode,
# owner and bytes are exactly what a broken hardlink looks like. It costs size,
# and on a root where klibc ships one binary under many names it costs a lot.
links "${work}/sq" > "${work}/sq.links"
links "${work}/ocix" > "${work}/oci.links"
echo "squashfs: $(wc -l < "${work}/sq.links") multiply-linked files; oci: $(wc -l < "${work}/oci.links")"
if diff -u "${work}/sq.links" "${work}/oci.links" > "${work}/links.diff"; then
    echo "HARDLINKS: identical"
else
    echo "HARDLINKS: differ -- ${work}/links.diff"; head -20 "${work}/links.diff"
    differing=$((differing + 1))
fi

echo
if [ "${differing}" -eq 0 ]; then
    echo "FIDELITY: the exported OCI image is the tree that ships, on all five comparisons"
else
    echo "FIDELITY: ${differing} of 5 comparisons differ. The image the smoke run"
    echo "          executes in is NOT the image the device ships, so nothing the smoke run"
    echo "          reports is about the shipped artifact."
    exit 1
fi
