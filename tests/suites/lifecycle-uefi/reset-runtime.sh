#!/bin/sh
# Run from a signed full-root fixture after production service startup.
set -eu
exec >/dev/console 2>&1
fail() {
    echo "FILE_AB_RESET_FAIL: $*"
    journalctl --no-pager -b -u micad -u mica-health -n 100
    systemctl poweroff --force
    exit 1
}
bus() { busctl --system call com.mica.micad /com/mica/micad com.mica.micad1 "$@"; }
tier=$(cat /usr/lib/mica/reset-test-tier)
proof=/var/lib/mica/reset-proof
booted=$(mica-deploy booted)
confirmed=0
for n in $(seq 1 90); do
    if mica-deploy status | grep -F "\"current\":\"$booted\"" >/dev/null; then confirmed=1; break; fi
    sleep 1
done
[ "$confirmed" = 1 ] || fail 'health confirmation'
if [ ! -e "$proof/staged" ]; then
    mkdir -m 0700 "$proof"
    cat /etc/machine-id > "$proof/machine-id"
    bus GetSettings s provisioning.deviceId > "$proof/device-id"
    printf '%s\n' "$booted" > "$proof/deployment-id"
    mkdir -p /srv/reset-content
    printf 'preserved or removed by the selected tier\n' > /srv/reset-content/file
    printf 'application\n' > /mica/apps/reset-content
    printf 'container\n' > /mica/containers/reset-content
    printf 'custom UI\n' > /mica/ui/reset-content
    printf 'unmodeled configuration\n' > /mica/config/reset-content
    printf 'application enrollment\n' > /mnt/data/state/systemd-units/reset-content
    bus SetSettings ss hostname '"reset-proof"'
    bus SetSettings ss reset "{\"tier\":\"$tier\",\"requested\":1}"
    touch "$proof/staged" "$proof/armed"
    sync
    echo "FILE_AB_RESET_STAGED: $tier"
else
    [ -s "$proof/fired" ] || fail 'reset interruption was not observed'
    cmp /etc/machine-id "$proof/machine-id" || fail 'machine identity changed'
    bus GetSettings s provisioning.deviceId > /run/reset-device-id
    cmp /run/reset-device-id "$proof/device-id" || fail 'device identity changed'
    [ "$booted" = "$(cat "$proof/deployment-id")" ] || fail 'deployment changed'
    if bus GetSettings s reset > /run/reset-intent 2>&1; then
        fail 'reset intent was not cleared'
    fi
    grep -F 'settings path not found: `reset`' /run/reset-intent >/dev/null || fail 'reset status unavailable'
    case "$tier" in
        configuration)
            [ -f /srv/reset-content/file ] && [ -f /mica/apps/reset-content ] && [ -f /mica/containers/reset-content ] || fail 'configuration reset removed application data'
            [ -f /mnt/data/state/systemd-units/reset-content ] || fail 'configuration reset removed enrollment'
            [ ! -e /mica/config/reset-content ] || fail 'configuration not cleared'
            [ "$(hostname)" != reset-proof ] || fail 'hostname not reseeded'
            ;;
        application-data|full-factory)
            [ ! -e /srv/reset-content ] && [ ! -e /mica/apps/reset-content ] && [ ! -e /mica/containers/reset-content ] || fail 'application data not cleared'
            [ ! -e /mnt/data/state/systemd-units/reset-content ] || fail 'enrollment not cleared'
            if [ "$tier" = application-data ]; then
                [ -f /mica/ui/reset-content ] && [ -f /mica/config/reset-content ] || fail 'application reset removed unrelated data'
                [ "$(hostname)" = reset-proof ] || fail 'application reset changed hostname'
            else
                [ ! -e /mica/ui/reset-content ] && [ ! -e /mica/config/reset-content ] || fail 'factory namespaces not reseeded'
                [ "$(hostname)" != reset-proof ] || fail 'factory hostname not reseeded'
            fi
            ;;
        *) fail 'unknown reset tier';;
    esac
    for path in /mnt/data /mica /mica/containers /srv /var /var/lib/mica; do
        findmnt -rn -M "$path" || fail "missing reset mount $path"
    done
    [ "$(stat -c %a /mnt/data/state/mica)" = 711 ] || fail 'state parent mode changed'
    [ "$(stat -c %a /var/lib/mica/apid)" = 700 ] || fail 'private state mode changed'
    [ -s /var/lib/mica/apid/identity.pem ] || fail 'TLS identity lost'
    repquota -P -n /mnt/data || fail 'quotas lost'
    mica-deploy firmware-readback | grep -F '"readbackVerified":true' || fail 'firmware changed'
    echo "FILE_AB_RESET_RETRY_PASS: $tier"
fi
systemctl --no-block poweroff
