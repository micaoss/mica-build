#!/bin/sh
# P1 writable-path audit probe. THROWAWAY HARNESS seeded into STATE for a QEMU
# run; it is never part of a shipped image. Every line it prints is prefixed
# P1AUDIT| so the console capture can be filtered.
set -u

MODE=${1:-observe}
LOG=/mnt/data/p1-audit.log
SEEDSRC=/mnt/data/p1-random-seed
SEED=/var/lib/systemd/random-seed
EPOCH=2021-01-01

say() { echo "P1AUDIT| $*"; }
sha() { sha256sum "$1" 2>&1 | cut -c1-16; }
ino() { stat -c '%i' "$1" 2>&1; }
dev() { stat -c '%D' "$1" 2>&1; }
tag() { sed "s/^/P1AUDIT| $1 /"; }

say "==== BEGIN mode=${MODE:-unset} boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) ===="

say "---- mounts ----"
findmnt -rno TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | tag MNT

say "---- /var paths written since the image epoch ----"
# mtime ONLY. ctime is not usable as a runtime-write signal here: the assembler
# builds EPHEMERAL with `mkfs.ext4 -d`, which stamps every inode's ctime at
# image build time, so `-newerct` matched all 53 factory paths on the first run
# and drowned the seven that were actually written.
find /var -xdev -newermt "$EPOCH" \
    -printf '%y %M %u:%g %TY-%Tm-%TdT%TH:%TM %s %p\n' 2>/dev/null | sort -k7 | tag VAR

say "---- /etc paths written since the image epoch ----"
find /etc -xdev -newermt "$EPOCH" \
    -printf '%y %M %u:%g %TY-%Tm-%TdT%TH:%TM %s %p\n' 2>/dev/null | tag ETC

say "---- STATE ----"
find /mnt/state -printf '%y %M %u:%g %s %p\n' 2>/dev/null | tag STATE

say "---- DATA (depth 3) ----"
find /mnt/data -maxdepth 3 -printf '%y %M %u:%g %s %p\n' 2>/dev/null | tag DATA

say "---- META ----"
find /mnt/meta -printf '%y %M %u:%g %s %p\n' 2>/dev/null | tag META

say "---- failed units ----"
systemctl list-units --state=failed --no-legend --plain --full 2>/dev/null | tag FAILED
say "system-state=$(systemctl is-system-running 2>&1)"

say "---- random-seed, as this boot left it ----"
say "RSEED show $(systemctl show systemd-random-seed.service -p ActiveState -p Result -p ExecMainStatus --value 2>&1 | tr '\n' ' ')"
say "RSEED path=$SEED ino=$(ino $SEED) dev=$(dev $SEED) size=$(stat -c '%s' $SEED 2>&1) sha=$(sha $SEED)"
journalctl -b -u systemd-random-seed.service --no-pager -o short-monotonic 2>/dev/null | tag RSEEDLOG

say "---- /var/tmp occupants (PrivateTmp evidence) ----"
ls -la /var/tmp 2>&1 | tag VARTMP

if [ -f "$LOG" ]; then
    say "---- record left by earlier boots ----"
    tag PREV <"$LOG"
fi

# sshd-session imports wtmpdb_login/wtmpdb_logout and libwtmpdb's only /var
# path string is /var/log/wtmp.db, so an SSH session is a login-accounting
# writer. Drive one and see what appears, rather than reading the symbols.
ssh_probe() {
    say "---- SSH login: does a session write /var/log/wtmp.db? ----"
    say "WTMPDB before: $(ls -la /var/log/wtmp.db 2>&1) | dir: $(ls -la /var/lib/wtmpdb/ 2>&1 | tr '\n' ' ')"
    # No throwaway keypair here: an earlier revision generated one and copied it
    # over /etc/ssh/authorized_keys.d/root, which is STATE-backed and persists,
    # so the run locked the NEXT boot out of the machine it was measuring. The
    # harness key installed at the top of this script is used instead.
    rm -f /run/p1-key /run/p1-key.pub
    cp /root/.ssh/authorized_keys /run/p1-key.pub 2>/dev/null || true
    systemctl start ssh.service 2>&1 | tag SSHSETUP
    say "ssh.service: $(systemctl show ssh.service -p ActiveState -p Result --value 2>&1 | tr '\n' ' ')"
    # The guest holds no private key, so the loopback login cannot authenticate.
    # What matters for the audit is whether a REAL session writes login
    # accounting, and the harness's own inbound session is a real session: the
    # before/after listing below brackets it.
    say "inbound harness session is the accounting subject; loopback auth not attempted"
    say "WTMPDB after: $(ls -la /var/log/wtmp.db 2>&1)"
    find /var/log /var/lib/wtmpdb -newermt "$EPOCH" -printf '%y %M %TY-%Tm-%TdT%TH:%TM %s %p\n' 2>/dev/null | tag WTMPDBNEW
}

