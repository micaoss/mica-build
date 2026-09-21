#!/usr/bin/env bash
# Package versions end to end on the uefi-x64 board's real producer against a real
# registry: tools/deb/version-guard.sh holds a freshly built pool to the board's
# latest release, and tools/deb/publish.sh publishes an unchanged pool as the
# same manifest digest. An unchanged version with unchanged inputs is the
# published bytes; a bump is built; changed inputs without a bump, a lower
# version, bytes that moved under an unchanged version, and a previous archive
# that is missing or not its lock row's are refused; a release from before the
# rules is not compared.
#
#   bash tests/version-guard-test.sh          (docker on the host)
#
# The scripts run in a scratch clone of the working tree, untracked files
# included, committed and tagged there (the tags never leave the clone). The
# registry is registry:3.1.1 from locks/mica-build-env.lock, a sibling container
# over plain HTTP; published releases are served from file://.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
for t in curl sha256sum jq docker git python3; do
    command -v "${t}" >/dev/null 2>&1 || { echo "error: ${t} is required" >&2; exit 1; }
done
mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/version-guard-test.XXXXXX")"
NAME="ai-agent-version-guard-test-$$"
cleanup() { docker rm -f "${NAME}" >/dev/null 2>&1 || true; rm -rf "${WORK}"; }
trap cleanup EXIT
PASS_N=0; FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
says() { grep -c -- "$2" "$1" >/dev/null; }

IMAGE="$(bash tools/from.sh --upstream registry:3.1.1)"
docker run -d --rm --label ai-agent=true --name "${NAME}" --network "${MICA_TEST_NETWORK:-traefik}" -e REGISTRY_STORAGE_DELETE_ENABLED=true "${IMAGE}" >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://${NAME}:5000/v2/" && break; sleep 1; done
curl -sf -o /dev/null "http://${NAME}:5000/v2/" || { echo "error: the registry ${NAME} did not answer" >&2; exit 1; }
REG="http://${NAME}:5000/v2/one/mica-boards"
MT='application/vnd.oci.image.manifest.v1+json'

CLONE="${WORK}/repo"
git clone -q "${REPO_ROOT}" "${CLONE}"
git -C "${CLONE}" remote set-url origin https://example.invalid/testorg/mica-boards.git
git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C "${CLONE}"
commit() { # <message>
    git -C "${CLONE}" add -A
    git -C "${CLONE}" -c user.name=test -c user.email=test@example.invalid commit -qm "$1" --allow-empty
}
commit "the working tree under test"
POOL="${CLONE}/_out/debs/amd64/pool"
VERSION_ENV="${CLONE}/boards/uefi-x64/package/version.env"
declare_version() { # <version> <epoch>
    printf 'VERSION=%s\nSOURCE_DATE_EPOCH=%s\n' "$1" "$2" >"${VERSION_ENV}"
}

