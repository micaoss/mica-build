#!/usr/bin/env bash
# Are two pools the same payloads? The archives' versions carry the commit,
# so the comparison is of each package's data.tar members (path, mode,
# owner, sha256), not of the archive files.
#
#   bash tools/pool-payload-diff.sh <pool A> <pool B>     (each: _out/debs-like, <arch>/pool/*.deb)
set -euo pipefail
A="${1:?pool A}"; B="${2:?pool B}"
python3 - "$A" "$B" <<'PY'
import hashlib, io, os, sys, tarfile
a, b = sys.argv[1], sys.argv[2]
def members(path):
    data = open(path, 'rb').read(); at = 8; out = {}
    while at + 60 <= len(data):
        name = data[at:at+16].decode('ascii','replace').strip().rstrip('/')
        size = int(data[at+48:at+58].decode('ascii').strip()); body = data[at+60:at+60+size]
        at += 60 + size + (size & 1)
        if not name.startswith('data.tar'): continue
        with tarfile.open(fileobj=io.BytesIO(body), mode='r:*') as t:
            for m in t.getmembers():
                digest = hashlib.sha256(t.extractfile(m).read()).hexdigest() if m.isfile() else (m.linkname if m.issym() else '')
                out[m.name] = (m.type, m.mode, m.uid, m.gid, digest)
    return out
def pools(root):
    found = {}
    for arch in ('amd64', 'arm64'):
        d = os.path.join(root, arch, 'pool')
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if not f.endswith('.deb'): continue
            found[(arch, f.split('_')[0])] = os.path.join(d, f)
    return found
pa, pb = pools(a), pools(b)
bad = 0
for key in sorted(set(pa) | set(pb)):
    if key not in pa or key not in pb:
        print(f'DIFF {key[0]} {key[1]}: only in {"A" if key in pa else "B"}'); bad += 1; continue
    ma, mb = members(pa[key]), members(pb[key])
    if ma == mb:
        print(f'same {key[0]} {key[1]} ({len(ma)} members)')
    else:
        bad += 1
        for p in sorted(set(ma) | set(mb)):
            if ma.get(p) != mb.get(p): print(f'DIFF {key[0]} {key[1]}: {p}: {ma.get(p)} -> {mb.get(p)}')
print('RESULT:', 'PASS' if bad == 0 else f'FAIL ({bad} package(s) differ)')
sys.exit(1 if bad else 0)
PY
