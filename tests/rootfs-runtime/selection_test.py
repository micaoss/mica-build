"""Exercise actual ELF files, filesystem objects and the selector CLI offline."""
import json
import os
import pathlib
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

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

SELECTOR = Path(__file__).resolve().parents[2] / 'rootfs/runtime/select.py'
CAP = struct.pack('<IIIII', 0x02000001, 0x2000, 0, 0, 0).hex()


def elf(machine=62, needed=(), interp=None, runpath=None, rpath=None, soname=None):
    """A sectionless ELF64 with PT_LOAD/PT_DYNAMIC, just as stripped inputs may be."""
    strings = bytearray(b'\0')
    tags = []
    for tag, values in [(1, needed), (29, [runpath] if runpath is not None else []),
                        (15, [rpath] if rpath is not None else []),
                        (14, [soname] if soname is not None else [])]:
        for value in values:
            tags.append((tag, len(strings)))
            strings.extend(value.encode() + b'\0')
    dynamic = b''.join(struct.pack('<QQ', t, v) for t, v in
                       [(5, 0x400400), (10, len(strings)), *tags, (0, 0)])
    data = bytearray(2048)
    ident = b'\x7fELF\x02\x01\x01' + bytes(9)
    data[:64] = struct.pack('<16sHHIQQQIHHHHHH', ident, 3, machine, 1,
                           0, 64, 0, 0, 64, 56, 3 if interp else 2, 0, 0, 0)
    headers = [(1, 5, 0, 0x400000, 0x400000, len(data), len(data), 4096),
               (2, 4, 512, 0x400200, 0x400200, len(dynamic), len(dynamic), 8)]
    if interp:
        raw = interp.encode() + b'\0'
        data[256:256 + len(raw)] = raw
        headers.append((3, 4, 256, 0x400100, 0x400100, len(raw), len(raw), 1))
    for i, header in enumerate(headers):
        data[64 + i * 56:120 + i * 56] = struct.pack('<IIQQQQQQ', *header)
    data[512:512 + len(dynamic)] = dynamic
    data[1024:1024 + len(strings)] = strings
    return bytes(data)


def loader_cache(entries):
    strings = bytearray()
    records = bytearray()
    start = 48 + 24 * len(entries)
    for name, path in entries:
        key = start + len(strings); strings.extend(name.encode() + b'\0')
        value = start + len(strings); strings.extend(path.encode() + b'\0')
        records.extend(struct.pack('<iIIIQ', 0x303, key, value, 0, 0))
    return b'glibc-ld.so.cache1.1' + struct.pack('<IIB3xIIII', len(entries), len(strings), 2, 0, 0, 0, 0) + records + strings


class SelectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mica-b4-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'installed'
        self.root.mkdir()
        self.out = self.base / 'runtime'
        self.db = self.base / 'dpkg-info'
        self.db.mkdir()
        self.manifest = self.base / 'manifest.tsv'
        self.manifest.write_text('#package\tversion\tarchitecture\nmica-system\t1\tall\nlibfixture\t1\tamd64\nunused\t1\tall\n')
        self.packages = self.base / 'selected.pkgs'
        self.packages.write_text('mica-system\n')
        self.report = self.base / 'rootfs-report.runtime.json'
        self.rules_path = self.base / 'rules.json'
        self.write('/usr/bin/app', elf(needed=['libfirst.so'], interp='/lib/loader.so'), 0o755)
        self.write('/usr/lib/libfirst.so', elf(needed=['libsecond.so']))
        self.write('/usr/lib/libsecond.so', elf())
        self.write('/usr/lib/loader.so', elf(), 0o755)
        self.link('/lib', 'usr/lib')
        self.write('/usr/bin/sh', elf(), 0o755)
        self.write('/usr/bin/helper', b'#!/usr/bin/sh\nexit 0\n', 0o755)
        self.write('/usr/bin/entry', b'#!/usr/bin/sh\nhelper\n', 0o755)
        self.write('/usr/lib/security/pam_fixture.so', elf())
        self.write('/usr/lib/libnss_fixture.so.2', elf())
        self.write('/etc/pam.d/login', b'auth required pam_fixture.so\n')
        self.write('/etc/nsswitch.conf', b'passwd: fixture\n')
        self.write('/etc/generated.conf', b'generated\n', 0o640)
        self.write('/etc/license', b'license\n')
        self.write('/usr/share/doc/mica-system/copyright', b'system license\n')
        self.write('/usr/share/doc/libfixture/copyright', b'library license\n')
        self.write('/var/lib/seed', b'seed\n', 0o640)
        os.chown(self.root / 'var/lib/seed', 123, 456)
        self.write('/usr/bin/captool', elf(), 0o4755)
        os.setxattr(self.root / 'usr/bin/captool', 'security.capability', bytes.fromhex(CAP))
        os.setxattr(self.root / 'var/lib/seed', 'user.fixture', b'value')
        os.link(self.root / 'var/lib/seed', self.root / 'var/lib/seed-alias')
        self.link('/etc/absolute', '/var/lib/seed')
        self.link('/etc/relative', '../var/lib/seed-alias')
        self.write('/usr/bin/unselected', elf(), 0o755)
        self.write('/usr/lib/debug/app.debug', b'matching debug input')
        self.write('/usr/lib/udev/hwdb.bin', b'static hwdb')
        self.write('/usr/lib/modules/modules.dep', b'support index input')
        self.write('/etc/systemd/system-generators/systemd-ssh-generator', b'placeholder')
        self.root.joinpath('etc/systemd/system-generators/systemd-ssh-generator').unlink()
        self.link('/etc/systemd/system-generators/systemd-ssh-generator', '/dev/null')
        self.write('/usr/lib/systemd/systemd-tmpfiles', elf(), 0o755)
        self.write('/etc/tmpfiles.d/mica-var.conf', b'f /run/mica/wtmp 0664 root utmp -\n')
        self.link('/var/log/wtmp', '/run/mica/wtmp')
        self.write('/etc/systemd/system/systemd-tmpfiles-setup.service', b'[Service]\n')
        self.root.joinpath('mnt/data').mkdir(parents=True)
        self.rules = {'library_dirs': ['/usr/lib'], 'path': ['/usr/bin'], 'consumers': {'mica-system': {
            'roots': [
                {'paths': ['/usr/bin/app', '/usr/bin/entry', '/usr/bin/helper', '/usr/bin/captool'], 'kind': 'executable', 'reason': 'entrypoints and invoked helper'},
                {'paths': ['/usr/lib/security/pam_fixture.so', '/usr/lib/libnss_fixture.so.2', '/etc/pam.d/login', '/etc/nsswitch.conf', '/etc/license', '/etc/absolute', '/etc/relative', '/etc/systemd/system-generators/systemd-ssh-generator'], 'kind': 'resource', 'reason': 'authentication and policy'},
                {'paths': ['/var/lib/seed', '/var/lib/seed-alias', '/etc/generated.conf'], 'kind': 'resource', 'reason': 'generated state', 'generated': 'fixture-configure'},
                {'paths': ['/mnt/data'], 'kind': 'directory', 'reason': 'DATA mountpoint'},
                {'paths': ['/usr/bin/captool'], 'kind': 'executable', 'reason': 'required capability', 'expect': {'xattrs': {'security.capability': CAP}}},
                {'paths': ['/var/log/wtmp'], 'kind': 'resource', 'reason': 'bounded login accounting'},
            ],
            'runtime_links': [
                {'path': '/etc/systemd/system-generators/systemd-ssh-generator', 'target': '/dev/null', 'generator': 'kernel devtmpfs', 'ordering': 'before systemd generators', 'test': 'B7 SSH listen and image-only keys', 'requires': []},
                {'path': '/var/log/wtmp', 'target': '/run/mica/wtmp', 'generator': 'systemd-tmpfiles', 'ordering': 'systemd-tmpfiles-setup before login', 'test': 'B7 repeated login bounds', 'requires': ['/usr/lib/systemd/systemd-tmpfiles', '/etc/tmpfiles.d/mica-var.conf', '/etc/systemd/system/systemd-tmpfiles-setup.service']},
            ],
        }}}
        self.capture_ownership()

    def write(self, path, data, mode=0o644):
        at = self.root / path.lstrip('/')
        at.parent.mkdir(parents=True, exist_ok=True)
        at.write_bytes(data)
        at.chmod(mode)

    def link(self, path, target):
        at = self.root / path.lstrip('/')
        at.parent.mkdir(parents=True, exist_ok=True)
        at.symlink_to(target)

    def capture_ownership(self):
        paths = ['/.']
        for parent, dirs, files in os.walk(self.root, followlinks=False):
            paths.extend('/' + str((Path(parent) / p).relative_to(self.root)) for p in dirs + files)
        paths = [p for p in paths if p not in ['/etc/generated.conf', '/var/lib/seed', '/var/lib/seed-alias']]
        (self.db / 'mica-system.list').write_text('\n'.join(sorted(set(paths))) + '\n')
        (self.db / 'libfixture:amd64.list').write_text('/usr/lib/libsecond.so\n/usr/share/doc/libfixture/copyright\n')
        text = (self.db / 'mica-system.list').read_text().replace('/usr/lib/libsecond.so\n', '').replace('/usr/share/doc/libfixture/copyright\n', '')
        (self.db / 'mica-system.list').write_text(text)
        (self.db / 'unused.list').write_text('/usr/bin/unselected\n')
        (self.db / 'mica-system.list').write_text(text.replace('/usr/bin/unselected\n', ''))

    def command(self, command='select', **overrides):
        self.rules_path.write_text(json.dumps(self.rules))
        options = dict(root=self.root, output=self.out, packages=self.packages, inventory=self.manifest,
                       ownership=self.db, rules=self.rules_path, arch='amd64', report=self.report)
        options.update(overrides)
        if command == 'verify':
            options = {'root': self.out, 'report': self.report, **overrides}
        argv = [sys.executable, str(SELECTOR), command]
        for k, v in options.items():
            argv.extend(['--' + k, str(v)])
        return subprocess.run(argv, capture_output=True, text=True, timeout=10)

    def selected(self):
        result = self.command()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(self.report.read_text())

    def refuse(self, fragment, **kwargs):
        result = self.command(**kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(fragment, result.stderr)
        self.assertFalse(self.report.exists(), 'failed selection must not publish a success report')

    def test_positive_offline_metadata_and_provenance(self):
        report = self.selected()
        rows = {r['path']: r for r in report['files']}
        for path in ['/usr/lib/libsecond.so', '/usr/lib/loader.so', '/usr/bin/sh', '/usr/bin/helper', '/etc/generated.conf']:
            self.assertIn(path, rows)
            self.assertTrue(rows[path]['reasons'])
            self.assertTrue(rows[path]['origins'])
        for path in ['/usr/bin/unselected', '/usr/lib/debug/app.debug', '/usr/lib/udev/hwdb.bin', '/usr/lib/modules/modules.dep']:
            self.assertNotIn(path, rows)
            self.assertTrue((self.root / path[1:]).exists())
        self.assertIn('/usr/lib/debug/app.debug', {r['path'] for r in report['external_inputs']})
        self.assertIn('/usr/lib/modules/modules.dep', {r['path'] for r in report['external_inputs']})
        seed = self.out / 'var/lib/seed'
        alias = self.out / 'var/lib/seed-alias'
        self.assertEqual(seed.stat().st_ino, alias.stat().st_ino)
        self.assertEqual((seed.stat().st_uid, seed.stat().st_gid, seed.stat().st_mode & 0o7777), (123, 456, 0o640))
        self.assertEqual(os.getxattr(seed, 'user.fixture'), b'value')
        self.assertEqual(os.getxattr(self.out / 'usr/bin/captool', 'security.capability').hex(), CAP)
        self.assertEqual(os.readlink(self.out / 'etc/absolute'), '/var/lib/seed')
        self.assertEqual(os.readlink(self.out / 'etc/systemd/system-generators/systemd-ssh-generator'), '/dev/null')
        self.assertEqual(self.command('verify').returncode, 0)

    def test_declaration_family(self):
        # A declaration keyed `mica-board-*` covers every mica-board-<b>: the
        # member's own name is not in the file, and in the family's rules the
        # key stands for the member.
        f = self
        f.write('/etc/mica/board.conf', b'board fact\n')
        f.write('/usr/share/doc/mica-board-fixture/copyright', b'board license\n')
        (f.db / 'mica-board-fixture.list').write_text('/etc/mica\n/etc/mica/board.conf\n/usr/share/doc/mica-board-fixture\n/usr/share/doc/mica-board-fixture/copyright\n')
        f.manifest.write_text(f.manifest.read_text() + 'mica-board-fixture\t1\tall\n')
        f.packages.write_text('mica-system\nmica-board-fixture\n')
        f.rules['consumers']['mica-board-*'] = {
            'roots': [{'paths': ['/etc/mica/*.conf'], 'kind': 'resource', 'reason': 'board facts', 'packages': ['mica-board-*']}],
            'runtime_links': []}
        report = f.selected()
        self.assertTrue((f.out / 'etc/mica/board.conf').exists())
        self.assertIn('mica-board-fixture', json.dumps(report))
        shutil.rmtree(f.out); f.out.mkdir(); f.report.unlink()
        f.packages.write_text('mica-system\nmica-boardless\n')
        f.manifest.write_text(f.manifest.read_text() + 'mica-boardless\t1\tall\n')
        f.refuse('no runtime declaration: mica-boardless')

    def test_arm64_offline(self):
        for p in self.root.rglob('*'):
            if not p.is_symlink() and p.is_file() and p.read_bytes().startswith(b'\x7fELF'):
                data = bytearray(p.read_bytes()); struct.pack_into('<H', data, 18, 183); p.write_bytes(data)
        os.setxattr(self.root / 'usr/bin/captool', 'security.capability', bytes.fromhex(CAP))
        self.manifest.write_text(self.manifest.read_text().replace('amd64', 'arm64'))
        (self.db / 'libfixture:amd64.list').rename(self.db / 'libfixture:arm64.list')
        r = self.command(arch='arm64'); self.assertEqual(r.returncode, 0, r.stderr)

    def test_missing_elf_interpreter(self):
        (self.root / 'usr/lib/loader.so').unlink(); self.refuse('ELF interpreter')

    def test_missing_recursive_library(self):
        (self.root / 'usr/lib/libsecond.so').unlink(); self.refuse('shared library libsecond.so')

    def test_missing_script_interpreter(self):
        (self.root / 'usr/bin/sh').unlink(); self.refuse('script interpreter')

    def test_missing_invoked_helper(self):
        (self.root / 'usr/bin/helper').unlink(); self.refuse('/usr/bin/helper')

    def test_missing_generated_state(self):
        (self.root / 'etc/generated.conf').unlink(); self.refuse('/etc/generated.conf')

    def test_missing_pam_nss_config_license_mountpoint(self):
        for path in ['usr/lib/security/pam_fixture.so', 'usr/lib/libnss_fixture.so.2', 'etc/pam.d/login', 'etc/license', 'mnt/data']:
            with self.subTest(path=path):
                at = self.root / path; saved = self.base / 'saved'; at.rename(saved)
                self.refuse('/' + path); saved.rename(at)

    def test_symlink_escape(self):
        p = self.root / 'etc/relative'; p.unlink(); p.symlink_to('../../outside')
        self.refuse('path escape')

    def test_broken_link(self):
        p = self.root / 'etc/relative'; p.unlink(); p.symlink_to('/missing-target')
        self.refuse('broken link')

    def test_symlink_cycle(self):
        p = self.root / 'etc/relative'; p.unlink(); p.symlink_to('relative')
        self.refuse('symlink cycle')

    def test_interpreter_cycle(self):
        self.write('/usr/bin/sh', b'#!/usr/bin/entry\n', 0o755)
        self.refuse('interpreter cycle')

    def test_lost_capability_before_selection(self):
        os.removexattr(self.root / 'usr/bin/captool', 'security.capability')
        self.refuse('security.capability')

    def test_verify_detects_metadata_and_payload_losses(self):
        mutations = [('capability', lambda: os.removexattr(self.out / 'usr/bin/captool', 'security.capability')),
                     ('mode', lambda: (self.out / 'usr/bin/helper').chmod(0o644)),
                     ('uid', lambda: os.chown(self.out / 'var/lib/seed', 0, 456)),
                     ('mtime', lambda: os.utime(self.out / 'etc/generated.conf', ns=(0, 0))),
                     ('digest', lambda: (self.out / 'etc/generated.conf').write_bytes(b'bad')),
                     ('target', lambda: ((self.out / 'etc/relative').unlink(), (self.out / 'etc/relative').symlink_to('/etc/license'))),
                     ('hardlink', lambda: ((self.out / 'var/lib/seed-alias').unlink(), shutil.copy2(self.out / 'var/lib/seed', self.out / 'var/lib/seed-alias')))]
        for label, mutate in mutations:
            with self.subTest(label=label):
                report = self.selected(); mutate()
                if label == 'hardlink':
                    os.chown(self.out / 'var/lib/seed-alias', 123, 456)
                for row in report['files']:
                    if row['type'] == 'directory':
                        os.utime(self.out / row['path'][1:], ns=(row['mtime_ns'], row['mtime_ns']))
                result = self.command('verify')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('hardlink changed' if label == 'hardlink' else 'changed', result.stderr)
                shutil.rmtree(self.out); self.report.unlink()

    def test_ambiguous_ownership(self):
        (self.db / 'unused.list').write_text('/usr/bin/app\n')
        self.refuse('ambiguous ownership')

    def test_unowned_selected_path(self):
        p = self.db / 'mica-system.list'; p.write_text(p.read_text().replace('/usr/bin/app\n', ''))
        self.refuse('no origin')

    def test_ambiguous_inventory(self):
        with self.manifest.open('a') as f: f.write('mica-system\t2\tall\n')
        self.refuse('duplicate package')

    def test_wrong_architecture(self):
        self.write('/usr/lib/libsecond.so', elf(machine=183)); self.refuse('ELF architecture')

    def test_lost_executable_bit(self):
        (self.root / 'usr/bin/helper').chmod(0o644); self.refuse('not executable')

    def test_missing_feature_declaration(self):
        self.packages.write_text('mica-system\nnew-feature\n'); self.refuse('no runtime declaration')

    def test_runtime_link_requires_generator(self):
        (self.root / 'etc/tmpfiles.d/mica-var.conf').unlink(); self.refuse('/etc/tmpfiles.d/mica-var.conf')

    def accounting_links(self):
        repo = SELECTOR.parents[2]
        policy = json.loads((repo / 'rootfs/runtime/consumers.json').read_text())
        paths = {'/var/log/wtmp', '/var/log/btmp', '/var/log/lastlog'}
        links = [link for link in policy['consumers']['mica-system']['runtime_links'] if link['path'] in paths]
        self.assertEqual({link['path'] for link in links}, paths)
        (self.root / 'usr/lib/systemd/systemd-tmpfiles').unlink()
        (self.root / 'etc/systemd/system/systemd-tmpfiles-setup.service').unlink()
        self.write('/usr/bin/systemd-tmpfiles', elf(needed=['libfirst.so'], interp='/lib/loader.so'), 0o755)
        self.write('/usr/lib/systemd/system/systemd-tmpfiles-setup.service', b'[Service]\nExecStart=systemd-tmpfiles --create --remove --boot\n')
        self.write('/etc/tmpfiles.d/mica-var.conf', shipped('/etc/tmpfiles.d/mica-var.conf'))
        declared = self.rules['consumers']['mica-system']['runtime_links']
        declared[:] = [link for link in declared if link['path'] not in paths]
        declared.extend(links)
        for link in links:
            if link['path'] != '/var/log/wtmp':
                self.link(link['path'], link['target'])
        self.capture_ownership()
        return links

    def test_accounting_links_retain_generator_and_resources(self):
        links = self.accounting_links()
        rows = {row['path']: row for row in self.selected()['files']}
        for link in links:
            self.assertEqual(rows[link['path']]['runtime_link'], link)
            self.assertEqual(rows[link['path']]['target'], link['target'])
            for required in link['requires']:
                self.assertEqual(rows[required]['type'], 'file')
                self.assertTrue(rows[required]['origins'])
        for dependency in ['/usr/lib/libfirst.so', '/usr/lib/libsecond.so', '/usr/lib/loader.so']:
            self.assertIn(dependency, rows)
        self.assertEqual(rows['/usr/bin/systemd-tmpfiles']['mode'], 0o755)
        self.assertEqual(self.command('verify').returncode, 0)

    def test_accounting_links_refuse_missing_dependencies(self):
        self.accounting_links()
        for path in ['/usr/bin/systemd-tmpfiles', '/usr/lib/systemd/system/systemd-tmpfiles-setup.service',
                     '/etc/tmpfiles.d/mica-var.conf', '/etc/license']:
            with self.subTest(path=path):
                at = self.root / path[1:]
                saved = self.base / 'held-resource'
                at.rename(saved)
                try:
                    self.refuse(path)
                finally:
                    saved.rename(at)

    def test_declared_runtime_links_reject_file_and_directory_substitutions(self):
        for path in ['/etc/systemd/system-generators/systemd-ssh-generator', '/var/log/wtmp']:
            at = self.root / path[1:]
            target = os.readlink(at)
            for kind in ['file', 'directory']:
                with self.subTest(path=path, kind=kind):
                    at.unlink()
                    if kind == 'file':
                        self.write(path, elf() if path.endswith('generator') else b'persistent accounting data', 0o755)
                    else:
                        at.mkdir()
                    try:
                        self.refuse('runtime link must be a symlink: ' + path)
                    finally:
                        at.rmdir() if kind == 'directory' else at.unlink()
                        at.symlink_to(target)
                        if self.out.exists():
                            shutil.rmtree(self.out)
                        if self.report.exists():
                            self.report.unlink()
        report = self.selected()
        rows = {row['path']: row for row in report['files']}
        for link in self.rules['consumers']['mica-system']['runtime_links']:
            self.assertEqual(rows[link['path']]['type'], 'symlink')
            self.assertEqual(rows[link['path']]['target'], link['target'])
            self.assertEqual(rows[link['path']]['runtime_link'], link)

    def test_runtime_link_declaration_is_itself_required(self):
        declaration = self.rules['consumers']['mica-system']
        for rule in declaration['roots']:
            rule['paths'] = [path for path in rule['paths'] if path != '/var/log/wtmp']
        declaration['roots'] = [rule for rule in declaration['roots'] if rule['paths']]
        report = self.selected()
        rows = {row['path']: row for row in report['files']}
        self.assertIn('/var/log/wtmp', rows)
        self.assertIn('/etc/tmpfiles.d/mica-var.conf', rows)
        shutil.rmtree(self.out); self.report.unlink()
        (self.root / 'etc/tmpfiles.d/mica-var.conf').unlink()
        self.refuse('/etc/tmpfiles.d/mica-var.conf')

    def test_runtime_link_declaration_uses_canonical_parent(self):
        self.link('/etc-alias', 'etc')
        self.capture_ownership()
        self.rules['consumers']['mica-system']['runtime_links'][0]['path'] = '/etc-alias/systemd/system-generators/systemd-ssh-generator'
        report = self.selected()
        rows = {row['path']: row for row in report['files']}
        path = '/etc/systemd/system-generators/systemd-ssh-generator'
        self.assertEqual(rows[path]['runtime_link']['target'], '/dev/null')
        self.assertEqual(rows['/etc-alias']['target'], 'etc')
        shutil.rmtree(self.out); self.report.unlink()
        (self.root / path[1:]).unlink()
        self.write(path, elf(), 0o755)
        self.refuse('runtime link must be a symlink: ' + path)

    def test_runtime_link_canonical_alias_is_ambiguous(self):
        self.link('/etc-alias', 'etc')
        self.capture_ownership()
        links = self.rules['consumers']['mica-system']['runtime_links']
        links.append({**links[0], 'path': '/etc-alias/systemd/system-generators/systemd-ssh-generator'})
        self.refuse('duplicate runtime link')

    def test_multi_package_roots_require_each_ownership_list(self):
        self.write('/usr/share/doc/unused/copyright', b'operator tool copyright')
        (self.db / 'unused.list').write_text('/usr/bin/unselected\n/usr/share/doc/unused\n/usr/share/doc/unused/copyright\n')
        self.rules['consumers']['mica-system']['roots'].append({
            'packages': ['mica-system', 'unused'], 'paths': ['/usr/bin/*'],
            'kind': 'executable', 'reason': 'selected operator tools from two required installed packages',
        })
        report = self.selected()
        row = next(row for row in report['files'] if row['path'] == '/usr/bin/unselected')
        self.assertEqual(row['origins'], [{'package': 'unused', 'version': '1', 'architecture': 'all'}])
        shutil.rmtree(self.out); self.report.unlink()
        (self.db / 'unused.list').unlink()
        self.refuse('missing ownership list: unused')
        self.assertFalse(self.out.exists())

    def test_selected_consumer_requires_ownership_capture(self):
        (self.db / 'mica-system.list').unlink()
        self.refuse('missing ownership list: mica-system')

    def test_unrequired_package_ownership_may_be_omitted(self):
        (self.db / 'unused.list').unlink()
        report = self.selected()
        self.assertNotIn('/usr/bin/unselected', {row['path'] for row in report['files']})

    def test_native_ownership_capture_must_be_unambiguous(self):
        shutil.copyfile(self.db / 'libfixture:amd64.list', self.db / 'libfixture.list')
        self.refuse('duplicate ownership list: libfixture')

    def test_undeclared_runtime_link(self):
        self.rules['consumers']['mica-system']['runtime_links'].pop(); self.refuse('broken link')

    def test_output_overlap_or_symlink(self):
        self.refuse('overlap', output=self.root / 'output')
        self.out.symlink_to(self.base / 'elsewhere'); self.refuse('symlink')

    def test_output_not_empty(self):
        self.out.mkdir(); (self.out / 'sentinel').write_text('preserve')
        self.refuse('empty'); self.assertEqual((self.out / 'sentinel').read_text(), 'preserve')

    def test_env_shebang_and_missing_command(self):
        self.write('/usr/bin/env', elf(), 0o755)
        self.write('/usr/bin/entry', b'#!/usr/bin/env sh\nhelper\n', 0o755)
        self.capture_ownership(); self.selected()
        shutil.rmtree(self.out); self.report.unlink()
        self.write('/usr/bin/entry', b'#!/usr/bin/env -S sh -e\n', 0o755)
        self.refuse('unsupported env shebang')

    def test_rpath_inherited_but_runpath_not_inherited(self):
        for tag in ['rpath', 'runpath']:
            with self.subTest(tag=tag):
                self.write('/usr/bin/app', elf(needed=['libprivate.so'], **{tag: '$ORIGIN/../private'}), 0o755)
                self.write('/usr/private/libprivate.so', elf(needed=['libchild.so']))
                self.write('/usr/private/libchild.so', elf())
                self.capture_ownership()
                if tag == 'rpath':
                    self.selected(); shutil.rmtree(self.out); self.report.unlink()
                else:
                    self.refuse('shared library libchild.so')

    def test_ambiguous_library_context(self):
        self.write('/usr/bin/app', elf(needed=['libfirst.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libfirst.so', elf())
        self.write('/usr/bin/helper', elf(needed=['libfirst.so']), 0o755)
        self.capture_ownership(); self.refuse('ambiguous library')

    def test_elf_entry_direct_siblings_are_discovered_before_children(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libshared.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libshared.so']))
        self.write('/usr/private/libshared.so', elf())
        self.capture_ownership()
        rows = {row['path']: row for row in self.selected()['files']}
        self.assertIn('/usr/private/libcore.so', rows)
        self.assertIn('/usr/private/libshared.so', rows)
        self.assertEqual(self.command('verify').returncode, 0)

    def test_elf_entry_soname_alias_is_loaded_without_synthetic_file(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libprovider.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libalias.so']))
        self.write('/usr/private/libprovider.so', elf(soname='libalias.so'))
        self.capture_ownership()
        rows = {row['path']: row for row in self.selected()['files']}
        self.assertIn('/usr/private/libprovider.so', rows)
        self.assertNotIn('/usr/private/libalias.so', rows)
        self.assertFalse((self.root / 'usr/private/libalias.so').exists())
        self.assertEqual(self.command('verify').returncode, 0)

    def test_elf_entry_loaded_provider_cannot_hide_missing_transitive_library(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libprovider.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libalias.so']))
        self.write('/usr/private/libprovider.so', elf(soname='libalias.so', needed=['libabsent.so']))
        self.capture_ownership(); self.refuse('shared library libabsent.so')

    def test_elf_entry_missing_direct_sibling_is_not_supplied_by_context(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libshared.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libshared.so']))
        self.capture_ownership(); self.refuse('shared library libshared.so')

    def test_elf_entry_independent_root_cannot_borrow_retained_namespace(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libshared.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libshared.so']))
        self.write('/usr/private/libshared.so', elf())
        self.rules['consumers']['mica-system']['roots'].append({
            'paths': ['/usr/private/libcore.so'], 'kind': 'resource', 'reason': 'independent ELF entry',
        })
        self.capture_ownership(); self.refuse('shared library libshared.so for /usr/private/libcore.so')

    def test_elf_entry_keeps_first_discovery_context(self):
        self.write('/usr/bin/app', elf(needed=['liba.so', 'libb.so']), 0o755)
        self.write('/usr/lib/liba.so', elf(needed=['libcommon.so'], runpath='/usr/private'))
        self.write('/usr/lib/libb.so', elf(needed=['libcommon.so'], rpath='/usr/private:/usr/child'))
        self.write('/usr/private/libcommon.so', elf(needed=['libchild.so']))
        self.write('/usr/child/libchild.so', elf())
        self.capture_ownership(); self.refuse('shared library libchild.so')

    def test_elf_entry_soname_conflict_across_independent_entries_is_refused(self):
        self.write('/usr/bin/app', elf(needed=['liba.so']), 0o755)
        self.write('/usr/lib/liba.so', elf(soname='libalias.so'))
        self.write('/usr/bin/helper', elf(needed=['libb.so']), 0o755)
        self.write('/usr/lib/libb.so', elf(soname='libalias.so'))
        self.capture_ownership(); self.refuse('ambiguous library libalias.so')

    def test_elf_entry_loaded_soname_does_not_mask_ambiguous_cache(self):
        self.write('/usr/bin/app', elf(needed=['libprovider.so', 'libalias.so']), 0o755)
        self.write('/usr/lib/libprovider.so', elf(soname='libalias.so'))
        self.write('/etc/ld.so.cache', loader_cache([
            ('libalias.so', '/usr/lib/libfirst.so'), ('libalias.so', '/usr/lib/libsecond.so'),
        ]))
        self.capture_ownership(); self.refuse('ambiguous cache library: libalias.so')

    def test_elf_entry_wrong_architecture_is_not_registered_by_soname(self):
        self.write('/usr/bin/app', elf(needed=['libcore.so', 'libprovider.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/libcore.so', elf(needed=['libalias.so']))
        self.write('/usr/private/libprovider.so', elf(machine=183, soname='libalias.so'))
        self.capture_ownership(); self.refuse('ELF architecture')

    def test_elf_entry_breadth_first_discovers_provider_before_grandchild(self):
        self.write('/usr/bin/app', elf(needed=['liba.so', 'libb.so'], runpath='/usr/private'), 0o755)
        self.write('/usr/private/liba.so', elf(needed=['libchild.so'], runpath='/usr/private'))
        self.write('/usr/private/libb.so', elf(needed=['libshared.so'], runpath='/usr/deep'))
        self.write('/usr/private/libchild.so', elf(needed=['libshared.so']))
        self.write('/usr/deep/libshared.so', elf(soname='libshared.so'))
        self.capture_ownership()
        paths = {row['path'] for row in self.selected()['files']}
        self.assertIn('/usr/private/libchild.so', paths)
        self.assertIn('/usr/deep/libshared.so', paths)
        self.assertEqual(self.command('verify').returncode, 0)

    def test_elf_entry_dependency_cycle_is_bounded(self):
        self.write('/usr/lib/libsecond.so', elf(needed=['libfirst.so']))
        self.capture_ownership()
        paths = {row['path'] for row in self.selected()['files']}
        self.assertIn('/usr/lib/libfirst.so', paths)
        self.assertIn('/usr/lib/libsecond.so', paths)
        self.assertEqual(self.command('verify').returncode, 0)

    def test_elf_soname_invalid_names_are_refused(self):
        for name in ['', '.', '..', '/usr/lib/libfirst.so', 'lib/name', 'lib\tname', 'lib name', '$ORIGIN']:
            with self.subTest(name=name):
                self.write('/usr/lib/libfirst.so', elf(soname=name))
                self.refuse('invalid ELF SONAME')

    def test_elf_soname_duplicate_tag_is_refused(self):
        data = bytearray(elf(needed=['libsecond.so'], soname='libfirst.so'))
        struct.pack_into('<Q', data, 512 + 2 * 16, 14)
        self.write('/usr/lib/libfirst.so', data)
        self.refuse('ambiguous ELF dynamic tag')

    def test_elf_soname_string_bounds_and_utf8_are_checked(self):
        for mutation in ['bounds', 'termination', 'utf8']:
            with self.subTest(mutation=mutation):
                data = bytearray(elf(soname='libfirst.so'))
                if mutation == 'bounds':
                    struct.pack_into('<Q', data, 512 + 2 * 16 + 8, len(data))
                elif mutation == 'termination':
                    data[1024 + len(b'\0libfirst.so')] = 0xff
                else:
                    data[1025] = 0xff
                self.write('/usr/lib/libfirst.so', data)
                self.refuse('utf-8' if mutation == 'utf8' else 'invalid ELF string')

    def test_removed_owned_hwdb_vendor_enablement_is_not_selected(self):
        unit = '/usr/lib/systemd/system/systemd-hwdb-update.service'
        link = '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service'
        keep = '/usr/lib/systemd/system/required-fixture.service'
        self.write(unit, b'[Service]\n')
        self.write(keep, b'[Service]\n')
        self.link(link, '../systemd-hwdb-update.service')
        self.capture_ownership()
        self.root.joinpath(unit[1:]).unlink()
        self.root.joinpath(link[1:]).unlink()
        self.rules['consumers']['mica-system']['roots'].append({
            'packages': ['mica-system'],
            'paths': ['/usr/lib/systemd/system/*.service', '/usr/lib/systemd/system/*.wants/*'],
            'kind': 'resource', 'reason': 'owned units after the existing exact hwdb removal',
        })
        paths = {row['path'] for row in self.selected()['files']}
        self.assertIn(keep, paths)
        self.assertNotIn(unit, paths)
        self.assertNotIn(link, paths)

    def test_unrelated_missing_owned_unit_is_refused(self):
        path = '/usr/lib/systemd/system/required-fixture.service'
        self.write(path, b'[Service]\n')
        self.capture_ownership()
        self.root.joinpath(path[1:]).unlink()
        self.rules['consumers']['mica-system']['roots'].append({
            'packages': ['mica-system'], 'paths': ['/usr/lib/systemd/system/*.service'],
            'kind': 'resource', 'reason': 'unrelated required unit',
        })
        self.refuse('missing path: ' + path)

    def test_unrelated_missing_owned_enablement_is_refused(self):
        path = '/usr/lib/systemd/system/sysinit.target.wants/required-fixture.service'
        self.link(path, '/etc/systemd/system/systemd-tmpfiles-setup.service')
        self.capture_ownership()
        self.root.joinpath(path[1:]).unlink()
        self.rules['consumers']['mica-system']['roots'].append({
            'packages': ['mica-system'], 'paths': ['/usr/lib/systemd/system/*.wants/*'],
            'kind': 'resource', 'reason': 'unrelated required enablement',
        })
        self.refuse('missing path: ' + path)

    def test_removed_hwdb_vendor_enablement_cannot_be_an_explicit_root(self):
        path = '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service'
        self.write('/usr/lib/systemd/system/systemd-hwdb-update.service', b'[Service]\n')
        self.link(path, '../systemd-hwdb-update.service')
        self.capture_ownership()
        self.rules['consumers']['mica-system']['roots'].append({
            'paths': [path], 'kind': 'resource', 'reason': 'accidental explicit selection',
        })
        self.refuse('excluded runtime payload: ' + path)

    def test_excluded_payload_cannot_be_a_root(self):
        for p in ['/usr/lib/udev/hwdb.bin', '/usr/lib/debug/app.debug', '/usr/lib/modules/modules.dep']:
            with self.subTest(path=p):
                r = {'paths': [p], 'kind': 'resource', 'reason': 'bad accidental selection'}
                self.rules['consumers']['mica-system']['roots'].append(r)
                self.refuse('excluded runtime payload')
                self.rules['consumers']['mica-system']['roots'].pop()

    def test_no_recursive_directory_copy(self):
        self.rules['consumers']['mica-system']['roots'].append({'paths': ['/usr'], 'kind': 'directory', 'reason': 'parent only'})
        self.selected(); self.assertFalse((self.out / 'usr/bin/unselected').exists())

    def test_loader_cache_precedes_default_directories(self):
        self.write('/usr/private/libfirst.so', elf())
        self.write('/etc/ld.so.cache', loader_cache([('libfirst.so', '/usr/private/libfirst.so')]))
        self.capture_ownership()
        report = self.selected()
        paths = [r['path'] for r in report['files']]
        self.assertIn('/usr/private/libfirst.so', paths)
        self.assertNotIn('/usr/lib/libfirst.so', paths)
        self.assertIn('/etc/ld.so.cache', paths)

    def test_missing_library_in_merged_usr_search_directory_falls_through(self):
        self.root.joinpath('usr/lib/x86_64-linux-gnu').mkdir()
        self.capture_ownership()
        self.rules['library_dirs'] = ['/lib/x86_64-linux-gnu', '/usr/lib']
        self.selected()

    def test_invalid_or_ambiguous_loader_cache(self):
        for data, expected in [(b'broken cache', 'loader cache'),
                               (loader_cache([('libfirst.so', '/usr/lib/libfirst.so'), ('libfirst.so', '/usr/lib/libsecond.so')]), 'ambiguous cache')]:
            with self.subTest(expected=expected):
                self.write('/etc/ld.so.cache', data); self.capture_ownership(); self.refuse(expected)

    def test_symlink_parent_dotdot_uses_target_directory(self):
        self.root.joinpath('var/deep').mkdir()
        self.link('/etc/dirlink', '/var/deep')
        self.write('/var/correct', b'correct target')
        p = self.root / 'etc/relative'; p.unlink(); p.symlink_to('dirlink/../correct')
        self.capture_ownership(); self.selected()
        self.assertEqual((self.out / 'var/correct').read_bytes(), b'correct target')
        self.assertTrue((self.out / 'var/deep').is_dir(), 'intermediate link target must survive even before ..')

    def test_elf_interpreter_cycle(self):
        self.write('/usr/lib/loader.so', elf(interp='/usr/bin/app'), 0o755)
        self.refuse('interpreter cycle')

    def test_owned_executable_patterns_are_not_recursive(self):
        self.write('/usr/bin/nested/not-a-root', elf(), 0o755)
        self.capture_ownership()
        self.rules['consumers']['mica-system']['roots'].append({'packages': ['mica-system'], 'paths': ['/usr/bin/*'], 'kind': 'executable', 'reason': 'operator tools'})
        self.selected()
        self.assertFalse((self.out / 'usr/bin/nested/not-a-root').exists())

    def test_owned_executable_lost_mode(self):
        self.rules['consumers']['mica-system']['roots'] = [{'packages': ['mica-system'], 'paths': ['/usr/bin/helper'], 'kind': 'executable', 'reason': 'helper'}]
        (self.root / 'usr/bin/helper').chmod(0o644)
        self.refuse('not executable')

    def test_owned_payload_missing_is_not_a_smaller_selection(self):
        self.rules['consumers']['mica-system']['roots'] = [{'packages': ['mica-system'], 'paths': ['/usr/bin/*'], 'kind': 'executable', 'reason': 'tools'}]
        (self.root / 'usr/bin/helper').unlink()
        self.refuse('/usr/bin/helper')

    def test_missing_contributing_package_copyright(self):
        self.selected(); shutil.rmtree(self.out); self.report.unlink()
        (self.root / 'usr/share/doc/libfixture/copyright').unlink()
        self.refuse('/usr/share/doc/libfixture/copyright')

    def test_missing_env_command(self):
        self.write('/usr/bin/env', elf(), 0o755)
        self.write('/usr/bin/entry', b'#!/usr/bin/env missingcommand\n', 0o755)
        self.capture_ownership(); self.refuse('missing env command')

    def test_relative_loader_path_rejected(self):
        self.write('/usr/bin/app', elf(needed=['libfirst.so'], runpath='relative'), 0o755)
        self.refuse('invalid absolute path')

    def test_child_runpath_overrides_inherited_rpath(self):
        self.write('/usr/bin/app', elf(needed=['libprivate.so'], rpath='/usr/private'), 0o755)
        self.write('/usr/private/libprivate.so', elf(needed=['libchild.so'], runpath='/usr/child'))
        self.write('/usr/private/libchild.so', elf())
        self.write('/usr/child/libchild.so', elf())
        self.capture_ownership(); self.selected()
        self.assertTrue((self.out / 'usr/child/libchild.so').exists())
        self.assertFalse((self.out / 'usr/private/libchild.so').exists())

    def test_undeclared_loader_preload_rejected(self):
        self.write('/etc/ld.so.preload', b'/usr/lib/libfirst.so\n')
        self.capture_ownership(); self.refuse('loader preload')

    def test_unsupported_node(self):
        p = self.root / 'usr/bin/helper'; p.unlink(); os.mkfifo(p)
        self.refuse('unsupported node')

    def readline_resources(self, radios=()):
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        resource = next(r for r in policy['consumers']['mica-system']['roots'] if '/etc/login.defs' in r['paths'])
        self.rules['consumers'] = {'mica-system': {'roots': [resource], 'runtime_links': []}}
        owners = {'tzdata': '/usr/share/zoneinfo/Etc/UTC',
                  'ncurses-base': '/usr/share/terminfo/x/xterm', 'login.defs': '/etc/login.defs',
                  'libaudit-common': '/etc/libaudit.conf'}
        if radios:
            owners['readline-common'] = '/usr/share/readline/inputrc'
            self.write('/etc/inputrc', b'readline configuration\n')
        for package, path in owners.items():
            self.write(path, b'readline configuration\n' if package == 'readline-common' else b'required resource\n')
            self.write('/usr/share/doc/' + package + '/copyright', b'fixture license\n')
        self.capture_ownership()
        system = self.db / 'mica-system.list'
        transferred = {'/etc/inputrc', *owners.values(),
                       *('/usr/share/doc/' + package + '/copyright' for package in owners)}
        system.write_text(''.join(path + '\n' for path in system.read_text().splitlines() if path not in transferred))
        with self.manifest.open('a') as stream:
            for package, path in owners.items():
                stream.write(package + '\t1\tall\n')
                (self.db / (package + '.list')).write_text(path + '\n/usr/share/doc/' + package + '/copyright\n')
            for radio in radios:
                stream.write(radio + '\t1\tall\n')
                (self.db / (radio + '.list')).write_text('/.\n')
                rules = [r for r in policy['consumers'][radio]['roots'] if
                         '/usr/share/readline/inputrc' in r['paths'] or '/etc/inputrc' in r['paths']]
                self.assertEqual(len(rules), 2)
                self.rules['consumers'][radio] = {'roots': rules, 'runtime_links': []}
        self.packages.write_text('\n'.join(['mica-system', *radios]) + '\n')

    def test_readline_is_not_required_without_radios(self):
        self.readline_resources()
        self.selected()
        self.assertTrue((self.out / 'etc/login.defs').is_file())
        self.assertFalse((self.out / 'etc/inputrc').exists())

    def selected_readline(self, radios):
        self.readline_resources(radios)
        rows = {r['path']: r for r in self.selected()['files']}
        self.assertEqual((self.out / 'etc/inputrc').read_bytes(), (self.out / 'usr/share/readline/inputrc').read_bytes())
        self.assertEqual([rows['/etc/inputrc'][k] for k in ('mode', 'uid', 'gid')], [0o644, 0, 0])
        self.assertTrue(rows['/etc/inputrc']['origins'])
        self.assertEqual(self.command('verify').returncode, 0)

    def test_readline_wifi_resource(self):
        self.selected_readline(['mica-wifi'])

    def test_readline_bluetooth_resource(self):
        self.selected_readline(['mica-bluetooth'])

    def test_readline_shared_radio_resource(self):
        self.selected_readline(['mica-wifi', 'mica-bluetooth'])

    def test_readline_missing_owner_refuses(self):
        self.readline_resources(['mica-wifi'])
        self.manifest.write_text(self.manifest.read_text().replace('readline-common\t1\tall\n', ''))
        (self.db / 'readline-common.list').unlink()
        self.refuse('root package not installed: readline-common')

    def test_readline_missing_template_refuses(self):
        self.readline_resources(['mica-wifi'])
        (self.root / 'usr/share/readline/inputrc').unlink()
        self.refuse('missing path: /usr/share/readline/inputrc')

    def test_readline_missing_generated_resource_refuses(self):
        self.readline_resources(['mica-bluetooth'])
        (self.root / 'etc/inputrc').unlink()
        self.refuse('missing path: /etc/inputrc')

    def test_readline_unrelated_owner_remains_required(self):
        self.readline_resources()
        self.manifest.write_text(self.manifest.read_text().replace('tzdata\t1\tall\n', ''))
        (self.db / 'tzdata.list').unlink()
        self.refuse('root package not installed: tzdata')

    def test_readline_unrelated_resource_remains_required(self):
        self.readline_resources()
        (self.root / 'usr/share/zoneinfo/Etc/UTC').unlink()
        self.refuse('missing path: /usr/share/zoneinfo/Etc/UTC')

    def test_disabled_nftables_unit_survives_runtime_selection(self):
        path = '/usr/lib/systemd/system/nftables.service'
        self.write(path, b'[Service]\nExecStart=/usr/bin/app\n')
        self.write('/usr/share/doc/nftables/copyright', b'nftables license\n')
        with self.manifest.open('a') as stream:
            stream.write('nftables\t1\tall\n')
        (self.db / 'nftables.list').write_text(path + '\n/usr/lib/systemd/system\n/usr/share/doc/nftables\n/usr/share/doc/nftables/copyright\n')
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        self.rules['consumers']['mica-system']['roots'].extend(
            r for r in policy['consumers']['mica-system']['roots'] if path in r['paths'])
        rows = {r['path']: r for r in self.selected()['files']}
        self.assertIn(path, rows)
        self.assertEqual((self.out / path[1:]).read_bytes(), (self.root / path[1:]).read_bytes())
        self.assertFalse((self.out / 'etc/systemd/system/sysinit.target.wants/nftables.service').exists())

    def test_empty_mqtt_enrollment_directory_survives_runtime_selection(self):
        path = '/usr/lib/mica/mqtt-applications.d'
        (self.root / path[1:]).mkdir(parents=True)
        self.write('/usr/share/doc/mica-mqttd/copyright', b'mqtt license\n')
        with self.manifest.open('a') as stream:
            stream.write('mica-mqttd\t1\tall\n')
        (self.db / 'mica-mqttd.list').write_text(path + '\n/usr/lib/mica\n/usr/share/doc/mica-mqttd\n/usr/share/doc/mica-mqttd/copyright\n')
        with self.packages.open('a') as stream:
            stream.write('mica-mqttd\n')
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        self.rules['consumers']['mica-mqttd'] = {
            'roots': [r for r in policy['consumers']['mica-mqttd']['roots'] if path in r['paths']] + [
                {'paths': ['/usr/share/doc/mica-mqttd/copyright'], 'kind': 'resource', 'reason': 'fixture package license'}],
            'runtime_links': []}
        rows = {r['path']: r for r in self.selected()['files']}
        self.assertIn(path, rows)
        self.assertTrue((self.out / path[1:]).is_dir())
        self.assertEqual(list((self.out / path[1:]).iterdir()), [])

    def test_bluez_uses_the_current_libexec_entrypoint(self):
        path = '/usr/libexec/bluetooth/bluetoothd'
        self.write(path, elf(), 0o755)
        self.write('/usr/bin/bluetoothctl', elf(), 0o755)
        self.write('/usr/share/doc/bluez/copyright', b'bluez license\n')
        with self.manifest.open('a') as stream:
            stream.write('bluez\t5.82-1.1\tamd64\nmica-bluetooth\t1\tall\n')
        (self.db / 'bluez.list').write_text(path + '\n/usr/libexec\n/usr/libexec/bluetooth\n/usr/bin/bluetoothctl\n/usr/share/doc/bluez\n/usr/share/doc/bluez/copyright\n')
        (self.db / 'mica-bluetooth.list').write_text('/.\n')
        with self.packages.open('a') as stream:
            stream.write('mica-bluetooth\n')
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        self.rules['consumers']['mica-bluetooth'] = {
            'roots': [r for r in policy['consumers']['mica-bluetooth']['roots'] if r['kind'] == 'executable'],
            'runtime_links': []}
        rows = {r['path']: r for r in self.selected()['files']}
        self.assertIn(path, rows)
        self.assertEqual((self.out / path[1:]).read_bytes(), (self.root / path[1:]).read_bytes())
        self.assertFalse((self.out / 'usr/lib/bluetooth').exists())

    def test_s905_bluetooth_keeps_bridge_dynamic_library_and_board_data(self):
        bridge = '/usr/sbin/skw_vhci_bridge'
        library = '/usr/lib/bluetooth/plugins/libskwbt.so'
        data = ['/etc/bluetooth/skwbt.conf', '/etc/bluetooth/sv6160.nvbin',
                '/etc/bluetooth/sv6160lite.nvbin', '/etc/bluetooth/sv6316.nvbin']
        self.write(bridge, elf(), 0o755)
        self.write(library, elf(needed=['libfirst.so']))
        for path in data:
            self.write(path, b'board bluetooth input\n')
        license = '/usr/share/doc/mica-s905x5m-bluetooth/copyright'
        self.write(license, b'board license\n')
        with self.manifest.open('a') as stream:
            stream.write('mica-s905x5m-bluetooth\t1\tall\n')
        owned = [bridge, library, *data, license, '/usr/sbin', '/usr/lib/bluetooth',
                 '/usr/lib/bluetooth/plugins', '/etc/bluetooth', '/usr/share/doc/mica-s905x5m-bluetooth']
        (self.db / 'mica-s905x5m-bluetooth.list').write_text('\n'.join(owned) + '\n')
        with self.packages.open('a') as stream:
            stream.write('mica-s905x5m-bluetooth\n')
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        self.rules['consumers']['mica-s905x5m-bluetooth'] = {
            'roots': [r for r in policy['consumers']['mica-s905x5m-bluetooth']['roots']
                      if any(p in r['paths'] for p in [bridge, library, *data])] + [
                {'paths': [license], 'kind': 'resource', 'reason': 'fixture board license'}],
            'runtime_links': []}
        rows = {r['path']: r for r in self.selected()['files']}
        for path in [bridge, library, *data]:
            self.assertIn(path, rows)
            self.assertEqual((self.out / path[1:]).read_bytes(), (self.root / path[1:]).read_bytes())
        self.assertEqual(self.command('verify').returncode, 0)

    def retained_named_resources(self):
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        roots = [r for r in policy['consumers']['mica-system']['roots'] if r['kind'] == 'resource' and r.get('packages') in
                 [['tzdata'], ['debianutils', 'bash', 'dash'], ['e2fsprogs']]]
        self.rules['consumers']['mica-system']['roots'].extend(roots)
        owners = {'tzdata': ['/usr/share/zoneinfo/iso3166.tab', '/usr/share/zoneinfo/Europe/London'],
                  'debianutils': ['/usr/share/debianutils/shells'], 'bash': ['/usr/share/debianutils/shells.d/bash'],
                  'dash': ['/usr/share/debianutils/shells.d/dash'], 'e2fsprogs': ['/etc/e2scrub.conf']}
        for owner, paths in owners.items():
            self.write('/usr/share/doc/' + owner + '/copyright', b'fixture license\n')
            for path in paths:
                self.write(path, b'configured retained tool resource\n')
        self.capture_ownership()
        system = self.db / 'mica-system.list'
        transferred = {p for paths in owners.values() for p in paths}
        system.write_text(''.join(p + '\n' for p in system.read_text().splitlines() if p not in transferred))
        with self.manifest.open('a') as stream:
            for owner, paths in owners.items():
                stream.write(owner + '\t1\tall\n')
                (self.db / (owner + '.list')).write_text('\n'.join(paths) + '\n')
        return transferred

    def test_retained_named_resources_without_python(self):
        required = self.retained_named_resources()
        rows = {r['path'] for r in self.selected()['files']}
        self.assertTrue(required <= rows)
        self.assertFalse(any('python' in p for p in rows))
        self.assertEqual(self.command('verify').returncode, 0)

    def test_retained_named_resources_missing_input_refuses(self):
        required = self.retained_named_resources()
        for path in sorted(required):
            with self.subTest(path=path):
                at = self.root / path[1:]; held = self.base / 'held-named-resource'
                at.rename(held); self.refuse(path); held.rename(at)

    def test_current_policy_declares_all_selected_consumers(self):
        repo = SELECTOR.parents[2]
        policy = json.loads(SELECTOR.with_name('consumers.json').read_text())
        # The packages a root installs: every pin but the separate components
        # (the lifecycle runkit, the unsigned loader).
        apart = ('mica-lifecycle', 'mica-systemd-boot')
        rows = subprocess.run(['bash', str(repo / 'tools/pool.sh'), 'rows'], capture_output=True, text=True, check=True).stdout
        consumers = {line.split('\t')[0] for line in rows.splitlines() if not line.startswith(apart)}
        # And the packages this tree's own producers declare (tools/deb/producers.sh): the board and radio
        # packages are rows of the pool only once make board-pool has built them, and the policy names them
        # whether or not this checkout has.
        producers = subprocess.run(['bash', str(repo / 'tools/deb/producers.sh')], capture_output=True, text=True, check=True).stdout
        consumers |= {p for line in producers.splitlines() for p in line.split()[3].split(',')}
        # The policy and the pins know the same consumers, where a family entry
        # `<prefix>-*` of the policy covers the pinned members it names.
        def family(k, name):
            return k.endswith('-*') and name.startswith(k[:-1]) and len(name) > len(k) - 1
        def covered(name, names):
            return name in names or any(family(k, name) or family(name, k) for k in names)
        self.assertEqual({n for n in policy['consumers'] if not covered(n, consumers)}, set())
        self.assertEqual({n for n in consumers if not covered(n, set(policy['consumers']))}, set())
        for name, consumer in policy['consumers'].items():
            self.assertTrue(consumer['roots'], name)
        system = policy['consumers']['mica-system']
        explicit = {p for r in system['roots'] for p in r['paths']}
        for p in ['/usr/bin/bash', '/usr/sbin/dropbear', '/usr/lib/mica/mica-dropbear-prestart', '/usr/bin/systemctl',
                  '/etc/systemd/system/mica-load-extensions.service', '/etc/tmpfiles.d/mica-var.conf']:
            self.assertIn(p, explicit)
        podman = policy['consumers']['mica-podman']
        self.assertIn('/usr/libexec/podman/quadlet', {p for r in podman['roots'] for p in r['paths']})

    def test_current_extension_and_accounting_resources(self):
        repo = SELECTOR.parents[2]
        anchors = [
            '/etc/systemd/system/mica-load-extensions.service',
            '/etc/systemd/system/usr-local-lib-systemd-system.mount',
            '/etc/systemd/system/etc-containers-systemd.mount',
            '/etc/tmpfiles.d/mica-var.conf',
        ]
        for path in anchors:
            self.write(path, shipped(path))
        self.write('/usr/libexec/podman/quadlet', elf(), 0o755)
        anchors.append('/usr/libexec/podman/quadlet')
        self.rules['consumers']['mica-system']['roots'].append({'paths': anchors, 'kind': 'resource', 'reason': 'current residual policy resources'})
        self.capture_ownership(); self.selected()
        for path in anchors:
            self.assertEqual((self.root / path[1:]).read_bytes(), (self.out / path[1:]).read_bytes())
        shutil.rmtree(self.out); self.report.unlink()
        for path in anchors:
            with self.subTest(path=path):
                at = self.root / path[1:]; saved = self.base / 'saved'; at.rename(saved)
                self.refuse(path); saved.rename(at)
        mask = self.root / 'etc/systemd/system-generators/systemd-ssh-generator'
        mask.unlink(); mask.symlink_to('/usr/bin/sh')
        self.refuse('runtime link target changed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
