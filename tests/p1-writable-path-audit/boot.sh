#!/usr/bin/env bash
# One x64 QEMU boot with a way in, and the P1-B probe run over it.
#
#   bash qemu-boot.sh <label> <mode>
#
# THE WAY IN IS THE PRODUCT'S OWN: micad owns SSH access. A oneshot unit seeded
# into DATA/state (build/src/seed-data.ts, enabled through
# mica-load-extensions, as the API harness seeds its units) asks micad over the
# bus to set access.ssh with the harness key; micad then renders
# /run/mica/dropbear.env and root's ~/.ssh/authorized_keys and enables and
# starts dropbear.service. The setting persists in micad's settings on DATA, so
# the later boots of this audit keep the way in. The image is untouched and
# nothing writes a file micad manages.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${P1_WORK:-$REPO/.tmp/p1-writable-path-audit}"
mkdir -p "$S"
H="$REPO/tests/p1-writable-path-audit"
MICA_PRODUCT="${MICA_PRODUCT:?product name required (make products lists them)}"
eval "$(bash "$REPO/tools/product.sh" "$MICA_PRODUCT")"
export MICA_PRODUCT MICA_BOARD="$BOARD"
LABEL="${1:?label}"
MODE="${2:?mode}"
SSH_PORT="${SSH_PORT:-18022}"
RUN_SECONDS="${RUN_SECONDS:-600}"
QEMU_TIMEOUT="${QEMU_TIMEOUT:-1200}"
NET="${NET:-traefik}"

BUN_IMAGE="$(bash "$REPO/tools/from.sh" --ref IMAGE_MICA_BUILD_BASE)"
CLI_IMAGE="$(bash "$REPO/tools/from.sh" --ref IMAGE_DOCKER_CLI_28)"
PORT_IMAGE="localhost/mica-verify-bun:$(printf '%s\n%s\n' "$BUN_IMAGE" "$CLI_IMAGE" | sha256sum | cut -c1-16)"

KEY="$S/p1-ssh-key"
if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -f "$KEY" -N '' -C '' </dev/null
    echo "generated $KEY"
fi
# micad accepts the canonical `<type> <base64>` form only, with no comment.
PUBKEY=$(cut -d' ' -f1,2 <"$KEY.pub")

if [ "${SEED_KEY:-1}" = "1" ]; then
    settings=$(printf '{"enabled":true,"port":22,"permitRootLogin":true,"passwordAuthentication":false,"listenAddresses":[],"authorizedKeys":[{"key":"%s"}]}' "$PUBKEY")
    unit="$S/p1-audit-ssh.service"
    cat >"$unit" <<UNIT
[Unit]
Description=P1 audit: SSH access for the harness key, through micad
Requires=micad.service
After=micad.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/busctl --timeout=30 call com.mica.micad /com/mica/micad com.mica.micad1 SetSettings ss access.ssh '${settings}'
[Install]
WantedBy=multi-user.target
UNIT
    docker run --rm --label ai-agent=true \
        -v "$REPO:$REPO" -v /var/run/docker.sock:/var/run/docker.sock \
        -w "$REPO/tests/apid-api" \
        -e "MICA_BOARD=$MICA_BOARD" -e "MICA_PRODUCT=$MICA_PRODUCT" \
        "$PORT_IMAGE" bun run src/qemu.ts --seed \
        "$unit" /state/systemd-units/p1-audit-ssh.service \
        --enable p1-audit-ssh.service
fi

RUN_DIR_REAL="$(readlink -f "$REPO/_out/products/$MICA_PRODUCT/qemu")"

# --- launch the boot in the background -------------------------------------
docker run --rm --label ai-agent=true \
    -v "$REPO:$REPO" -v /var/run/docker.sock:/var/run/docker.sock \
    -w "$REPO/tests/apid-api" \
    -e "MICA_BOARD=$MICA_BOARD" -e "MICA_PRODUCT=$MICA_PRODUCT" \
    -e MICA_QEMU_REUSE_DISK=1 \
    -e "MICA_QEMU_RUN_SECONDS=$RUN_SECONDS" \
    -e "MICA_QEMU_TIMEOUT=$QEMU_TIMEOUT" \
    -e MICA_QEMU_FORWARD=1 \
    -e "MICA_QEMU_NETWORK=$NET" \
    -e "MICA_QEMU_SSH_PORT=$SSH_PORT" \
    "$PORT_IMAGE" bun run src/qemu.ts --capture "$S/console-$LABEL.txt" \
    >"$S/qemu-$LABEL.log" 2>&1 &
QEMU_PID=$!
echo "qemu.ts pid $QEMU_PID, console -> $S/console-$LABEL.txt"

cleanup() { kill "$QEMU_PID" 2>/dev/null || true; }
trap cleanup EXIT

# --- find the QEMU container and its address -------------------------------
guest_ip() {
    local id src resolved
    for id in $(docker ps -q 2>/dev/null); do
        for src in $(docker inspect "$id" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null); do
            resolved="$(readlink -f "$src" 2>/dev/null)" || continue
            [ "$resolved" = "$RUN_DIR_REAL" ] || continue
            docker inspect "$id" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" 2>/dev/null
            return 0
        done
    done
    return 1
}

IP=""
for _ in $(seq 1 60); do
    IP="$(guest_ip || true)"
    [ -n "$IP" ] && break
    sleep 2
done
[ -n "$IP" ] || { echo "error: no QEMU container on $NET holding $RUN_DIR_REAL" >&2; wait "$QEMU_PID"; exit 1; }
echo "guest container at $IP:$SSH_PORT"

# --- wait for dropbear, then run the probe ---------------------------------
ssh_try() {
    timeout 90 ssh -i "$KEY" -p "$SSH_PORT" \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR \
        "root@$IP" "$@"
}

# QEMU's hostfwd listener is open before the guest is, so `nc -z` succeeding
# proves nothing. Retry a real SSH command until it answers.
ready=0
for i in $(seq 1 60); do
    if out=$(ssh_try 'echo P1-SSH-READY' 2>&1); then
        case "$out" in *P1-SSH-READY*) echo "dropbear answered on attempt $i"; ready=1; break ;; esac
    fi
    last="$out"
    sleep 10
done
if [ "$ready" != 1 ]; then
    echo "error: dropbear never accepted a session; last: ${last:-<none>}" >&2
    echo "error: dropbear never accepted a session; last: ${last:-<none>}" >"$S/probe-$LABEL.txt"
    wait "$QEMU_PID" || true
    exit 1
fi

set +e
timeout 900 ssh -i "$KEY" -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR \
    "root@$IP" "sh -s $MODE" <"$H/probe.sh" >"$S/probe-$LABEL.txt" 2>&1
rc=$?
set -e
echo "probe exit $rc, $(grep -c 'P1AUDIT|' "$S/probe-$LABEL.txt" 2>/dev/null || echo 0) lines -> $S/probe-$LABEL.txt"

trap - EXIT
echo "waiting for the guest to be powered down by the harness..."
wait "$QEMU_PID" || echo "qemu.ts exit $?"
echo "BOOT-$LABEL-DONE"
