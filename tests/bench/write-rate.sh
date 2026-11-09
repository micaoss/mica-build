#!/usr/bin/env bash
# Storage write-rate sampler for a field bench (W3.3).
#
#   bash write-rate.sh sample  [--interval SEC] [--duration SEC] [--out DIR] [--data-mount DIR] [--procs "a b"]
#                              [--disks GLOB]
#   bash write-rate.sh summary [--out DIR]
#
# It runs ON THE DEVICE, as root (it reads /proc/<pid>/io), and needs nothing from the repository.
# `sample` appends one line every --interval seconds (default 600) until --duration (default 86400)
# has passed; start it detached so an SSH drop does not end it:
#   setsid nohup bash /root/write-rate.sh sample >/dev/null 2>&1 &
# Everything it writes goes under --out (default /run/mica-write-rate): /run is RAM, so the sampler
# does not add to the writes it measures. Copy samples.txt off the device before a reboot.
#
# One line per sample, space-separated key=value:
#   t=<epoch> up=<uptime s> blk.<disk>=<sectors written> data=<DATA ext4 lifetime_write_kbytes>
#   journal=<journalctl --disk-usage, bytes> proc.<comm>.<pid>=<write_bytes>
# blk counts every write the card took (field 7 of /sys/block/<dev>/stat, 512-byte sectors), DATA's
# counter only what ext4 wrote to DATA; proc.* attributes writes to processes (write_bytes counts
# what a process caused to reach the block layer; a restarted process shows up under its new pid).
# The header file (header.txt) keeps what is read once: the kernel, the DATA device, and journald's
# own "max" line, which states the journal's cap.
#
# `summary` reads samples.txt (on the device, or on a copy: --out DIR) and prints MB/day for each
# card and for DATA, the top writers, and the journal's first and last size. A reboot inside the run
# resets every counter, so a run whose uptime goes backwards is refused instead of summed.
set -euo pipefail

ROOT=${WRITE_RATE_ROOT:-}        # tests point /sys and /proc elsewhere; empty on a device
interval=600
duration=86400
out=/run/mica-write-rate
data_mount=/mnt/data
disks="mmcblk*"   # the whole disks to count, under /sys/block; vd* in a QEMU lab with a virtio disk
procs="systemd-journal micad mica-apid mica-mqttd mica-mqtt-broker mica-containerd containerd sshd dropbear systemd-networkd"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'write-rate: %s\n' "$*" >&2; exit 1; }

mode=${1:-}
[ -n "$mode" ] || { usage >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
    case $1 in
        --interval) interval=$2; shift 2 ;;
        --duration) duration=$2; shift 2 ;;
        --out) out=$2; shift 2 ;;
        --data-mount) data_mount=$2; shift 2 ;;
        --procs) procs=$2; shift 2 ;;
        --disks) disks=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

# The kernel name (dm-0, mmcblk1p4) of the device mounted at $data_mount, from mountinfo's major:minor.
data_dev() {
    local majmin
    majmin=$(awk -v m="$data_mount" '$5 == m { d = $3 } END { print d }' "$ROOT/proc/self/mountinfo")
    [ -n "$majmin" ] || return 0
    basename "$(readlink -f "$ROOT/sys/dev/block/$majmin")"
}

# `journalctl --disk-usage` ("... take up 24.0M in the file system.") in bytes; empty if absent.
journal_bytes() {
    command -v journalctl >/dev/null || return 0
    journalctl --disk-usage 2>/dev/null | awk '{
        for (i = 1; i <= NF; i++) if ($i == "up") { v = $(i + 1) }
    } END {
        if (v == "") exit
        n = v + 0; u = substr(v, length(v))
        f = (u == "K") ? 1024 : (u == "M") ? 1048576 : (u == "G") ? 1073741824 : (u == "T") ? 1099511627776 : 1
        printf "%.0f\n", n * f
    }'
}

