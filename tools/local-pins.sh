#!/usr/bin/env bash
# Pins for a local build: a sibling checkout's own pools stand in for its release.
#
#   bash tools/local-pins.sh <repository> <checkout>
#
#   reads   <checkout>/_out/debs/<amd64|arm64>/{pool/*.deb,SHA256SUMS}   (the repository's own indexed build)
#   writes  <checkout>/_out/offline/{<repository>.lock,oci/,SHA256SUMS}  (its offline lock, mica:docs/design/release-lock.md 6)
#           locks/<repository>.lock and locks/pins/<repository>.pin     (the offline pin, section 7)
#
# THIS IS NEVER A RELEASE INPUT. An offline pin names its CHECKOUT, which
# tools/locks.py refuses under CI and tools/product-build.sh --release refuses.
# The composer binds a root to a clean commit, so a local build commits the
# lock and pin on a local branch of its own, which is never pushed.
#
# UNTIL THE PRODUCERS' `make offline` WRITES _out/offline/ ITSELF, this packs
# the checkout's indexed pools into that layout: one OCI image layout with a
# pool manifest per architecture (application/vnd.mica.pool, one
# application/vnd.mica.deb layer per archive titled with its file name) and, for
# mica-boards, a board artifact per mica-kernel-<board> archive (the bundle
# under /usr/lib/mica/board/<board>/, one layer per file, firmware/ as one tar),
# as the releases publish them. The references are local/<repository>:<kind>.offline.
# Every archive must come from one commit, the checkout's clean HEAD.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
die() { echo "local-pins.sh: error: $*" >&2; exit 1; }

