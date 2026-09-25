#!/usr/bin/env bash
# Render a board's runtime storage policy out of its layout.tsv: fstab, the repart.d set, the growth
# drop-in, and, where the layout has an esp, the ESP mount. The partitions are the board's
# declaration (src/image/file-layout.ts holds the table to its rules); nothing here names a board or a
# partition set.
set -euo pipefail
src=${1:?source root required}
out=${2:?output directory required}
layout="$src/layout.tsv"
[ "$(head -n 1 "$layout")" = '# mica layout v1' ] || { echo "render: $layout is not a mica layout v1" >&2; exit 1; }
mkdir -p "$out/repart.d" "$out/systemd-repart.service.d"
# The one value of a role's partition: <role> <column> (part rows: 2 number, 3 name, 4 role, 5 start,
# 6 size, 7 type, 8 guid).
part() { awk -F'\t' -v r="$1" -v c="$2" '$1 == "part" && $4 == r { print $c; exit }' "$layout"; }
disk_guid=$(awk -F'\t' '$1 == "disk" { print $2; exit }' "$layout")
data_guid=$(part data 8); system_guid=$(part system 8)
[ -n "$disk_guid" ] && [ -n "$data_guid" ] && [ -n "$system_guid" ] || { echo "render: $layout declares no disk, system or data" >&2; exit 1; }
printf -v data_line 'PARTUUID=%s /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2' "${data_guid,,}"
sed "s|@DATA_LINE@|$data_line|g" "$src/common/fstab.in" >"$out/fstab"
esp_guid=$(part esp 8)
if [ -n "$esp_guid" ]; then
    sed "s|@ESP_GUID@|${esp_guid,,}|g" "$src/overlay/etc/systemd/system/boot.mount.in" >"$out/boot.mount"
fi
# Repart 257 matches partitions by type and order; every partition keeps its size and only data, the
# last, grows.
while IFS=$'\t' read -r kind number name role _start size type _rest; do
    [ "$kind" = part ] || continue
    {
        printf '[Partition]\nType=%s\n' "$type"
        if [ "$role" = data ]; then printf 'Weight=1000\n';
        else printf 'SizeMinBytes=%s\nSizeMaxBytes=%s\nWeight=0\n' "$((size * 512))" "$((size * 512))"; fi
    } >"$out/repart.d/${number}0-${name}.conf"
done <"$layout"
cat >"$out/systemd-repart.service.d/10-data.conf" <<EOT
[Unit]
Before=mnt-data.mount
[Service]
ExecStart=
ExecStart=/usr/lib/mica/mica-grow-data ${system_guid,,} ${disk_guid,,}
SuccessExitStatus=
TimeoutStartSec=30
EOT
if grep -R -E '@[A-Z_]+@' "$out"; then
    echo 'render: unexpanded layout placeholder' >&2; exit 1
fi
