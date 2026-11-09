#!/usr/bin/env bash
# The Compute Engine-like suite over a built uefi-x64.gcp: its gce import artefact booted the way an instance
# boots it (gce-boot.sh), then the disk grown as a persistent disk is grown.
#
#   bash tests/suites/lifecycle-uefi/gce.sh <product>
#
#   1. first boot on a 20 GB disk: DATA grows to the disk; after boot ssh-keys appear in the metadata and their
#      users log in (alice and bob), also over an rsa-sha2-256 host key as the console's SSH-in-browser needs;
#      sudo -n works for them, root and mica keys there are refused; no sit0; the link MTU is 1460, timesyncd is on
#      169.254.169.254; IMA's boot_aggregate and the firmware event log are in securityfs (integrity monitoring's
#      late boot report); the device code is readable after the login (sudo micad
#      device-code) and on no serial output; claiming without it or with a wrong one is refused, without its seed on
#      DATA it fails closed, and with it the device is claimed; the owner's access.cloudAdmins off removes the
#      users' sudo and on gives it back
#      the image carries no podman and no MQTT service; with containers turned on, dockerd answers and runs a
#      local image (the root's static busybox, imported)
#   2. the disk enlarged to 30 GB: the next boot grows DATA again
#   3. the disk enlarged to 40 GB and the power cut once repart has grown the partition, before the filesystem
#      grows; then to 50 GB and the power cut while the filesystem is resized: each boot after grows DATA to the
#      end with a clean filesystem
#   4. the disk enlarged to 2 TiB and the power cut GCE_CUT_DELAY (0.7 s) into the resize, when part of the grow is
#      committed to the journal: the boot after replays it in a mount of its own (the runkit's line) and grows
#      DATA to the end with a clean filesystem
#
# The disk is disk.raw out of _out/products/<product>/kinds/*.gce.tar, the bytes Compute Engine imports; the
# firmware enrols the build's boot certificate (MICA_SIGNING_OUTPUT, default meta/) as PK, KEK and db. The
# login and claim checks need the metadata agent and the random device code in the image; until both are,
# GCE_REQUIRE_LOGIN=0 reports them as pending instead of failing. GCE_DISK=scsi puts the boot disk on virtio-scsi,
# as on E2/N2 machines, instead of NVMe, GCE_DISK_BPS throttles it and GCE_SERIAL_BPS the serial console
# (gce-boot.sh). The first boot and the one after the resize end with a clean poweroff. Evidence: _out/gce-suite.*/, the last line.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
product=${1:?product name required}
require_login=${GCE_REQUIRE_LOGIN:-1}
out="_out/products/$product"
tars=("$out"/kinds/mica-"$product"-*.gce.tar)
[ -f "${tars[0]}" ] && [ ${#tars[@]} -eq 1 ] || { echo "error: $out/kinds holds no single gce image kind (bun src/cli.ts product-build $product)" >&2; exit 1; }
cert="${MICA_SIGNING_OUTPUT:-$PWD/meta}/boot/signer.cert.pem"
[ -s "$cert" ] || { echo "error: $cert does not exist; the firmware enrols the boot certificate the image is signed with" >&2; exit 1; }
bash tests/suites/signed-boot-lab/images.sh --lifecycle >/dev/null

evidence=$(mktemp -d "$PWD/_out/gce-suite.XXXXXX")
cp "$cert" "$evidence/db.cert.pem"
mkdir -p "$evidence/metadata/instance/attributes" "$evidence/metadata/project/attributes" "$evidence/keys"
printf 'mica-gce-test' >"$evidence/metadata/instance/hostname"
printf 'mica-gce-test.europe-west4-a.c.mica-test.internal' >"$evidence/metadata/instance/name"
printf '' >"$evidence/metadata/instance/attributes/ssh-keys"
printf '' >"$evidence/metadata/project/attributes/ssh-keys"
lab() {  # lab <command...>: the lab image, the evidence at /w, a network namespace of its own with a tap device
    docker run --rm -i --label ai-agent=true --network none --cap-add NET_ADMIN --device /dev/net/tun -e GCE_DISK -e GCE_DISK_BPS -e GCE_SERIAL_BPS \
        -v "$evidence:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab "$@"
}
fail() { echo "error: $*; evidence $evidence" >&2; exit 1; }
# A boot the harness ended with an ACPI power button press, as `gcloud compute instances stop` does: the guest
# released its storage and powered off, and no watchdog reset it instead.
poweroff_check() {  # poweroff_check <name>
    local s="$evidence/$1.serial"
    if grep -aq 'reboot: Power down' "$s" && ! grep -aqE 'MICA_SHUTDOWN stage=failed|softdog: Initiating' "$s"; then
        echo "GCE_POWEROFF_PASS[$1]" | tee -a "$evidence/results"
    else
        grep -aE 'MICA_SHUTDOWN stage=(empty-observation|storage-not-released|storage-released|failed)|systemd-shutdown|softdog|reboot:' "$s" | tail -15 >&2
        fail "the $1 boot did not power off cleanly ($1.serial)"
    fi
}
gib=$((1024 * 1024 * 1024))

echo "== the import artefact: disk.raw of $(basename "${tars[0]}") =="
tar -xSf "${tars[0]}" -C "$evidence"
[ -f "$evidence/disk.raw" ] || fail "the gce tar holds no disk.raw"
[ $(( $(stat -c %s "$evidence/disk.raw") % gib )) -eq 0 ] || fail "disk.raw is not a whole GiB"

# DATA's size and state, read off the disk between boots: the partition the GPT ends at the disk's end, and the
# ext4 superblock of partition 3 (its block count covers the partition, its state is clean).
data_check() {  # data_check <phase>
    lab python3 - "$1" <<'PY'
import struct, sys
phase = sys.argv[1]
with open('/w/disk.raw', 'rb') as f:
    f.seek(0, 2); size = f.tell()
    f.seek(512); h = f.read(92)
    backup, last = struct.unpack_from('<Q', h, 32)[0], struct.unpack_from('<Q', h, 48)[0]
    f.seek(2 * 512 + 2 * 128); e = f.read(128)
    start, end = struct.unpack_from('<QQ', e, 32)
    f.seek(start * 512 + 1024); sb = f.read(1024)
blocks = struct.unpack_from('<I', sb, 4)[0] | struct.unpack_from('<I', sb, 0x150)[0] << 32
block = 1024 << struct.unpack_from('<I', sb, 24)[0]
state = struct.unpack_from('<H', sb, 0x3A)[0]
part = (end - start + 1) * 512
print(f'GCE_DATA[{phase}]: disk {size} partition 3 {part} bytes ext4 {blocks * block} bytes state {state} backup GPT at {backup}')
ok = backup == size // 512 - 1 and last == size // 512 - 34 and end >= last - 2048 and blocks * block > part - 4 * 1048576 and state & 1
print(f'GCE_DATA_{"PASS" if ok else "FAIL"}[{phase}]')
PY
}

# 1. The first boot on a 20 GB disk, and the logins of the metadata's ssh-keys.
truncate -s 20G "$evidence/disk.raw"
cat >"$evidence/first.during.sh" <<'DURING'
set -u
guest=10.128.0.2
for _ in $(seq 1 120); do (exec 3<>/dev/tcp/$guest/22) 2>/dev/null && break; sleep 1; done
(exec 3<>/dev/tcp/$guest/22) 2>/dev/null && echo GCE_SSH_PORT_PASS || { echo GCE_SSH_PORT_FAIL; exit 1; }
for u in alice bob root mica; do ssh-keygen -q -t ed25519 -N '' -C "$u" -f "/w/keys/$u"; done
# After boot, as Compute Engine adds them: instance keys and a project key, the console button's ephemeral form.
{
    printf 'alice:%s\n' "$(cat /w/keys/alice.pub)"
    printf 'root:%s\n' "$(cat /w/keys/root.pub)"
    printf 'mica:%s\n' "$(cat /w/keys/mica.pub)"
} >/w/metadata/instance/attributes/ssh-keys
printf 'bob:%s google-ssh {"userName":"bob@example.com","expireOn":"2099-01-01T00:00:00+0000"}\n' "$(cut -d' ' -f1,2 /w/keys/bob.pub)" \
    >/w/metadata/project/attributes/ssh-keys
as() { local u=$1; shift; ssh -i "/w/keys/$u" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/w/known_hosts -o ConnectTimeout=5 "$u@$guest" "$@"; }
login=
for _ in $(seq 1 90); do [ "$(as alice id -un 2>/dev/null)" = alice ] && { login=1; break; }; sleep 2; done
if [ -z "$login" ]; then echo GCE_LOGIN_PENDING; exit 0; fi
echo GCE_LOGIN_PASS: alice
[ "$(as bob id -un 2>/dev/null)" = bob ] && echo GCE_LOGIN_PASS: bob || echo GCE_LOGIN_FAIL: bob
# The console's SSH-in-browser accepts only rsa-sha2-256 and ssh-rsa host keys.
rsa=$(ssh -i /w/keys/alice -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/w/known_hosts.rsa \
    -o HostKeyAlgorithms=rsa-sha2-256 -o ConnectTimeout=5 "alice@$guest" id -un 2>&1 | tr -d '\r' | tail -n 1)
[ "$rsa" = alice ] && echo "GCE_SSH_RSA_PASS: $(ssh-keygen -lf /w/known_hosts.rsa | awk '{print $1, $NF}')" ||
    echo "GCE_SSH_RSA_FAIL: $rsa"
[ "$(as alice sudo -n id -u 2>/dev/null)" = 0 ] && echo GCE_SUDO_PASS || echo GCE_SUDO_FAIL
for u in root mica; do as "$u" true 2>/dev/null && echo "GCE_RESERVED_FAIL: $u logged in with a metadata key" || echo "GCE_RESERVED_PASS: $u"; done
mtu=$(as alice 'cat /sys/class/net/$(ip -o route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | sed -n 1p)/mtu' 2>/dev/null)
[ "$mtu" = 1460 ] && echo GCE_MTU_PASS || echo "GCE_MTU_FAIL: $mtu"
links=$(as alice 'ip -o link show' 2>/dev/null | awk -F': ' '{print $2}' | tr '\n' ' ')
case " $links" in *" sit0"*) echo "GCE_NO_SIT_FAIL: $links" ;; *) echo "GCE_NO_SIT_PASS: $links" ;; esac
ntp=$(as alice timedatectl show-timesync -p ServerName --value 2>/dev/null)
[ "$ntp" = 169.254.169.254 ] || [ "$ntp" = metadata.google.internal ] && echo "GCE_NTP_PASS: $ntp" || echo "GCE_NTP_FAIL: $ntp"
# Measured boot as integrity monitoring needs it: IMA's boot_aggregate in PCR 10, the firmware's event log readable.
ima=$(as alice 'sudo -n head -n1 /sys/kernel/security/ima/ascii_runtime_measurements' 2>/dev/null | tr -d '\r')
bios=$(as alice "sudo -n sh -c 'wc -c </sys/kernel/security/tpm0/binary_bios_measurements'" 2>/dev/null | tr -d '\r')
case "$ima" in *boot_aggregate*) [ "${bios:-0}" -gt 0 ] && ok=PASS || ok=FAIL ;; *) ok=FAIL ;; esac
echo "GCE_IMA_$ok: '$ima', event log ${bios:-none} bytes"
code=$(as alice "${GCE_CODE_COMMAND:-sudo -n micad device-code}" 2>/dev/null | tr -d '\r' | grep -oE '[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{3}' | sed -n 1p)
[ -n "$code" ] && echo "GCE_CODE_PASS: $code" || echo GCE_CODE_FAIL
# The console through the tunnel the docs show (apid's HTTP on 8080): the claim without the code is refused (422),
# with the seed of the code gone from DATA it fails closed (503), with a wrong code it is refused (403), and with the
# code it claims the device (201).
ssh -i /w/keys/alice -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/w/known_hosts -N -L 18080:localhost:8080 "alice@$guest" &
tunnel=$!
sleep 3
claim() {  # claim <code or ''>: the status of POST /api/v1/setup, waiting out the login backoff (429)
    python3 - "$1" <<'PY'
import json, sys, time, urllib.request, urllib.error
body = {'password': 'gce-suite-claim-1'}
if sys.argv[1]:
    body['deviceCode'] = sys.argv[1]
for _ in range(6):
    try:
        r = urllib.request.urlopen(urllib.request.Request('http://localhost:18080/api/v1/setup', json.dumps(body).encode(),
            {'Content-Type': 'application/json'}), timeout=10)
        status = r.status
        if status == 201:
            cookie = r.headers.get('Set-Cookie', '').split(';')[0]
            json.dump({'cookie': cookie, 'csrf': json.load(r).get('csrfToken', '')}, open('/w/session.json', 'w'))
    except urllib.error.HTTPError as e:
        status = e.code
        if status == 429:
            time.sleep(min(int(e.headers.get('Retry-After') or 5), 60))
            continue
    except Exception:
        status = 0
    break
print(status)
PY
}
seed=/mnt/data/meta/device-code
none=$(claim '')
as alice sudo -n mv "$seed" "$seed.suite" 2>/dev/null
unavailable=$(claim "$code")
as alice sudo -n mv "$seed.suite" "$seed" 2>/dev/null
wrong=$(claim "$([ "$code" != ZZZZ-ZZZZ-ZZZ ] && echo ZZZZ-ZZZZ-ZZZ || echo 2222-2222-222)")
right=$(claim "$code")
[ "$none" = 422 ] && [ "$unavailable" = 503 ] && [ "$wrong" = 403 ] && [ "$right" = 201 ] && verdict=PASS || verdict=FAIL
echo "GCE_CLAIM_$verdict: no code $none, no seed $unavailable, wrong code $wrong, the code $right"
# The owner's switch: access.cloudAdmins off removes the metadata users' sudo, on gives it back.
admins() {  # admins true|false: the status of the owner's PUT of access.cloudAdmins.enabled
    python3 - "$1" <<'PY'
import json, sys, urllib.request, urllib.error
s = json.load(open('/w/session.json'))
try:
    r = urllib.request.urlopen(urllib.request.Request('http://localhost:18080/api/v1/settings/access.cloudAdmins.enabled', sys.argv[1].encode(),
        {'Content-Type': 'application/json', 'Cookie': s['cookie'], 'X-CSRF-Token': s['csrf']}, method='PUT'), timeout=10)
    print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)