RELEASES="${WORK}/releases"
mkdir -p "${RELEASES}/download"
published() { # <tag> <lock>...: exactly these releases are published
    echo '[]' >"${RELEASES}/releases.json"
    while [ "$#" -gt 0 ]; do
        mkdir -p "${RELEASES}/download/$1"
        cp "$2" "${RELEASES}/download/$1/mica-boards.lock"
        jq --arg t "$1" '. + [{tag_name: $t, draft: false, assets: [{name: "mica-boards.lock"}, {name: "SHA256SUMS"}]}]' "${RELEASES}/releases.json" >"${RELEASES}/r.json"
        mv "${RELEASES}/r.json" "${RELEASES}/releases.json"
        shift 2
    done
}
cat >"${WORK}/registry.env" <<ENV
MICA_REGISTRY=${NAME}:5000/one
MICA_REGISTRY_USER=nobody
MICA_RELEASE_TOKEN_VAR=PUBLISH_TEST_TOKEN
MICA_SOURCE_URL=https://example.invalid/testorg
ENV
run() { # <tag> <log> <command...>: in the clone, for the release <tag>
    local tag="$1" log="$2"; shift 2
    (cd "${CLONE}" && MICA_REGISTRY_ENV="${WORK}/registry.env" MICA_REGISTRY_PLAIN_HTTP=1 MICA_RELEASE_NO_GH=1 PUBLISH_TEST_TOKEN=fixture \
        MICA_RELEASE_TAG="${tag}" MICA_LOCK_ROWS="${WORK}/rows-${tag//\//-}" \
        MICA_RELEASE_LIST="file://${RELEASES}/releases.json" MICA_RELEASE_DOWNLOAD="file://${RELEASES}/download" \
        "$@") >"${log}" 2>&1
}
pool() { # <log>: the uefi-x64 pool at the clone's HEAD
    rm -rf "${CLONE}/_out/debs"
    run - "$1" bash tools/deb/build.sh --producer board@uefi-x64 --arch amd64
}
guard() { # <log> [--release <tag>]
    local log="$1"; shift
    run - "${log}" bash tools/deb/version-guard.sh --board uefi-x64 "$@"
}
# release <tag>: pool, guard, publish; writes <tag>.lock with its pool and package rows.
release() {
    local tag="$1" base="${WORK}/${1//\//-}"
    git -C "${CLONE}" tag "${tag}"
    pool "${base}-pool.log" && guard "${base}-guard.log" --release "${tag}" && run "${tag}" "${base}-publish.log" bash tools/deb/publish.sh || return 1
    {
        echo "# mica-lock v1"
        awk -F'\t' '{ printf "pool\t%s\tghcr.io/micaoss/mica-boards:%s@%s\n", $1, $2, $3 }' "${WORK}/rows-${tag//\//-}/pool.tsv"
        awk -F'\t' '{ printf "package\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4 }' "${WORK}/rows-${tag//\//-}/package.tsv"
    } >"${base}.lock"
}
refused() { # <expected message> <label> [guard arguments]: the guard over a fresh pool refuses
    local expected="$1" label="$2"; shift 2
    pool "${WORK}/refused-pool.log" || { fail "${label}: the pool did not build: $(tail -n3 "${WORK}/refused-pool.log")"; return; }
    if guard "${WORK}/refused.log" "$@"; then fail "${label}: accepted: $(tail -n2 "${WORK}/refused.log")"
    elif says "${WORK}/refused.log" "${expected}"; then pass "${label}: refused"
    else fail "${label}: $(tail -n2 "${WORK}/refused.log")"; fi
}
served() { echo "sha256:$(curl -sf -H "Accept: ${MT}" "${REG}/manifests/$1" | sha256sum | cut -d' ' -f1)"; } # <tag>
inputs() { (cd "${CLONE}" && bash tools/deb/package-inputs.sh board@uefi-x64 amd64); }
put_blob() { # <file>
    local loc
    loc="$(curl -sf -D - -o /dev/null -X POST "${REG}/blobs/uploads/" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
    case "${loc}" in http*) ;; *) loc="http://${NAME}:5000${loc}" ;; esac
    case "${loc}" in *\?*) loc="${loc}&" ;; *) loc="${loc}?" ;; esac
    curl -sf -o /dev/null -X PUT -H 'Content-Type: application/octet-stream' --data-binary "@$1" "${loc}digest=sha256:$(sha256sum "$1" | cut -d' ' -f1)"
}
put_manifest() { curl -sf -o /dev/null -X PUT -H "Content-Type: ${MT}" --data-binary "@$1" "${REG}/manifests/$2"; } # <file> <tag>
lock_for() { # <out> <pool tag> <manifest file> <version> <sha256>
    printf '# mica-lock v1\npool\tamd64\tghcr.io/micaoss/mica-boards:%s@sha256:%s\npackage\tmica-board-uefi-x64\tamd64\t%s\t%s\n' "$2" "$(sha256sum "$3" | cut -d' ' -f1)" "$4" "$5" >"$1"
}
A=uefi-x64.20260101-0000 B=uefi-x64.20260101-0100 C=uefi-x64.20260101-0200

