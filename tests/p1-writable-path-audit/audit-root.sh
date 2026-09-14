#!/usr/bin/env bash
# The static half of the P1-B audit, run over one extracted factory root.
#   bash audit-root.sh <board>
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${P1_WORK:-$REPO/.tmp/p1-writable-path-audit}"
mkdir -p "$S"
b="${1:?board}"
R="$S/root-$b"
[ -d "$R" ] || { echo "error: $R not extracted" >&2; exit 1; }

echo "############################## $b ##############################"

echo "### enabled by /etc/systemd/system/*.wants"
for d in "$R"/etc/systemd/system/*.wants; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    for l in "$d"/*; do [ -e "$l" ] || [ -L "$l" ] || continue; echo "  $n <- $(basename "$l")"; done
done

echo "### masked (-> /dev/null)"
find "$R"/etc/systemd/system "$R"/usr/lib/systemd/system -maxdepth 1 -lname /dev/null -printf '  %f\n' 2>/dev/null | sort

echo "### presets"
for f in "$R"/usr/lib/systemd/system-preset/*.preset; do
    [ -f "$f" ] || continue
    echo "  --- ${f#"$R"}"; grep -vE '^\s*#|^$' "$f" | sed 's/^/    /'
done

echo "### exec-directory directives across every shipped unit"
grep -rHn -E '^(StateDirectory|CacheDirectory|LogsDirectory|ConfigurationDirectory)=' \
    "$R"/usr/lib/systemd/system/ "$R"/etc/systemd/system/ 2>/dev/null | sed "s|$R||" | sort

echo "### RequiresMountsFor / ReadWritePaths"
grep -rHn -E '^(RequiresMountsFor|ReadWritePaths)=' \
    "$R"/usr/lib/systemd/system/ "$R"/etc/systemd/system/ 2>/dev/null | sed "s|$R||" | sort

echo "### PrivateTmp"
grep -rHn '^PrivateTmp=' "$R"/usr/lib/systemd/system/ "$R"/etc/systemd/system/ 2>/dev/null | sed "s|$R||" | sort

echo "### DynamicUser"
grep -rHn '^DynamicUser=' "$R"/usr/lib/systemd/system/ "$R"/etc/systemd/system/ 2>/dev/null | sed "s|$R||" | sort

echo "### tmpfiles rules mentioning /var"
cat "$R"/usr/lib/tmpfiles.d/*.conf "$R"/etc/tmpfiles.d/*.conf 2>/dev/null \
    | grep -vE '^\s*#|^$' | grep -E '/var' | sort -u | sed 's/^/  /'

echo "### /var in the read-only image"
find "$R/var" 2>/dev/null | sed "s|$R||" | sort | sed 's/^/  /'

echo "### /usr/share/factory/var (the tree a device gets)"
F="$R/usr/share/factory/var"
find "$F" -mindepth 1 2>/dev/null | sort | while read -r p; do
    rel="/var${p#"$F"}"
    if   [ -L "$p" ]; then echo "  L $rel -> $(readlink "$p")"
    elif [ -d "$p" ]; then echo "  d $(stat -c '%a %u:%g' "$p") $rel ($(ls -A "$p" | wc -l) entries)"
    else echo "  f $(stat -c '%a %u:%g %s' "$p") $rel"; fi
done

echo "### bind targets, present in the read-only image?"
for p in /etc/ssh /etc/hostname /etc/containers/systemd /usr/local/lib/systemd/system \
         /etc/hostapd /etc/wpa_supplicant /mica /srv /home /root \
         /mnt/state /mnt/data /mnt/meta \
         /var/lib/mica /var/lib/bluetooth /var/lib/systemd/timesync \
         /var/lib/systemd/random-seed /var/lib/systemd/rfkill /var/lib/systemd/linger \
         /var/lib/containers /var/tmp /var/log/wtmp.db /var/lib/wtmpdb; do
    if [ -e "$R$p" ] || [ -L "$R$p" ]; then echo "  present  $p"; else echo "  ABSENT   $p"; fi
done

echo "### cross-tree symlinks out of /etc"
find "$R/etc" -type l 2>/dev/null | while read -r l; do
    t=$(readlink "$l")
    case "$t" in /run/*|/mnt/*|/mica/*|/var/*|../run/*) echo "  ${l#"$R"} -> $t" ;; esac
done | sort

echo "### login-accounting: libwtmpdb consumers"
find "$R" -type f \( -name '*.so*' -o -perm -u+x \) 2>/dev/null | while read -r f; do
    case "$f" in *libwtmpdb*) continue ;; esac
    readelf -d "$f" 2>/dev/null | grep -c libwtmpdb >/dev/null && echo "  ${f#"$R"}"
done

echo "### pam modules referenced"
grep -rhoE 'pam_[a-z0-9_]+\.so' "$R"/etc/pam.d/ 2>/dev/null | sort -u | sed 's/^/  /'

echo "### random-seed binary imports (rename would break a file bind)"
readelf -W --dyn-syms "$R/usr/lib/systemd/systemd-random-seed" 2>/dev/null \
    | awk '$7=="UND"{print "  " $8}' | sort

echo "### absent daemons"
for x in cron crond anacron atd rsyslogd logrotate systemd-update-utmp systemd-coredump wtmpdb; do
    if find "$R" -name "$x" -type f 2>/dev/null | grep -c . >/dev/null; then echo "  PRESENT $x"; else echo "  absent  $x"; fi
done