PY
}
sudo_after() {  # sudo_after yes|no: whether alice's sudo -n id -u settles to 0 (yes) or fails (no) within 30 s
    for _ in $(seq 1 15); do
        r=$(as alice sudo -n id -u 2>/dev/null)
        { [ "$1" = yes ] && [ "$r" = 0 ]; } || { [ "$1" = no ] && [ "$r" != 0 ]; } && { echo "$1"; return; }
        sleep 2
    done
    echo unsettled
}
if [ -s /w/session.json ]; then
    off=$(admins false); off_sudo=$(sudo_after no); off_flag=$(as alice cat /run/mica/cloud-admins 2>/dev/null)
    on=$(admins true); on_sudo=$(sudo_after yes); on_flag=$(as alice cat /run/mica/cloud-admins 2>/dev/null)
    [ "$off" = 202 ] && [ "$off_sudo" = no ] && [ "$off_flag" = off ] && [ "$on" = 202 ] && [ "$on_sudo" = yes ] && [ "$on_flag" = on ] &&
        verdict=PASS || verdict=FAIL
    echo "GCE_ADMINS_SWITCH_$verdict: off $off (sudo removed: $off_sudo, cloud-admins $off_flag), on $on (sudo back: $on_sudo, cloud-admins $on_flag)"
