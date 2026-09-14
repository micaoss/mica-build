#!/usr/bin/env python3
"""One member of a Debian binary package's payload, read without dpkg.

    python3 tools/deb-member.py <archive.deb> <path> [<out>]

Writes the payload member at <path> (as installed, e.g.
usr/share/mica-podman/versions.env) to <out>, or to stdout when <out> is
absent. The archive is `ar`; data.tar is gzip, xz or uncompressed -- what
dpkg-deb writes and what the standard library reads. A path the payload
does not carry, a directory, or a symlink is a refusal by name: the callers
compare what an imported archive holds with what this tree commits, and
"nothing" must never stand in for a file.

Host-side reader of a Debian archive member: dpkg-deb is not on the host, and the host toolchain
lint keeps it that way.
"""
import io
import os
import sys
import tarfile


def members(path):
    data = open(path, 'rb').read()
    if data[:8] != b'!<arch>\n':
        raise SystemExit(f'error: {path} is not an ar archive, so not a Debian binary package')
    at = 8
    while at + 60 <= len(data):
        name = data[at:at + 16].decode('ascii', 'replace').strip().rstrip('/')
        size = int(data[at + 48:at + 58].decode('ascii').strip())
        yield name, data[at + 60:at + 60 + size]
        at += 60 + size + (size & 1)


def payload_member(archive, wanted):
    for name, body in members(archive):
        if name.startswith('data.tar'):
            if name.endswith(('.zst', '.lz4', '.bz2')):
                raise SystemExit(f'error: {archive} compresses its payload as {name}; only data.tar, .gz and .xz are read here')
            with tarfile.open(fileobj=io.BytesIO(body), mode='r:*') as tar:
                for member in tar.getmembers():
                    if member.name.lstrip('./') != wanted:
                        continue
                    if not member.isfile():
                        raise SystemExit(f'error: {archive}: {wanted} is not a regular file in the payload (it is a {member.type!r} entry)')
                    return tar.extractfile(member).read(), member.mode
            raise SystemExit(f'error: {archive} carries no {wanted} in its payload')
    raise SystemExit(f'error: {archive} carries no data.tar member')


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit('usage: deb-member.py <archive.deb> <path> [<out>]')
    archive, wanted = sys.argv[1], sys.argv[2].lstrip('/')
    body, mode = payload_member(archive, wanted)
    if len(sys.argv) == 4:
        out = sys.argv[3]
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        with open(out, 'wb') as f:
            f.write(body)
        os.chmod(out, mode & 0o777)
    else:
        sys.stdout.buffer.write(body)


if __name__ == '__main__':
    main()