# The test owns the versions it asserts, whatever the tree declares today.
declare_version 0.1.0-1 1789430400
commit "the version this test starts from"

# 1. No published release: everything is built and published, its layer carries the inputs.
echo '[]' >"${RELEASES}/releases.json"
if release "${A}" && says "${WORK}/uefi-x64.20260101-0000-guard.log" "has no published release"; then pass "no previous release: built and published"
else fail "first release: $(tail -n3 "${WORK}"/uefi-x64.20260101-0000-*.log)"; fi
A_POOL="$(served pool.uefi-x64.amd64.20260101-0000)"
case "$(ls "${POOL}")" in mica-board-uefi-x64_0.1.0-1_amd64.deb) pass "the archive carries the declared version" ;; *) fail "archive name: $(ls "${POOL}")" ;; esac
[ -z "$(python3 "${CLONE}/tools/deb/control-fields.py" "${POOL}"/*.deb Mica-Source-Commit)" ] && pass "no Mica-Source-Commit control field" || fail "the archive carries Mica-Source-Commit"
[ -n "$(inputs)" ] && [ "$(curl -sf -H "Accept: ${MT}" "${REG}/manifests/pool.uefi-x64.amd64.20260101-0000" | jq -r '.layers[0].annotations["mica.inputs"]')" = "$(inputs)" ] &&
    pass "the pool layer carries the producer's inputs as mica.inputs" || fail "layer mica.inputs"
A_LOCK="${WORK}/uefi-x64.20260101-0000.lock"

# 2. A previous release from before the rules (no mica.inputs) is not compared.
curl -sf -H "Accept: ${MT}" "${REG}/manifests/pool.uefi-x64.amd64.20260101-0000" | jq -c 'del(.layers[].annotations["mica.inputs"])' >"${WORK}/old.json"
put_manifest "${WORK}/old.json" pool.uefi-x64.amd64.20251231-0000
lock_for "${WORK}/old.lock" pool.uefi-x64.amd64.20251231-0000 "${WORK}/old.json" 0.1.0+git0123456789ab-1 "$(awk -F'\t' '$1 == "package" { print $5 }' "${A_LOCK}")"
published uefi-x64.20251231-0000 "${WORK}/old.lock"
pool "${WORK}/old-pool.log"
if guard "${WORK}/old.log" && says "${WORK}/old.log" "predates the package-version rules"; then pass "a release from before the rules: nothing compared, a lower version accepted"
else fail "pre-rules release: $(tail -n2 "${WORK}/old.log")"; fi

# 3. A commit outside the package's inputs: same version, same bytes, same pool digest (CI and release).
published "${A}" "${A_LOCK}"
printf '\nA change outside every package input.\n' >>"${CLONE}/docs/changelog.md"
commit "outside the inputs"
pool "${WORK}/ci-pool.log"
if guard "${WORK}/ci.log" && says "${WORK}/ci.log" "1 unchanged, 0 bumped, 0 new"; then pass "CI: an unchanged version is the published archive"
else fail "CI unchanged: $(tail -n3 "${WORK}/ci.log")"; fi
if release "${B}" && says "${WORK}/uefi-x64.20260101-0100-guard.log" "1 unchanged"; then pass "release: an unchanged version is the published archive"
else fail "release unchanged: $(tail -n5 "${WORK}"/uefi-x64.20260101-0100-*.log)"; fi
[ "$(served pool.uefi-x64.amd64.20260101-0100)" = "${A_POOL}" ] && pass "nothing bumped: the new pool tag names the published pool digest" || fail "pool digest $(served pool.uefi-x64.amd64.20260101-0100) against ${A_POOL}"
published "${B}" "${WORK}/uefi-x64.20260101-0100.lock"

# 4. A changed input without a bump: refused in CI and at release.
printf '# a changed input\n' >>"${CLONE}/producers/board/producer.env"
commit "a producer input, not bumped"
refused "inputs of mica-board-uefi-x64 changed without a version bump" "CI: changed inputs without a bump"
refused "inputs of mica-board-uefi-x64 changed without a version bump" "release: changed inputs without a bump" --release "${C}"