else
    echo "GCE_ADMINS_SWITCH_FAIL: no owner session (the claim did not succeed)"
fi
# The container engine is docker, and no podman and no MQTT service is in the image. The owner turns containers on
# (container.enabled); dockerd answers, and a local image (the root's static busybox, imported) runs.
leftovers=$(as alice 'ls /usr/bin/podman /usr/bin/mica-containerd /usr/bin/mica-mqttd /usr/bin/mica-mqtt-broker 2>/dev/null' | tr '\n' ' ')
[ -z "$leftovers" ] && echo "GCE_NO_PODMAN_MQTT_PASS" || echo "GCE_NO_PODMAN_MQTT_FAIL: $leftovers"
if [ -s /w/session.json ]; then
    enabled=$(python3 - <<'PY'
import json, urllib.request, urllib.error
s = json.load(open('/w/session.json'))
try:
    r = urllib.request.urlopen(urllib.request.Request('http://localhost:18080/api/v1/settings/container.enabled', b'true',
        {'Content-Type': 'application/json', 'Cookie': s['cookie'], 'X-CSRF-Token': s['csrf']}, method='PUT'), timeout=10)
    print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)
PY
)
    info=
    # docker info prints its format (blank server fields) and fails while dockerd is not up: its status decides.
    for _ in $(seq 1 60); do
        info=$(as alice "sudo -n docker info --format '{{.ServerVersion}} {{.Driver}}'" 2>/dev/null) && break
        info=; sleep 2
    done
    info=$(printf '%s' "$info" | tr -d '\r')
    hello=$(as alice 'sudo -n sh -c "d=\$(mktemp -d) && mkdir -p \$d/bin && cp /usr/bin/busybox \$d/bin/busybox && tar -C \$d -c . | docker import - mica-smoke:1 >/dev/null && docker run --rm --network none mica-smoke:1 /bin/busybox echo hello-from-docker; docker rmi -f mica-smoke:1 >/dev/null; rm -rf \$d"' 2>&1 | tr -d '\r' | sed -n 1p)
    [ "$enabled" = 202 ] && [ -n "$info" ] && [ "$hello" = hello-from-docker ] && verdict=PASS || verdict=FAIL
    echo "GCE_DOCKER_$verdict: container.enabled $enabled, docker info '$info', run '$hello'"
