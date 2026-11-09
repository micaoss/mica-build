#!/usr/bin/env bash
# Off-device test of write-rate.sh: one sample from a fake /sys + /proc, and the summary's arithmetic.
set -euo pipefail

sampler=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/write-rate.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
expect() { # expect FILE FIXED-STRING
    if ! grep -F -- "$2" "$1" >/dev/null; then
        printf 'FAIL: %s lacks: %s\n' "$1" "$2" >&2
        failures=$((failures + 1))
    fi
}

# --- a fake device ----------------------------------------------------------------------------
r=$work/root
mkdir -p "$r/proc/self" "$r/proc/sys/kernel" "$r/proc/101" "$r/proc/202" "$r/proc/303" \
    "$r/sys/block/mmcblk1/mmcblk1p4" "$r/sys/block/mmcblk1boot0" "$r/sys/dev/block" "$r/sys/fs/ext4/mmcblk1p4" "$work/bin"
echo '36 30 179:4 / /mnt/data rw,noatime shared:9 - ext4 /dev/mmcblk1p4 rw' >"$r/proc/self/mountinfo"
ln -s ../../block/mmcblk1/mmcblk1p4 "$r/sys/dev/block/179:4"
echo '3600.25 7000.00' >"$r/proc/uptime"
echo '6.12.116' >"$r/proc/sys/kernel/osrelease"
echo '  100 0 800 10 2000 30 4096 50 0 60 70' >"$r/sys/block/mmcblk1/stat"
echo '  1 0 8 1 99 0 9999 1 0 1 1' >"$r/sys/block/mmcblk1boot0/stat"
echo 5120 >"$r/sys/fs/ext4/mmcblk1p4/lifetime_write_kbytes"
echo systemd-journal >"$r/proc/101/comm"; printf 'rchar: 1\nwrite_bytes: 65536\n' >"$r/proc/101/io"
echo mica-mqtt-broke >"$r/proc/202/comm"; printf 'write_bytes: 4096\n' >"$r/proc/202/io"
echo bash >"$r/proc/303/comm"; printf 'write_bytes: 1\n' >"$r/proc/303/io"
cat >"$work/bin/journalctl" <<'EOF'
#!/bin/sh
case "$*" in
    --disk-usage) echo 'Archived and active journals take up 24.0M in the file system.' ;;
    *) echo 'Nov 09 systemd-journald[101]: System Journal (/var/log/journal/x) is 8.0M, max 64.0M, 56.0M free.' ;;
esac
EOF
chmod +x "$work/bin/journalctl"

out=$work/out
PATH=$work/bin:$PATH WRITE_RATE_ROOT=$r bash "$sampler" sample --interval 1 --duration 0 --out "$out"
line=$(cat "$out/samples.txt")
for want in 'up=3600.25' 'blk.mmcblk1=4096' 'data=5120' 'journal=25165824' \
    'proc.systemd-journal.101=65536' 'proc.mica-mqtt-broker.202=4096'; do
    case " $line " in *" $want "*) ;; *) printf 'FAIL: sample lacks %s: %s\n' "$want" "$line" >&2; failures=$((failures + 1)) ;; esac
done
case $line in *boot0*|*bash*|*.303=*) printf 'FAIL: sample has a boot partition or an unlisted process: %s\n' "$line" >&2; failures=$((failures + 1)) ;; esac
expect "$out/header.txt" 'data_dev=mmcblk1p4'
expect "$out/header.txt" 'max 64.0M'
expect "$out/header.txt" 'kernel=6.12.116'

# --- the summary over one day -------------------------------------------------------------------
s=$work/sum
mkdir -p "$s"
cat >"$s/samples.txt" <<'EOF'
t=1000 up=100 blk.mmcblk1=0 data=0 journal=1000000 proc.systemd-journal.101=0 proc.micad.7=500000
t=44200 up=43300 blk.mmcblk1=97656 data=24414 journal=3000000 proc.systemd-journal.101=20000000 proc.micad.7=1500000 proc.sshd.900=250000
t=87400 up=86500 blk.mmcblk1=195312 data=48828 journal=5000000 proc.systemd-journal.101=40000000 proc.micad.7=2500000 proc.sshd.900=500000
EOF
bash "$sampler" summary --out "$s" >"$work/summary.txt"
expect "$work/summary.txt" 'span 24.00 h, 3 samples'
expect "$work/summary.txt" 'card mmcblk1: 100.0 MB/day'
expect "$work/summary.txt" 'DATA (ext4): 50.0 MB/day'
expect "$work/summary.txt" 'journal on disk: 1.0 MB at start, 5.0 MB at end'
expect "$work/summary.txt" 'writer systemd-journal: 40.0 MB/day'
expect "$work/summary.txt" 'writer micad: 2.0 MB/day'
# sshd appeared after the first sample: all its writes are inside the run.
expect "$work/summary.txt" 'writer sshd: 0.5 MB/day'
top=$(awk '/^writer / { print $2; exit }' "$work/summary.txt")
[ "$top" = 'systemd-journal:' ] || { printf 'FAIL: top writer is %s\n' "$top" >&2; failures=$((failures + 1)); }

# --- a reboot inside the run is refused -----------------------------------------------------------
printf 't=1 up=500 blk.mmcblk1=10\nt=2 up=5 blk.mmcblk1=1\n' >"$s/samples.txt"
if bash "$sampler" summary --out "$s" >/dev/null 2>"$work/err"; then
    printf 'FAIL: a run across a reboot was summed\n' >&2
    failures=$((failures + 1))
fi
expect "$work/err" 'uptime went backwards'

[ "$failures" -eq 0 ] || { printf '%d failure(s)\n' "$failures" >&2; exit 1; }
echo WRITE_RATE_TEST_PASS
