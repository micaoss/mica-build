#!/usr/bin/env bash
# boards/uefi-x64/gce/gce-import.sh against a fake gcloud: the calls it makes, with and without --labels/--family.
set -euo pipefail

import=$(cd "$(dirname "${BASH_SOURCE[0]}")/../gce" && pwd)/gce-import.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat >"$work/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GCLOUD_LOG"
EOF
chmod +x "$work/bin/gcloud"
archive=$work/mica-uefi-x64.gcp-20261110-0100.gce.tar.gz
: >"$archive"; : >"$work/db.der"

failures=0
run() { # run <log name> <gce-import.sh args...>
    local log=$work/$1; shift
    : >"$log"
    PATH=$work/bin:$PATH GCLOUD_LOG=$log bash "$import" "$@" >/dev/null
}
expect_line() { # expect_line <log> <line number> <exact text>
    local got
    got=$(sed -n "$2p" "$work/$1")
    [ "$got" = "$3" ] || { printf 'FAIL: %s line %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3" "$got" >&2; failures=$((failures + 1)); }
}
keys="--platform-key-file=$work/db.der --key-exchange-key-file=$work/db.der --signature-database-file=$work/db.der"
features='--guest-os-features=UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE'

# As before: the image named after the archive, only the product label, no family.
run plain "$archive" "$work/db.der" micaos
expect_line plain 1 "storage cp $archive gs://micaos/mica-uefi-x64.gcp-20261110-0100.gce.tar.gz"
expect_line plain 2 "compute images create mica-uefi-x64-gcp-20261110-0100 --source-uri=gs://micaos/mica-uefi-x64.gcp-20261110-0100.gce.tar.gz --storage-location=europe-west4 $features $keys --labels=mica-product=uefi-x64-gcp"

# The publish workflow's call: a prefix in the bucket, extra labels, a family, a name.
run publish --labels mica-release=uefi-x64-gcp-20261110-0100,mica-signing=development --family mica-uefi-x64-gcp-dryrun \
    "$archive" "$work/db.der" micaos/releases/uefi-x64.gcp.20261110-0100 mica-uefi-x64-gcp-20261110-0100-staging
expect_line publish 1 "storage cp $archive gs://micaos/releases/uefi-x64.gcp.20261110-0100/mica-uefi-x64.gcp-20261110-0100.gce.tar.gz"
expect_line publish 2 "compute images create mica-uefi-x64-gcp-20261110-0100-staging --source-uri=gs://micaos/releases/uefi-x64.gcp.20261110-0100/mica-uefi-x64.gcp-20261110-0100.gce.tar.gz --storage-location=europe-west4 $features $keys --labels=mica-product=uefi-x64-gcp,mica-release=uefi-x64-gcp-20261110-0100,mica-signing=development --family=mica-uefi-x64-gcp-dryrun"

# Too few arguments after the options: the usage line, status 2, no gcloud call.
: >"$work/usage"
status=0
PATH=$work/bin:$PATH GCLOUD_LOG=$work/usage bash "$import" --family f "$archive" "$work/db.der" 2>"$work/usage.err" || status=$?
[ "$status" -eq 2 ] && [ ! -s "$work/usage" ] && grep -F 'gce-import.sh [--labels' "$work/usage.err" >/dev/null ||
    { printf 'FAIL: too few arguments: status %s, calls %s\n' "$status" "$(wc -l <"$work/usage")" >&2; failures=$((failures + 1)); }

[ "$failures" -eq 0 ] || { printf '%d failure(s)\n' "$failures" >&2; exit 1; }
echo GCE_IMPORT_TEST_PASS
