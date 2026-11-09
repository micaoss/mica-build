#!/usr/bin/env bash
# boards/uefi-x64/gce/publish.sh against a fake gcloud and a fake smoke: what it verifies before any call, and the
# calls of a publish, a failed smoke, a repeated publish and the family's retention.
set -euo pipefail

publish=$(cd "$(dirname "${BASH_SOURCE[0]}")/../gce" && pwd)/publish.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# A fake gcloud: every call logged; answers for what publish.sh reads back. FAKE_FAIL (a substring of the
# arguments) makes that call fail.
cat >"$work/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GCLOUD_LOG"
case "$*" in *"${FAKE_FAIL:-@none@}"*) echo "ERROR: (gcloud) fake refusal" >&2; exit 1 ;; esac
case "$*" in
    "config get-value core/project") echo micaos ;;
    *"images list"*"--show-deprecated"*) cat "$FAKE_FAMILY" ;;
    *"images list"*) echo "${FAKE_EXISTING:-}" ;;
    *"shieldedInstanceInitialState"*) echo X509 ;;
    *"value(id)"*) echo 4242 ;;
esac
EOF
cat >"$work/bin/smoke" <<'EOF'
#!/usr/bin/env bash
mkdir -p "$GCE_SMOKE_OUT"; echo "smoke $*" >>"$GCLOUD_LOG"
echo "GCE_SMOKE_$([ "${FAKE_SMOKE_RC:-0}" = 0 ] && echo PASS || echo FAIL)" >"$GCE_SMOKE_OUT/results.txt"
exit "${FAKE_SMOKE_RC:-0}"
EOF
chmod +x "$work/bin/gcloud" "$work/bin/smoke"

