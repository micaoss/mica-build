#!/usr/bin/env bash
# Render a board's runtime storage policy out of its board.env: fstab, the
# repart.d set, the growth drop-in, and for a UEFI board the ESP mount.
# The layout is the board's declaration (LAYOUT_PARTITIONS); nothing here
# names a board.
set -euo pipefail
src=${1:?source root required}
out=${2:?output directory required}
. "$src/board.env"
[ "$LAYOUT_VERSION" = 3 ]
mkdir -p "$out/repart.d" "$out/systemd-repart.service.d"
printf -v data_line 'PARTUUID=%s /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2' "${DATA_GUID,,}"
sed "s|@DATA_LINE@|$data_line|g" "$src/common/fstab.in" >"$out/fstab"
case "$LAYOUT_PARTITIONS" in
'ESP SYSTEM DATA')
    # Repart 257 matches partitions by type and order; only the final DATA grows.
    sed "s|@ESP_GUID@|${ESP_GUID,,}|g" "$src/overlay/etc/systemd/system/boot.mount.in" >"$out/boot.mount"
    for entry in ESP SYSTEM DATA; do
        var=${entry}_SIZE_MIB; size=${!var}
        var=${entry}_TYPECODE; type=${!var}
        var=${entry}_PARTNUM; number=${!var}
        {
            printf '[Partition]\nType=%s\n' "$type"
            if [ "$entry" = DATA ]; then printf 'Weight=1000\n';
            else printf 'SizeMaxBytes=%sM\nSizeMinBytes=%sM\nWeight=0\n' "$size" "$size"; fi
        } >"$out/repart.d/${number}0-${entry,,}.conf"
    done
    ;;
'FIRMWARE SYSTEM DATA')
    for entry in FIRMWARE SYSTEM DATA; do
        var=${entry}_TYPECODE; type=${!var}
        var=${entry}_PARTNUM; number=${!var}
        if [ "$entry" = FIRMWARE ]; then size=$((FIRMWARE_SIZE_SECTORS * 512));
        else var=${entry}_SIZE_MIB; size=$(( ${!var} * 1048576 )); fi
        {
            printf '[Partition]\nType=%s\n' "$type"
            if [ "$entry" = DATA ]; then printf 'Weight=1000\n';
            else printf 'SizeMinBytes=%s\nSizeMaxBytes=%s\nWeight=0\n' "$size" "$size"; fi
        } > "$out/repart.d/${number}0-${entry,,}.conf"
    done
    ;;
*) echo "render: LAYOUT_PARTITIONS='$LAYOUT_PARTITIONS' is neither the UEFI nor the FIT layout" >&2; exit 1 ;;
esac
cat >"$out/systemd-repart.service.d/10-data.conf" <<EOT
[Unit]
Before=mnt-data.mount
[Service]
ExecStart=
ExecStart=/usr/lib/mica/mica-grow-data ${SYSTEM_GUID,,} ${DISK_GUID,,}
SuccessExitStatus=
TimeoutStartSec=30
EOT
if grep -R -E '@[A-Z_]+@' "$out"; then
    echo 'render: unexpanded layout placeholder' >&2; exit 1
fi
