#!/usr/bin/env bash
# The Compute Engine-like suite over a built uefi-x64.gcp: its gce import artefact booted the way an instance
# boots it (gce-boot.sh), then the disk grown as a persistent disk is grown.
#
#   bash tests/suites/lifecycle-uefi/gce.sh <product>
#
#   1. first boot on a 20 GB disk: DATA grows to the disk; after boot ssh-keys appear in the metadata and their
#      users log in (alice and bob), sudo -n works for them, root and mica keys there are refused; the link MTU
#      is 1460, timesyncd is on 169.254.169.254; claiming without the device code or with a wrong one is refused,
#      and the code is readable after the login
#   2. the disk enlarged to 30 GB: the next boot grows DATA again
#   3. the disk enlarged to 40 GB and the power cut once repart has grown the partition, before the filesystem
#      grows; then to 50 GB and the power cut while the filesystem is resized: each boot after grows DATA to the
#      end with a clean filesystem
#
# The disk is disk.raw out of _out/products/<product>/kinds/*.gce.tar, the bytes Compute Engine imports; the
# firmware enrols the build's boot certificate (MICA_SIGNING_OUTPUT, default meta/) as PK, KEK and db. The
# login and claim checks need the metadata agent and the random device code in the image; until both are,
# GCE_REQUIRE_LOGIN=0 reports them as pending instead of failing. Evidence: _out/gce-suite.*/, the last line.
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
    docker run --rm -i --label ai-agent=true --network none --cap-add NET_ADMIN --device /dev/net/tun \
        -v "$evidence:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab "$@"
}
fail() { echo "error: $*; evidence $evidence" >&2; exit 1; }
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
[ "$(as alice sudo -n id -u 2>/dev/null)" = 0 ] && echo GCE_SUDO_PASS || echo GCE_SUDO_FAIL
for u in root mica; do as "$u" true 2>/dev/null && echo "GCE_RESERVED_FAIL: $u logged in with a metadata key" || echo "GCE_RESERVED_PASS: $u"; done
mtu=$(as alice 'cat /sys/class/net/$(ip -o route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | sed -n 1p)/mtu' 2>/dev/null)
[ "$mtu" = 1460 ] && echo GCE_MTU_PASS || echo "GCE_MTU_FAIL: $mtu"
ntp=$(as alice timedatectl show-timesync -p ServerName --value 2>/dev/null)
[ "$ntp" = 169.254.169.254 ] || [ "$ntp" = metadata.google.internal ] && echo "GCE_NTP_PASS: $ntp" || echo "GCE_NTP_FAIL: $ntp"
code=$(as alice "${GCE_CODE_COMMAND:-sudo -n micad device-code}" 2>/dev/null | tr -d '\r' | grep -oE '[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{3}' | sed -n 1p)
[ -n "$code" ] && echo "GCE_CODE_PASS: $code" || echo GCE_CODE_FAIL
# The console through the tunnel the docs show: a claim without the code and with a wrong one are refused.
ssh -i /w/keys/alice -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/w/known_hosts -N -L 18080:localhost:8080 "alice@$guest" &
tunnel=$!
sleep 3
python3 - "$code" <<'PY'
import json, ssl, sys, urllib.request, urllib.error
code = sys.argv[1]
def claim(body):
    for scheme in ('https', 'http'):
        try:
            r = urllib.request.urlopen(urllib.request.Request(f'{scheme}://localhost:18080/api/v1/claim', json.dumps(body).encode(),
                {'Content-Type': 'application/json'}), context=ssl._create_unverified_context() if scheme == 'https' else None, timeout=10)
            return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except Exception:
            continue
    return 0
wrong = 'ZZZZ-ZZZZ-ZZZ' if code != 'ZZZZ-ZZZZ-ZZZ' else '2222-2222-222'
results = {'none': claim({'password': 'gce-suite-claim-1'}), 'wrong': claim({'deviceCode': wrong, 'password': 'gce-suite-claim-1'})}
ok = all(400 <= s < 500 for s in results.values())
print(f'GCE_CLAIM_{"PASS" if ok else "FAIL"}: refused {results}')
PY
kill "$tunnel" 2>/dev/null || true
DURING
lab bash /harness/gce-boot.sh /w/disk.raw 600 first
cat "$evidence/first.events"
grep -a 'resized filesystem' "$evidence/first.serial" || fail "the first boot did not grow DATA (first.serial)"
grep -aq 'login:' "$evidence/first.serial" || fail "the first boot reached no login prompt (first.serial)"
cat "$evidence/first.during.log" 2>/dev/null || true
data_check first | tee -a "$evidence/results"
results=$(cat "$evidence/first.during.log" 2>/dev/null || true)
grep -q GCE_SSH_PORT_PASS <<<"$results" || fail "sshd did not answer on port 22"
if grep -q GCE_LOGIN_PENDING <<<"$results"; then
    [ "$require_login" = 0 ] || fail "no metadata user logged in (GCE_REQUIRE_LOGIN=0 reports it as pending)"
    echo "GCE_LOGIN_PENDING: no metadata login; the login, sudo, MTU, NTP, code and claim checks did not run"
elif grep -q '_FAIL' <<<"$results"; then fail "a check of the first boot failed"
fi

# 2. The disk enlarged after the first boot: the next boot grows DATA again.
truncate -s 30G "$evidence/disk.raw"
lab bash /harness/gce-boot.sh /w/disk.raw 400 resized
grep -a 'resized filesystem' "$evidence/resized.serial" || fail "the boot after the resize did not grow DATA (resized.serial)"
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
grep -q 'GCE_DATA_FAIL' "$evidence/results" && fail "DATA does not span the disk with a clean filesystem (results)"
grep -q GCE_LOGIN_PENDING <<<"$results" && echo "GCE_SUITE_PASS (login checks pending)" || echo GCE_SUITE_PASS
echo "$evidence"
