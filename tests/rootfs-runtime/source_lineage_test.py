#!/usr/bin/env python3
"""The composer's two-class rule, exercised through rootfs/runtime/source-lineage.py.

A fixture repository with one producer (mica-fixture), a pool with that archive
built at the fixture's stamp, and a lock that imports mica-imported from a
fixture registry component. Every refusal is by name; every acceptance writes
a record that validates again on the way back in."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / 'rootfs/runtime/source-lineage.py'
spec = importlib.util.spec_from_file_location('source_lineage', HELPER)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def run(*args, cwd=None, env=None):
    return subprocess.run(list(map(str, args)), cwd=cwd, env=env, capture_output=True, text=True)


class SourceLineageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.tree = self.work / 'tree'
        self.tree.mkdir()
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                        GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                        GIT_AUTHOR_DATE='2020-01-02T00:00:00Z', GIT_COMMITTER_DATE='2020-01-02T00:00:00Z')
        for name in ['tools/version.sh']:
            at = self.tree / name
            at.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, at)
        for name, text in {'.gitignore': '_out/\n', 'Makefile': '# fixture\n', 'VERSION': '0.1.0\n', 'deps/packages/.keep': ''}.items():
            at = self.tree / name; at.parent.mkdir(parents=True, exist_ok=True); at.write_text(text)
        self.must('git', 'init', '-q', self.tree)
        self.commit()
        self.commit_id = self.must('git', '-C', self.tree, 'rev-parse', 'HEAD').strip()
        self.version = self.must('bash', self.tree / 'tools/version.sh').strip()
        self.pool = self.tree / '_out/debs/amd64'
        (self.pool / 'pool').mkdir(parents=True)
        self.imported_commit = 'b' * 40
        self.imported_version = '2.0.0+git' + 'b' * 12 + '-1'
        self.archives = {}
        self.build('mica-fixture', self.version, 'amd64', 'mica-build', self.commit_id)
        self.build('mica-imported', self.imported_version, 'amd64', 'mica-imported', self.imported_commit)
        self.base_commit = 'c' * 40
        self.build('mica-base', '20260914-1148-1', 'all', 'mica-system-base', self.base_commit)
        self.index()
        self.lock([('mica-imported', self.imported_version, 'amd64', self.archives['mica-imported'][1], 'mica-imported', self.imported_commit)])

    def must(self, *args):
        result = run(*args, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def commit(self):
        self.must('git', '-C', self.tree, 'add', '.')
        self.must('git', '-C', self.tree, 'commit', '-qm', 'Freeze fixture')

    def build(self, name, version, arch, repo, commit, control_extra=''):
        root = self.work / ('deb-' + name)
        if root.exists():
            shutil.rmtree(root)
        (root / 'DEBIAN').mkdir(parents=True)
        (root / 'usr/bin').mkdir(parents=True)
        (root / 'usr/bin' / name).write_text(name + ' bytes\n')
        (root / 'DEBIAN/control').write_text(f'Package: {name}\nVersion: {version}\nArchitecture: {arch}\nMaintainer: Fixture <fixture@example.invalid>\n'
                                             f'Description: isolated package\nMica-Source-Repo: {repo}\nMica-Source-Commit: {commit}\n{control_extra}')
        for old in (self.pool / 'pool').glob(name + '_*.deb'):
            old.unlink()
        archive = self.pool / 'pool' / f'{name}_{version}_{arch}.deb'
        self.must('dpkg-deb', '--build', root, archive)
        self.archives[name] = (archive, hashlib.sha256(archive.read_bytes()).hexdigest(), version, arch, repo, commit)

    def index(self):
        rows = sorted(self.archives.values(), key=lambda r: r[0].name)
        (self.pool / 'SHA256SUMS').write_text(''.join(f'{r[1]}  pool/{r[0].name}\n' for r in rows))
        (self.pool / 'Packages').write_text(''.join(
            f'Package: {r[0].name.split("_")[0]}\nVersion: {r[2]}\nArchitecture: {r[3]}\nFilename: pool/{r[0].name}\nSHA256: {r[1]}\n\n' for r in rows))
        (self.pool / 'manifest.txt').write_text('#package\tversion\tarchitecture\tinstalled-size\tsha256\tfile\tsource-repo\tsource-commit\n' + ''.join(
            f'{r[0].name.split("_")[0]}\t{r[2]}\t{r[3]}\t1\t{r[1]}\tpool/{r[0].name}\t{r[4]}\t{r[5]}\n' for r in rows))

    def lock(self, rows):
        pins = self.tree / 'deps/packages'
        for old in pins.glob('*.json'):
            old.unlink()
        for name, version, arch, sha, repo, commit in rows:
            asset = f'{name}_{version}_{arch}.deb'.replace('+', '.')
            targets = {pool: dict(version=version, architecture=arch, sha256=sha, asset=asset) for pool in (['amd64', 'arm64'] if arch == 'all' else [arch])}
            (pins / (name + '.json')).write_text(json.dumps(dict(name=name, repository=repo, commit=commit, targets=targets), indent=2, sort_keys=True) + '\n')
        self.commit()
        self.commit_id = self.must('git', '-C', self.tree, 'rev-parse', 'HEAD').strip()
        self.version = self.must('bash', self.tree / 'tools/version.sh').strip()
        # The built-here archive follows the tree's stamp.
        self.build('mica-fixture', self.version, 'amd64', 'mica-build', self.commit_id)
        self.index()

    def base_rows(self):
        """The mica-system-base pool rows, as tools/system-base.sh rows prints them."""
        _, sha, version, arch, repo, commit = self.archives['mica-base']
        return f'mica-base\t{version}\t{arch}\t{sha}\t{repo}\t{commit}\tmica-base_{version}_{arch}.deb\n'

    def invoke(self, unlocked='', local='mica-fixture', tree=None, base=None):
        self.output = self.work / 'lineage.json'
        if self.output.exists():
            self.output.unlink()
        tree = tree or self.tree
        rows = self.work / 'system-base-rows.tsv'
        rows.write_text(self.base_rows() if base is None else base)
        return run('python3', HELPER, '--composition-source', tree, '--pool', self.pool, '--arch', 'amd64', '--epoch', '1577836800',
                   '--lock', tree / 'deps/packages', '--base-rows', rows, '--unlocked', unlocked, '--local-packages', local, '--output', self.output, env=self.env)

    def record(self):
        return json.loads(self.output.read_text())

    def refuses(self, message, **kwargs):
        result = self.invoke(**kwargs)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source lineage refused', result.stderr)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.output.exists())

    def test_two_classes_accept_and_the_record_validates_again(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.version)
        record = self.record()
        self.assertEqual(record['schema'], 'mica/source-lineage/v1')
        self.assertEqual(record['package_source']['commit'], self.commit_id)
        self.assertEqual(record['unlocked'], [])
        self.assertEqual([r['package'] for r in record['lock']], ['mica-base', 'mica-imported'])
        by_name = {r['package']: r for r in record['pool']['packages']}
        self.assertEqual(by_name['mica-imported']['source_commit'], self.imported_commit)
        self.assertEqual(by_name['mica-fixture']['source_repo'], 'mica-build')
        self.assertEqual(h.validate(json.loads(self.output.read_text()), 'amd64', 1577836800), record)
        again = self.invoke(); self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.output.read_bytes(), h.canonical(record))

    def test_locked_archive_with_one_byte_changed_refuses_by_name(self):
        archive = self.archives['mica-imported'][0]
        data = bytearray(archive.read_bytes()); data[-1] ^= 1; archive.write_bytes(data)
        self.archives['mica-imported'] = (archive, hashlib.sha256(bytes(data)).hexdigest(), *self.archives['mica-imported'][2:])
        self.index()
        self.refuses('locked archive differs from the lock: mica-imported')

    def test_locked_archive_at_another_version_refuses_by_name(self):
        self.build('mica-imported', '2.0.1+git' + 'c' * 12 + '-1', 'amd64', 'mica-imported', self.imported_commit)
        self.index()
        self.refuses('locked archive differs from the lock: mica-imported')

    def test_locked_archive_from_another_source_refuses_by_name(self):
        # Same version and bytes cannot happen with another commit inside, so the
        # lock row is what is changed: the pool then disagrees with it.
        self.lock([('mica-imported', self.imported_version, 'amd64', self.archives['mica-imported'][1], 'mica-imported', 'c' * 40)])
        self.refuses('locked archive source differs from the lock: mica-imported')

    def test_archive_neither_locked_nor_local_refuses_by_name(self):
        self.build('mica-stray', self.version, 'amd64', 'mica-build', self.commit_id)
        self.index()
        self.refuses('archive neither locked nor built by a producer of this tree: mica-stray')

    def test_built_here_archive_at_another_stamp_refuses_by_name(self):
        self.build('mica-fixture', '0.1.0+git' + 'd' * 12 + '-1', 'amd64', 'mica-build', 'd' * 40)
        self.index()
        self.refuses('archive built here at another stamp: mica-fixture')

    def test_locked_archive_missing_from_the_pool_refuses(self):
        self.archives['mica-imported'][0].unlink()
        del self.archives['mica-imported']
        self.index()
        self.refuses('locked archive missing from the pool: mica-imported')

    def test_unlocked_waives_the_digest_and_is_recorded(self):
        archive = self.archives['mica-imported'][0]
        self.build('mica-imported', '2.0.0+git' + 'e' * 12 + '.dirty-1', 'amd64', 'mica-imported', 'e' * 40)
        self.index()
        self.refuses('locked archive differs from the lock: mica-imported')
        result = self.invoke(unlocked='mica-imported')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.record()
        self.assertEqual(record['unlocked'], ['mica-imported'])
        self.assertEqual({r['package']: r['version'] for r in record['pool']['packages']}['mica-imported'], '2.0.0+git' + 'e' * 12 + '.dirty-1')
        self.assertEqual(h.validate(record, 'amd64', 1577836800), record)
        record['unlocked'] = []
        with self.assertRaises(ValueError):
            h.validate(record, 'amd64', 1577836800)

    def test_unlocked_naming_an_unlocked_package_refuses(self):
        self.refuses('MICA_POOL_UNLOCKED names mica-fixture, which the lock does not import', unlocked='mica-fixture')
        self.refuses('MICA_POOL_UNLOCKED names mica-other, which the lock does not import', unlocked='mica-other')

    def test_missing_provenance_fields_refuse(self):
        root = self.work / 'deb-mica-fixture'
        control = root / 'DEBIAN/control'
        control.write_text('\n'.join(l for l in control.read_text().splitlines() if not l.startswith('Mica-Source-Commit')) + '\n')
        archive = self.archives['mica-fixture'][0]
        self.must('dpkg-deb', '--build', root, archive)
        self.archives['mica-fixture'] = (archive, hashlib.sha256(archive.read_bytes()).hexdigest(), *self.archives['mica-fixture'][2:])
        self.index()
        self.refuses('malformed digest')

    def test_base_pool_rows_are_imported(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('mica-base', [r['package'] for r in self.record()['lock']])
        self.refuses('no base rows', base='')
        self.refuses('locked archive differs from the lock: mica-base', base=self.base_rows().replace(self.archives['mica-base'][1], '0' * 64))
        self.refuses('base row repository', base=self.base_rows().replace('\tmica-system-base\t', '\tmica-other\t'))

    def test_dirty_tree_and_malformed_lock_refuse(self):
        (self.tree / 'Makefile').write_text('# edited\n')
        self.refuses('dirty source checkout')
        self.must('git', '-C', self.tree, 'checkout', '--', 'Makefile')
        pin = self.tree / 'deps/packages/mica-imported.json'
        original = pin.read_text()
        good = json.loads(original)
        def mutate(change):
            value = json.loads(original)
            change(value)
            return json.dumps(value) + '\n'
        for name, bad, message in [
            ('digest', mutate(lambda v: v['targets']['amd64'].__setitem__('sha256', 'z' * 64)), 'malformed digest'),
            ('dirty', mutate(lambda v: v['targets']['amd64'].update(version='2.0.0+git' + 'b' * 12 + '.dirty-1', asset='mica-imported_2.0.0.git' + 'b' * 12 + '.dirty-1_amd64.deb')), 'dirty version cannot be pinned'),
            ('missing-key', mutate(lambda v: v['targets']['amd64'].pop('asset')), 'unknown or missing fields'),
            ('asset', mutate(lambda v: v['targets']['amd64'].__setitem__('asset', 'other.deb')), 'pin asset name'),
            ('pool', mutate(lambda v: v['targets'].__setitem__('arm64', dict(v['targets']['amd64']))), 'pin target architecture'),
        ]:
            with self.subTest(name=name):
                pin.write_text(bad)
                self.commit()
                self.refuses(message)
        # A file named for another package than it holds.
        pin.write_text(original)
        (self.tree / 'deps/packages/mica-other.json').write_text(original)
        self.commit()
        self.refuses('pin file name/package: mica-other.json')
        (self.tree / 'deps/packages/mica-other.json').unlink()
        pin.write_text(original); self.commit()

    def test_stale_index_and_membership_refuse(self):
        self.refuses('stale pool index') if False else None
        archive = self.archives['mica-fixture'][0]
        os.utime(archive, ns=(2 ** 40 * 10 ** 9, 2 ** 40 * 10 ** 9))
        self.refuses('stale pool index')
        os.utime(archive, ns=(0, 0))
        (self.pool / 'SHA256SUMS').write_text('')
        self.refuses('archive checksum membership')

    def test_validate_refuses_shape_mutations(self):
        self.assertEqual(self.invoke().returncode, 0)
        record = self.record()
        cases = {
            'schema': lambda r: r.__setitem__('schema', 'mica/source-lineage/join-v1'),
            'unknown-field': lambda r: r.__setitem__('producer_join', {}),
            'missing-lock': lambda r: r.pop('lock'),
            'unsorted-lock': lambda r: r['lock'].append(dict(r['lock'][0], package='aaa')),
            'unlocked-unknown': lambda r: r.__setitem__('unlocked', ['mica-fixture']),
            'lock-row-differs': lambda r: r['lock'][0].__setitem__('sha256', '0' * 64),
            'stamp': lambda r: r['pool']['packages'][0].__setitem__('version', '0.1.0+git' + 'f' * 12 + '-1'),
            'source-differs': lambda r: r['package_source'].__setitem__('epoch', 1),
            'arch': lambda r: r.__setitem__('architecture', 'arm64'),
            'epoch': lambda r: r.__setitem__('root_epoch', 1),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                changed = json.loads(json.dumps(record)); mutate(changed)
                with self.assertRaises((ValueError, KeyError)):
                    h.validate(changed, 'amd64', 1577836800)


if __name__ == '__main__':
    unittest.main()