# 5. The bump: built, published, a new pool.
declare_version 0.1.0-2 1789516800
commit "mica-board-uefi-x64 0.1.0-2"
if release "${C}" && says "${WORK}/uefi-x64.20260101-0200-guard.log" "mica-board-uefi-x64 0.1.0-1 -> 0.1.0-2: bumped"; then pass "a bumped version is built and published"
else fail "bump: $(tail -n5 "${WORK}"/uefi-x64.20260101-0200-*.log)"; fi
[ "$(served pool.uefi-x64.amd64.20260101-0200)" != "${A_POOL}" ] && pass "a bumped package: a new pool digest" || fail "the pool digest did not change with a bump"
C_LOCK="${WORK}/uefi-x64.20260101-0200.lock"
published "${C}" "${C_LOCK}"

# 6. A lower version than the latest release: refused.
declare_version 0.1.0-1 1789430400
commit "back to 0.1.0-1"
refused "lower than 0.1.0-2" "a version lower than the latest release's"
declare_version 0.1.0-2 1789516800
commit "0.1.0-2 again"

# 7. Bytes that moved under an unchanged version and unchanged inputs: refused.
python3 - "${WORK}/moved.deb" <<'PY'
import io, sys, tarfile
def tgz(files):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode='w:gz') as t:
        for name, data in files:
            i = tarfile.TarInfo(name); i.size = len(data); i.mtime = 1789516800; t.addfile(i, io.BytesIO(data))
    return b.getvalue()
control = b'Package: mica-board-uefi-x64\nVersion: 0.1.0-2\nArchitecture: amd64\nMica-Source-Repo: mica-boards\n'
with open(sys.argv[1], 'wb') as f:
    f.write(b'!<arch>\n')
    for n, d in [('debian-binary', b'2.0\n'), ('control.tar.gz', tgz([('./control', control)])), ('data.tar.gz', tgz([('./usr/share/doc/mica-board-uefi-x64/copyright', b'moved\n')]))]:
        f.write(f'{n + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(d):<10}`\n'.encode() + d + (b'\n' if len(d) % 2 else b''))
PY
put_blob "${WORK}/moved.deb"
M_SHA="$(sha256sum "${WORK}/moved.deb" | cut -d' ' -f1)"
curl -sf -H "Accept: ${MT}" "${REG}/manifests/pool.uefi-x64.amd64.20260101-0200" |
    jq -c --arg d "sha256:${M_SHA}" --argjson s "$(stat -c %s "${WORK}/moved.deb")" '.layers[0].digest = $d | .layers[0].size = $s' >"${WORK}/moved.json"
put_manifest "${WORK}/moved.json" pool.uefi-x64.amd64.20260101-0250
lock_for "${WORK}/moved.lock" pool.uefi-x64.amd64.20260101-0250 "${WORK}/moved.json" 0.1.0-2 "${M_SHA}"
published uefi-x64.20260101-0250 "${WORK}/moved.lock"
refused "is not the published archive" "an unchanged version whose bytes moved"

# 8. A previous archive that is not its lock row's, or missing: refused.
C_SHA="$(awk -F'\t' '$1 == "package" { print $5 }' "${C_LOCK}")"
awk -F'\t' 'BEGIN { OFS = "\t" } $1 == "package" { $5 = "0000000000000000000000000000000000000000000000000000000000000000" } { print }' "${C_LOCK}" >"${WORK}/wrong-row.lock"
published "${C}" "${WORK}/wrong-row.lock"
refused "is no layer of its pool" "a lock row that names no layer of its pool"
published "${C}" "${C_LOCK}"
curl -sf -o /dev/null -X DELETE "${REG}/blobs/sha256:${C_SHA}"
refused "does not download anonymously" "a published archive that is missing"

echo "version-guard-test: ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ]
