#!/usr/bin/env python3
"""Record the package pool a root is composed from, and verify it on the way in.

Every archive of the pool is a package row of locks/ (as tools/pool.sh rows
--arch prints it), at the locked version, sha256 and source repository; its
source commit is the release row of the lock that pins it. This tree builds no
package, and a package version carries no commit
(mica:docs/decisions/2026-09-15-package-versions.md).

MICA_POOL_UNLOCKED names imported packages whose digest check is waived for
local development; the waiver is recorded in the lineage record, in the image's
identity file, and build/src/release-manifest.ts refuses such an image outside
the development channel.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True

SCHEMA = 'mica/source-lineage/v1'
LOCK_COLUMNS = ('package', 'version', 'architecture', 'sha256', 'source_repo', 'source_commit')


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError('source lineage: ' + message)


def keys(value: object, names: str) -> dict:
    require(isinstance(value, dict) and set(value) == set(names.split()), 'unknown or missing fields')
    return value


def pairs(items: list) -> dict:
    result = {}
    for key, value in items:
        require(key not in result, 'duplicate key: ' + key)
        result[key] = value
    return result


def load(path: Path) -> object:
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16 * 1024 * 1024, 'bounded regular input required')
    return json.loads(path.read_text(), object_pairs_hook=pairs)


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def hex_id(value: str, length: int = 64) -> str:
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value), 'malformed digest')
    return value


def relative(value: str) -> str:
    require(isinstance(value, str) and value and not value.startswith('/')
            and all(p not in ('', '.', '..') for p in value.split('/'))
            and not re.search(r'[\x00-\x1f\x7f]', value), 'unsafe relative path')
    return value


def natural(value: int) -> None:
    require(type(value) is int and 0 <= value <= 0xffffffff, 'invalid epoch')


def package_name(value: str) -> str:
    require(isinstance(value, str) and re.fullmatch('[a-z0-9][a-z0-9+.-]+', value), 'package name')
    return value


def repo_name(value: str) -> str:
    require(isinstance(value, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*', value), 'source repository name')
    return value


def package_version(version: str) -> str:
    """A package's declared Debian version."""
    require(isinstance(version, str) and re.fullmatch(r'[0-9][A-Za-z0-9.+~-]*', version) is not None, 'package version: ' + str(version))
    return version


def command(args: list, cwd: Path | None = None) -> bytes:
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE, timeout=60, env=dict(os.environ, GIT_OPTIONAL_LOCKS='0'))


def git(root: Path, *args: str) -> bytes:
    return command(['git', '-C', str(root), *args])


def tree(root: Path, commit: str) -> dict:
    """Every blob of the commit, and every submodule as a `commit` entry (mode 160000)."""
    result = {}
    for entry in git(root, 'ls-tree', '-rz', commit).split(b'\0'):
        if entry:
            header, name = entry.split(b'\t', 1)
            mode, kind, blob = header.decode().split()
            require((kind == 'blob' and mode in ('100644', '100755', '120000')) or (kind == 'commit' and mode == '160000'), 'unsupported Git object')
            result[name.decode()] = dict(mode=mode, blob=blob)
    return result


def identity(root: Path) -> dict:
    """The checkout's commit, tree and epoch -- after proving the checkout IS that tree."""
    require(root.is_dir(), 'source checkout missing')
    require(not git(root, 'status', '--porcelain', '--untracked-files=all'), 'dirty source checkout')
    commit = git(root, 'rev-parse', 'HEAD').decode().strip()
    for name, entry in tree(root, commit).items():
        path = root / name
        require(path.parent.resolve().is_relative_to(root.resolve()), 'checkout parent escapes source')
        require(entry['mode'] != '160000', 'submodule in the tree: ' + name)
        info = path.lstat()
        mode = '120000' if stat.S_ISLNK(info.st_mode) else ('100755' if info.st_mode & 0o111 else '100644')
        require(stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode), 'unsupported checkout node')
        data = os.readlink(path).encode() if mode == '120000' else path.read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        require(dict(mode=mode, blob=blob) == entry, 'checkout bytes/mode changed: ' + name)
    return dict(commit=hex_id(commit, 40), tree=hex_id(git(root, 'rev-parse', 'HEAD^{tree}').decode().strip(), 40),
                epoch=int(git(root, 'show', '-s', '--format=%ct', 'HEAD')))


