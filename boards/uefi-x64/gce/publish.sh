#!/usr/bin/env bash
# Publish a uefi-x64.gcp GitHub release to Compute Engine (.github/workflows/publish-gce.yml runs it; a dry run
# runs it by hand), or a local hand-over to the public test channel (by hand, with our service account).
#
#   publish.sh [--channel release|test] <release or hand-over dir> <out dir>
#
# THE CHANNELS. release (the default, the formal channel): a GitHub release's assets, its mica-build.lock, the family
# mica-uefi-x64-gcp, labels mica-release; nothing below changes for it. test: a local-build hand-over
# (_out/handover/<name>, src/offline/local-build.ts), its handover.lock in place of the release lock; the family
# mica-uefi-x64-gcp-test (any family given must end in -test, so a test image never enters the formal family),
# images mica-test-<build id>, labels mica-channel=test and mica-build=<build id>, the archive under
# gs://<bucket>/test/<build id>/, public by default. Each channel refuses the other's input before any gcloud call;
# the verify, the smoke, the clean-up and the retention are the same.
#
# <release dir> holds the release's mica-build.lock, SHA256SUMS, <...>.gce.tar.gz and <...>.db.der. gcloud must be
# authenticated with its project set. The environment:
#   GCE_BOOT_CERT  (required) the PEM of the release boot certificate (the repository variable MICA_BOOT_TRUST_CERT);
#                  the db.der must be its DER, and its common name gives the signing grade
#   GCE_BUCKET     the bucket (default micaos); the archive goes under gs://<bucket>/releases/<tag>/
#   GCE_FAMILY     the image family (default mica-uefi-x64-gcp)
#   GCE_PUBLIC     1: allAuthenticatedUsers gets roles/compute.imageUser on the promoted image; 0: project-private
#   GCE_KEEP       how many images of the family stay current (default 3); older ones are deprecated, and deleted
#                  30 days later by a later publish
#   GCE_SMOKE      the smoke script (default tests/suites/gce-real/smoke.sh)
#
# 1. Verify: the archive and db.der hash to the lock's `asset <product> image gce` and `data gce-db.<product>` rows
#    and to SHA256SUMS; db.der is GCE_BOOT_CERT. Anything else is refused before any gcloud call.
# 2. Skip when the family already has an image labelled with this release (idempotent per release).
# 3. Stage: gce-import.sh into <image>-staging (no family).
# 4. Smoke the staging image on a real instance (smoke.sh); a failure deletes the staging image and the object.
# 5. Promote: <image> from the staging image, into the family, labelled mica-release, mica-commit, mica-signing
#    (development|production); then public if GCE_PUBLIC=1. A failure here deletes the promoted image too, so the
#    family never points at an image that did not finish.
# 6. Clean: the staging image and the uploaded object, always.
# 7. Retention: within the family, only images labelled mica-release (test: mica-channel=test) are touched.
# <out dir> gets results.txt, publish.log, the smoke's evidence, and gce-image.txt (the record the release carries).
set -u
CHANNEL=release
if [ "${1:-}" = --channel ]; then CHANNEL=${2:-}; shift 2 || true; fi
[ $# -eq 2 ] && { [ "$CHANNEL" = release ] || [ "$CHANNEL" = test ]; } || { sed -n '5p' "$0" | sed 's/^# *//' >&2; exit 2; }
REL=$1 OUT=$2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
BUCKET=${GCE_BUCKET:-micaos}
if [ "$CHANNEL" = test ]; then
    FAMILY=${GCE_FAMILY:-mica-uefi-x64-gcp-test} PUBLIC=${GCE_PUBLIC:-1}
else
    FAMILY=${GCE_FAMILY:-mica-uefi-x64-gcp} PUBLIC=${GCE_PUBLIC:-0}
fi
KEEP=${GCE_KEEP:-3}
SMOKE=${GCE_SMOKE:-$repo/tests/suites/gce-real/smoke.sh}
mkdir -p "$OUT"
R=$OUT/results.txt
: >"$R"
log() { echo "$(date -u +%FT%TZ) $*" >>"$OUT/publish.log"; }
res() { echo "$*" | tee -a "$R"; }
die() { res "PUBLISH_REFUSED: $*"; exit 1; }

# --- 1. verify, offline ---------------------------------------------------------------------------------------
if [ "$CHANNEL" = test ]; then
    case $FAMILY in *-test) ;; *) die "the test channel publishes only into a -test family, not $FAMILY" ;; esac
    lock=$REL/handover.lock first=handover
    [ -f "$lock" ] || die "the test channel takes a local hand-over (handover.lock); $REL has none"
else
    lock=$REL/mica-build.lock first=release
    [ -f "$REL/handover.lock" ] && die "a hand-over (handover.lock) is never published to the formal channel"
