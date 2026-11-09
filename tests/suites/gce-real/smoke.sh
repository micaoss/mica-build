#!/usr/bin/env bash
# The real Compute Engine smoke of a uefi-x64.gcp image: one shielded instance, the checks, the instance deleted.
#
#   smoke.sh <image> [<image project>]
#
# gcloud must be authenticated with a project set (the publish workflow's auth step, or activate-service-account
# by hand). GCE_ZONE (default europe-west4-a), GCE_MACHINE (default e2-small), GCE_SMOKE_NAME (default
# mica-gce-smoke-<epoch>; it must start with mica-gce-smoke-) and GCE_SMOKE_OUT (the evidence directory, default
# a new temporary one) adjust the run. The instance has no service account, so the caller needs no actAs.
#
# PASS needs every one of, in this order:
#   BOOT          a login prompt on the serial port;
#   INTEGRITY     earlyBootReportEvent and lateBootReportEvent with policyEvaluationPassed=True (Shielded VM
#                 integrity monitoring; lateBoot needs IMA's PCR 10);
#   HOSTKEYS      with enable-guest-attributes=TRUE the agent publishes ssh-ed25519 and ssh-rsa under hostkeys/;
#   PIN_LOGIN     the first login is `gcloud compute ssh --strict-host-key-checking=yes` from an empty known_hosts:
#                 gcloud pins the published keys, so a metadata ssh-keys user logs in without trust-on-first-use,
#                 and `sudo -n` works for it;
#   SSH_RSA       a login with HostKeyAlgorithms=rsa-sha2-256 (what the console's SSH-in-browser offers) against
#                 the pinned key;
#   POWEROFF      after `instances stop`, 'reboot: Power down' in Cloud Logging's serial_port_1_output with no
#                 MICA_SHUTDOWN stage=failed and no softdog line; stage=forced-action is FORCED, which fails.
# Every gcloud call goes through g(): a refused or failed call is written verbatim and ends the checks. The
# instance is deleted whatever happened. The last line is GCE_SMOKE_PASS or GCE_SMOKE_FAIL; the status follows it.
set -u
[ $# -ge 1 ] && [ $# -le 2 ] || { sed -n '4p' "$0" | sed 's/^# *//' >&2; exit 2; }
IMAGE=$1 IMAGE_PROJECT=${2:-}
ZONE=${GCE_ZONE:-europe-west4-a}
MACHINE=${GCE_MACHINE:-e2-small}
N=${GCE_SMOKE_NAME:-mica-gce-smoke-$(date +%s)}
OUT=${GCE_SMOKE_OUT:-$(mktemp -d)}
USERNAME=micasmoke
case $N in mica-gce-smoke-*) ;; *) echo "error: the smoke instance's name must start with mica-gce-smoke-: $N" >&2; exit 2 ;; esac
for tool in gcloud ssh ssh-keygen; do command -v "$tool" >/dev/null || { echo "error: $tool is not installed" >&2; exit 2; }; done
# gcloud's own configuration stays where it is when HOME moves for the ssh checks below.
export CLOUDSDK_CONFIG=${CLOUDSDK_CONFIG:-$(gcloud info --format='value(config.paths.global_config_dir)' 2>/dev/null)}
PY=$(command -v python3 || echo /usr/lib/google-cloud-sdk/platform/bundledpythonunix/bin/python3)
PROJECT=$(gcloud config get-value core/project 2>/dev/null)
[ -n "$PROJECT" ] || { echo "error: gcloud has no project (gcloud config set core/project ...)" >&2; exit 2; }
[ -n "$IMAGE_PROJECT" ] || IMAGE_PROJECT=$PROJECT
mkdir -p "$OUT"
R=$OUT/results.txt
: >"$R"
log() { echo "$(date -u +%FT%TZ) $*" >>"$OUT/smoke.log"; }
res() { echo "$*" | tee -a "$R"; }
failed=
fail() { res "$*"; failed=1; }

