#!/usr/bin/env bash
# The update path from a released round: a device on the released build of <product> takes the build in
# _out/products/<product> through the normal update flow -- the archive imported through micad, installed, the trial
# boot confirmed by health -- and then rolls back to the released deployment. Neither image is changed: the guest
# side (update-from-release-guest.sh) is the user's own service on DATA.
#
#   bash tests/suites/lifecycle-uefi/update-from-release.sh <product> <released>
#
# <released> is either
#   latest | <tag>   the GitHub release of <product> (the newest one, or that tag): its image and its update archive,
#                    whose deployment descriptor names the released deployment. The released bytes are signed by the
#                    release keys, so this is the form for a job that signs with them (release-product.yml).
#   <dir>            a product directory (_out/products/<product> of a build at the released commit) under this
#                    tree's signing workspace, for a local run: a released image only boots and takes updates
#                    signed with the keys it was released under.
#
# The archive is the new build's deployment, signed one generation above the released one, as its release will be.
# The core set it carries is the build's seed set when that is newer than the released one (a release run seeds the
# newest published set); otherwise one built here from the pool one generation above the released set, so the
# device composes it, as it composes the round's core release. Signing: MICA_SIGNING_OUTPUT, default meta/.
#
# The checks (the guest prints UFR_* lines):
#   boot 1, released: health confirms the released deployment; the archive is copied off a second disk under the
#           uploads directory, imported through micad (state ready, naming the new deployment), installed (the
#           candidate), then micad reboots
#   boot 2, new:      the policy carries board.watchdog with confirmS; the update's core set is composed; the trial
#           deadline sees the boot as a trial; health confirms it; the fallback is the released deployment; micad
#           rolls it back and reboots
#   boot 3, released: the core set and the boot policy are the released ones byte for byte, health confirms, the
#           rollback is reported rolled_back to the released deployment, and no log line refuses a field
# Evidence is left under _out/update-from-release.*/ (one console log per boot).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
HERE=tests/suites/lifecycle-uefi
p=${1:?product} released=${2:?released: latest, a tag or a product directory}
new=$PWD/_out/products/$p
eval "$(bash bin/bun.sh src/cli.ts product "$p" | grep -E '^(BOARD|INIT)=')"
arch=$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$BOARD/board.env")
case "${MICA_SIGNING_OUTPUT:-meta}" in
/*) signing=$MICA_SIGNING_OUTPUT ;;
*) signing=$PWD/${MICA_SIGNING_OUTPUT:-meta} ;;
esac
pub=$(tr -d '\n' <"$signing/updates/public.key")
cli=(bash bin/bun.sh src/cli.ts components)
work=$(mktemp -d "$PWD/_out/update-from-release.XXXXXX")
echo "evidence: $work"
payload() { jq -r .payload "$1" | base64 -d; }

# 0. The released build: its image and its deployment descriptor.
if [ -d "$released" ]; then
    old=$(realpath "$released")
    oldgen=$(find "$old/deployments" -name '*.json' -printf '%f\n' | sed 's/\.json$//' | sort -n | tail -n 1)
    olddep=$old/deployments/$oldgen.json
    img=$(find "$old/image" -maxdepth 1 -name 'mica-*.img' -print -quit)
else
    tag=$released
    if [ "$tag" = latest ]; then
        tag=$(gh release list -L 200 --json tagName --jq '.[].tagName' | grep -E "^${p//./\\.}\\.[0-9]{8}-[0-9]{4}\$" | sort | tail -n 1 || true)
    fi
    [ -n "$tag" ] || { echo "error: no release of $p" >&2; exit 1; }
    mkdir -p "$work/released"
    gh release download "$tag" -p "mica-$p-*.img.gz" -p "mica-$p-*.micaupd" -p mica-build.lock -p SHA256SUMS -D "$work/released"
    # SHA256SUMS signs off the lock, and the lock's asset rows the image and the archive.
    (cd "$work/released" && sha256sum -c SHA256SUMS && awk -F'\t' -v p="$p" '$1 == "asset" && $2 == p { print $6 "  " $5 }' mica-build.lock >assets.sha256 &&
        [ "$(wc -l <assets.sha256)" -eq 2 ] && sha256sum -c assets.sha256)
    gunzip "$work/released"/mica-*.img.gz
    img=$(find "$work/released" -maxdepth 1 -name 'mica-*.img' -print -quit)
    "${cli[@]}" unpack --input "$(find "$work/released" -maxdepth 1 -name 'mica-*.micaupd' -print -quit)" --public-key "$pub" \
        --kernel "$work/released/kernel" --root "$work/released/root" --out "$work/released/deployment.json" >"$work/released.unpack.log" 2>&1
    olddep=$work/released/deployment.json
    oldgen=$(payload "$olddep" | jq -r .generation)
    echo "released: $tag"
fi
[ -f "$img" ] && [ -f "$olddep" ] || { echo "error: no released image or deployment ($img, $olddep)" >&2; exit 1; }

# 1. The core set the update carries.
oldsetgen=$(payload "$olddep" | jq -r .coreSet.generation)
coreset=$new/core-set
newsetgen=$(payload "$coreset/core-set.json" | jq -r .generation)
[[ "$oldsetgen" =~ ^[0-9]+$ && "$newsetgen" =~ ^[0-9]+$ ]] || { echo "error: no core set generations (released $oldsetgen, build $newsetgen)" >&2; exit 1; }
if [ "$newsetgen" -le "$oldsetgen" ]; then
    coreset=$work/core-set
    "${cli[@]}" core-set --pool "$PWD/_out/debs/$arch/pool" --arch "$arch" --channel general --generation "$((oldsetgen + 1))" \
        --product "$p" --root "$new/root" --out "$coreset" --content-key "$signing/verity/signer.key.pem" \
        --content-cert "$signing/verity/signer.cert.pem" --metadata-key "$signing/updates/signer.key.pem" >"$work/core-set.log" 2>&1
fi

# 2. The archive.
newgen=$(find "$new/deployments" -name '*.json' -printf '%f\n' | sed 's/\.json$//' | sort -n | tail -n 1)
version=$(payload "$new/deployments/$newgen.json" | jq -r .version)
"${cli[@]}" identity --input "$olddep" --public-key "$pub" --out "$work/old.tsv" >"$work/archive.log" 2>&1
"${cli[@]}" deployment --kernel "$new/kernel" --root "$new/root" --product "$p" --generation "$((oldgen + 1))" \
    --version "$version" --metadata-key "$signing/updates/signer.key.pem" --core-set "$coreset" --out "$work/deployment.json" >>"$work/archive.log" 2>&1
"${cli[@]}" archive --input "$work/deployment.json" --kernel "$new/kernel" --root "$new/root" --kind full \
    --core-set "$coreset" --public-key "$pub" --out "$work/next.micaupd" >>"$work/archive.log" 2>&1
"${cli[@]}" identity --input "$work/deployment.json" --public-key "$pub" --out "$work/new.tsv" >>"$work/archive.log" 2>&1
OLD=$(cut -f4 "$work/old.tsv") NEW=$(cut -f4 "$work/new.tsv")
[[ "$OLD" =~ ^[0-9a-f]{64}$ && "$NEW" =~ ^[0-9a-f]{64}$ ]] || { echo "error: no deployment ids ($OLD, $NEW)" >&2; exit 1; }
size=$(stat -c %s "$work/next.micaupd") sha=$(sha256sum "$work/next.micaupd" | cut -d' ' -f1)
cp "$work/next.micaupd" "$work/archive.img"
truncate -s "$(((size / 1048576 + 2) * 1048576))" "$work/archive.img"
newset=$(payload "$work/deployment.json" | jq -r .coreSet.id)
echo "released: $(payload "$olddep" | jq -c '{product,version,generation}') deployment $OLD, core set $(payload "$olddep" | jq -r .coreSet.id) (generation $oldsetgen)"
echo "update:   $p version $version generation $((oldgen + 1)) (the build's own is $newgen), deployment $NEW, core set $newset (generation $(payload "$work/deployment.json" | jq -r .coreSet.generation)), $size bytes"

# 3. The device: the released factory image on a device's disk (DATA grows to its end on the first boot), and the
# guest side on DATA.
cp --reflink=auto --sparse=always "$img" "$work/disk.img"
truncate -s 4G "$work/disk.img"
cp "$signing/boot/signer.cert.pem" "$work/db.cert.pem"
printf '%s %s %s %s %s\n' "$OLD" "$NEW" "$size" "$sha" "$newset" >"$work/ids"
cp "$HERE/update-from-release-guest.sh" "$work/guest.sh"
seed=("$work/guest.sh" /state/ufr/guest.sh "$work/ids" /state/ufr/ids)
if [ "$INIT" = systemd ]; then
    printf '[Unit]\nDescription=Update path from a released round\nAfter=micad.service\n\n[Service]\nType=simple\nExecStart=/bin/sh /mnt/data/state/ufr/guest.sh\n\n[Install]\nWantedBy=multi-user.target\n' >"$work/ufr.service"
    seed+=("$work/ufr.service" /state/systemd-units/ufr.service --enable ufr.service)
else
    printf '#!/sbin/openrc-run\ndescription="Update path from a released round"\ndepend() { need mica-mounts; after micad; }\nstart() { /bin/sh /mnt/data/state/ufr/guest.sh >/dev/console 2>&1 & }\n' >"$work/ufr"
    chmod 0755 "$work/ufr"
    seed+=("$work/ufr" /state/openrc-local/init.d/ufr)
fi
timeout -k 15 240 bash bin/bun.sh src/image/qemu-seed-data.ts "$BOARD" "$work/disk.img" "${seed[@]}" >"$work/seed.log" 2>&1
if [ "$INIT" = openrc ]; then
    # Enabled the way mica-unit enables a script: a link in openrc-local/enabled, the script executable.
    read -r start sectors < <(awk -F'\t' '$1 == "part" && $3 == "data" { print $5, $6 }' "_out/boards/$BOARD/layout.tsv")
    image=$(bash bin/mica-tools from --ref upstream:debian:trixie-slim)
    # mica-build-side: container-block -- debugfs and e2fsck edit the DATA partition of the disk copy inside the pinned
    # image; a loop mount on the host would need privileges a test should not want
    docker run --rm --label ai-agent=true -e START="$start" -e SECTORS="$sectors" -v "$work:/w" "$image" sh -euc '
        apt-get update -qq >/dev/null 2>&1
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends e2fsprogs >/dev/null 2>&1
        dd if=/w/disk.img of=/tmp/data.img bs=512 skip="$START" count="$SECTORS" status=none
        debugfs -w -R "mkdir /state/openrc-local/enabled" /tmp/data.img 2>/dev/null || true
        debugfs -w -R "symlink /state/openrc-local/enabled/ufr ../init.d/ufr" /tmp/data.img
        debugfs -w -R "sif /state/openrc-local/init.d/ufr mode 0100755" /tmp/data.img
        debugfs -R "stat /state/openrc-local/enabled/ufr" /tmp/data.img | grep -F "Fast link dest: \"../init.d/ufr\""
        debugfs -R "stat /state/openrc-local/init.d/ufr" /tmp/data.img | grep -E "Mode: +0755"
        e2fsck -fy /tmp/data.img >/dev/null || [ $? -le 1 ]
        e2fsck -fn /tmp/data.img >/dev/null
        dd if=/tmp/data.img of=/w/disk.img bs=512 seek="$START" conv=notrunc,fsync status=none' >>"$work/seed.log" 2>&1
    # mica-build-side: host
fi

# 4. Three boots: released -> the update (trial, confirmed) -> rolled back.
bash tests/suites/signed-boot-lab/images.sh --lifecycle >/dev/null
boot() { # <name> <limit>
    local rc=0
    docker run --rm --label ai-agent=true --network traefik -e DISK2=archive.img -v "$work:/w" \
        -v "$PWD/$HERE:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh disk.img writable "$2" "$arch" >"$work/$1.log" 2>&1 || rc=$?
    tr -d '\r' <"$work/$1.log" | grep -a '^UFR_' | cut -c1-400 | sed "s/^/$1: /" || true
    ! tr -d '\r' <"$work/$1.log" | grep -a '^UFR_FAIL' >/dev/null || { echo "error: $1 failed (rc $rc); see $work/$1.log" >&2; exit 1; }
    echo "$1: qemu ended with $rc"
}
boot released 2400
tr -d '\r' <"$work/released.log" | grep -aF 'UFR_STEP_PASS: 1 ' >/dev/null || { echo "error: no install on the released build; see $work/released.log" >&2; exit 1; }
boot update 2400
tr -d '\r' <"$work/update.log" | grep -aF 'UFR_STEP_PASS: 2 ' >/dev/null || { echo "error: the update boot did not pass; see $work/update.log" >&2; exit 1; }
boot rolledback 1800
tr -d '\r' <"$work/rolledback.log" | grep -aF 'UFR_PASS: ' >/dev/null || { echo "error: the rolled-back boot did not pass; see $work/rolledback.log" >&2; exit 1; }
echo "UPDATE_FROM_RELEASE_PASS: $p released $OLD -> $NEW -> $OLD"
