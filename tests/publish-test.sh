#!/usr/bin/env bash
# The publishers and the lock writer against a real registry, for board releases
# <board>.<YYYYMMDD-HHMM>: tools/deb/publish.sh pushes the board's pool as
# pool.<board>.<arch>.<YYYYMMDD-HHMM>, tools/publish-components.sh its components
# as <component>.<board>.<YYYYMMDD-HHMM>, reusing an unchanged component of the
# board's previous release by digest, and tools/release-lock.sh writes the lock.
# Everything reads back anonymously; a tag holding another digest is refused;
# two boards released in one minute do not collide; the written lock passes the
# lock checker.
#
#   bash tests/publish-test.sh          (docker on the host)
#
# The registry is the upstream registry:3.1.1 image locks/mica-build-env.lock
# lists, a sibling container spoken to over plain HTTP. The scripts run in a
# scratch clone of the working tree, committed and tagged there (the tags never
# leave the clone), over fixture build outputs laid out as outputs.tsv lists them
# and fixture archives of the board's packages. Previous releases are served
# from file://.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
for t in curl sha256sum jq docker git python3; do
    command -v "${t}" >/dev/null 2>&1 || { echo "error: ${t} is required" >&2; exit 1; }
done
mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/publish-test.XXXXXX")"
NAME="ai-agent-publish-test-$$"
cleanup() { docker rm -f "${NAME}" >/dev/null 2>&1 || true; rm -rf "${WORK}"; }
trap cleanup EXIT
PASS_N=0; FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
says() { grep -c -- "$2" "$1" >/dev/null; }

IMAGE="$(bash tools/from.sh --upstream registry:3.1.1)"
docker run -d --rm --label ai-agent=true --name "${NAME}" --network "${MICA_TEST_NETWORK:-traefik}" "${IMAGE}" >/dev/null
for _ in $(seq 1 30); do curl -sf -o /dev/null "http://${NAME}:5000/v2/" && break; sleep 1; done
curl -sf -o /dev/null "http://${NAME}:5000/v2/" || { echo "error: the registry ${NAME} did not answer" >&2; exit 1; }
REG="http://${NAME}:5000/v2"
MT='application/vnd.oci.image.manifest.v1+json'

CLONE="${WORK}/repo"
git clone -q "${REPO_ROOT}" "${CLONE}"
git -C "${CLONE}" remote set-url origin https://example.invalid/testorg/mica-boards.git
# The working tree's tracked files, so an uncommitted change is what is tested.
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "${CLONE}"
git -C "${CLONE}" add -A
[ -z "$(git -C "${CLONE}" status --porcelain)" ] || git -C "${CLONE}" -c user.name=test -c user.email=test@example.invalid commit -qm "the working tree under test"
HEAD="$(git -C "${CLONE}" rev-parse HEAD)"
STAMP=20260101-0000

# Fixture trust certificates (any bytes: they are hashed and carried, not parsed here).
printf 'fixture verity certificate\n' >"${WORK}/verity.pem"
printf 'fixture boot certificate\n' >"${WORK}/boot.pem"
export VERITY_TRUST_CERT="${WORK}/verity.pem" FIT_TRUST_CERT="${WORK}/boot.pem"