g() {  # g <gcloud args...>: stdout to the caller; a failure written verbatim, and the run ends
    if gcloud "$@" 2>"$OUT/last.err"; then return 0; fi
    log "REFUSED/FAILED: gcloud $*"; cat "$OUT/last.err" >>"$OUT/smoke.log"
    fail "GCLOUD_FAIL: gcloud $*"; sed 's/^/    /' "$OUT/last.err" | tee -a "$R"
    return 1
}
created= t_create=
finish() {
    if [ -n "$created" ]; then
        if gcloud compute instances delete "$N" --zone "$ZONE" --quiet >>"$OUT/smoke.log" 2>&1; then
            res "DELETED: $N after $(( ($(date +%s) - t_create) / 60 )) min"
        else
            fail "DELETE_FAIL: $N is still there (gcloud compute instances delete $N --zone $ZONE)"
        fi
    fi
    if [ -z "$failed" ]; then res GCE_SMOKE_PASS; exit 0; fi
    res GCE_SMOKE_FAIL; exit 1
}
trap finish EXIT
trap 'failed=1; exit 1' INT TERM

log "smoke $IMAGE ($IMAGE_PROJECT) as $N in $PROJECT/$ZONE"
g compute instances create "$N" --zone "$ZONE" --machine-type "$MACHINE" --network-interface nic-type=VIRTIO_NET \
    --image "$IMAGE" --image-project "$IMAGE_PROJECT" --boot-disk-size 20GB --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata enable-oslogin=FALSE,block-project-ssh-keys=TRUE,serial-port-logging-enable=TRUE,enable-guest-attributes=TRUE \
    --labels mica-smoke=true >>"$OUT/smoke.log" || exit 1
created=1 t_create=$(date +%s)
ID=$(g compute instances describe "$N" --zone "$ZONE" --format='value(id)') || exit 1
IP=$(g compute instances describe "$N" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)') || exit 1

# BOOT
booted=
for _ in $(seq 1 42); do
    g compute instances get-serial-port-output "$N" --zone "$ZONE" >"$OUT/serial.txt" || exit 1
    grep -a 'login:' "$OUT/serial.txt" >/dev/null && { booted=1; break; }
    sleep 10
done
[ -n "$booted" ] || { fail "BOOT_FAIL: no login prompt in 7 min"; exit 1; }
res "BOOT_PASS: login prompt after $(( $(date +%s) - t_create )) s"

# INTEGRITY
integrity() {
    g logging read "resource.type=\"gce_instance\" AND resource.labels.instance_id=\"$ID\" AND logName=\"projects/$PROJECT/logs/compute.googleapis.com%2Fshielded_vm_integrity\"" \
        --freshness 1h --order asc --format=json >"$OUT/integrity.json" || return 2
    "$PY" -I - "$OUT/integrity.json" <<'PY'
import json, sys
seen = {}
for e in json.load(open(sys.argv[1])):
    for kind, body in (e.get('jsonPayload') or {}).items():
        if kind in ('earlyBootReportEvent', 'lateBootReportEvent') and isinstance(body, dict):
            seen.setdefault(kind, []).append(body.get('policyEvaluationPassed'))
for kind in ('earlyBootReportEvent', 'lateBootReportEvent'):
    print(f"{kind} policyEvaluationPassed={seen.get(kind, ['absent'])}")
sys.exit(0 if all(seen.get(k) and all(v is True for v in seen[k]) for k in ('earlyBootReportEvent', 'lateBootReportEvent')) else 1)
PY
}
ok=
for _ in $(seq 1 18); do
    integrity >"$OUT/integrity.txt"; rc=$?
    [ "$rc" -eq 2 ] && exit 1
    [ "$rc" -eq 0 ] && { ok=1; break; }
    sleep 10
done
if [ -n "$ok" ]; then res "INTEGRITY_PASS: $(tr '\n' ' ' <"$OUT/integrity.txt")"
else fail "INTEGRITY_FAIL: $(tr '\n' ' ' <"$OUT/integrity.txt")"; fi