else
    echo "GCE_DOCKER_FAIL: no owner session (the claim did not succeed)"
fi
kill "$tunnel" 2>/dev/null || true
DURING
lab bash /harness/gce-boot.sh /w/disk.raw 600 first
cat "$evidence/first.events"
grep -a 'resized filesystem' "$evidence/first.serial" || fail "the first boot did not grow DATA (first.serial)"
grep -aq 'login:' "$evidence/first.serial" || fail "the first boot reached no login prompt (first.serial)"
poweroff_check first
cat "$evidence/first.during.log" 2>/dev/null || true
data_check first | tee -a "$evidence/results"
results=$(cat "$evidence/first.during.log" 2>/dev/null || true)
grep -q GCE_SSH_PORT_PASS <<<"$results" || fail "sshd did not answer on port 22"
if grep -q GCE_LOGIN_PENDING <<<"$results"; then
    [ "$require_login" = 0 ] || fail "no metadata user logged in (GCE_REQUIRE_LOGIN=0 reports it as pending)"
    echo "GCE_LOGIN_PENDING: no metadata login; the login, sudo, MTU, NTP, code and claim checks did not run"
elif grep -q '_FAIL' <<<"$results"; then fail "a check of the first boot failed"
fi
# The code drawn on the device is on no console Compute Engine copies to its serial output.
code=$(sed -n 's/^GCE_CODE_PASS: //p' <<<"$results")
if [ -n "$code" ]; then
    grep -aqF "$code" "$evidence/first.serial" && fail "the device code $code is on the serial console (first.serial)"
    echo "GCE_CODE_SERIAL_PASS: $code is not on the serial console" | tee -a "$evidence/results"
