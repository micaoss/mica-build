#!/bin/sh
# Take the package-manager logs OUT of the tree, ahead of the purge that removes them.
#
# Called from rootfs/compose/90-pack.Dockerfile (closed stage), where the reasoning lives.

set -eu
[ -s /var/log/dpkg.log ] ||
    { echo "error: /var/log/dpkg.log is missing or empty before the purge. It is the instrument the stage-order claim is measured with -- rootfs/README.md, 'Check the apt order directly' -- so capturing nothing here would leave that claim unmeasurable rather than failed, which is the worse of the two" >&2; exit 1; }
mkdir -p /rootfs-report.pkglogs
for p in /var/log/dpkg.log /var/log/alternatives.log /var/log/apt; do
    [ ! -e "${p}" ] || cp -a "${p}" /rootfs-report.pkglogs/
done
n="$(find /rootfs-report.pkglogs -type f | wc -l)"
echo "package-manager logs captured: ${n} files, $(du -sk /rootfs-report.pkglogs | cut -f1) KB"
