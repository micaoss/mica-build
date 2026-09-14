"""Exercise the final packing entry against real small installed trees."""
import hashlib
import json
import os
import pathlib
from pathlib import Path
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
import unittest

from selection_test import SelectionTest, elf, loader_cache

# The shipped policy files the fixtures are seeded with, read out of the
# archives the lock imports (mica-system and, for the Quadlet mount unit,
# mica-podman) at their pins: tools/deb-member.py reads a payload member
# without dpkg. `make os-rootfs-runtime-test` fetches the amd64 pool first;
# MICA_POOL_DIR overrides its location.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_POOL = pathlib.Path(os.environ.get('MICA_POOL_DIR') or (_REPO_ROOT / '_out/debs'))


def shipped(path: str) -> bytes:
    for pattern in ('mica-system_*_all.deb', 'mica-podman_*_amd64.deb'):
        for archive in sorted((_POOL / 'amd64/pool').glob(pattern)):
            r = subprocess.run([sys.executable, str(_REPO_ROOT / 'tools/deb-member.py'), str(archive), path.lstrip('/')], capture_output=True)
            if r.returncode == 0:
                return r.stdout
    raise FileNotFoundError(f'{path} is in none of the imported archives under {_POOL}/amd64/pool; fetch them with `make os-pool`')

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / 'rootfs/runtime/compose.py'
PACKAGE_VERSION = '0.1.0+git' + 'a' * 12 + '-1'