fi
grep -aq 'sudo micad device-code' "$evidence/first.serial" || fail "the login prompt does not say to run sudo micad device-code (first.serial)"

# 2. The disk enlarged after the first boot: the next boot grows DATA again.
truncate -s 30G "$evidence/disk.raw"
lab bash /harness/gce-boot.sh /w/disk.raw 400 resized
grep -a 'resized filesystem' "$evidence/resized.serial" || fail "the boot after the resize did not grow DATA (resized.serial)"
poweroff_check resized
data_check resized | tee -a "$evidence/results"

# 3. The power cut between the partition's growth and the filesystem's, then during the filesystem's, and the
# boot after each.
truncate -s 40G "$evidence/disk.raw"
lab bash /harness/gce-boot.sh /w/disk.raw 400 cut-repart cut-repart
grep -q 'power cut after repart' "$evidence/cut-repart.events" || fail "the power was not cut after repart (cut-repart.events)"
lab bash /harness/gce-boot.sh /w/disk.raw 400 after-cut-repart
grep -aq 'login:' "$evidence/after-cut-repart.serial" || fail "the boot after the power cut reached no login prompt (after-cut-repart.serial)"
data_check after-cut-repart | tee -a "$evidence/results"
truncate -s 50G "$evidence/disk.raw"
lab bash /harness/gce-boot.sh /w/disk.raw 900 cut-resize cut-resize
grep -q 'power cut while DATA is resized (resize unfinished)' "$evidence/cut-resize.events" ||
    fail "the power was not cut while the filesystem was being resized ($(cat "$evidence/cut-resize.events"))"