REPOSITORY="${1:-}"; CHECKOUT="${2:-}"
[[ "${REPOSITORY}" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [ -n "${CHECKOUT}" ] || die "usage: bash tools/local-pins.sh <repository> <checkout>"
[ -z "${CI:-}${GITHUB_ACTIONS:-}" ] || die "an offline pin is never written under CI"
CHECKOUT="$(cd "${CHECKOUT}" && pwd)" || die "${2} is not a directory"
[ "${CHECKOUT}" != "${REPO_ROOT}" ] || die "the checkout is this tree"
COMMIT="$(git -C "${CHECKOUT}" rev-parse HEAD)" || die "${CHECKOUT} is not a git checkout"
[ -z "$(git -C "${CHECKOUT}" status --porcelain)" ] || die "${CHECKOUT} has uncommitted changes; an offline lock names a clean commit"

mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.local-pins.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
: >"${WORK}/fields"
image="$(bash "${HERE}/from.sh" --ref mica-build-env:base)"
for pool in amd64 arm64; do
    [ -d "${CHECKOUT}/_out/debs/${pool}/pool" ] || continue
    # The pool as its build indexed it: exactly the archives its SHA256SUMS lists, at those digests.
    [ -f "${CHECKOUT}/_out/debs/${pool}/SHA256SUMS" ] || die "${CHECKOUT}/_out/debs/${pool} has no SHA256SUMS; index the pool in ${CHECKOUT} first"
    (cd "${CHECKOUT}/_out/debs/${pool}" && sha256sum --quiet -c SHA256SUMS) || die "${CHECKOUT}/_out/debs/${pool}/pool does not match its SHA256SUMS"
    [ "$(sed 's/^[0-9a-f]\{64\}  //' "${CHECKOUT}/_out/debs/${pool}/SHA256SUMS" | LC_ALL=C sort)" = "$(cd "${CHECKOUT}/_out/debs/${pool}" && find pool -maxdepth 1 -name '*.deb' | LC_ALL=C sort)" ] ||
        die "${CHECKOUT}/_out/debs/${pool}/pool holds other archives than its SHA256SUMS lists"
    # mica-build-side: container-block -- dpkg-deb runs in mica-build-env:base.
    docker run --rm --label ai-agent=true --network none -v "${CHECKOUT}/_out/debs/${pool}/pool:/pool:ro" -e "POOL=${pool}" "${image}" \
        bash -c 'set -euo pipefail; cd /pool; for f in *.deb; do [ -e "$f" ] || continue; printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$POOL" "$f" "$(dpkg-deb -f "$f" Package)" "$(dpkg-deb -f "$f" Version)" "$(dpkg-deb -f "$f" Architecture)" "$(dpkg-deb -f "$f" Mica-Source-Repo)" "$(dpkg-deb -f "$f" Mica-Source-Commit)"; done' >>"${WORK}/fields"
    # mica-build-side: host
done
awk -F'\t' -v r="${REPOSITORY}" '$6 == r' "${WORK}/fields" >"${WORK}/own"
[ -s "${WORK}/own" ] || die "${CHECKOUT}/_out/debs holds no archive whose Mica-Source-Repo is ${REPOSITORY}"
while IFS=$'\t' read -r pool file name version arch _ commit; do
    [ "${commit}" = "${COMMIT}" ] || die "${pool}/pool/${file} was built from ${commit:-no commit}, and ${CHECKOUT} is at ${COMMIT}"
    [ "${file}" = "${name}_${version}_${arch}.deb" ] || die "${pool}/pool/${file} is not named ${name}_${version}_${arch}.deb"
done <"${WORK}/own"

rm -rf "${CHECKOUT}/_out/offline"
python3 - "${REPOSITORY}" "${CHECKOUT}" "${COMMIT}" "$(git -C "${CHECKOUT}" show -s --format=%cI HEAD)" "${WORK}/own" <<'PY'
import hashlib, io, json, os, sys, tarfile
repository, checkout, commit, created, own = sys.argv[1:6]
out = os.path.join(checkout, '_out', 'offline')
blobs = os.path.join(out, 'oci', 'blobs', 'sha256')
os.makedirs(blobs)

def blob(data):
    digest = hashlib.sha256(data).hexdigest()
    with open(os.path.join(blobs, digest), 'wb') as f:
        f.write(data)
    return digest, len(data)

empty, _ = blob(b'{}')
source = {'org.opencontainers.image.revision': commit, 'org.opencontainers.image.created': created,
          'org.opencontainers.image.source': f'https://github.com/micaoss/{repository}', 'org.opencontainers.image.version': 'offline',
          'mica.source-repo': repository, 'mica.source-commit': commit}
index, rows = [], []

def manifest(tag, artifact, layers, annotations):
    body = json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'artifactType': artifact,
                       'config': {'mediaType': 'application/vnd.oci.empty.v1+json', 'digest': 'sha256:' + empty, 'size': 2},
                       'layers': layers, 'annotations': annotations}, sort_keys=True, separators=(',', ':')).encode()
    digest, size = blob(body)
    index.append({'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': 'sha256:' + digest, 'size': size,
                  'annotations': {'org.opencontainers.image.ref.name': tag}})
    return f'local/{repository}:{tag}@sha256:{digest}'