def lock_rows(path: Path, arch: str) -> list:
    """The package rows of one pool (tools/pool.sh rows --arch: package, version, architecture, sha256, repository, commit, file), sorted."""
    rows = {}
    for line in path.read_text().splitlines():
        fields = line.split('\t')
        require(len(fields) == 7, 'pool row: ' + line)
        name, version, architecture, sha256, repository, commit, file = fields
        package_name(name); repo_name(repository); hex_id(sha256); hex_id(commit, 40)
        package_version(version)
        require(architecture in (arch, 'all'), 'pool row architecture: ' + name)
        require(file == f'{name}_{version}_{architecture}.deb', 'pool row file name: ' + name)
        require(name not in rows, 'a package has two rows in one pool: ' + name)
        rows[name] = dict(package=name, version=version, architecture=architecture, sha256=sha256, source_repo=repository, source_commit=commit)
    require(rows, 'no pool rows in ' + str(path))
    return [rows[n] for n in sorted(rows)]


def control_fields(archive: Path) -> dict:
    fields = {}
    key = None
    for line in command(['dpkg-deb', '-f', str(archive)]).decode().splitlines():
        if line.startswith((' ', '\t')):
            require(key is not None, 'control continuation')
            fields[key] += '\n' + line
        elif line:
            key, value = line.split(': ', 1)
            require(key not in fields, 'duplicate control field')
            fields[key] = value
    return fields