# Fixture build outputs for <board>: every kernel and uboot file its outputs.tsv lists, under _out/<board>/.
outputs() { # <board>
    local b="$1" loader p
    loader=uboot; [ "$(sed -n 's/^FIRMWARE_FORMAT=//p' "${CLONE}/boards/${b}/board.env")" != rockchip-loader ] || loader=uboot-mica
    while IFS=$'\t' read -r kind component path; do
        [ "${kind}" = file ] || continue
        case "${component}:${path}" in
        kernel:kernel/*) p="${CLONE}/_out/${b}/${path}" ;;
        uboot:uboot/*) p="${CLONE}/_out/${b}/${loader}/${path#uboot/}" ;;
        uboot:uboot-package/*) p="${CLONE}/_out/${b}/${path}" ;;
        *) continue ;;
        esac
        mkdir -p "$(dirname "${p}")"
        printf 'fixture %s %s\n' "${b}" "${path}" >"${p}"
    done < <(grep -v '^#' "${CLONE}/boards/${b}/outputs.tsv")
}
# A fixture archive of <package> at <arch> and <version>.
deb() { # <out> <package> <arch> <version>
    python3 - "$1" "$2" "$3" "$4" <<'PY'
import io, sys, tarfile
out, package, arch, version = sys.argv[1:5]
def tgz(files):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode='w:gz') as t:
        for name, data in files:
            i = tarfile.TarInfo(name); i.size = len(data); t.addfile(i, io.BytesIO(data))
    return b.getvalue()
control = (f'Package: {package}\nVersion: {version}\nArchitecture: {arch}\n'
           f'Mica-Source-Repo: mica-boards\n').encode()
with open(out, 'wb') as f:
    f.write(b'!<arch>\n')
    for n, d in [('debian-binary', b'2.0\n'), ('control.tar.gz', tgz([('./control', control)])), ('data.tar.gz', tgz([(f'./usr/share/doc/{package}/copyright', b'fixture\n')]))]:
        f.write(f'{n + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(d):<10}`\n'.encode() + d + (b'\n' if len(d) % 2 else b''))
PY
}
for b in uefi-x64 cx3576; do
    outputs "${b}"
    a="$(bash tools/boards.sh arch "${b}")"
    mkdir -p "${CLONE}/_out/debs/${a}/pool"
    while read -r producer _dir arches packages _enablement; do
        V="$(bash tools/deb/producers.sh --version-for "${producer}" | cut -d' ' -f1)"
        arch="${a}"; [ "${arches}" != all ] || arch=all
        for p in ${packages//,/ }; do
            [ -f "${CLONE}/_out/debs/${a}/pool/${p}_${V}_${arch}.deb" ] || deb "${CLONE}/_out/debs/${a}/pool/${p}_${V}_${arch}.deb" "${p}" "${arch}" "${V}"
        done
    done < <(bash tools/boards.sh producers "${b}")
done

# Previous releases, served from file://: <dir>/releases.json and <dir>/download/<tag>/mica-boards.lock.
RELEASES="${WORK}/releases"
mkdir -p "${RELEASES}/download"
echo '[]' >"${RELEASES}/releases.json"
remember() { # <tag> <lock>: a published release the next one may reuse from
    mkdir -p "${RELEASES}/download/$1"
    cp "$2" "${RELEASES}/download/$1/mica-boards.lock"
    jq --arg t "$1" '. + [{tag_name: $t, draft: false, assets: [{name: "mica-boards.lock"}, {name: "SHA256SUMS"}]}]' "${RELEASES}/releases.json" >"${RELEASES}/r.json"
    mv "${RELEASES}/r.json" "${RELEASES}/releases.json"
}

# run <owner> <tag> <log> <script>: the script in the clone, for the release <tag>, against <registry>/<owner>.
run() {
    cat >"${WORK}/registry.env" <<ENV
MICA_REGISTRY=${NAME}:5000/$1
MICA_REGISTRY_USER=nobody
MICA_RELEASE_TOKEN_VAR=PUBLISH_TEST_TOKEN
MICA_SOURCE_URL=https://example.invalid/testorg
ENV
    local rows="${WORK}/rows-$1-${2//\//-}"
    (cd "${CLONE}" && MICA_REGISTRY_ENV="${WORK}/registry.env" MICA_REGISTRY_PLAIN_HTTP=1 MICA_RELEASE_NO_GH=1 PUBLISH_TEST_TOKEN=fixture \
        MICA_RELEASE_TAG="$2" MICA_LOCK_ROWS="${rows}" MICA_RELEASE_OUT="${rows}/out" MICA_LOCK_REGISTRY=ghcr.io/micaoss \
        MICA_RELEASE_LIST="file://${RELEASES}/releases.json" MICA_RELEASE_DOWNLOAD="file://${RELEASES}/download" \
        bash $4) >"$3" 2>&1
}
release() { # <owner> <tag>: pool, components, lock
    run "$1" "$2" "${WORK}/$1-${2//\//-}-pool.log" tools/deb/publish.sh &&
        run "$1" "$2" "${WORK}/$1-${2//\//-}-components.log" tools/publish-components.sh &&
        run "$1" "$2" "${WORK}/$1-${2//\//-}-lock.log" "tools/release-lock.sh write"
}
lock_of() { echo "${WORK}/rows-$1-${2//\//-}/out/mica-boards.lock"; }
served() { echo "sha256:$(curl -sf -H "Accept: ${MT}" "${REG}/$1/mica-boards/manifests/$2" | sha256sum | cut -d' ' -f1)"; } # <owner> <tag>

# 0. Only a release publishes.
if run notag "uefi-x64.${STAMP}" "${WORK}/notag.log" tools/publish-components.sh; then fail "a checkout without the release tag published"
elif says "${WORK}/notag.log" "carries no release tag"; then pass "no release tag on HEAD: refused"
else fail "no release tag: $(tail -n2 "${WORK}/notag.log")"; fi
git -C "${CLONE}" tag "uefi-x64.${STAMP}"
git -C "${CLONE}" tag "cx3576.${STAMP}"
if run othertag "uefi-x64.20260101-0001" "${WORK}/othertag.log" tools/publish-components.sh; then fail "a release event naming another tag published"
elif says "${WORK}/othertag.log" "the release event names uefi-x64.20260101-0001"; then pass "a release event naming another tag: refused"
else fail "other release tag: $(tail -n2 "${WORK}/othertag.log")"; fi

# 1. Two first releases in one minute: every component built and published, locks valid.
for b in uefi-x64 cx3576; do
    tag="${b}.${STAMP}"; a="$(bash tools/boards.sh arch "${b}")"; L="$(lock_of one "${tag}")"
    if release one "${tag}"; then pass "${tag}: pool, components and lock published"
    else fail "${tag}: $(tail -n3 "${WORK}/one-${b}.${STAMP}-pool.log" "${WORK}/one-${b}.${STAMP}-components.log" "${WORK}/one-${b}.${STAMP}-lock.log" 2>/dev/null)"; continue; fi
    [ "$(bash tools/check-lock.sh lock "${L}")" = valid ] && pass "${tag}: the lock passes tools/check-lock.sh" || fail "${tag}: the lock is $(bash tools/check-lock.sh lock "${L}")"
    if [ -f "${REPO_ROOT}/../mica/tools/docs/release-lock-check.py" ]; then
        [ "$(python3 "${REPO_ROOT}/../mica/tools/docs/release-lock-check.py" lock "${L}")" = valid ] && pass "${tag}: the lock passes the specification's reference checker" || fail "${tag}: reference checker: $(python3 "${REPO_ROOT}/../mica/tools/docs/release-lock-check.py" lock "${L}")"
    fi
    [ "$(sed -n 2p "${L}")" = "$(printf 'release\tmica-boards\t%s\t%s' "${tag}" "${HEAD}")" ] && pass "${tag}: the release row" || fail "${tag}: release row $(sed -n 2p "${L}")"
    [ "$(grep '^pool' "${L}")" = "$(printf 'pool\t%s\tghcr.io/micaoss/mica-boards:pool.%s.%s.%s@%s' "${a}" "${b}" "${a}" "${STAMP}" "$(served one "pool.${b}.${a}.${STAMP}")")" ] && pass "${tag}: one pool row at the served digest" || fail "${tag}: pool rows $(grep '^pool' "${L}")"
    why=""
    for c in $(bash tools/component.sh list "${b}"); do
        grep -qxF "$(printf 'board\t%s\t%s\t%s\tghcr.io/micaoss/mica-boards:%s.%s.%s@%s' "${b}" "${c}" "${a}" "${c}" "${b}" "${STAMP}" "$(served one "${c}.${b}.${STAMP}")")" "${L}" || why="${why} ${c}:row"
        m="$(curl -sf -H "Accept: ${MT}" "${REG}/one/mica-boards/manifests/${c}.${b}.${STAMP}")"
        [ "$(jq -r '.annotations["mica.component"] + " " + .annotations["mica.inputs"]' <<<"${m}")" = "${c} $(cd "${CLONE}" && bash tools/inputs.sh "${b}" "${c}")" ] || why="${why} ${c}:inputs"
        [ "$(jq -r '[.layers[].annotations["org.opencontainers.image.title"]] | sort | join(" ")' <<<"${m}")" = "$(bash tools/boards.sh files "${b}" "${c}" | sed 's|^firmware/.*|firmware.tar|' | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')" ] || why="${why} ${c}:layers"
    done
    [ "$(grep -c '^board' "${L}")" = "$(bash tools/component.sh list "${b}" | wc -l)" ] || why="${why} count"
    [ -z "${why}" ] && pass "${tag}: one board row per component at its served digest, annotated with its inputs, its layers its outputs.tsv files" || fail "${tag}: board rows:${why}"
    [ "$(grep '^package' "${L}" | cut -f2 | sort | tr '\n' ' ')" = "$(bash tools/boards.sh packages "${b}" | sort | tr '\n' ' ')" ] && pass "${tag}: package rows are its outputs.tsv packages" || fail "${tag}: package rows $(grep '^package' "${L}")"
done
[ "$(curl -sf "${REG}/one/mica-boards/tags/list" | jq -r '.tags | length')" = 8 ] && pass "two boards in one minute: eight distinct tags" || fail "tags: $(curl -s "${REG}/one/mica-boards/tags/list")"

# 2. The next uefi-x64 release with unchanged inputs reuses every component by digest.
remember "uefi-x64.${STAMP}" "$(lock_of one "uefi-x64.${STAMP}")"
NEXT=20260101-0100
git -C "${CLONE}" tag "uefi-x64.${NEXT}"
if release one "uefi-x64.${NEXT}" && says "${WORK}/one-uefi-x64.${NEXT}-components.log" "0 component(s) published, 2 reused"; then pass "unchanged inputs: every component reused, none built"
else fail "reuse: $(tail -n3 "${WORK}/one-uefi-x64.${NEXT}-components.log")"; fi
for c in board kernel; do
    [ "$(served one "${c}.uefi-x64.${NEXT}")" = "$(served one "${c}.uefi-x64.${STAMP}")" ] && pass "the reused ${c} tag names the published digest" || fail "${c}.uefi-x64.${NEXT} is another digest"
done
[ "$(served one "pool.uefi-x64.amd64.${NEXT}")" = "$(served one "pool.uefi-x64.amd64.${STAMP}")" ] && pass "unchanged archives: the next release's pool tag is the published pool digest" || fail "pool.uefi-x64.amd64.${NEXT} is another digest"
m="$(curl -sf -H "Accept: ${MT}" "${REG}/one/mica-boards/manifests/pool.uefi-x64.amd64.${STAMP}")"
[ "$(jq -c '.annotations' <<<"${m}")" = '{"mica.source-repo":"mica-boards","mica.arch":"amd64"}' ] &&
    [ "$(jq -r '.layers[0].annotations["mica.inputs"]' <<<"${m}")" = "$(cd "${CLONE}" && bash tools/deb/package-inputs.sh board@uefi-x64 amd64)" ] &&
    pass "a pool manifest carries only mica.source-repo and mica.arch, each layer its title and mica.inputs" || fail "pool annotations: $(jq -c '[.annotations, .layers[0].annotations]' <<<"${m}")"
[ "$(bash tools/check-lock.sh lock "$(lock_of one "uefi-x64.${NEXT}")")" = valid ] && pass "the reusing release's lock is valid" || fail "reusing lock: $(bash tools/check-lock.sh lock "$(lock_of one "uefi-x64.${NEXT}")")"

# 3. The next cx3576 release with another boot certificate rebuilds only its uboot.
remember "cx3576.${STAMP}" "$(lock_of one "cx3576.${STAMP}")"
git -C "${CLONE}" tag "cx3576.${NEXT}"
printf 'another boot certificate\n' >"${WORK}/boot2.pem"
if FIT_TRUST_CERT="${WORK}/boot2.pem" release one "cx3576.${NEXT}" && says "${WORK}/one-cx3576.${NEXT}-components.log" "1 component(s) published, 3 reused"; then pass "a changed U-Boot input: uboot published, board, kernel and firmware reused"
else fail "partial reuse: $(tail -n4 "${WORK}/one-cx3576.${NEXT}-components.log")"; fi
[ "$(served one "uboot.cx3576.${NEXT}")" != "$(served one "uboot.cx3576.${STAMP}")" ] && [ "$(served one "kernel.cx3576.${NEXT}")" = "$(served one "kernel.cx3576.${STAMP}")" ] &&
    pass "uboot is a new digest, kernel the published one" || fail "uboot/kernel digests after a boot certificate change"

# 4. Refusals (no previous release to reuse from).
echo '[]' >"${RELEASES}/releases.json"
curl -sf -H "Accept: ${MT}" "${REG}/one/mica-boards/manifests/kernel.uefi-x64.${STAMP}" | jq -c '.annotations["mica.arch"] = "other"' >"${WORK}/edited.json"
git -C "${CLONE}" tag "uefi-x64.20260101-0200"
curl -s -o /dev/null -X PUT -H "Content-Type: ${MT}" --data-binary "@${WORK}/edited.json" "${REG}/one/mica-boards/manifests/kernel.uefi-x64.20260101-0200"
if run one "uefi-x64.20260101-0200" "${WORK}/two.log" tools/publish-components.sh; then fail "a component tag holding another digest was published over"
elif says "${WORK}/two.log" "a published tag is never re-pointed"; then pass "a component tag holding another digest: refused"
else fail "component tag with another digest: $(tail -n2 "${WORK}/two.log")"; fi
curl -sf -H "Accept: ${MT}" "${REG}/one/mica-boards/manifests/pool.uefi-x64.amd64.${STAMP}" | jq -c '.annotations["mica.arch"] = "other"' >"${WORK}/pool-edited.json"
curl -s -o /dev/null -X PUT -H "Content-Type: ${MT}" --data-binary "@${WORK}/pool-edited.json" "${REG}/one/mica-boards/manifests/pool.uefi-x64.amd64.20260101-0200"
if run one "uefi-x64.20260101-0200" "${WORK}/two-pool.log" tools/deb/publish.sh; then fail "a pool tag holding another digest was published over"
elif says "${WORK}/two-pool.log" "a published tag is never re-pointed"; then pass "a pool tag holding another digest: refused"
else fail "pool tag with another digest: $(tail -n2 "${WORK}/two-pool.log")"; fi
git -C "${CLONE}" tag "uefi-x64.20260101-0300"
rm "${CLONE}/_out/uefi-x64/kernel/config"
if run three "uefi-x64.20260101-0300" "${WORK}/three.log" tools/publish-components.sh; then fail "a kernel component missing a listed file was published"
elif says "${WORK}/three.log" "missing kernel/config"; then pass "a component without a file its outputs.tsv lists: refused"
else fail "missing component file: $(tail -n2 "${WORK}/three.log")"; fi
rm "${CLONE}"/_out/debs/amd64/pool/mica-board-uefi-x64_*.deb
if run three "uefi-x64.20260101-0300" "${WORK}/three-pool.log" tools/deb/publish.sh; then fail "a pool without a listed archive was published"
elif says "${WORK}/three-pool.log" "exactly one mica-board-uefi-x64 archive"; then pass "a pool without an archive its outputs.tsv lists: refused"
else fail "pool without a listed archive: $(tail -n2 "${WORK}/three-pool.log")"; fi
rm -f "${WORK}/rows-one-uefi-x64.${NEXT}/board.tsv"
if run one "uefi-x64.${NEXT}" "${WORK}/noboard.log" "tools/release-lock.sh write"; then fail "a lock was written without its board rows"
elif says "${WORK}/noboard.log" "board.tsv does not exist"; then pass "a lock without the board rows: refused"
else fail "lock without board rows: $(tail -n2 "${WORK}/noboard.log")"; fi

echo "publish-test: ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ]