fi
[ -f "$lock" ] && [ -f "$REL/SHA256SUMS" ] || die "$REL lacks $(basename "$lock") or SHA256SUMS"
[ -n "${GCE_BOOT_CERT:-}" ] && [ -f "$GCE_BOOT_CERT" ] || die "GCE_BOOT_CERT is not a file"
read -r tag commit < <(awk -F'\t' -v k="$first" '$1 == k && $2 == "mica-build" { print $3, $4 }' "$lock")
[[ ${tag:-} =~ ^([a-z0-9-]+\.[a-z0-9-]+)\.([0-9]{8}-[0-9]{4})$ ]] || die "the lock's $first row names no <product>.<YYYYMMDD-HHMM> tag: '${tag:-}'"
product=${BASH_REMATCH[1]}
[[ ${commit:-} =~ ^[0-9a-f]{40}$ ]] || die "the lock's $first row has no commit: '${commit:-}'"
row() { awk -F'\t' -v k="$1" -v p="$2" '($1 == "asset" && k == "image" && $2 == p && $3 == "image" && $4 == "gce") { print $5, $6 }
    ($1 == "data" && k == "db" && $2 == "gce-db." p) { print $3, $4 }' "$lock"; }
read -r tar_name tar_sha < <(row image "$product")
read -r db_name db_sha < <(row db "$product")
[ -n "${tar_name:-}" ] || die "the lock has no 'asset $product image gce' row"
[ -n "${db_name:-}" ] || die "the lock has no 'data gce-db.$product' row"
for pair in "$tar_name:$tar_sha" "$db_name:$db_sha"; do
    f=${pair%%:*} want=${pair#*:}
    [ -f "$REL/$f" ] || die "$f is not in $REL"
    got=$(sha256sum "$REL/$f" | cut -d' ' -f1)
    [ "$got" = "$want" ] || die "$f hashes to $got, the lock says $want"
    sums=$(awk -v f="$f" '$2 == f || $2 == "*" f { print $1 }' "$REL/SHA256SUMS")
    [ "$sums" = "$want" ] || die "SHA256SUMS says '$sums' for $f, the lock says $want"
done
# A PEM certificate is its DER in base64 between the armour lines: no x509 tool is needed to compare the two.
sed -n '/^-----BEGIN CERTIFICATE-----/,/^-----END CERTIFICATE-----/p' "$GCE_BOOT_CERT" | sed '1d;$d' |
    base64 -d >"$OUT/boot-cert.der" 2>>"$OUT/publish.log" && [ -s "$OUT/boot-cert.der" ] || die "GCE_BOOT_CERT is not a PEM certificate"
cmp -s "$OUT/boot-cert.der" "$REL/$db_name" || die "$db_name is not the release boot certificate (GCE_BOOT_CERT)"
# The grade as release-product.yml reads it: a MICA-development-* certificate is development-grade. The common
# name is a plain string inside the DER.
if grep -a 'MICA-development-' "$OUT/boot-cert.der" >/dev/null; then grade=development cn='MICA-development-*'
else grade=production cn='not MICA-development-*'; fi
slug=$(printf '%s' "$tag" | tr '.' '-')
if [ "$CHANNEL" = test ]; then
    IMAGE=mica-test-$slug LABELS="mica-channel=test,mica-build=$slug,mica-commit=$commit,mica-signing=$grade"
    MINE="labels.mica-build=$slug" OURS="labels.mica-channel=test" PREFIX=test what="hand-over "
else
    IMAGE=mica-$slug LABELS="mica-release=$slug,mica-commit=$commit,mica-signing=$grade"
    MINE="labels.mica-release=$slug" OURS="labels.mica-release:*" PREFIX=releases what=
fi
STAGING=$IMAGE-staging
res "VERIFY_PASS: $what$tag ($commit), $tar_name and $db_name match the lock and SHA256SUMS; boot certificate $cn ($grade)"

# --- gcloud from here on ----------------------------------------------------------------------------------------
command -v gcloud >/dev/null || die "gcloud is not installed"
PROJECT=$(gcloud config get-value core/project 2>/dev/null)
[ -n "$PROJECT" ] || die "gcloud has no project"
g() {  # g <gcloud args...>: stdout to the caller; a failure written verbatim, and the run ends
    if gcloud "$@" 2>"$OUT/last.err"; then return 0; fi
    log "REFUSED/FAILED: gcloud $*"; cat "$OUT/last.err" >>"$OUT/publish.log"
    res "GCLOUD_FAIL: gcloud $*"; sed 's/^/    /' "$OUT/last.err" | tee -a "$R"
    return 1
}
OBJECT=gs://$BUCKET/$PREFIX/$tag/$tar_name
staged= uploaded= promoted= done=
finish() {
    [ -n "$staged" ] && { g compute images delete "$STAGING" --quiet >>"$OUT/publish.log" && res "CLEAN: staging image $STAGING deleted"; }
    [ -n "$uploaded" ] && { g storage rm "$OBJECT" >>"$OUT/publish.log" 2>&1 && res "CLEAN: $OBJECT deleted"; }
    if [ -z "$done" ] && [ -n "$promoted" ]; then
        g compute images delete "$IMAGE" --quiet >>"$OUT/publish.log" && res "CLEAN: $IMAGE deleted, the publish did not finish"
    fi
    [ -n "$done" ] && { res PUBLISH_PASS; exit 0; }
    res PUBLISH_FAIL; exit 1
}
trap finish EXIT
trap 'exit 1' INT TERM

# --- 2. idempotent ---------------------------------------------------------------------------------------------
existing=$(g compute images list --no-standard-images --filter="$MINE AND family=$FAMILY" --format='value(name)') || exit 1
if [ -n "$existing" ]; then
    res "SKIP: $FAMILY already has $existing for $tag"
    IMAGE=$existing
else
    # --- 3. stage --------------------------------------------------------------------------------------------
    log "stage $STAGING from $OBJECT"
    if bash "$here/gce-import.sh" --labels "$LABELS" "$REL/$tar_name" "$REL/$db_name" "$BUCKET/$PREFIX/$tag" "$STAGING" >>"$OUT/publish.log" 2>&1; then
        staged=1 uploaded=1
    else
        gcloud storage ls "$OBJECT" >/dev/null 2>&1 && uploaded=1
        gcloud compute images describe "$STAGING" >/dev/null 2>&1 && staged=1
        res "STAGE_FAIL (gce-import.sh), verbatim:"; tail -n 15 "$OUT/publish.log" | tee -a "$R"; exit 1
    fi
    res "STAGE_PASS: $STAGING"

    # --- 4. smoke --------------------------------------------------------------------------------------------
    GCE_SMOKE_OUT=$OUT/smoke bash "$SMOKE" "$STAGING" "$PROJECT" >>"$OUT/publish.log" 2>&1
    smoke=$?
    sed 's/^/SMOKE /' "$OUT/smoke/results.txt" 2>/dev/null | tee -a "$R"
    [ "$smoke" -eq 0 ] || { res "SMOKE_FAIL: status $smoke, nothing promoted"; exit 1; }

    # --- 5. promote ------------------------------------------------------------------------------------------
    promoted=1
    g compute images create "$IMAGE" --source-image "$STAGING" --family "$FAMILY" \
        --storage-location "${GCE_LOCATION:-europe-west4}" \
        --guest-os-features=UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE \
        --platform-key-file="$REL/$db_name" --key-exchange-key-file="$REL/$db_name" --signature-database-file="$REL/$db_name" \
        --labels="mica-product=uefi-x64-gcp,$LABELS" >>"$OUT/publish.log" || exit 1
    dbs=$(g compute images describe "$IMAGE" --format='value(shieldedInstanceInitialState.dbs[0].fileType)') || exit 1
    [ -n "$dbs" ] || { res "PROMOTE_FAIL: $IMAGE carries no Secure Boot db"; exit 1; }
    res "PROMOTE_PASS: $IMAGE in family $FAMILY (Secure Boot db $dbs)"
    if [ "$PUBLIC" = 1 ]; then
        g compute images add-iam-policy-binding "$IMAGE" --member=allAuthenticatedUsers --role=roles/compute.imageUser >>"$OUT/publish.log" || exit 1
        res "PUBLIC: allAuthenticatedUsers has roles/compute.imageUser on $IMAGE"
    else
        res "PRIVATE: $IMAGE stays project-private"
    fi
fi

# --- 7. retention ------------------------------------------------------------------------------------------------
g compute images list --no-standard-images --show-deprecated --filter="family=$FAMILY AND $OURS" \
    --sort-by=~creationTimestamp --format='csv[no-heading](name,deprecated.state,deprecated.deleted)' >"$OUT/family.csv" || exit 1
now=$(date -u +%s) i=0
while IFS=, read -r name state deleted; do
    if [ -z "$state" ]; then
        i=$((i + 1))
        [ "$i" -gt "$KEEP" ] || continue
        g compute images deprecate "$name" --state=DEPRECATED --delete-in=30d >>"$OUT/publish.log" || exit 1
        res "RETENTION: $name deprecated (delete after 30 days)"
    elif [ "$state" = DEPRECATED ] && [ -n "$deleted" ] && [ "$(date -u -d "$deleted" +%s)" -le "$now" ]; then
        g compute images delete "$name" --quiet >>"$OUT/publish.log" || exit 1
        res "RETENTION: $name deleted (deprecated, past $deleted)"
    fi
done <"$OUT/family.csv"

# --- record ------------------------------------------------------------------------------------------------------
id=$(g compute images describe "$IMAGE" --format='value(id)') || exit 1
{
    if [ "$CHANNEL" = test ]; then echo "build $tag"; echo "channel test"; else echo "release $tag"; fi
    echo "commit $commit"
    echo "project $PROJECT"
    echo "image $IMAGE"
    echo "id $id"
    echo "family $FAMILY"
    echo "signing $grade"
    echo "public $([ "$PUBLIC" = 1 ] && echo allAuthenticatedUsers || echo no)"
    echo "use gcloud compute instances create <name> --image-project $PROJECT --image-family $FAMILY --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring"
} >"$OUT/gce-image.txt"
res "RECORD: $OUT/gce-image.txt ($IMAGE, id $id)"
done=1
