#!/bin/sh
# Preserve native installation inputs outside the selected runtime payload.
set -eu
[ ! -e /mica-build-inputs ]
install -d -m 0755 /mica-build-inputs/info
cp -a /var/lib/dpkg/info/*.list /mica-build-inputs/info/
cp /mica-compose/source-lineage.json /mica-build-inputs/source-lineage.json
cp /mica-compose/packages.txt /mica-build-inputs/selected.pkgs
cp /mica-compose/upstream.tsv /mica-build-inputs/
cp /etc/dpkg/dpkg.cfg.d/mica-slim /mica-build-inputs/dpkg-slim.conf
cp "/mica-debs/${MICA_ARCH}/Packages" "/mica-debs/${MICA_ARCH}/SHA256SUMS" "/mica-debs/${MICA_ARCH}/manifest.txt" /mica-build-inputs/
dpkg-query -W -f='${Package}\t${source:Package}\t${source:Version}\n' | LC_ALL=C sort > /mica-build-inputs/sources.tsv
install -d -m 0755 /mica-build-inputs/alternatives /mica-build-inputs/enablement
update-alternatives --get-selections | awk '{print $1}' > /mica-build-inputs/alternative-names.txt
while IFS= read -r name; do
    update-alternatives --query "$name" > "/mica-build-inputs/alternatives/$name"
done < /mica-build-inputs/alternative-names.txt
if [ -d /var/lib/systemd/deb-systemd-helper-enabled ]; then
    cp -a /var/lib/systemd/deb-systemd-helper-enabled/. /mica-build-inputs/enablement/
fi
find /mica-build-inputs/enablement -maxdepth 1 -type f -name '*.dsh-also' -printf '%f\n' | LC_ALL=C sort > /mica-build-inputs/enablement-names.txt
: > /mica-build-inputs/preset-removed.tsv
sha256sum /mica-scripts/compose-install.sh /mica-scripts/compose-capture.sh > /mica-build-inputs/transform-sources.sha256