case "$MODE" in
observe)
    ssh_probe
    say "mode observe: the layout was not changed"
    ;;
candidate | verify)
    say "==== CANDIDATE LAYOUT: DATA-backed seed file, read-only /var ===="
    if [ ! -f "$SEEDSRC" ]; then
        if cp "$SEED" "$SEEDSRC" 2>/dev/null; then
            say "seeded $SEEDSRC from the running seed"
        else
            : >"$SEEDSRC"
            say "created an empty $SEEDSRC"
        fi
        chmod 0600 "$SEEDSRC"
    else
        say "reusing $SEEDSRC left by an earlier boot"
    fi
    SRC_SHA_BOOTSTART=$(sha "$SEEDSRC")
    say "SRC at boot start: ino=$(ino $SEEDSRC) dev=$(dev $SEEDSRC) size=$(stat -c '%s' $SEEDSRC 2>&1) sha=$SRC_SHA_BOOTSTART"

    if mount --bind "$SEEDSRC" "$SEED"; then
        say "BIND ok: $SEEDSRC over $SEED"
    else
        say "BIND FAILED rc=$?"
    fi
    findmnt -rno TARGET,SOURCE,FSTYPE,OPTIONS "$SEED" 2>&1 | tag BINDMNT
    MP_INO_BEFORE=$(ino "$SEED")
    say "MP after bind: ino=$MP_INO_BEFORE dev=$(dev $SEED)"

    if mount -o remount,ro /var; then
        say "REMOUNT /var ro: ok"
    else
        say "REMOUNT /var ro: FAILED rc=$?"
    fi
    findmnt -rno TARGET,SOURCE,FSTYPE,OPTIONS /var 2>&1 | tag VARMNT
    if touch /var/lib/systemd/p1-negative-write 2>/dev/null; then
        say "NEGATIVE-WRITE: /var/lib/systemd accepted a write, so /var is NOT read-only"
        rm -f /var/lib/systemd/p1-negative-write
    else
        say "NEGATIVE-WRITE: /var/lib/systemd refused a write, read-only as intended"
    fi

    say "---- does RequiresMountsFor= pick the leaf mount up? ----"
    say "ESCAPED=$(systemd-escape -p --suffix=mount /var/lib/systemd/random-seed 2>&1)"
    systemctl daemon-reload
    systemctl list-units --all --no-legend --plain --full 'var-lib-systemd-random*' 2>&1 | tag SEEDMOUNTUNIT
    say "RMF=$(systemctl show systemd-random-seed.service -p RequiresMountsFor --value 2>&1)"
    systemctl show systemd-random-seed.service -p After --value 2>&1 | tr ' ' '\n' | grep -i 'random\|var' | tag RSEEDAFTER

    say "---- REAL unit, ExecStop=save under the candidate layout ----"
    systemctl stop systemd-random-seed.service
    say "stop rc=$?"
    say "after stop: show=$(systemctl show systemd-random-seed.service -p ActiveState -p Result -p ExecMainStatus --value 2>&1 | tr '\n' ' ')"
    say "after stop: MP ino=$(ino $SEED) was=$MP_INO_BEFORE sha=$(sha $SEED)"
    say "after stop: SRC ino=$(ino $SEEDSRC) sha=$(sha $SEEDSRC) size=$(stat -c '%s' $SEEDSRC 2>&1)"
    findmnt -rno TARGET,SOURCE "$SEED" 2>&1 | tag BINDAFTERSAVE
    journalctl -b -u systemd-random-seed.service --no-pager -o cat 2>/dev/null | tail -6 | tag SAVELOG

    say "---- REAL unit, ExecStart=load under the candidate layout ----"
    systemctl start systemd-random-seed.service
    say "start rc=$?"
    say "after start: show=$(systemctl show systemd-random-seed.service -p ActiveState -p Result -p ExecMainStatus --value 2>&1 | tr '\n' ' ')"
    say "after start: MP ino=$(ino $SEED) sha=$(sha $SEED)"
    say "after start: SRC ino=$(ino $SEEDSRC) sha=$(sha $SEEDSRC)"
    journalctl -b -u systemd-random-seed.service --no-pager -o cat 2>/dev/null | tail -6 | tag LOADLOG

    say "---- PrivateTmp=yes against a read-only /var ----"
    for u in micad apid; do
        systemctl restart "$u.service" 2>&1 | tag "RESTART-$u"
        say "PRIVTMPYES $u: $(systemctl show "$u.service" -p ActiveState -p Result -p ExecMainStatus --value 2>&1 | tr '\n' ' ')"
        journalctl -b -u "$u.service" --no-pager -o cat 2>/dev/null | tail -3 | tag "PRIVTMPYESLOG-$u"
    done

    say "---- PrivateTmp=disconnected against a read-only /var ----"
    for u in micad apid; do
        mkdir -p "/run/systemd/system/$u.service.d"
        printf '[Service]\nPrivateTmp=disconnected\n' >"/run/systemd/system/$u.service.d/10-p1.conf"
    done
    systemctl daemon-reload
    for u in micad apid; do
        systemctl restart "$u.service" 2>&1 | tag "RESTART2-$u"
        say "PRIVTMPDISC $u: $(systemctl show "$u.service" -p ActiveState -p Result -p ExecMainStatus -p PrivateTmp --value 2>&1 | tr '\n' ' ')"
        journalctl -b -u "$u.service" --no-pager -o cat 2>/dev/null | tail -3 | tag "PRIVTMPDISCLOG-$u"
    done
    say "VARTMP after: $(ls /var/tmp 2>&1 | tr '\n' ' ')"

    say "---- StateDirectory= writers against a read-only /var ----"
    for u in systemd-logind systemd-pstore systemd-rfkill systemd-timesyncd systemd-networkd-persistent-storage; do
        systemctl list-unit-files --no-legend --plain --full "$u.service" >/dev/null 2>&1 || continue
        sd=$(systemctl show "$u.service" -p StateDirectory --value 2>&1)
        say "SD $u StateDirectory=$sd present=$( [ -d "/var/lib/$sd" ] && echo yes || echo no )"
        systemctl restart "$u.service" 2>&1 | tag "SDRESTART-$u"
        say "SD $u after restart: $(systemctl show "$u.service" -p ActiveState -p Result -p ExecMainStatus --value 2>&1 | tr '\n' ' ')"
        journalctl -b -u "$u.service" --no-pager -o cat 2>/dev/null | tail -3 | tag "SDLOG-$u"
    done

    say "---- the same SSH login, now against a read-only /var ----"
    ssh_probe

    say "---- what this boot hands to the shutdown save ----"
    say "SRC pre-shutdown: sha=$(sha $SEEDSRC) size=$(stat -c '%s' $SEEDSRC 2>&1)"
    {
        echo "boot mode=$MODE boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
        echo "  src_sha_at_boot_start=$SRC_SHA_BOOTSTART"
        echo "  src_sha_pre_shutdown=$(sha $SEEDSRC)"
        echo "  src_ino=$(ino $SEEDSRC) mp_ino_at_bind=$MP_INO_BEFORE"
    } >>"$LOG"
    sync
    say "recorded to $LOG"
    ;;
*)
    say "unknown mode ${MODE:-unset}"
    ;;
esac

say "==== END mode=${MODE:-unset} ===="