# HOSTKEYS
found=
for _ in $(seq 1 24); do
    if gcloud compute instances get-guest-attributes "$N" --zone "$ZONE" --query-path=hostkeys/ --format='value(key)' >"$OUT/hostkeys.txt" 2>"$OUT/last.err" &&
        grep -x ssh-ed25519 "$OUT/hostkeys.txt" >/dev/null && grep -x ssh-rsa "$OUT/hostkeys.txt" >/dev/null; then found=1; break; fi
    sleep 5   # 404 until the agent has published: a wait, not a refusal
done
[ -n "$found" ] || { fail "HOSTKEYS_FAIL: hostkeys/ has [$(tr '\n' ' ' <"$OUT/hostkeys.txt")] after 2 min: $(tr '\n' ' ' <"$OUT/last.err")"; exit 1; }
res "HOSTKEYS_PASS: hostkeys/ lists ssh-ed25519 and ssh-rsa"

# PIN_LOGIN: gcloud adds the user's key to the instance metadata; the agent needs a moment to create the user.
export HOME=${GCE_SMOKE_HOME:-$OUT/home}
mkdir -p "$HOME"
rm -f "$HOME/.ssh/google_compute_known_hosts"
who=
for _ in $(seq 1 18); do
    who=$(gcloud compute ssh "$USERNAME@$N" --zone "$ZONE" --strict-host-key-checking=yes --quiet \
        --command 'id -un; sudo -n true && echo sudo-ok' -- -o ConnectTimeout=10 </dev/null 2>"$OUT/pin.err" | tr -d '\r' | tr '\n' ' ')
    [ "$who" = "$USERNAME sudo-ok " ] && break
    sleep 10
done
if [ "$who" = "$USERNAME sudo-ok " ]; then res "PIN_LOGIN_PASS: $USERNAME (sudo -n) with strict host key checking from an empty known_hosts"
else fail "PIN_LOGIN_FAIL: got '$who': $(tail -n 3 "$OUT/pin.err" | tr '\n' ' ')"; exit 1; fi

# SSH_RSA, against the key gcloud pinned (google_compute_known_hosts names the host compute.<id>).
rsa=$(ssh -i "$HOME/.ssh/google_compute_engine" -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$HOME/.ssh/google_compute_known_hosts" -o HostKeyAlias="compute.$ID" \
    -o HostKeyAlgorithms=rsa-sha2-256 -o ConnectTimeout=10 -o LogLevel=ERROR "$USERNAME@$IP" id -un 2>&1 | tr -d '\r')
if [ "$rsa" = "$USERNAME" ]; then res "SSH_RSA_PASS: rsa-sha2-256 host key, the pinned one"
else fail "SSH_RSA_FAIL: $rsa"; fi

# POWEROFF
t_stop=$(date -u +%FT%TZ)
g compute instances stop "$N" --zone "$ZONE" >>"$OUT/smoke.log" || exit 1
for _ in $(seq 1 30); do
    g logging read "resource.type=\"gce_instance\" AND resource.labels.instance_id=\"$ID\" AND logName=\"projects/$PROJECT/logs/serialconsole.googleapis.com%2Fserial_port_1_output\" AND timestamp>=\"$t_stop\"" \
        --freshness 1h --order asc --limit 3000 --format='value(textPayload)' >"$OUT/poweroff.txt" || exit 1
    grep -a 'reboot: Power down' "$OUT/poweroff.txt" >/dev/null && break
    sleep 20
done
if ! grep -a 'reboot: Power down' "$OUT/poweroff.txt" >/dev/null; then fail "POWEROFF_FAIL: no 'reboot: Power down' in serial_port_1_output"
elif grep -a 'MICA_SHUTDOWN stage=forced-action' "$OUT/poweroff.txt" >/dev/null; then fail "POWEROFF_FORCED: stage=forced-action before 'reboot: Power down'"
elif grep -aE 'MICA_SHUTDOWN stage=failed|softdog: Initiating' "$OUT/poweroff.txt" >/dev/null; then fail "POWEROFF_FAIL: 'reboot: Power down' after a failure line"
else res "POWEROFF_PASS: 'reboot: Power down', no failed or forced stage"; fi
