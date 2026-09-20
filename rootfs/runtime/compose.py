#!/usr/bin/env python3
"""Connect disposable installation, explicit runtime selection and rootfs reports."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True

# Avoid shadowing the standard-library select extension when imported by tooling.
spec = importlib.util.spec_from_file_location('runtime_selector', Path(__file__).with_name('select.py'))
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
require = selector.require
lineage_spec = importlib.util.spec_from_file_location('source_lineage', Path(__file__).with_name('source-lineage.py'))
lineage = importlib.util.module_from_spec(lineage_spec)
lineage_spec.loader.exec_module(lineage)

# debootstrap setup_devices_simple creates these in the disposable installation.
# Capture their identity for transfer checks; runtime selection stays strict.
BOOTSTRAP_DEVICES = {
    '/dev/console': (5, 1), '/dev/full': (1, 7), '/dev/null': (1, 3), '/dev/ptmx': (5, 2),
    '/dev/random': (1, 8), '/dev/tty': (5, 0), '/dev/urandom': (1, 9), '/dev/zero': (1, 5),
}


def snapshot(root: Path) -> dict:
    rows = {}
    groups = {}
    for path in selector.tree_paths(root):
        if path == '/mica-build-inputs' or path.startswith('/mica-build-inputs/'):
            continue
        at = root / path.lstrip('/')
        st = at.lstat()
        if stat.S_ISCHR(st.st_mode) and path in BOOTSTRAP_DEVICES:
            numbers = os.major(st.st_rdev), os.minor(st.st_rdev)
            require(numbers == BOOTSTRAP_DEVICES[path] and stat.S_IMODE(st.st_mode) == 0o666
                    and st.st_uid == 0 and st.st_gid == 0, f'bootstrap device identity changed: {path}')
            row = dict(type='bootstrap-character-device', major=numbers[0], minor=numbers[1],
                       mode=stat.S_IMODE(st.st_mode), uid=st.st_uid, gid=st.st_gid, mtime_ns=st.st_mtime_ns,
                       xattrs={name: os.getxattr(at, name, follow_symlinks=False).hex()
                               for name in os.listxattr(at, follow_symlinks=False)})
        else:
            row = selector.metadata(at)
        if row['type'] == 'file':
            st = at.stat()
            row['hardlink'] = groups.setdefault((st.st_dev, st.st_ino), path)
        rows[path] = row
    return rows


def write_json(path: Path, data: dict) -> None:
    with path.open('x') as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write('\n')


def archives(inputs: Path, packages: dict) -> dict:
    """Join existing lock rows and pool control records; never resolve packages."""
    records = {}

    def add(name: str, version: str, arch: str, digest: str, source: str) -> None:
        require(name not in records, f'ambiguous archive identity: {name}')
        require(re.fullmatch('[0-9a-f]{64}', digest), f'invalid archive identity: {name}')
        records[name] = dict(package=name, version=version, architecture=arch, archive_sha256=digest, archive=source)

    for line in (inputs / 'upstream.tsv').read_text().splitlines():
        fields = line.split('\t')
        require(len(fields) == 6, 'invalid upstream archive identity')
        name, version, arch, digest, url, _ = fields
        add(name, version, arch, digest, url)
    selected = (inputs / 'selected.pkgs').read_text().splitlines()
    for paragraph in (inputs / 'Packages').read_text().strip().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Package') in selected:
            add(fields['Package'], fields['Version'], fields['Architecture'], fields['SHA256'], fields['Filename'])
    for name, package in packages.items():
        require(name in records and all(records[name][k] == package[k] for k in ('version', 'architecture')), f'missing or mismatched archive identity: {name}')
    require(set(records) == set(packages), 'archive identity set differs from installed inventory')
    sources = {}
    for line in (inputs / 'sources.tsv').read_text().splitlines():
        fields = line.split('\t')
        require(len(fields) == 3 and all(fields) and fields[0] not in sources, 'invalid native source identity')
        sources[fields[0]] = dict(package=fields[1], version=fields[2])
    require(set(sources) == set(packages), 'native source identity set differs from inventory')
    for name, record in records.items():
        record['source'] = sources[name]
    return records


def generated_rules(engine: selector.Selector, inputs: Path, configured: dict) -> dict:
    """Resolve exact native installer outputs, never select an unowned subtree."""
    rules = engine.declarations
    roots = rules['consumers']['mica-system']['roots']
    public_producer = 'rootfs/build.sh public-meta staging; compose-install.sh meta_install'
    public_rules = [r for r in roots if r.get('generated') == public_producer]
    if public_rules:
        manifest = '/usr/share/mica/meta/updates/manifest.json'
        product = '/usr/lib/mica/product.conf'
        marker = '/usr/share/mica/meta/GENERATED'
        # Two declared public files -- the manifest and the product record --
        # and the marker, declared here when captured.
        declared = {r['paths'][0]: r for r in public_rules if len(r['paths']) == 1}
        require(len(public_rules) == 2 and set(declared) == {manifest, product}, 'ambiguous public metadata declaration')
        for directory in ['/usr/share/mica/meta', '/usr/share/mica/meta/updates', '/usr/lib/mica']:
            require(configured.get(directory, {}).get('type') == 'directory' and engine.at(directory).is_dir()
                    and not engine.at(directory).is_symlink(), f'public metadata directory changed: {directory}')
        for path in [manifest, product, marker]:
            original = configured.get(path)
            at = engine.at(path)
            if path == marker and original is None:
                require(not at.exists() and not at.is_symlink(), 'uncaptured public metadata marker')
                continue
            require(original and original['type'] == 'file' and original['size'] > 0,
                    f'public metadata capture must be a nonempty regular file: {path}')
            require(at.is_file() and not at.is_symlink() and selector.sha256(at) == original['sha256'],
                    f'public metadata changed after capture: {path}')
            expected = dict(mode=0o644, uid=0, gid=0, sha256=original['sha256'])
            if path in declared:
                declared[path]['expect'] = expected
            else:
                roots.append(dict(paths=[path], kind='resource', reason='captured nonempty public development marker',
                                  generated=public_producer, expect=expected))
    for directory, manifest, pattern in [('alternatives', 'alternative-names.txt', '*'), ('enablement', 'enablement-names.txt', '*.dsh-also')]:
        names = (inputs / manifest).read_text().splitlines()
        files = list((inputs / directory).glob(pattern))
        require(len(names) == len(set(names)) and set(names) == {p.name for p in files}
                and all(p.is_file() and not p.is_symlink() for p in files), f'captured native outputs changed: {directory}')

    def generated(path: str, producer: str, target: str | None = None) -> None:
        require(path == selector.normalized(path), f'invalid generated path: {path}')
        row = dict(paths=[path], kind='resource', reason='captured native installer output', generated=producer)
        if target is not None:
            physical, _ = engine.resolve(path, follow_leaf=False)
            require(engine.at(physical).is_symlink(), f'generated link must be a symlink: {path}')
            row['expect'] = dict(target=target)
        roots.append(row)

    for file in sorted((inputs / 'alternatives').iterdir()):
        text = file.read_text()
        paragraphs = text.strip().split('\n\n')
        header = dict(line.split(': ', 1) for line in paragraphs[0].splitlines() if ': ' in line and not line.startswith(' '))
        name, link, value = header['Name'], header['Link'], header['Value']
        require(re.fullmatch('[A-Za-z0-9+_.-]+', name) and name == file.name, 'invalid alternative name')
        producer = f'update-alternatives --query {name}; captured native dpkg state'
        generated(link, producer, '/etc/alternatives/' + name)
        generated('/etc/alternatives/' + name, producer, value)
        # The header names slave links; the selected alternative names targets.
        selected = [p for p in paragraphs[1:] if p.splitlines()[0] == 'Alternative: ' + value]
        require(len(selected) == 1, f'no unique selected alternative: {name}')
        slaves = dict(line.strip().split(None, 1) for line in paragraphs[0].splitlines() if line.startswith(' '))
        targets = dict(line.strip().split(None, 1) for line in selected[0].splitlines() if line.startswith(' '))
        for slave, path in slaves.items():
            require(slave in targets, f'missing selected alternative slave: {slave}')
            if path.startswith('/usr/share/man/') and targets[slave].startswith('/usr/share/man/'):
                require('path-exclude /usr/share/man/*' in (inputs / 'dpkg-slim.conf').read_text().splitlines(), 'missing manual-page exclusion authority')
                require(path not in configured and targets[slave] not in configured, f'excluded alternative manual page was installed: {path}')
                continue
            generated(path, producer, '/etc/alternatives/' + slave)
            generated('/etc/alternatives/' + slave, producer, targets[slave])

    removed = {}
    for line in (inputs / 'preset-removed.tsv').read_text().splitlines():
        path, source = line.split('\t')
        require(path not in removed and configured.get(path, {}).get('type') == 'symlink', f'invalid preset removal: {path}')
        require(not engine.at(path).is_symlink() and not engine.at(path).exists(), f'preset removal survived: {path}')
        removed[path] = source
    for file in sorted((inputs / 'enablement').glob('*.dsh-also')):
        for path in file.read_text().splitlines():
            require(path.startswith('/etc/systemd/system/'), f'unknown native enablement path: {path}')
            original = configured.get(path)
            # update-state also records potential links under a disabled preset.
            # Only configured outputs activate a conditional producer; once
            # captured, losing that output needs the exact removal record below.
            if original is None:
                require(not engine.at(path).is_symlink() and not engine.at(path).exists(), f'uncaptured enablement appeared: {path}')
                continue
            require(original['type'] == 'symlink', f'native enablement capture is not a link: {path}')
            if path in removed:
                roots.append(dict(paths=[removed[path]], kind='resource', reason=f'preset-enforce.sh removed {path}'))
                continue
            target = original['target']
            absolute = target if target.startswith('/') else str(Path(path).parent) + '/' + target
            canonical, _ = engine.resolve(absolute, missing=True)
            if engine.excluded(canonical) or engine.owners.get(canonical, set()) & {'apt', 'dpkg'}:
                require(not engine.at(path).is_symlink() and not engine.at(path).exists(), f'installer enablement survived removal: {path}')
                continue
            if path not in engine.owners:
                generated(path, f'deb-systemd-helper {file.name}; captured native enablement', target)

    # A generated leaf can need a package-unowned parent. Name only those exact
    # directory inodes, preserving their configured metadata without contents.
    explicit = {p for c in engine.consumers for r in rules['consumers'][engine.declaration_key(c)]['roots'] if r.get('generated') for p in r['paths']}
    parents = set()
    for path in explicit:
        for parent in Path(path).parents:
            physical, _ = engine.resolve(str(parent), follow_leaf=False)
            if physical not in engine.owners and physical not in explicit:
                parents.add(physical)
    for path in sorted(parents):
        roots.append(dict(paths=[path], kind='directory', reason='parent of declared generated output', generated='offline installation and named composition output directories'))
    return rules


def debug_records(directory: Path, files: dict) -> dict:
    records = {}
    for line in (directory / 'manifest.tsv').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        fields = line.split('\t')
        require(len(fields) == 6, 'invalid debug counterpart record')
        path, build_id, debug, before, after, digest = fields
        require(path in files and path not in records and re.fullmatch('[0-9a-f]{3,}', build_id), f'debug counterpart has no unique shipped binary: {path}')
        require(debug == f'.build-id/{build_id[:2]}/{build_id[2:]}.debug', f'debug counterpart path: {path}')
        require(files[path].get('sha256') == digest and str(files[path].get('size')) == after and before.isdigit(), f'debug counterpart differs from shipped binary: {path}')
        at = selector.host_path(str(directory / debug))
        require(at.is_file(), f'debug counterpart missing: {path}')
        records[path] = dict(build_id=build_id, path=debug, bytes_before=int(before), **selector.metadata(at))
    return records


def measurements(root: Path, rows: list) -> dict:
    groups = {}
    for row in rows:
        if row['type'] == 'file':
            groups.setdefault(row['hardlink'], row)
    return dict(apparent_file_bytes=sum(r.get('size', 0) for r in rows),
                unique_file_bytes=sum(r['size'] for r in groups.values()),
                allocated_file_bytes=sum((root / p.lstrip('/')).stat().st_blocks * 512 for p in groups),
                unique_file_inodes=len(groups), directories=sum(r['type'] == 'directory' for r in rows),
                symlinks=sum(r['type'] == 'symlink' for r in rows),
                runtime_allocation='pending B7 guest evidence', rss='pending B7 guest evidence',
                fresh_image_comparison='pending B7 granted image builds')


def compose(args: argparse.Namespace) -> None:
    inputs = selector.host_path(args.inputs)
    root = selector.host_path(args.root)
    source_lineage = lineage.validate(lineage.load(inputs / 'source-lineage.json'), args.arch, int(args.epoch))
    require((inputs / 'source-lineage.json').read_bytes() == lineage.canonical(source_lineage), 'noncanonical source lineage capture')
    for name in ('Packages', 'SHA256SUMS', 'manifest.txt'):
        require(selector.sha256(inputs / name) == source_lineage['pool']['files'][name], 'source lineage captured pool changed: ' + name)
    configured = json.loads((inputs / 'configured.json').read_text())
    args.inventory = str(inputs / 'manifest.tsv')
    args.packages = str(inputs / 'selected.pkgs')
    args.ownership = str(inputs / 'info')
    engine = selector.Selector(args)
    records = archives(inputs, engine.packages)
    local = {row['package']: row for row in source_lineage['pool']['packages']}
    require(all(name in local for name in (inputs / 'selected.pkgs').read_text().splitlines()), 'source lineage selected package missing')
    for name, row in records.items():
        if name in local:
            expected = local[name]
            require(all(row[k] == expected[k] for k in ('version', 'architecture', 'archive'))
                    and row['archive_sha256'] == expected['sha256'], 'source lineage installed package mismatch: ' + name)
    effective = inputs / 'runtime-rules.json'
    write_json(effective, generated_rules(engine, inputs, configured))
    args.rules = str(effective)
    engine = selector.Selector(args)
    report = engine.select()
    contributors = {o['package'] for r in report['files'] if r['type'] != 'directory' for o in r['origins'] if 'package' in o}
    manifest_path, _ = engine.resolve('/usr/share/mica/manifest.tsv', follow_leaf=False)
    manifest = engine.at(manifest_path)
    require(manifest.is_file() and not manifest.is_symlink(), 'shipping manifest must be a regular file')
    manifest.write_text('#package\tversion\tarchitecture\n' + ''.join(f"{p}\t{records[p]['version']}\t{records[p]['architecture']}\n" for p in sorted(contributors)))
    # The SquashFS time is the same normalization applied before selection; no
    # output inode is rewritten after its exact report has been published.
    epoch_ns = int(args.epoch) * 1000000000
    require(0 <= epoch_ns <= 0xffffffff * 1000000000, 'invalid SquashFS epoch')
    for path in reversed(selector.tree_paths(root)):
        os.utime(root / path.lstrip('/'), ns=(epoch_ns, epoch_ns), follow_symlinks=False)
    engine = selector.Selector(args)
    report = engine.select()
    files = {row['path']: row for row in report['files']}
    for path in selector.tree_paths(root):
        if path.startswith('/usr/share/mica/meta/'):
            require(path in {'/usr/share/mica/meta/updates', '/usr/share/mica/meta/updates/manifest.json', '/usr/share/mica/meta/GENERATED'}
                    and path in files, f'undeclared public metadata: {path}')
    # EVERY D-BUS ACTIVATION ENTRY MUST NAME A SYSTEMD SERVICE. dbus-daemon starts
    # a SystemdService= entry by asking systemd and forks nothing; a TRADITIONAL
    # entry would have it fork through /usr/lib/dbus-1.0/dbus-daemon-launch-helper,
    # the setuid helper this composition drops. mica-core established that the
    # systemd entries all carry SystemdService= with Exec=/bin/false as a dead
    # fallback, which is why dropping the helper is safe TODAY; this asserts it of
    # the root rather than of mica-core, so an entry arriving from any package
    # fails the build instead of failing at the moment of first use.
    # THE ONE EXEMPTION IS org.freedesktop.systemd1, AND IT IS NOT A LOOPHOLE: PID 1
    # OWNS THAT NAME FROM BOOT, so the activation path is never taken. Its entry is
    # a traditional one -- Exec=/bin/false, User=root, no SystemdService= -- and if
    # anything ever did try to activate it the attempt would FAIL for want of the
    # helper rather than fork something. Written as a name and not as a pattern,
    # because the next traditional entry to arrive should fail the build.
    #
    # I asserted this rule without the exemption first and the build refused on
    # exactly this file, one message after I had relayed "five of six carry
    # SystemdService=, and the sixth is systemd1, whose name PID 1 owns from boot".
    # The assertion was stricter than the fact it was built from.
    owned_from_boot = {'/usr/share/dbus-1/system-services/org.freedesktop.systemd1.service'}
    for path, row in files.items():
        if path.startswith('/usr/share/dbus-1/system-services/') and row['type'] == 'file' and path not in owned_from_boot:
            require(b'SystemdService=' in (root / path.lstrip('/')).read_bytes(),
                    f'traditional D-Bus activation entry: {path} names no SystemdService=, and the setuid '
                    'launch helper it would need is not in this root')
    # DROPBEAR AUTHENTICATES WITHOUT PAM, AND THAT IS LOAD-BEARING RATHER THAN
    # INCIDENTAL: it is the only route into a fielded device, and on 2026-09-19
    # every published image carried a PAM stack that could not assemble, so SSH
    # was the only way in. mica-core measured that the pinned dropbear links no
    # libpam; this asserts it of the binary in the composed root, where a later
    # package change would still be caught.
    dropbear = root / 'usr/sbin/dropbear'
    if '/usr/sbin/dropbear' in files and dropbear.is_file():
        require(b'libpam' not in dropbear.read_bytes(),
                'the shipped dropbear links libpam: SSH would then depend on the PAM stack, which is the one '
                'thing that must not share a failure with the console')
    for path in files:
        forbidden = ('/mica-build-inputs', '/mica-compose', '/.debian-extra', '/debootstrap',
                     '/var/lib/dpkg', '/var/lib/apt', '/var/cache/apt', '/var/cache/debconf',
                     '/etc/apt', '/etc/dpkg', '/usr/lib/apt', '/usr/lib/dpkg', '/usr/lib/debug')
        require(not any(path == prefix or path.startswith(prefix + '/') for prefix in forbidden),
                f'build residue selected: {path}')
    for path in selector.tree_paths(root):
        if re.fullmatch('/usr/(?:local/)?s?bin/[^/]+', path):
            at = root / path.lstrip('/')
            # Dangling symlinks and unsupported executables must already refuse
            # through the selector. Check every surviving operator entry too.
            if at.is_symlink() or (at.is_file() and at.stat().st_mode & 0o111):
                require(path in files, f'operator executable omitted: {path}')
    debug = debug_records(selector.host_path(args.debug), files)
    provenance = {}
    for path, row in files.items():
        origins = row['origins']
        require(path in configured or any('generated' in o for o in origins), f'new shipped path has no named producer: {path}')
        provenance[path] = dict(configured=configured.get(path), final={k: v for k, v in row.items() if k not in ('reasons', 'origins')},
                                archives=[records[o['package']] for o in origins if 'package' in o],
                                generators=[o['generated'] for o in origins if 'generated' in o])
        if path in debug:
            provenance[path]['debug'] = debug[path]
    report['provenance'] = dict(source_lineage=source_lineage, build_packages=[records[p] for p in sorted(records)],
                                shipped_packages=[records[p] for p in sorted(contributors)], files=provenance,
                                configured_sha256=selector.sha256(inputs / 'configured.json'))
    report['provenance']['capture_sha256'] = {str(p.relative_to(inputs)): selector.sha256(p)
        for p in sorted(inputs.rglob('*')) if p.is_file() and not p.is_symlink()}
    engine.copy(report, publish=False)
    # THE COMPARISON THAT DID NOT EXIST: what the installed root had and the
    # selection did not carry, classified by why. Written beside the report and
    # counted on stdout, because three user-visible defects -- /etc/profile, the
    # PAM stack a console login needs, and whatever is next -- were paths that
    # went missing here with nothing holding an opinion about it.
    drops = engine.dropped(report)
    Path(str(engine.report) + '.drops.tsv').write_text(''.join(f'{why}\t{tags}\t{path}\n' for path, why, tags in drops))
    counts = {why: sum(1 for _, w, _ in drops if w == why) for why in ('excluded', 'owned', 'unowned')}
    privileged = [(path, tags) for path, _, tags in drops if tags]
    carried_caps = sum(1 for row in report['files']
                       if any('capability' in name for name in (row.get('xattrs') or {})))
    print(f"runtime selection: {len(report['files'])} carried, {len(drops)} left behind "
          f"({counts['excluded']} excluded by rule, {counts['owned']} owned by a package and claimed by no consumer, "
          f"{counts['unowned']} shipped by no package at all)")
    print(f"runtime selection: {len(privileged)} of the dropped paths are privileged"
          + (': ' + ', '.join(f'{p} ({t})' for p, t in privileged) if privileged else '')
          + f"; {carried_caps} carried file(s) hold a capability")
    report['measurements'] = measurements(engine.output, report['files'])
    write_json(engine.report, report)


def measure_packed(args: argparse.Namespace) -> None:
    out = selector.host_path(args.out)
    path = out / 'rootfs-report.runtime.json'
    report = json.loads(path.read_text())
    selector.verify(selector.host_path(args.root), report)
    env = dict(line.split('=', 1) for line in (out / 'rootfs-verity.env').read_text().splitlines())
    image = out / 'rootfs-verity.img'
    size = int(env['SQUASHFS_BYTES'])
    require(0 < size < image.stat().st_size == int(env['IMAGE_BYTES']), 'invalid packed root geometry')
    digest = hashlib.sha256()
    with image.open('rb') as stream:
        left = size
        while left:
            data = stream.read(min(left, 1024 * 1024))
            require(data, 'truncated packed root')
            digest.update(data)
            left -= len(data)
    report['measurements']['squashfs'] = dict(bytes=size, sha256=digest.hexdigest())
    report['measurements']['verity_image'] = dict(bytes=image.stat().st_size, sha256=selector.sha256(image), geometry=env)
    report['measurements']['boot_payload'] = 'independent signed kernel component; pending B7 matching artifact inputs'
    # This update changes measurements only, after verifying the selected tree.
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    capture = commands.add_parser('snapshot')
    capture.add_argument('--root', required=True)
    capture.add_argument('--output', required=True)
    comparison = commands.add_parser('compare')
    comparison.add_argument('--root', required=True)
    comparison.add_argument('--snapshot', required=True)
    packed = commands.add_parser('measure-packed')
    packed.add_argument('--root', required=True)
    packed.add_argument('--out', required=True)
    final = commands.add_parser('compose')
    for name in ('root', 'output', 'inputs', 'arch', 'epoch', 'debug', 'report'):
        final.add_argument('--' + name, required=True)
    final.add_argument('--rules', default=str(Path(__file__).with_name('consumers.json')))
    args = parser.parse_args()
    try:
        if args.action == 'snapshot':
            write_json(selector.host_path(args.output), snapshot(selector.host_path(args.root)))
        elif args.action == 'compare':
            require(snapshot(selector.host_path(args.root)) == json.loads(Path(args.snapshot).read_text()), 'installation transfer changed metadata, bytes or hardlinks')
        elif args.action == 'measure-packed':
            measure_packed(args)
        else:
            compose(args)
        print('runtime composition: verified')
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'runtime composition refused: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