def pool_identity(pool: Path, arch: str, lock: list, unlocked: list) -> dict:
    """Every archive of the pool, checked against its lock row, with the three index files."""
    require(arch in ('amd64', 'arm64'), 'invalid architecture')
    locked = {row['package']: row for row in lock}
    for name in unlocked:
        require(name in locked, 'MICA_POOL_UNLOCKED names ' + name + ', which the lock does not import')
    files = {p.relative_to(pool).as_posix(): sha(p) for p in sorted(pool.glob('pool/*.deb'))}
    require(files, 'empty pool')
    for name in ('Packages', 'SHA256SUMS', 'manifest.txt'):
        require((pool / name).is_file() and not (pool / name).is_symlink(), 'missing pool index')
        files[name] = sha(pool / name)
    sums = {}
    for line in (pool / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  (pool/[^/]+\.deb)', line)
        require(match is not None and match[2] not in sums, 'invalid or duplicate pool checksum')
        sums[match[2]] = match[1]
    require(sums == {k: v for k, v in files.items() if k.startswith('pool/')}, 'archive checksum membership')
    indexed = {}
    for paragraph in (pool / 'Packages').read_text().strip().split('\n\n'):
        fields = {}
        for line in paragraph.splitlines():
            if line.startswith((' ', '\t')):
                continue
            key, value = line.split(': ', 1)
            require(key not in fields, 'duplicate package index field')
            fields[key] = value
        name = fields['Filename']
        require(name in sums and name not in indexed and fields['SHA256'] == sums[name], 'package index digest/membership')
        indexed[name] = fields
    require(set(indexed) == set(sums), 'package index archive set')
    manifest = []
    for line in (pool / 'manifest.txt').read_text().splitlines():
        if line and not line.startswith('#'):
            manifest.append(line.split('\t'))
    packages = []
    for name in sorted(sums):
        archive = pool / name
        require(archive.is_file() and not archive.is_symlink(), 'regular archive required')
        require(archive.stat().st_mtime_ns <= (pool / 'manifest.txt').stat().st_mtime_ns, 'stale pool index')
        control = command(['dpkg-deb', '--ctrl-tarfile', str(archive)])
        fields = control_fields(archive)
        p, v, a = (fields[k] for k in ('Package', 'Version', 'Architecture'))
        package_name(p)
        require(a in (arch, 'all'), 'archive architecture: ' + p)
        repo = repo_name(fields.get('Mica-Source-Repo', ''))
        require(all(indexed[name][k] == fields[k] for k in ('Package', 'Version', 'Architecture')), 'archive control/index mismatch: ' + p)
        require(p in locked, 'archive not in the lock: ' + p)
        row = locked[p]
        commit = row['source_commit']
        if p not in unlocked:  # the waiver: present, recorded, not compared
            require(v == row['version'] and a == row['architecture'] and sums[name] == row['sha256'], 'locked archive differs from the lock: ' + p)
            require(repo == row['source_repo'], 'locked archive source repository differs from the lock: ' + p)
        require(sum(len(row) == 8 and row[:3] == [p, v, a] and row[4:] == [sums[name], name, repo, commit] for row in manifest) == 1, 'manifest/control membership: ' + p)
        packages.append(dict(package=p, version=v, architecture=a, archive=name, sha256=sums[name],
                             control_sha256=hashlib.sha256(control).hexdigest(), source_repo=repo, source_commit=commit))
    require(len(manifest) == len(packages) and len({p['package'] for p in packages}) == len(packages), 'mixed/duplicate pool')
    present = {p['package'] for p in packages}
    for row in lock:
        require(row['package'] in present, 'locked archive missing from the pool: ' + row['package'])
    return dict(files=dict(sorted(files.items())), packages=packages)


def validate(record: dict, arch: str, epoch: int) -> dict:
    keys(record, 'schema package_source composition_source architecture root_epoch pool lock unlocked')
    require(record['schema'] == SCHEMA and record['architecture'] == arch, 'schema/architecture mismatch')
    require(arch in ('amd64', 'arm64'), 'invalid architecture')
    natural(record['root_epoch']); require(record['root_epoch'] == epoch, 'root epoch mismatch')
    p = keys(record['package_source'], 'commit tree epoch version')
    c = keys(record['composition_source'], 'commit tree epoch')
    for source in (p, c):
        hex_id(source['commit'], 40); hex_id(source['tree'], 40); natural(source['epoch'])
    require({k: p[k] for k in c} == c, 'package and composition source differ')
    require(re.fullmatch(r'[0-9][A-Za-z0-9.~]*\+git' + p['commit'][:12] + '-1', p['version']) is not None, 'tree version/source commit')
    require(isinstance(record['lock'], list), 'lock rows')
    locked = {}
    for row in record['lock']:
        keys(row, ' '.join(LOCK_COLUMNS))
        package_name(row['package']); repo_name(row['source_repo']); hex_id(row['sha256']); hex_id(row['source_commit'], 40)
        package_version(row['version'])
        require(row['architecture'] in (arch, 'all'), 'lock row architecture: ' + row['package'])
        require(row['package'] not in locked, 'duplicate lock row: ' + row['package'])
        locked[row['package']] = row
    require([r['package'] for r in record['lock']] == sorted(locked), 'lock rows unsorted')
    unlocked = record['unlocked']
    require(isinstance(unlocked, list) and unlocked == sorted(set(unlocked)) and all(n in locked for n in unlocked), 'unlocked names')
    pool = keys(record['pool'], 'files packages')
    require(isinstance(pool['files'], dict) and isinstance(pool['packages'], list) and pool['packages'], 'empty lineage pool')
    for path, digest in pool['files'].items():
        relative(path); hex_id(digest)
    expected = {'Packages', 'SHA256SUMS', 'manifest.txt'}
    names = set()
    for row in pool['packages']:
        keys(row, 'package version architecture archive sha256 control_sha256 source_repo source_commit')
        package_name(row['package']); require(row['package'] not in names, 'duplicate package')
        names.add(row['package'])
        require(row['architecture'] in (arch, 'all'), 'package architecture: ' + row['package'])
        require(re.fullmatch(r'pool/[^/]+\.deb', row['archive']) is not None, 'archive path')
        hex_id(row['sha256']); hex_id(row['control_sha256']); repo_name(row['source_repo']); hex_id(row['source_commit'], 40)
        require(pool['files'].get(row['archive']) == row['sha256'] and row['archive'] not in expected, 'pool archive mismatch')
        expected.add(row['archive'])
        require(row['package'] in locked, 'archive not in the lock: ' + row['package'])
        if row['package'] not in unlocked:
            require(all(row[k] == locked[row['package']][k] for k in LOCK_COLUMNS), 'locked archive differs from the lock: ' + row['package'])
    require(set(pool['files']) == expected, 'lineage pool membership')
    require(set(locked) <= names, 'locked archive missing from the pool')
    return record


def create(composition_root: Path, pool: Path, arch: str, epoch: int, rows_path: Path, unlocked: list) -> dict:
    c = identity(composition_root)
    p = dict(c, version=command(['bash', str(composition_root / 'tools/version.sh')]).decode().strip())
    lock = lock_rows(rows_path, arch)
    unlocked = sorted(set(unlocked))
    pool_record = pool_identity(pool, arch, lock, unlocked)
    record = dict(schema=SCHEMA, package_source=p, composition_source=c, architecture=arch, root_epoch=epoch,
                  pool=pool_record, lock=lock, unlocked=unlocked)
    return validate(record, arch, epoch)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--composition-source', type=Path, required=True)
    parser.add_argument('--pool', type=Path, required=True)
    parser.add_argument('--arch', required=True)
    parser.add_argument('--epoch', type=int, required=True)
    parser.add_argument('--rows', type=Path, required=True, help='the package rows of the pool (tools/pool.sh rows --arch)')
    parser.add_argument('--unlocked', default='', help='space-separated MICA_POOL_UNLOCKED names')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        record = create(args.composition_source, args.pool, args.arch, args.epoch, args.rows,
                        args.unlocked.split())
        args.output.write_bytes(canonical(record))
        print(record['package_source']['version'])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'source lineage refused: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