sample_line() {
    local line dev f stat comm name want pid wb
    line="t=$(date +%s) up=$(cut -d' ' -f1 "$ROOT/proc/uptime")"
    for f in "$ROOT"/sys/block/$disks; do
        [ -e "$f/stat" ] || continue
        dev=${f##*/}
        case $dev in *boot*|*rpmb*) continue ;; esac
        read -r -a stat <"$f/stat"
        line="$line blk.$dev=${stat[6]}"
    done
    dev=$(data_dev)
    if [ -n "$dev" ] && [ -r "$ROOT/sys/fs/ext4/$dev/lifetime_write_kbytes" ]; then
        line="$line data=$(cat "$ROOT/sys/fs/ext4/$dev/lifetime_write_kbytes")"
    fi
    wb=$(journal_bytes)
    [ -z "$wb" ] || line="$line journal=$wb"
    for f in "$ROOT"/proc/[0-9]*/comm; do
        comm=$(cat "$f" 2>/dev/null) || continue
        for name in $procs; do
            want=${name:0:15}   # the kernel keeps 15 characters of a command name
            [ "$comm" = "$want" ] || continue
            pid=${f%/comm}; pid=${pid##*/}
            wb=$(awk '$1 == "write_bytes:" { print $2 }' "$ROOT/proc/$pid/io" 2>/dev/null) || wb=
            [ -z "$wb" ] || line="$line proc.$name.$pid=$wb"
        done
    done
    printf '%s\n' "$line"
}

do_sample() {
    local end
    mkdir -p "$out"
    {
        printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'kernel=%s\n' "$(cat "$ROOT/proc/sys/kernel/osrelease" 2>/dev/null || true)"
        printf 'interval=%s duration=%s data_mount=%s data_dev=%s\n' "$interval" "$duration" "$data_mount" "$(data_dev)"
        if command -v journalctl >/dev/null; then
            printf 'journald=%s\n' "$(journalctl -b -u systemd-journald --no-pager 2>/dev/null | grep -F ', max ' | tail -n 1 || true)"
        fi
    } >"$out/header.txt"
    end=$(( $(date +%s) + duration ))
    while :; do
        sample_line >>"$out/samples.txt"
        [ "$(date +%s)" -lt "$end" ] || break
        sleep "$interval"
    done
}

do_summary() {
    [ -s "$out/samples.txt" ] || die "no samples in $out/samples.txt"
    [ ! -r "$out/header.txt" ] || sed 's/^/# /' "$out/header.txt"
    awk '
        function kv(i,   k, v) { k = $i; sub(/=.*/, "", k); v = $i; sub(/^[^=]*=/, "", v); K = k; V = v + 0 }
        {
            for (i = 1; i <= NF; i++) {
                kv(i)
                if (K == "up") { if (NR > 1 && V < up) { reboot = 1 }; up = V }
                # A process first seen after the first sample started inside the run: all of its writes count.
                if (!(K in first)) first[K] = (NR > 1 && K ~ /^proc\./) ? 0 : V
                last[K] = V
            }
        }
        END {
            if (reboot) { print "write-rate: uptime went backwards (a reboot inside the run); counters reset, nothing summed" > "/dev/stderr"; exit 1 }
            span = last["t"] - first["t"]
            if (span <= 0) { print "write-rate: fewer than two samples" > "/dev/stderr"; exit 1 }
            day = 86400 / span
            printf "span %.2f h, %d samples\n", span / 3600, NR
            for (k in first) if (k ~ /^blk\./) printf "card %s: %.1f MB/day\n", substr(k, 5), (last[k] - first[k]) * 512 / 1e6 * day
            if ("data" in first) printf "DATA (ext4): %.1f MB/day\n", (last["data"] - first["data"]) * 1024 / 1e6 * day
            if ("journal" in first) printf "journal on disk: %.1f MB at start, %.1f MB at end\n", first["journal"] / 1e6, last["journal"] / 1e6
            for (k in first) if (k ~ /^proc\./) {
                n = k; sub(/^proc\./, "", n); sub(/\.[0-9]+$/, "", n)
                w[n] += last[k] - first[k]
            }
            for (n in w) printf "writer %s: %.1f MB/day\n", n, w[n] / 1e6 * day | "sort -k3,3nr"
        }
    ' "$out/samples.txt"
}

case $mode in
    sample) do_sample ;;
    summary) do_summary ;;
    *) usage >&2; exit 2 ;;
esac