lab bash /harness/gce-boot.sh /w/disk.raw 400 after-cut-resize
grep -aq 'login:' "$evidence/after-cut-resize.serial" || fail "the boot after the power cut reached no login prompt (after-cut-resize.serial)"
data_check after-cut-resize | tee -a "$evidence/results"

# 4. The power cut late in a large grow, part of it committed to the journal; the boot after completes it. The
# superblock read between the two boots shows how far the grow had got.
truncate -s 2T "$evidence/disk.raw"
lab env GCE_CUT_DELAY="${GCE_CUT_DELAY:-0.7}" bash /harness/gce-boot.sh /w/disk.raw 900 cut-late cut-late
grep -q 'into the DATA resize (resize unfinished)' "$evidence/cut-late.events" ||
    fail "the power was not cut during the large resize ($(cat "$evidence/cut-late.events"))"
data_check cut-late | sed 's/GCE_DATA_\(PASS\|FAIL\)/GCE_DATA_CUT/' | tee "$evidence/cut-late.data"
lab bash /harness/gce-boot.sh /w/disk.raw 900 after-cut-late
grep -aq 'login:' "$evidence/after-cut-late.serial" || fail "the boot after the late power cut reached no login prompt (after-cut-late.serial)"
grep -a 'journal replayed in a mount of its own' "$evidence/after-cut-late.serial" ||
    fail "the boot after the late power cut did not replay DATA's journal in a mount of its own (after-cut-late.serial)"
grep -aiE 'resize\.c|kernel BUG|EXT4-fs error' "$evidence/after-cut-late.serial" && fail "the boot after the late power cut hit an ext4 error (after-cut-late.serial)"
data_check after-cut-late | tee -a "$evidence/results"
grep -q 'GCE_DATA_FAIL' "$evidence/results" && fail "DATA does not span the disk with a clean filesystem (results)"
grep -q GCE_LOGIN_PENDING <<<"$results" && echo "GCE_SUITE_PASS (login checks pending)" || echo GCE_SUITE_PASS
echo "$evidence"