class CompositionTest(unittest.TestCase):
    def setUp(self):
        self.f = SelectionTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        self.inputs = f.base / 'inputs'
        self.inputs.mkdir()
        shutil.copytree(f.db, self.inputs / 'info')
        shutil.copyfile(f.manifest, self.inputs / 'manifest.tsv')
        shutil.copyfile(f.packages, self.inputs / 'selected.pkgs')
        (self.inputs / 'upstream.tsv').write_text('libfixture\t1\tamd64\t' + 'a' * 64 + '\thttps://example.invalid/library.deb\tmica-system\nunused\t1\tall\t' + 'b' * 64 + '\thttps://example.invalid/unused.deb\tbase\n')
        (self.inputs / 'Packages').write_text('Package: mica-system\nVersion: 1\nArchitecture: all\nFilename: pool/mica-system.deb\nSHA256: ' + 'c' * 64 + '\n\n')
        (self.inputs / 'sources.tsv').write_text('mica-system\tmica-system\t1\nlibfixture\tfixture-source\t1\nunused\tunused\t1\n')
        (self.inputs / 'alternatives').mkdir()
        (self.inputs / 'enablement').mkdir()
        (self.inputs / 'preset-removed.tsv').write_text('')
        f.write('/usr/share/mica/manifest.tsv', f.manifest.read_bytes())
        f.rules['consumers']['mica-system']['roots'].append({'paths': ['/usr/share/mica', '/usr/share/mica/manifest.tsv'], 'kind': 'resource', 'reason': 'shipping inventory', 'generated': 'runtime composition'})
        # An unselected executable is an operator omission, even when owned.
        f.root.joinpath('usr/bin/unselected').unlink()
        f.rules_path.write_text(json.dumps(f.rules))
        for path in (f.manifest, self.inputs / 'manifest.tsv', self.inputs / 'sources.tsv', f.root / 'usr/share/mica/manifest.tsv'):
            path.write_text(path.read_text().replace('mica-system\t1\t', 'mica-system\t' + PACKAGE_VERSION + '\t')
                            .replace('mica-system\tmica-system\t1\n', 'mica-system\tmica-system\t' + PACKAGE_VERSION + '\n'))
        index = self.inputs / 'Packages'
        index.write_text(index.read_text().replace('Version: 1\n', 'Version: ' + PACKAGE_VERSION + '\n'))
        self.lineage()
        self.debug = f.base / 'debug'
        self.debug.mkdir()
        (self.debug / 'manifest.tsv').write_text('#path\tbuild-id\tdebug\tbytes-before\tbytes-after\tsha256-after\n')

    def lineage(self, arch='amd64'):
        for name in ('SHA256SUMS', 'manifest.txt'):
            if not (self.inputs / name).exists():
                (self.inputs / name).write_text('fixture pool index\n')
        files = {name: hashlib.sha256((self.inputs / name).read_bytes()).hexdigest()
                 for name in ('Packages', 'SHA256SUMS', 'manifest.txt')}
        files['pool/mica-system.deb'] = 'c' * 64
        record = dict(schema='mica/source-lineage/v1', architecture=arch, root_epoch=1000000000,
                      package_source=dict(commit='a' * 40, tree='b' * 40, epoch=1000000000, version=PACKAGE_VERSION),
                      composition_source=dict(commit='a' * 40, tree='b' * 40, epoch=1000000000),
                      lock=[], unlocked=[], pool=dict(files=files, packages=[dict(
                          package='mica-system', version=PACKAGE_VERSION, architecture='all',
                          archive='pool/mica-system.deb', sha256='c' * 64, control_sha256='d' * 64,
                          source_repo='mica-build', source_commit='a' * 40)]))
        (self.inputs / 'source-lineage.json').write_text(json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n')

    def command(self, action, **options):
        argv = [sys.executable, str(COMPOSE), action]
        for name, value in options.items():
            argv += ['--' + name.replace('_', '-'), str(value)]
        return subprocess.run(argv, capture_output=True, text=True, timeout=15)

    def capture(self):
        (self.inputs / 'alternative-names.txt').write_text(''.join(p.name + '\n' for p in sorted((self.inputs / 'alternatives').iterdir())))
        (self.inputs / 'enablement-names.txt').write_text(''.join(p.name + '\n' for p in sorted((self.inputs / 'enablement').glob('*.dsh-also'))))
        r = self.command('snapshot', root=self.f.root, output=self.inputs / 'configured.json')
        self.assertEqual(r.returncode, 0, r.stderr)

    def compose(self):
        return self.command('compose', root=self.f.root, output=self.f.out, inputs=self.inputs,
                            rules=self.f.rules_path, arch='amd64', epoch=1000000000,
                            debug=self.debug, report=self.f.report)

    def podman_alias(self):
        declared = json.loads((REPO / 'rootfs/runtime/consumers.json').read_text())['consumers']['mica-podman']
        entries = declared['roots'][0]['paths']
        for path in entries:
            self.f.write(path, elf(needed=['libpodman-fixture.so'], interp='/usr/lib/podman-loader.so'), 0o755)
        self.f.write('/usr/lib/libpodman-fixture.so', elf())
        self.f.write('/usr/lib/podman-loader.so', elf(), 0o755)
        self.f.write('/usr/share/doc/mica-podman/copyright', b'Podman fixture license\n')
        self.f.link('/usr/bin/docker', 'podman')
        owned = [*entries, '/usr/bin/docker', '/usr/lib/libpodman-fixture.so',
                 '/usr/lib/podman-loader.so', '/usr/share/doc/mica-podman/copyright']
        owned = sorted(set(owned) | {str(parent) for path in owned for parent in Path(path).parents})
        (self.inputs / 'info/mica-podman.list').write_text('\n'.join(owned) + '\n')
        for path in (self.inputs / 'manifest.tsv', self.f.root / 'usr/share/mica/manifest.tsv'):
            with path.open('a') as stream:
                stream.write(f'mica-podman\t{PACKAGE_VERSION}\tamd64\n')
        with (self.inputs / 'sources.tsv').open('a') as stream:
            stream.write(f'mica-podman\tmica-podman\t{PACKAGE_VERSION}\n')
        with (self.inputs / 'selected.pkgs').open('a') as stream:
            stream.write('mica-podman\n')
        with (self.inputs / 'Packages').open('a') as stream:
            stream.write(f'Package: mica-podman\nVersion: {PACKAGE_VERSION}\nArchitecture: amd64\n'
                         'Filename: pool/mica-podman.deb\nSHA256: ' + 'e' * 64 + '\n\n')
        self.lineage()
        path = self.inputs / 'source-lineage.json'
        record = json.loads(path.read_text())
        record['pool']['files']['pool/mica-podman.deb'] = 'e' * 64
        record['pool']['packages'].append(dict(package='mica-podman', version=PACKAGE_VERSION,
            architecture='amd64', archive='pool/mica-podman.deb', sha256='e' * 64, control_sha256='f' * 64,
            source_repo='mica-build', source_commit='a' * 40))
        path.write_text(json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n')
        self.f.rules['consumers']['mica-podman'] = dict(roots=[declared['roots'][0],
            *(row for row in declared['roots'] if row['paths'] == ['/usr/bin/docker'])], runtime_links=[])
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        return entries

    def test_package_owned_docker_alias_composes_with_target_and_helpers(self):
        entries = self.podman_alias()
        self.capture()
        result = self.compose()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.f.report.read_text())
        rows = {row['path']: row for row in report['files']}
        row = rows['/usr/bin/docker']
        self.assertEqual((row['type'], row['target'], row['mode'], row['uid'], row['gid']),
                         ('symlink', 'podman', 0o777, 0, 0))
        self.assertEqual(report['provenance']['files']['/usr/bin/docker']['archives'][0]['package'], 'mica-podman')
        self.assertEqual(os.readlink(self.f.out / 'usr/bin/docker'), 'podman')
        for path in entries:
            self.assertEqual((self.f.out / path[1:]).read_bytes(), (self.f.root / path[1:]).read_bytes())
        self.assertEqual(self.f.command('verify').returncode, 0)

    def test_package_owned_docker_alias_preserves_refusals(self):
        cases = [('owner', 'empty owned runtime roots'), ('wrong-owner', 'empty owned runtime roots'),
                 ('target', 'required target changed'), ('mode', 'required mode changed'),
                 ('missing-target', 'missing path:'), ('interpreter', 'missing path:'),
                 ('library', 'unresolved shared library'), ('unrelated', 'operator executable omitted:')]
        for mutation, expected in cases:
            with self.subTest(mutation=mutation):
                fixture = CompositionTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                fixture.podman_alias()
                if mutation in ('owner', 'wrong-owner'):
                    owner = fixture.inputs / 'info/mica-podman.list'
                    owner.write_text(owner.read_text().replace('/usr/bin/docker\n', ''))
                    if mutation == 'wrong-owner':
                        with (fixture.inputs / 'info/unused.list').open('a') as stream:
                            stream.write('/usr/bin/docker\n')
                elif mutation == 'target':
                    (fixture.f.root / 'usr/bin/docker').unlink()
                    fixture.f.link('/usr/bin/docker', 'crun')
                elif mutation == 'mode':
                    # Linux symlink modes are fixed; a conflicting required mode must refuse.
                    fixture.f.rules['consumers']['mica-podman']['roots'][-1]['expect']['mode'] = 0o755
                elif mutation in ('missing-target', 'interpreter', 'library'):
                    path = {'missing-target': 'usr/bin/podman', 'interpreter': 'usr/lib/podman-loader.so',
                            'library': 'usr/lib/libpodman-fixture.so'}[mutation]
                    (fixture.f.root / path).unlink()
                else:
                    fixture.f.link('/usr/bin/unexpected-podman-alias', 'podman')
                    with (fixture.inputs / 'info/mica-podman.list').open('a') as stream:
                        stream.write('/usr/bin/unexpected-podman-alias\n')
                fixture.f.rules_path.write_text(json.dumps(fixture.f.rules))
                fixture.capture()
                result = fixture.compose()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertFalse(fixture.f.report.exists())

    def operator_companions(self):
        operators = {f'/usr/sbin/{name}': ('systemd-sysv', '../bin/systemctl')
                     for name in ('halt', 'poweroff', 'reboot', 'runlevel', 'shutdown', 'telinit')}
        operators.update({'/usr/bin/resolvectl': ('systemd-resolved', None),
                          '/usr/sbin/resolvconf': ('systemd-resolved', '../bin/resolvectl'),
                          '/usr/sbin/invoke-rc.d': ('init-system-helpers', None),
                          '/usr/sbin/service': ('init-system-helpers', None),
                          '/usr/bin/dpkg-realpath': ('dpkg', None),
                          '/usr/bin/update-alternatives': ('dpkg', None),
                          '/usr/sbin/start-stop-daemon': ('dpkg', None)})
        resources = {
            'dbus': ['/etc/init.d/dbus', '/etc/default/dbus'],
            'procps': ['/etc/init.d/procps'],
            'quota': ['/etc/init.d/quota', '/etc/init.d/quotarpc', '/etc/default/quota',
                      '/usr/share/quota/quotaon.sh', '/usr/share/quota/quotaoff.sh',
                      '/usr/share/quota/quotarpc.sh', '/usr/share/quota/quota-initial-check.sh', '/var/lib/quota'],
            'sysvinit-utils': ['/usr/lib/lsb/init-functions', '/usr/lib/lsb/init-functions.d/00-verbose',
                              '/usr/lib/init/init-d-script', '/usr/lib/init/vars.sh'],
            'systemd': ['/usr/lib/lsb/init-functions.d/40-systemd'],
        }
        links = {f'/etc/rc{level}.d/S01{name}': '../init.d/' + name
                 for level in '2345' for name in ('dbus',)}
        links['/etc/rcS.d/S01procps'] = '../init.d/procps'
        expected = set(operators) | {p for paths in resources.values() for p in paths} | set(links)
        declared = json.loads((REPO / 'rootfs/runtime/consumers.json').read_text())
        rows = [row for row in declared['consumers']['mica-system']['roots']
                if set(row['paths']) & expected]
        system = self.f.rules['consumers']['mica-system']['roots']
        system.extend(rows)
        owners = {}
        for path, (owner, target) in operators.items():
            owners[path] = owner
            if target:
                self.f.link(path, target)
            else:
                data = b'#!/usr/bin/sh\nexit 0\n' if owner == 'init-system-helpers' else elf(
                    needed=['liboperator.so'], interp='/usr/lib/operator-loader.so')
                self.f.write(path, data, 0o755)
        for owner, paths in resources.items():
            for path in paths:
                owners[path] = owner
                if path == '/var/lib/quota':
                    (self.f.root / path[1:]).mkdir(parents=True)
                else:
                    executable = path.startswith(('/etc/init.d/', '/usr/share/quota/')) or path.endswith('/init-d-script')
                    self.f.write(path, b'#!/usr/bin/sh\nexit 0\n' if executable else b'fixture resource\n',
                                 0o755 if executable else 0o644)
        for path in ('/usr/bin/systemctl', '/usr/lib/operator-loader.so', '/usr/lib/liboperator.so'):
            self.f.write(path, elf(), 0o755)
            owners[path] = 'systemd'
        system.append(dict(paths=['/usr/bin/systemctl'], packages=['systemd'], kind='executable',
                           reason='existing retained systemctl target'))
        for path, target in links.items():
            self.f.link(path, target)
        for owner in sorted(set(owners.values())):
            copyright_path = f'/usr/share/doc/{owner}/copyright'
            self.f.write(copyright_path, b'fixture license\n')
            paths = {p for p, package in owners.items() if package == owner} | {copyright_path}
            paths |= {str(parent) for p in list(paths) for parent in Path(p).parents}
            (self.inputs / 'info' / (owner + '.list')).write_text('\n'.join(sorted(paths)) + '\n')
            with (self.inputs / 'manifest.tsv').open('a') as stream:
                stream.write(f'{owner}\t1\tamd64\n')
            with (self.inputs / 'upstream.tsv').open('a') as stream:
                stream.write(f'{owner}\t1\tamd64\t' + 'e' * 64 + f'\thttps://example.invalid/{owner}.deb\tmica-system\n')
            with (self.inputs / 'sources.tsv').open('a') as stream:
                stream.write(f'{owner}\t{owner}\t1\n')
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        return operators, resources, links, expected

    def test_retained_operator_companions_compose_with_native_resources(self):
        operators, resources, links, expected = self.operator_companions()
        self.capture()
        result = self.compose()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.f.report.read_text())
        rows = {row['path']: row for row in report['files']}
        self.assertTrue(expected <= rows.keys())
        for path, (owner, target) in operators.items():
            self.assertEqual(rows[path]['mode'], 0o777 if target else 0o755)
            self.assertEqual((rows[path]['uid'], rows[path]['gid']), (0, 0))
            self.assertIn(owner, {o['package'] for o in rows[path]['origins'] if 'package' in o})
            if target:
                self.assertEqual(os.readlink(self.f.out / path[1:]), target)
            else:
                self.assertEqual((self.f.out / path[1:]).read_bytes(), (self.f.root / path[1:]).read_bytes())
        for path, target in links.items():
            self.assertEqual(os.readlink(self.f.out / path[1:]), target)
            self.assertTrue(any('generated' in o for o in rows[path]['origins']))
        for path in ('usr/bin/dpkg', 'usr/bin/dpkg-query', 'usr/bin/apt-get', 'usr/bin/perl', 'var/lib/dpkg'):
            self.assertFalse(os.path.lexists(self.f.out / path))
        self.assertEqual(self.f.command('verify').returncode, 0)

    def test_retained_operator_companions_preserve_refusals(self):
        cases = {'owner': 'empty owned runtime roots', 'wrong-owner': 'empty owned runtime roots',
                 'script-interpreter': 'missing path:', 'device': 'unsupported node:',
                 'mode': 'required mode changed',
                 'target': 'required target changed', 'target-missing': 'No such file or directory',
                 'interpreter': 'missing path:', 'library': 'unresolved shared library',
                 'resource': 'missing path:', 'rc-target': 'required target changed',
                 'omitted': 'operator executable omitted:', 'package-manager': 'operator executable omitted:',
                 'database': 'build residue selected:'}
        for mutation, message in cases.items():
            with self.subTest(mutation=mutation):
                f = CompositionTest(); f.setUp(); self.addCleanup(f.doCleanups)
                f.operator_companions()
                if mutation in ('owner', 'wrong-owner'):
                    p = f.inputs / 'info/dpkg.list'
                    p.write_text(p.read_text().replace('/usr/bin/dpkg-realpath\n', ''))
                    if mutation == 'wrong-owner':
                        with (f.inputs / 'info/unused.list').open('a') as stream:
                            stream.write('/usr/bin/dpkg-realpath\n')
                elif mutation == 'script-interpreter':
                    f.f.write('/usr/sbin/service', b'#!/usr/bin/missing-shell\n', 0o755)
                elif mutation == 'device':
                    f.capture()
                    path = f.f.root / 'dev/unexpected'
                    path.parent.mkdir(exist_ok=True)
                    os.mkfifo(path)
                    f.f.rules['consumers']['mica-system']['roots'].append(dict(
                        paths=['/dev/unexpected'], kind='resource', reason='negative special node', generated='negative fixture'))
                elif mutation == 'mode':
                    (f.f.root / 'usr/bin/dpkg-realpath').chmod(0o700)
                elif mutation in ('target', 'rc-target'):
                    path = '/usr/sbin/halt' if mutation == 'target' else '/etc/rc2.d/S01dbus'
                    (f.f.root / path[1:]).unlink()
                    f.f.link(path, '../bin/resolvectl' if mutation == 'target' else '../init.d/procps')
                elif mutation in ('target-missing', 'interpreter', 'library', 'resource'):
                    path = {'target-missing': 'usr/bin/resolvectl', 'interpreter': 'usr/lib/operator-loader.so',
                            'library': 'usr/lib/liboperator.so', 'resource': 'etc/default/dbus'}[mutation]
                    (f.f.root / path).unlink()
                elif mutation in ('omitted', 'package-manager'):
                    f.f.link('/usr/bin/unexpected-alias' if mutation == 'omitted' else '/usr/bin/dpkg', 'systemctl')
                else:
                    f.f.write('/var/lib/dpkg/status', b'fixture forbidden database\n')
                    f.f.rules['consumers']['mica-system']['roots'].append(dict(
                        paths=['/var/lib/dpkg', '/var/lib/dpkg/status'], kind='resource',
                        reason='negative forbidden database', generated='negative fixture'))
                f.f.rules_path.write_text(json.dumps(f.f.rules))
                if mutation != 'device':
                    f.capture()
                result = f.compose()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(f.f.report.exists())

    def bootstrap_device(self, name='console', major=5, minor=1, mode=0o666):
        path = self.f.root / 'dev' / name
        path.parent.mkdir(exist_ok=True)
        os.mknod(path, stat.S_IFCHR | mode, os.makedev(major, minor))
        path.chmod(mode)
        return path

    def systemd_masks(self, with_device=True):
        masks = ['/usr/lib/systemd/system/' + name + '.service'
                 for name in ('cryptdisks-early', 'cryptdisks', 'hwclock', 'x11-common')]
        unit = '/usr/lib/systemd/system/basic.target'
        self.f.write(unit, b'[Unit]\nDescription=Required ordinary unit\n')
        license_path = '/usr/share/doc/systemd/copyright'
        self.f.write(license_path, b'systemd fixture license\n')
        for path in masks:
            self.f.link(path, '/dev/null')
        (self.inputs / 'info/systemd.list').write_text('\n'.join([
            '/usr/lib/systemd', '/usr/lib/systemd/system', '/usr/share/doc/systemd',
            *masks, unit, license_path,
        ]) + '\n')
        for path in (self.inputs / 'manifest.tsv', self.f.root / 'usr/share/mica/manifest.tsv'):
            with path.open('a') as stream:
                stream.write('systemd\t257\tamd64\n')
        with (self.inputs / 'upstream.tsv').open('a') as stream:
            stream.write('systemd\t257\tamd64\t' + 'e' * 64 + '\thttps://example.invalid/systemd.deb\tmica-system\n')
        with (self.inputs / 'sources.tsv').open('a') as stream:
            stream.write('systemd\tsystemd\t257\n')
        system = self.f.rules['consumers']['mica-system']
        system['roots'].append(dict(paths=[*masks, unit], packages=['systemd'], kind='resource',
                                    reason='units, live udev rules, PAM and D-Bus resources'))
        declared = json.loads((REPO / 'rootfs/runtime/consumers.json').read_text())['consumers']['mica-system']
        system['runtime_links'].extend(row for row in declared['runtime_links'] if row['path'] in masks)
        if with_device:
            self.bootstrap_device('null', 1, 3)
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        return masks, unit

    def assert_systemd_masks_compose(self, with_device):
        masks, unit = self.systemd_masks(with_device)
        self.capture()
        result = self.compose()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.f.report.read_text())
        rows = {row['path']: row for row in report['files']}
        self.assertIn(unit, rows)
        self.assertEqual((self.f.out / unit[1:]).read_bytes(), (self.f.root / unit[1:]).read_bytes())
        for path in masks:
            row = rows[path]
            self.assertEqual((row['type'], row['target'], row['mode'], row['uid'], row['gid']),
                             ('symlink', '/dev/null', 0o777, 0, 0))
            self.assertEqual(row['runtime_link']['generator'], 'kernel devtmpfs')
            self.assertEqual(report['provenance']['files'][path]['archives'][0]['package'], 'systemd')
            self.assertEqual(os.readlink(self.f.out / path[1:]), '/dev/null')
        self.assertNotIn('/dev/null', rows)
        self.assertFalse(os.path.lexists(self.f.out / 'dev/null'))
        self.assertEqual(self.f.command('verify').returncode, 0)

    def test_systemd_masks_compose_without_copying_device(self):
        self.assert_systemd_masks_compose(True)

    def test_systemd_masks_compose_without_disposable_device(self):
        self.assert_systemd_masks_compose(False)

    def test_systemd_masks_preserve_strict_refusals(self):
        for mutation, expected in [('target', 'runtime link target changed'), ('owner', 'no origin:'),
                                   ('unit', 'missing path:'), ('undeclared', 'unsupported node:')]:
            with self.subTest(mutation=mutation):
                fixture = CompositionTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                masks, unit = fixture.systemd_masks()
                if mutation == 'target':
                    (fixture.f.root / masks[0][1:]).unlink()
                    fixture.f.link(masks[0], '/dev/zero')
                elif mutation == 'owner':
                    owner = fixture.inputs / 'info/systemd.list'
                    owner.write_text(owner.read_text().replace(masks[0] + '\n', ''))
                elif mutation == 'unit':
                    (fixture.f.root / unit[1:]).unlink()
                else:
                    extra = '/usr/lib/systemd/system/undeclared.service'
                    fixture.f.link(extra, '/dev/null')
                    with (fixture.inputs / 'info/systemd.list').open('a') as stream:
                        stream.write(extra + '\n')
                    fixture.f.rules['consumers']['mica-system']['roots'][-1]['paths'].append(extra)
                    fixture.f.rules_path.write_text(json.dumps(fixture.f.rules))
                fixture.capture()
                result = fixture.compose()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertFalse(fixture.f.report.exists())

    def test_missing_swapped_or_malformed_lineage_refuses(self):
        self.capture()
        path = self.inputs / 'source-lineage.json'
        original = path.read_bytes()
        for mutation in ('missing', 'epoch', 'architecture', 'unknown', 'duplicate', 'pool'):
            with self.subTest(mutation=mutation):
                path.write_bytes(original)
                if mutation == 'missing':
                    path.unlink()
                elif mutation == 'duplicate':
                    path.write_bytes(original.replace(b'{', b'{"schema":"duplicate",', 1))
                else:
                    value = json.loads(original)
                    if mutation == 'epoch': value['root_epoch'] += 1
                    if mutation == 'architecture': value['architecture'] = 'arm64'
                    if mutation == 'unknown': value['waiver'] = True
                    if mutation == 'pool': value['pool']['files']['Packages'] = '0' * 64
                    path.write_text(json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n')
                r = self.compose()
                self.assertNotEqual(r.returncode, 0, mutation)
                self.assertIn('lineage', r.stderr)
                self.assertFalse(self.f.report.exists())

    def test_lineage_is_captured_and_retained_in_runtime_provenance(self):
        self.capture()
        r = self.compose(); self.assertEqual(r.returncode, 0, r.stderr)
        record = json.loads(self.f.report.read_text())['provenance']
        self.assertEqual(record['source_lineage'], json.loads((self.inputs / 'source-lineage.json').read_text()))
        self.assertEqual(record['capture_sha256']['source-lineage.json'], hashlib.sha256((self.inputs / 'source-lineage.json').read_bytes()).hexdigest())

    def test_bootstrap_devices_are_captured_but_never_shipped(self):
        devices = {'console': (5, 1), 'full': (1, 7), 'null': (1, 3), 'ptmx': (5, 2),
                   'random': (1, 8), 'tty': (5, 0), 'urandom': (1, 9), 'zero': (1, 5)}
        for name, numbers in devices.items():
            self.bootstrap_device(name, *numbers)
        self.capture()
        rows = json.loads((self.inputs / 'configured.json').read_text())
        for name, (major, minor) in devices.items():
            row = rows['/dev/' + name]
            self.assertEqual(row['type'], 'bootstrap-character-device')
            self.assertEqual((row['major'], row['minor'], row['mode'], row['uid'], row['gid']),
                             (major, minor, 0o666, 0, 0))
            self.assertIn('mtime_ns', row)
            self.assertIn('xattrs', row)
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(all(not (self.f.out / 'dev' / name).exists() for name in devices))
        self.assertTrue(all(row['type'] in {'file', 'directory', 'symlink'}
                            for row in json.loads(self.f.report.read_text())['files']))

    def test_selected_bootstrap_device_still_refuses(self):
        self.bootstrap_device()
        self.capture()
        self.f.rules['consumers']['mica-system']['roots'].append({
            'paths': ['/dev/console'], 'kind': 'resource', 'reason': 'invalid shipped device',
            'generated': 'fixture',
        })
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('unsupported node:', r.stderr)
        self.assertIn('/dev/console', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_bootstrap_device_transfer_checks_inode_metadata(self):
        self.bootstrap_device()
        self.capture()
        copy = self.f.base / 'transferred'
        copy.mkdir()
        archive = self.f.base / 'tree.tar'
        subprocess.run(['tar', '-C', str(self.f.root), '--numeric-owner', '--xattrs', '--xattrs-include=*', '-cf', str(archive), '.'], check=True, timeout=15)
        subprocess.run(['tar', '-C', str(copy), '--same-owner', '--xattrs', '--xattrs-include=*', '-xf', str(archive)], check=True, timeout=15)
        r = self.command('compare', root=copy, snapshot=self.inputs / 'configured.json')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(stat.S_ISCHR((copy / 'dev/console').lstat().st_mode))
        os.utime(copy / 'dev/console', ns=(1000000000, 1000000000))
        r = self.command('compare', root=copy, snapshot=self.inputs / 'configured.json')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('installation transfer changed', r.stderr)

    def test_snapshot_refuses_unrelated_special_nodes(self):
        for relative in ['dev/other-device', 'var/lib/device']:
            with self.subTest(path=relative):
                path = self.f.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                os.mknod(path, stat.S_IFCHR | 0o666, os.makedev(5, 1))
                r = self.command('snapshot', root=self.f.root, output=self.inputs / 'refused.json')
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('unsupported node:', r.stderr)
                self.assertFalse((self.inputs / 'refused.json').exists())
                path.unlink()
        path = self.f.root / 'dev/console'
        os.mkfifo(path)
        r = self.command('snapshot', root=self.f.root, output=self.inputs / 'refused.json')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('unsupported node:', r.stderr)

    def test_snapshot_refuses_changed_bootstrap_device_identity(self):
        for major, minor, mode, uid in [(1, 3, 0o666, 0), (5, 1, 0o600, 0), (5, 1, 0o666, 123)]:
            with self.subTest(major=major, minor=minor, mode=mode, uid=uid):
                path = self.bootstrap_device(major=major, minor=minor, mode=mode)
                os.chown(path, uid, 0)
                r = self.command('snapshot', root=self.f.root, output=self.inputs / 'refused.json')
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('bootstrap device identity', r.stderr)
                self.assertFalse((self.inputs / 'refused.json').exists())
                path.unlink()

    def test_pack_entry_selects_real_paths_and_metadata(self):
        self.capture()
        self.f.write('/var/lib/dpkg/status', b'build database')
        self.f.write('/mica-compose/archive.deb', b'build archive')
        self.f.write('/.debian-extra/bootstrap', b'bootstrap')
        self.f.write('/usr/lib/udev/hwdb.bin', b'hwdb')
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(self.f.report.read_text())
        self.assertTrue(self.f.out.joinpath('usr/bin/app').is_file())
        for path in ['var/lib/dpkg', 'mica-compose', '.debian-extra', 'usr/lib/udev/hwdb.bin', 'usr/lib/debug', 'usr/lib/modules/modules.dep']:
            self.assertFalse(self.f.out.joinpath(path).exists(), path)
        self.assertEqual(os.readlink(self.f.out / 'etc/systemd/system-generators/systemd-ssh-generator'), '/dev/null')
        self.assertEqual(os.readlink(self.f.out / 'var/log/wtmp'), '/run/mica/wtmp')
        self.assertEqual((self.f.out / 'var/lib/seed').stat().st_ino, (self.f.out / 'var/lib/seed-alias').stat().st_ino)
        self.assertEqual((self.f.out / 'var/lib/seed').stat().st_uid, 123)
        self.assertEqual(os.getxattr(self.f.out / 'var/lib/seed', 'user.fixture'), b'value')
        self.assertEqual(os.getxattr(self.f.out / 'usr/bin/captool', 'security.capability'), os.getxattr(self.f.root / 'usr/bin/captool', 'security.capability'))
        self.assertNotIn('unused\t', (self.f.out / 'usr/share/mica/manifest.tsv').read_text())
        self.assertEqual({p['package'] for p in report['provenance']['build_packages']}, {'mica-system', 'libfixture', 'unused'})
        self.assertEqual({p['package'] for p in report['provenance']['shipped_packages']}, {'mica-system', 'libfixture'})
        self.assertLess(report['measurements']['unique_file_bytes'], report['measurements']['apparent_file_bytes'])
        self.assertEqual(report['measurements']['runtime_allocation'], 'pending B7 guest evidence')
        check = subprocess.run([sys.executable, str(REPO / 'rootfs/runtime/select.py'), 'verify', '--root', str(self.f.out), '--report', str(self.f.report)], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_accounting_link_capture_preserves_producer_identity(self):
        links = self.f.accounting_links()
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        shutil.copyfile(self.f.db / 'mica-system.list', self.inputs / 'info/mica-system.list')
        self.capture()
        result = self.compose()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(self.f.report.read_text())
        rows = {row['path']: row for row in report['files']}
        snapshot = json.loads((self.inputs / 'configured.json').read_text())
        for link in links:
            self.assertEqual(rows[link['path']]['runtime_link'], link)
            for path in link['requires']:
                self.assertEqual(rows[path]['sha256'], snapshot[path]['sha256'])
                self.assertIn({'package': 'mica-system', 'version': PACKAGE_VERSION, 'architecture': 'all'}, rows[path]['origins'])
        self.assertEqual(report['provenance']['capture_sha256']['configured.json'],
                         hashlib.sha256((self.inputs / 'configured.json').read_bytes()).hexdigest())

    def test_optimizer_cache_is_excluded_while_loader_state_survives(self):
        cache = loader_cache([('libfirst.so', '/usr/lib/libfirst.so')])
        self.f.write('/etc/ld.so.cache', cache)
        self.f.write('/usr/sbin/ldconfig', elf(), 0o755)
        self.f.write('/var/cache/ldconfig/aux-cache', b'host-specific optimizer state\n')
        self.f.rules['consumers']['mica-system']['roots'].append({
            'paths': ['/etc/ld.so.cache', '/usr/sbin/ldconfig'],
            'kind': 'resource',
            'reason': 'runtime dynamic loader state and maintenance tool',
        })
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.f.capture_ownership()
        shutil.copyfile(self.f.db / 'mica-system.list', self.inputs / 'info/mica-system.list')
        self.capture()

        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.f.out.joinpath('var/cache/ldconfig/aux-cache').exists())
        self.assertEqual(self.f.out.joinpath('etc/ld.so.cache').read_bytes(), cache)
        self.assertTrue(os.access(self.f.out / 'usr/sbin/ldconfig', os.X_OK))
        rows = {row['path'] for row in json.loads(self.f.report.read_text())['files']}
        self.assertIn('/etc/ld.so.cache', rows)
        self.assertIn('/usr/sbin/ldconfig', rows)
        self.assertNotIn('/var/cache/ldconfig/aux-cache', rows)

    def test_missing_required_path_is_not_filtered(self):
        self.capture()
        self.f.root.joinpath('usr/bin/app').unlink()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('missing path', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_missing_archive_identity_refuses(self):
        self.capture()
        (self.inputs / 'upstream.tsv').write_text('')
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('archive identity', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_surviving_operator_omission_refuses(self):
        self.capture()
        self.f.write('/usr/bin/unselected', elf(), 0o755)
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('operator executable omitted: /usr/bin/unselected', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_post_transform_hash_and_debug_counterpart(self):
        self.capture()
        before = hashlib.sha256(self.f.root.joinpath('usr/bin/app').read_bytes()).hexdigest()
        self.f.write('/usr/bin/app', elf(), 0o755)
        after = hashlib.sha256(self.f.root.joinpath('usr/bin/app').read_bytes()).hexdigest()
        debug = self.debug / '.build-id/ab/cd.debug'
        debug.parent.mkdir(parents=True)
        debug.write_bytes(b'fixture symbols')
        (self.debug / 'manifest.tsv').write_text(f'/usr/bin/app\tabcd\t.build-id/ab/cd.debug\t2048\t2048\t{after}\n')
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        provenance = json.loads(self.f.report.read_text())['provenance']['files']['/usr/bin/app']
        self.assertEqual(provenance['configured']['sha256'], before)
        self.assertEqual(provenance['final']['sha256'], after)
        self.assertEqual(provenance['debug']['sha256'], hashlib.sha256(debug.read_bytes()).hexdigest())

    def test_debug_mismatch_refuses(self):
        self.capture()
        (self.debug / 'manifest.tsv').write_text('/usr/bin/app\tabcd\t.build-id/ab/cd.debug\t2048\t2048\t' + '0' * 64 + '\n')
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('debug counterpart', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_explicit_residue_rule_is_refused(self):
        self.f.write('/var/lib/dpkg/status', b'build database')
        self.f.rules['consumers']['mica-system']['roots'].append({'paths': ['/var/lib/dpkg', '/var/lib/dpkg/status'], 'kind': 'resource', 'reason': 'invalid build-state root', 'generated': 'fixture'})
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.capture()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('build residue selected', r.stderr)
        self.assertFalse(self.f.report.exists())

    def test_transfer_compares_hardlinks_and_capabilities(self):
        self.capture()
        copy = self.f.base / 'transferred'
        copy.mkdir()
        archive = self.f.base / 'tree.tar'
        subprocess.run(['tar', '-C', str(self.f.root), '--numeric-owner', '--xattrs', '--xattrs-include=*', '-cf', str(archive), '.'], check=True)
        subprocess.run(['tar', '-C', str(copy), '--same-owner', '--xattrs', '--xattrs-include=*', '-xf', str(archive)], check=True)
        r = self.command('compare', root=copy, snapshot=self.inputs / 'configured.json')
        self.assertEqual(r.returncode, 0, r.stderr)
        alias = copy / 'var/lib/seed-alias'
        saved = copy / 'var/lib/seed'
        alias.unlink()
        shutil.copy2(saved, alias)
        os.chown(alias, 123, 456)
        r = self.command('compare', root=copy, snapshot=self.inputs / 'configured.json')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('transfer changed', r.stderr)

    def test_native_alternative_capture_retains_exact_alias(self):
        self.f.link('/usr/bin/fixture-alias', '/etc/alternatives/fixture-alias')
        self.f.link('/etc/alternatives/fixture-alias', '/usr/bin/helper')
        (self.inputs / 'alternatives/fixture-alias').write_text('Name: fixture-alias\nLink: /usr/bin/fixture-alias\nStatus: auto\nBest: /usr/bin/helper\nValue: /usr/bin/helper\n\nAlternative: /usr/bin/helper\nPriority: 1\n')
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(os.readlink(self.f.out / 'etc/alternatives/fixture-alias'), '/usr/bin/helper')

    def test_native_enablement_retains_configured_link(self):
        link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
        target = '/usr/lib/systemd/system/fixture.service'
        self.f.write(target, b'[Service]\nExecStart=/usr/bin/helper\n')
        self.f.link(link, target)
        self.f.capture_ownership()
        native = self.f.db / 'mica-system.list'
        native.write_text(native.read_text().replace(link + '\n', ''))
        shutil.copyfile(native, self.inputs / 'info/mica-system.list')
        (self.inputs / 'enablement/fixture.service.dsh-also').write_text(link + '\n')
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(os.readlink(self.f.out / link[1:]), target)

    def test_lost_configured_enablement_refuses(self):
        link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
        self.f.link(link, '/usr/bin/helper')
        (self.inputs / 'enablement/fixture.service.dsh-also').write_text(link + '\n')
        self.capture()
        self.f.root.joinpath(link[1:]).unlink()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('missing path', r.stderr)

    def test_preset_removal_uses_exact_record_and_retained_policy(self):
        link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
        policy = '/usr/lib/systemd/system-preset/fixture.preset'
        self.f.write(policy, b'disable fixture.service\n')
        self.f.link(link, '/usr/bin/helper')
        self.f.capture_ownership()
        native = self.f.db / 'mica-system.list'
        native.write_text(native.read_text().replace(link + '\n', ''))
        shutil.copyfile(native, self.inputs / 'info/mica-system.list')
        (self.inputs / 'enablement/fixture.service.dsh-also').write_text(link + '\n')
        self.capture()
        self.f.root.joinpath(link[1:]).unlink()
        (self.inputs / 'preset-removed.tsv').write_text(link + '\t' + policy + '\n')
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.f.out.joinpath(link[1:]).is_symlink())
        self.assertEqual(self.f.out.joinpath(policy[1:]).read_bytes(), b'disable fixture.service\n')

    def test_alternative_manual_slave_needs_exact_install_exclusion(self):
        self.f.link('/usr/bin/fixture-alias', '/etc/alternatives/fixture-alias')
        self.f.link('/etc/alternatives/fixture-alias', '/usr/bin/helper')
        (self.inputs / 'alternatives/fixture-alias').write_text('Name: fixture-alias\nLink: /usr/bin/fixture-alias\nSlaves:\n fixture-alias.1.gz /usr/share/man/man1/fixture-alias.1.gz\nStatus: auto\nBest: /usr/bin/helper\nValue: /usr/bin/helper\n\nAlternative: /usr/bin/helper\nPriority: 1\nSlaves:\n fixture-alias.1.gz /usr/share/man/man1/helper.1.gz\n')
        (self.inputs / 'dpkg-slim.conf').write_text('path-exclude /usr/share/man/*\n')
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.f.out.joinpath('usr/share/man').exists())

    def test_current_policy_resources_survive_final_composition(self):
        anchors = ['/etc/systemd/system/mica-load-extensions.service',
                   '/etc/systemd/system/usr-local-lib-systemd-system.mount',
                   '/etc/systemd/system/etc-containers-systemd.mount',
                   '/etc/tmpfiles.d/mica-var.conf']
        for path in anchors:
            self.f.write(path, shipped(path))
        self.f.rules['consumers']['mica-system']['roots'].append({'paths': anchors, 'kind': 'resource', 'reason': 'current policy resources'})
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.f.capture_ownership()
        shutil.copyfile(self.f.db / 'mica-system.list', self.inputs / 'info/mica-system.list')
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        for path in anchors:
            self.assertEqual(self.f.out.joinpath(path[1:]).read_bytes(), shipped(path))

    def readline_configuration(self):
        policy = json.loads((REPO / 'rootfs/runtime/consumers.json').read_text())
        rule = next(r for r in policy['consumers']['mica-wifi']['roots'] if '/etc/inputrc' in r['paths'])
        self.f.rules['consumers']['mica-system']['roots'].append(rule)
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.f.write('/etc/inputrc', b'fixture readline defaults\n')
        self.capture()

    def test_readline_generated_configuration_binds_capture_and_final_bytes(self):
        self.readline_configuration()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(self.f.report.read_text())
        row = report['provenance']['files']['/etc/inputrc']
        digest = hashlib.sha256(self.f.root.joinpath('etc/inputrc').read_bytes()).hexdigest()
        self.assertEqual(row['configured']['sha256'], digest)
        self.assertEqual(row['final']['sha256'], digest)
        self.assertEqual([row['final'][k] for k in ('mode', 'uid', 'gid')], [0o644, 0, 0])
        self.assertEqual(self.f.command('verify').returncode, 0)

    def test_lost_generated_readline_configuration_refuses(self):
        self.readline_configuration()
        self.f.root.joinpath('etc/inputrc').unlink()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('missing path: /etc/inputrc', r.stderr)
        self.assertFalse(self.f.report.exists())

    def public_metadata(self, marker=None):
        producer = 'rootfs/build.sh public-meta staging; compose-install.sh meta_install'
        rules = json.loads((REPO / 'rootfs/runtime/consumers.json').read_text())
        # Every declared public file: the manifest and the product record.
        for rule in [r for r in rules['consumers']['mica-system']['roots'] if r.get('generated') == producer]:
            self.f.rules['consumers']['mica-system']['roots'].append(rule)
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.f.write('/usr/share/mica/meta/updates/manifest.json', (REPO / 'meta.example/updates/manifest.json').read_bytes())
        self.f.write('/usr/lib/mica/product.conf', b'PRODUCT=fixture\nBOARD=fixture\nPROFILE=dev\nFEATURES=""\nCOMPONENTS=""\n')
        if marker is not None:
            self.f.write('/usr/share/mica/meta/GENERATED', marker)

    def test_current_public_manifest_and_conditional_marker_survive(self):
        self.public_metadata(b'DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n')
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(self.f.report.read_text())
        for path in ['/usr/share/mica/meta/updates/manifest.json', '/usr/share/mica/meta/GENERATED', '/usr/lib/mica/product.conf']:
            self.assertEqual(self.f.out.joinpath(path.lstrip('/')).read_bytes(), self.f.root.joinpath(path.lstrip('/')).read_bytes())
            provenance = report['provenance']['files'][path]
            self.assertEqual(provenance['configured']['sha256'], provenance['final']['sha256'])
            self.assertEqual(provenance['generators'], ['rootfs/build.sh public-meta staging; compose-install.sh meta_install'])
            self.assertEqual(provenance['final']['mode'], 0o644)

    def test_absent_public_marker_stays_absent(self):
        self.public_metadata()
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.f.out.joinpath('usr/share/mica/meta/GENERATED').exists())

    def test_changed_or_lost_public_input_refuses(self):
        self.public_metadata(b'DEVELOPMENT-GRADE\nDOMAINS=boot\n')
        self.capture()
        self.f.root.joinpath('usr/share/mica/meta/GENERATED').unlink()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('public metadata', r.stderr)

    def test_public_manifest_tamper_refuses(self):
        self.public_metadata()
        self.capture()
        self.f.write('/usr/share/mica/meta/updates/manifest.json', b'{}')
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('public metadata', r.stderr)

    def test_empty_installed_public_marker_refuses(self):
        self.public_metadata(b'')
        self.capture()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('public metadata', r.stderr)

    def test_uncaptured_public_metadata_refuses(self):
        self.f.write('/usr/share/mica/meta/fixture.json', b'{}')
        self.capture()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('undeclared public metadata: /usr/share/mica/meta/fixture.json', r.stderr)

    def test_unknown_public_metadata_directory_refuses(self):
        self.public_metadata()
        self.f.root.joinpath('usr/share/mica/meta/unapproved').mkdir()
        self.capture()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('undeclared public metadata: /usr/share/mica/meta/unapproved', r.stderr)

    def test_missing_native_producer_capture_refuses(self):
        (self.inputs / 'enablement/fixture.service.dsh-also').write_text('/etc/systemd/system/fixture.service\n')
        self.capture()
        (self.inputs / 'enablement/fixture.service.dsh-also').unlink()
        r = self.compose()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('captured native outputs changed: enablement', r.stderr)

    def test_allocated_bytes_measure_the_selected_destination(self):
        sparse = self.f.root / 'var/lib/sparse'
        with sparse.open('wb') as stream:
            stream.seek(1024 * 1024)
            stream.write(b'x')
        self.f.rules['consumers']['mica-system']['roots'].append({'paths': ['/var/lib/sparse'], 'kind': 'resource', 'reason': 'sparse fixture', 'generated': 'fixture'})
        self.f.rules_path.write_text(json.dumps(self.f.rules))
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(self.f.report.read_text())
        groups = {r['hardlink'] for r in report['files'] if r['type'] == 'file'}
        actual = sum(self.f.out.joinpath(p.lstrip('/')).stat().st_blocks * 512 for p in groups)
        self.assertEqual(report['measurements']['allocated_file_bytes'], actual)

    def test_packed_measurement_binds_prefix_and_complete_image(self):
        self.capture()
        r = self.compose()
        self.assertEqual(r.returncode, 0, r.stderr)
        data, hashes = b'fixture compressed root', b'fixture verity hash bytes'
        (self.f.base / 'rootfs-verity.img').write_bytes(data + hashes)
        (self.f.base / 'rootfs-verity.env').write_text(f'SQUASHFS_BYTES={len(data)}\nIMAGE_BYTES={len(data + hashes)}\n')
        r = self.command('measure-packed', root=self.f.out, out=self.f.base)
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads(self.f.report.read_text())['measurements']
        self.assertEqual(m['squashfs']['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(m['verity_image']['sha256'], hashlib.sha256(data + hashes).hexdigest())
        self.f.out.joinpath('usr/bin/app').write_bytes(b'changed')
        r = self.command('measure-packed', root=self.f.out, out=self.f.base)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('metadata or bytes changed', r.stderr)

    def test_current_transform_exclusions_are_exact(self):
        f = self.f
        with (f.db / 'mica-system.list').open('a') as stream:
            stream.write('/usr/bin/systemd-hwdb\n/usr/sbin/pam_getenv\n')
        f.rules['consumers']['mica-system']['roots'].append({'paths': ['/usr/bin/systemd-hwdb', '/usr/sbin/pam_getenv', '/usr/bin/app'], 'packages': ['mica-system'], 'kind': 'executable', 'reason': 'approved transformation survivors'})
        r = f.command()
        self.assertEqual(r.returncode, 0, r.stderr)
        shutil.rmtree(f.out)
        f.report.unlink()
        with (f.db / 'mica-system.list').open('a') as stream:
            stream.write('/usr/bin/required-new-tool\n')
        f.rules['consumers']['mica-system']['roots'][-1]['paths'].append('/usr/bin/required-new-tool')
        r = f.command()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('required-new-tool', r.stderr)

    def test_actual_docker_pack_uses_final_selection(self):
        dockerfile = (REPO / 'rootfs/compose/90-pack.Dockerfile').read_text()
        selection = dockerfile.index('python3 /mica-runtime/compose.py compose')
        squash = dockerfile.index('sh /mica-scripts/pack-squashfs.sh')
        self.assertLess(selection, squash)
        self.assertIn('RUN --network=none', dockerfile[:selection].rsplit('\n#', 1)[-1])
        self.assertIn('COPY --from=pack /runtime/ /', dockerfile)
        self.assertIn('rootfs-report.runtime.json', dockerfile)
        self.assertIn('mksquashfs /runtime ', (REPO / 'rootfs/scripts/pack-squashfs.sh').read_text())


if __name__ == '__main__':
    unittest.main()