# A release: the archive, the boot certificate's DER, the lock rows and SHA256SUMS.
# Two self-signed P-256 certificates (fixtures; their keys were not kept): CN=MICA-development-boot, CN=MICA-boot.
cat >"$work/dev.pem" <<'EOF'
-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUOcSYgU5y8u2MKnFl8EfVketFc7kwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVTUlDQS1kZXZlbG9wbWVudC1ib290MCAXDTI2MTEwOTIyNDYx
N1oYDzIxMjYxMDE2MjI0NjE3WjAgMR4wHAYDVQQDDBVNSUNBLWRldmVsb3BtZW50
LWJvb3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS0YK8uiituPLNxxDoiuZ4F
SmF+8FpnsVOnSqQMcT5Suc675LqFKf1sZGDQ9W+43IXRLLSL4SVvwlaCQJGZo9Dh
o1MwUTAdBgNVHQ4EFgQUhyf8J0oZEDpFuzss2zthJajJ1icwHwYDVR0jBBgwFoAU
hyf8J0oZEDpFuzss2zthJajJ1icwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNIADBFAiEAhbghPq9YXJ49mUnj2/KUXEXehfEjsdFptYyQ3WCRlyQCIA57w3hx
c6NyRDO/YHz4j8hXqwOHUbSwBB6sdUYqy2zx
-----END CERTIFICATE-----
EOF
cat >"$work/prod.pem" <<'EOF'
-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUI5SHGaiAkrIl2uLo3kCvvcF2SXgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJTUlDQS1ib290MCAXDTI2MTEwOTIyNDYxN1oYDzIxMjYxMDE2
MjI0NjE3WjAUMRIwEAYDVQQDDAlNSUNBLWJvb3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARht361vkbte8w4+MO5b33638TeWGSeaXbJcQdXcwpMYcKMQmiNJwBD
C9WJN9DV7Q7OrGhlRA7OA5Utvx5Sg7iDo1MwUTAdBgNVHQ4EFgQU94HWBZBzjXj6
Tihej/bj95JA9dUwHwYDVR0jBBgwFoAU94HWBZBzjXj6Tihej/bj95JA9dUwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBdQyQ+g+5xwcKh1HfNKQAf
dK8gAA6sOqr6tNOZn8D0sgIhAOie2BseV2hbzypG4zfMT6Uac4YsBXL1aZF/Rbs0
1B41
-----END CERTIFICATE-----
EOF
rel=$work/rel
mkdir -p "$rel"
tag=uefi-x64.gcp.20261110-0100
commit=0123456789abcdef0123456789abcdef01234567
tar=mica-uefi-x64.gcp-20261110-0100.gce.tar.gz db=mica-uefi-x64.gcp-20261110-0100.db.der
make_release() { # make_release <cert>
    rm -f "$rel"/*
    printf 'disk' >"$rel/$tar"
    sed '1d;$d' "$work/$1.pem" | base64 -d >"$rel/$db"
    printf '# mica-lock v1\nrelease\tmica-build\t%s\t%s\nasset\tuefi-x64.gcp\timage\tgce\t%s\t%s\ndata\tgce-db.uefi-x64.gcp\t%s\t%s\n' \
        "$tag" "$commit" "$tar" "$(sha256sum "$rel/$tar" | cut -d' ' -f1)" "$db" "$(sha256sum "$rel/$db" | cut -d' ' -f1)" >"$rel/mica-build.lock"
    (cd "$rel" && sha256sum "$tar" "$db" >SHA256SUMS)
}
cat >"$work/family.csv" <<'EOF'
mica-uefi-x64-gcp-20261110-0100,,
mica-uefi-x64-gcp-20261101-0100,,
mica-uefi-x64-gcp-20261020-0100,,
mica-uefi-x64-gcp-20261010-0100,,
mica-uefi-x64-gcp-20261001-0100,,
mica-uefi-x64-gcp-20260901-0100,DEPRECATED,2026-10-01T00:00:00Z
mica-uefi-x64-gcp-20260915-0100,DEPRECATED,2099-01-01T00:00:00Z
EOF

failures=0
run() { # run <case> [VAR=value ...]: publish.sh with the fakes; its status in $status
    local name=$1; shift
    out=$work/$name log=$work/$name.calls
    rm -rf "$out"; : >"$log"
    status=0
    env PATH="$work/bin:$PATH" GCLOUD_LOG="$log" GCE_SMOKE="$work/bin/smoke" GCE_BOOT_CERT="$work/dev.pem" \
        FAKE_FAMILY="$work/family.csv" "$@" bash "$publish" "$rel" "$out" >/dev/null 2>&1 || status=$?
}
has() { grep -F -- "$2" "$1" >/dev/null || { printf 'FAIL: %s lacks: %s\n' "$1" "$2" >&2; failures=$((failures + 1)); }; }
lacks() { ! grep -F -- "$2" "$1" >/dev/null || { printf 'FAIL: %s has: %s\n' "$1" "$2" >&2; failures=$((failures + 1)); }; }
status_is() { [ "$status" -eq "$1" ] || { printf 'FAIL: %s: status %s, want %s\n' "$2" "$status" "$1" >&2; failures=$((failures + 1)); }; }

# A private publish (the dry run's shape): stage, smoke, promote into the family, clean, retention, record.
make_release dev
run private GCE_FAMILY=mica-uefi-x64-gcp-dryrun GCE_PUBLIC=0
status_is 0 private
has "$out/results.txt" "VERIFY_PASS: $tag ($commit)"
has "$out/results.txt" 'MICA-development-* (development)'
has "$log" "storage cp $rel/$tar gs://micaos/releases/$tag/$tar"
has "$log" 'compute images create mica-uefi-x64-gcp-20261110-0100-staging'
has "$log" "--labels=mica-product=uefi-x64-gcp,mica-release=uefi-x64-gcp-20261110-0100,mica-commit=$commit,mica-signing=development"
has "$log" 'smoke mica-uefi-x64-gcp-20261110-0100-staging micaos'
has "$log" 'compute images create mica-uefi-x64-gcp-20261110-0100 --source-image mica-uefi-x64-gcp-20261110-0100-staging --family mica-uefi-x64-gcp-dryrun'
has "$log" "--signature-database-file=$rel/$db"
lacks "$log" 'add-iam-policy-binding'
has "$out/results.txt" 'PRIVATE: mica-uefi-x64-gcp-20261110-0100 stays project-private'
has "$log" 'compute images delete mica-uefi-x64-gcp-20261110-0100-staging --quiet'
has "$log" "storage rm gs://micaos/releases/$tag/$tar"
lacks "$log" 'compute images delete mica-uefi-x64-gcp-20261110-0100 --quiet'
# Retention: three current images stay, the 4th and 5th are deprecated, a deprecated one past its date is deleted.
has "$log" 'filter=family=mica-uefi-x64-gcp-dryrun AND labels.mica-release:*'
lacks "$log" 'images deprecate mica-uefi-x64-gcp-20261020-0100'
has "$log" 'images deprecate mica-uefi-x64-gcp-20261010-0100 --state=DEPRECATED --delete-in=30d'
has "$log" 'images deprecate mica-uefi-x64-gcp-20261001-0100 --state=DEPRECATED --delete-in=30d'
has "$log" 'images delete mica-uefi-x64-gcp-20260901-0100 --quiet'
lacks "$log" 'mica-uefi-x64-gcp-20260915-0100 --quiet'
has "$out/gce-image.txt" 'image mica-uefi-x64-gcp-20261110-0100'
has "$out/gce-image.txt" 'id 4242'
has "$out/results.txt" PUBLISH_PASS

# Public: the grant on the promoted image; a production certificate labels production.
make_release prod
run public GCE_PUBLIC=1 GCE_BOOT_CERT="$work/prod.pem"
status_is 0 public
has "$log" 'compute images add-iam-policy-binding mica-uefi-x64-gcp-20261110-0100 --member=allAuthenticatedUsers --role=roles/compute.imageUser'
has "$log" 'mica-signing=production'
has "$log" '--family mica-uefi-x64-gcp '

# A failed smoke: nothing promoted, the staging image and the object deleted.
make_release dev
run smokefail FAKE_SMOKE_RC=1
status_is 1 smokefail
lacks "$log" '--source-image'
has "$log" 'compute images delete mica-uefi-x64-gcp-20261110-0100-staging --quiet'
has "$log" "storage rm gs://micaos/releases/$tag/$tar"
has "$out/results.txt" 'SMOKE GCE_SMOKE_FAIL'
has "$out/results.txt" PUBLISH_FAIL

# The public grant refused: the promoted image goes too, the family keeps pointing where it did.
run grantfail GCE_PUBLIC=1 FAKE_FAIL=add-iam-policy-binding
status_is 1 grantfail
has "$log" 'compute images delete mica-uefi-x64-gcp-20261110-0100 --quiet'
has "$out/results.txt" 'GCLOUD_FAIL: gcloud compute images add-iam-policy-binding'

# Published before: skipped, nothing uploaded.
run again FAKE_EXISTING=mica-uefi-x64-gcp-20261110-0100
status_is 0 again
has "$out/results.txt" 'SKIP: mica-uefi-x64-gcp already has mica-uefi-x64-gcp-20261110-0100'
lacks "$log" 'storage cp'

# Refused before any gcloud call: an archive that is not the lock's, a db that is not the boot certificate.
printf 'other' >"$rel/$tar"
run badtar
status_is 1 badtar
has "$out/results.txt" "PUBLISH_REFUSED: $tar hashes to"
[ ! -s "$log" ] || { echo 'FAIL: badtar called gcloud' >&2; failures=$((failures + 1)); }
make_release dev
run baddb GCE_BOOT_CERT="$work/prod.pem"
status_is 1 baddb
has "$out/results.txt" "PUBLISH_REFUSED: $db is not the release boot certificate"
[ ! -s "$log" ] || { echo 'FAIL: baddb called gcloud' >&2; failures=$((failures + 1)); }

[ "$failures" -eq 0 ] || { printf '%d failure(s)\n' "$failures" >&2; exit 1; }
echo GCE_PUBLISH_TEST_PASS