def data_tar(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'!<arch>\n', path
    at = 8
    while at + 60 <= len(data):
        name = data[at:at + 16].decode('ascii', 'replace').strip().rstrip('/')
        size = int(data[at + 48:at + 58].decode('ascii').strip())
        if name.startswith('data.tar'):
            return tarfile.open(fileobj=io.BytesIO(data[at + 60:at + 60 + size]), mode='r:*')
        at += 60 + size + (size & 1)
    raise SystemExit(f'local-pins.sh: error: {path} carries no data.tar member it can read')

archives = [line.rstrip('\n').split('\t') for line in open(own)]
packages, kernels = [], []
for pool in ('amd64', 'arm64'):
    layers = []
    for p, file, name, version, arch, _, _ in sorted(a for a in archives if a[0] == pool):
        path = os.path.join(checkout, '_out', 'debs', pool, 'pool', file)
        digest, size = blob(open(path, 'rb').read())
        layers.append({'mediaType': 'application/vnd.mica.deb', 'digest': 'sha256:' + digest, 'size': size,
                       'annotations': {'org.opencontainers.image.title': file}})
        packages.append(['package', name, pool, version, digest])
        if name.startswith('mica-kernel-'):
            kernels.append((name[len('mica-kernel-'):], pool, path))
    if layers:
        rows.append(['pool', pool, manifest(f'pool.{pool}.offline', 'application/vnd.mica.pool', layers, dict(source, **{'mica.arch': pool}))])

def kind(title):
    top = title.split('/')[0]
    return {'board.env': 'env', 'evidence.json': 'evidence', 'manifests': 'manifest', 'kernel': 'kernel', 'uboot': 'uboot', 'trust': 'trust'}.get(top, 'file')

boards = []
for board, arch, path in sorted(kernels):
    prefix, files = f'usr/lib/mica/board/{board}/', {}
    with data_tar(path) as tar:
        for m in tar.getmembers():
            rel = m.name.lstrip('./')
            if rel.startswith(prefix) and m.isfile():
                files[rel[len(prefix):]] = tar.extractfile(m).read()
    if 'trust/verity-signer.cert.pem' not in files:
        raise SystemExit(f'local-pins.sh: error: {path} carries no bundle under /{prefix} with trust/verity-signer.cert.pem')
    firmware = sorted(t for t in files if t.startswith('firmware/'))
    if firmware:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w', format=tarfile.GNU_FORMAT) as tar:
            for t in firmware:
                info = tarfile.TarInfo(t); info.size = len(files[t]); info.mode = 0o644; info.mtime = 0
                tar.addfile(info, io.BytesIO(files.pop(t)))
        files['firmware.tar'] = buf.getvalue()
    layers = []
    for title in sorted(files):
        digest, size = blob(files[title])
        layers.append({'mediaType': 'application/vnd.mica.board.' + kind(title), 'digest': 'sha256:' + digest, 'size': size,
                       'annotations': {'org.opencontainers.image.title': title}})
    annotations = dict(source, **{'mica.board': board, 'mica.arch': arch, 'mica.verity-cert-sha256': hashlib.sha256(files['trust/verity-signer.cert.pem']).hexdigest()})
    boards.append(['board', board, arch, manifest(f'board.{board}.offline', 'application/vnd.mica.board', layers, annotations)])

with open(os.path.join(out, 'oci', 'oci-layout'), 'w') as f:
    f.write('{"imageLayoutVersion":"1.0.0"}\n')
with open(os.path.join(out, 'oci', 'index.json'), 'w') as f:
    json.dump({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': index}, f, sort_keys=True)
key = lambda r: tuple(k.encode() for k in r[1:3])
lock = [['release', repository, 'offline', commit]] + sorted(rows, key=key) + sorted(packages, key=key) + sorted(boards, key=lambda r: r[1].encode())
text = '# mica-lock v1\n' + ''.join('\t'.join(r) + '\n' for r in lock)
with open(os.path.join(out, repository + '.lock'), 'w') as f:
    f.write(text)
with open(os.path.join(out, 'SHA256SUMS'), 'w') as f:
    f.write(f'{hashlib.sha256(text.encode()).hexdigest()}  {repository}.lock\n')
PY

mkdir -p "${REPO_ROOT}/locks/pins"
cp "${CHECKOUT}/_out/offline/${REPOSITORY}.lock" "${REPO_ROOT}/locks/${REPOSITORY}.lock"
printf '# mica-pin v1\nREPOSITORY=%s\nRELEASE=offline\nSHA256SUMS=%s\nCHECKOUT=%s\n' "${REPOSITORY}" \
    "$(sha256sum "${CHECKOUT}/_out/offline/SHA256SUMS" | cut -d' ' -f1)" "${CHECKOUT}" >"${REPO_ROOT}/locks/pins/${REPOSITORY}.pin"
# The boards' old form (tools/locks.py legacy_boards) gives way to their lock.
if [ "${REPOSITORY}" = mica-boards ] && [ -f "${REPO_ROOT}/deps/releases/mica-boards.json" ]; then
    rm -rf "${REPO_ROOT}/deps"
fi
python3 "${HERE}/locks.py" check >/dev/null
bash "${HERE}/pool.sh" rows >/dev/null
n="$(python3 "${HERE}/locks.py" rows package "${REPOSITORY}" | cut -f2 | sort -u | grep -c .)"
echo "local-pins.sh: ${n} package(s) of ${REPOSITORY} pinned offline at ${COMMIT} from ${CHECKOUT}/_out/offline (local only; never a release input)"
