#!/usr/bin/env python3
"""Select installed runtime payloads offline; never execute a target program.

Inputs reuse selected package names, manifest.tsv and captured dpkg info/*.list.
Consumer declarations describe runtime reasons, not a second package inventory.
"""
import argparse
from collections import deque
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import sys


class Refusal(ValueError):
    """An incomplete or ambiguous runtime must not be published."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refusal(message)


def normalized(path: str) -> str:
    require(isinstance(path, str) and path.startswith('/') and not any(c in path for c in '\0\n\r\t'),
            f'invalid absolute path: {path!r}')
    parts = []
    for part in path.split('/'):
        if part == '..':
            require(bool(parts), f'path escape: {path}')
            parts.pop()
        elif part not in ('', '.'):
            parts.append(part)
    return '/' + '/'.join(parts)


def host_path(path: str) -> Path:
    """Do not let an input/output ancestor symlink redirect a host operation."""
    result = Path(os.path.abspath(path))
    require(result != Path('/'), 'host root is not a runtime input/output')
    for parent in [*reversed(result.parents), result]:
        require(not parent.is_symlink(), f'host path contains symlink: {parent}')
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def metadata(path: Path) -> dict:
    st = path.lstat()
    kind = 'file' if stat.S_ISREG(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode) else 'symlink' if stat.S_ISLNK(st.st_mode) else None
    require(kind is not None, f'unsupported node: {path}')
    result = dict(type=kind, mode=stat.S_IMODE(st.st_mode), uid=st.st_uid, gid=st.st_gid,
                  mtime_ns=st.st_mtime_ns,
                  xattrs={name: os.getxattr(path, name, follow_symlinks=False).hex()
                          for name in sorted(os.listxattr(path, follow_symlinks=False))})
    if kind == 'file':
        result.update(sha256=sha256(path), size=st.st_size)
    if kind == 'symlink':
        result['target'] = os.readlink(path)
    return result


def tree_paths(root: Path) -> list[str]:
    def fail(error: OSError) -> None:
        raise error

    result = ['/']
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        result.extend('/' + str((Path(directory) / name).relative_to(root)) for name in dirs + files)
    return sorted(result)


def elf_info(data: bytes, machine: int, path: str) -> dict:
    require(len(data) >= 64 and data[:7] == b'\x7fELF\x02\x01\x01' and struct.unpack_from('<H', data, 18)[0] == machine,
            f'ELF architecture: {path}')
    header = struct.unpack_from('<16sHHIQQQIHHHHHH', data)
    require(header[1] in (2, 3) and header[3] == 1 and header[8] == 64 and header[9] == 56 and 0 < header[10] < 65535,
            f'unsupported ELF header: {path}')
    offset, count = header[5], header[10]
    require(offset + count * 56 <= len(data), f'truncated ELF headers: {path}')
    segments = [struct.unpack_from('<IIQQQQQQ', data, offset + i * 56) for i in range(count)]
    for s in segments:
        require(s[2] + s[5] <= len(data), f'truncated ELF segment: {path}')
    dynamic = [s for s in segments if s[0] == 2]
    interps = [s for s in segments if s[0] == 3]
    require(len(dynamic) <= 1 and len(interps) <= 1, f'ambiguous ELF segments: {path}')
    result = dict(needed=[], interp=None, rpath=None, runpath=None, soname=None)
    if interps:
        s = interps[0]; raw = data[s[2]:s[2] + s[5]]
        require(raw.endswith(b'\0') and b'\0' not in raw[:-1], f'invalid ELF interpreter: {path}')
        result['interp'] = raw[:-1].decode('utf-8')
    if not dynamic:
        return result
    s = dynamic[0]
    require(s[5] % 16 == 0, f'invalid ELF dynamic size: {path}')
    entries = []
    for at in range(s[2], s[2] + s[5], 16):
        tag, value = struct.unpack_from('<QQ', data, at)
        if tag == 0:
            break
        entries.append((tag, value))
    else:
        raise Refusal(f'unterminated ELF dynamic table: {path}')
    # These change loader behavior beyond the declared closure; never ignore them.
    require(not any(t in (0x6ffffefb, 0x6ffffefc, 0x7fffffff, 0x7ffffffd) or
                    (t == 0x6ffffffb and v & 0x800) for t, v in entries),
            f'unsupported ELF loader policy: {path}')
    for tag in (5, 10, 14, 15, 29):
        require(sum(t == tag for t, _ in entries) <= 1, f'ambiguous ELF dynamic tag: {path}')
    values = dict(entries)
    if not any(t in (1, 14, 15, 29) for t, _ in entries):
        return result
    require(5 in values and 10 in values, f'missing ELF string table: {path}')
    loads = [s for s in segments if s[0] == 1 and s[3] <= values[5] and values[5] + values[10] <= s[3] + s[5]]
    require(len(loads) == 1, f'ambiguous ELF string mapping: {path}')
    start = loads[0][2] + values[5] - loads[0][3]
    strings = data[start:start + values[10]]
    for tag, value in entries:
        if tag not in (1, 14, 15, 29):
            continue
        end = strings.find(b'\0', value)
        require(0 <= value < len(strings) and end >= 0, f'invalid ELF string: {path}')
        text = strings[value:end].decode('utf-8')
        if tag == 1:
            require(bool(text), f'empty ELF dependency: {path}')
            result['needed'].append(text)
        elif tag == 14:
            require(bool(re.fullmatch(r'[^/\x00-\x20\x7f$]+', text)) and text not in ('.', '..'),
                    f'invalid ELF SONAME: {path}')
            result['soname'] = text
        else:
            result['rpath' if tag == 15 else 'runpath'] = text
    return result


def read_loader_cache(data: bytes, arch: str) -> dict:
    require(len(data) >= 48 and data[:20] == b'glibc-ld.so.cache1.1' and data[28] == 2,
            'unsupported loader cache format or endianness')
    count, size = struct.unpack_from('<II', data, 20)
    start, end = 48 + 24 * count, 48 + 24 * count + size
    require(end <= len(data), 'truncated loader cache')
    cache = {}
    for i in range(count):
        flags, key, value, _, hwcap = struct.unpack_from('<iIIIQ', data, 48 + 24 * i)
        require(flags == {'amd64': 0x303, 'arm64': 0xa03}[arch] and hwcap == 0,
                'unsupported loader cache architecture/hwcaps')
        strings = []
        for offset in (key, value):
            stop = data.find(b'\0', offset, end)
            require(start <= offset < end and stop >= 0, 'invalid loader cache string')
            strings.append(data[offset:stop].decode('utf-8'))
        name, path = strings
        require(name and '/' not in name and path == normalized(path), 'invalid loader cache path')
        cache.setdefault(name, []).append(path)
    return cache


class Selector:
    def __init__(self, args: argparse.Namespace):
        self.root = host_path(args.root)
        self.output = host_path(args.output)
        self.report = host_path(args.report)
        require(self.root.is_dir(), 'installed root is missing')
        require(not (self.root == self.output or self.root in self.output.parents or self.output in self.root.parents), 'input/output overlap')
        require(not self.output.exists() or (self.output.is_dir() and not any(self.output.iterdir())), 'output must be empty')
        require(not self.report.exists(), 'report already exists')
        require(self.root not in self.report.parents and self.output not in self.report.parents, 'report must be outside runtime roots')
        self.machine, self.triplet = {'amd64': (62, 'x86_64-linux-gnu'), 'arm64': (183, 'aarch64-linux-gnu')}[args.arch]
        self.arch = args.arch
        self.packages = {}
        for line in Path(args.inventory).read_text().splitlines():
            if line.startswith('#'):
                continue
            row = line.split('\t')
            require(len(row) == 3 and all(row) and re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', row[0]), 'invalid manifest.tsv row')
            name, version, arch = row
            require(name not in self.packages, f'duplicate package: {name}')
            require(arch in (args.arch, 'all'), f'package architecture: {name}')
            self.packages[name] = dict(package=name, version=version, architecture=arch)
        require(bool(self.packages), 'empty package inventory')
        self.owners = {}
        self.ownership_packages = set()
        lists = sorted(Path(args.ownership).glob('*.list'))
        require(bool(lists), 'no captured dpkg ownership lists')
        for file in lists:
            name, _, arch = file.stem.partition(':')
            require(name in self.packages and (not arch or arch == self.packages[name]['architecture']), f'unknown ownership package: {file.name}')
            require(name not in self.ownership_packages, f'duplicate ownership list: {name}')
            self.ownership_packages.add(name)
            for line in file.read_text().splitlines():
                require(line == normalized(line) or line == '/.', f'ambiguous ownership path: {line}')
                canonical, _ = self.resolve(normalized(line), follow_leaf=False, missing=True)
                self.owners.setdefault(canonical, set()).add(name)
        self.declarations = json.loads(Path(args.rules).read_text())
        self.inputs = {'inventory_sha256': sha256(Path(args.inventory)),
                       'selection_sha256': sha256(Path(args.packages)),
                       'rules_sha256': sha256(Path(args.rules)),
                       'ownership_sha256': {p.name: sha256(p) for p in lists}}
        require(set(self.declarations) == {'consumers', 'library_dirs', 'path'}, 'invalid declaration fields')
        self.library_dirs = [normalized(p.replace('{triplet}', self.triplet)) for p in self.declarations['library_dirs']]
        self.path = [normalized(p) for p in self.declarations['path']]
        require(self.library_dirs and self.path, 'empty loader/PATH contract')
        self.consumers = []
        for line in Path(args.packages).read_text().splitlines():
            name = line.split('#', 1)[0].strip()
            if name:
                require(name not in self.consumers, f'duplicate selected consumer: {name}')
                require(self.declaration_key(name) is not None, f'no runtime declaration: {name}')
                require(name in self.packages, f'selected consumer not installed: {name}')
                require(name in self.ownership_packages, f'missing ownership list: {name}')
                self.consumers.append(name)
        require(bool(self.consumers), 'empty consumer selection')
        self.files = {}
        self.generated = {}
        self.links = {}
        self.bindings = {}
        self.paths = tree_paths(self.root)
        cache, _ = self.resolve('/etc/ld.so.cache', missing=True)
        self.cache = read_loader_cache(self.at(cache).read_bytes(), args.arch) if self.at(cache).exists() else {}
        preload, _ = self.resolve('/etc/ld.so.preload', missing=True)
        if self.at(preload).exists():
            require(not any(line.split('#', 1)[0].strip() for line in self.at(preload).read_text().splitlines()),
                    'unsupported loader preload: declare and review its load policy first')

    def at(self, path: str) -> Path:
        return self.root / path.lstrip('/')

    def resolve(self, path: str, follow_leaf: bool = True, missing: bool = False) -> tuple[str, list[str]]:
        normalized(path)
        pending = [part for part in path.split('/') if part not in ('', '.')]
        current = []
        links = []
        while pending:
            part = pending.pop(0)
            if part == '..':
                require(bool(current), f'path escape: {path}')
                current.pop()
                continue
            candidate = '/' + '/'.join([*current, part])
            at = self.at(candidate)
            try:
                mode = at.lstat().st_mode
            except FileNotFoundError:
                if missing:
                    return normalized('/' + '/'.join([*current, part, *pending])), links
                raise Refusal(f'missing path: {candidate}') from None
            if stat.S_ISLNK(mode) and (follow_leaf or pending):
                require(candidate not in links and len(links) < 40, f'symlink cycle: {candidate}')
                links.append(candidate)
                target = os.readlink(at)
                require(target and not any(c in target for c in '\0\n\r\t'), f'invalid link: {candidate}')
                pending = [part for part in target.split('/') if part not in ('', '.')] + pending
                if target.startswith('/'):
                    current = []
            else:
                require(not pending or stat.S_ISDIR(mode), f'non-directory ancestor: {candidate}')
                current.append(part)
        return '/' + '/'.join(current), links

    def excluded(self, path: str) -> bool:
        return (path.startswith(('/boot/', '/usr/lib/debug/', '/usr/lib/modules/', '/usr/lib/firmware/')) or
                # Exact removals already performed by hwdb-remove.sh and
                # package-manager-purge.sh, respectively. Other missing owned
                # paths still fail; this is not a missing-path filter.
                path in ('/usr/bin/systemd-hwdb', '/usr/sbin/pam_getenv',
                         '/usr/lib/udev/hwdb.bin', '/etc/udev/hwdb.bin', '/usr/lib/systemd/system/systemd-hwdb-update.service',
                         '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service',
                         '/etc/systemd/system/sysinit.target.wants/systemd-hwdb-update.service') or
                path.startswith(('/usr/lib/udev/hwdb.d/', '/etc/udev/hwdb.d/')))

    def retain(self, path: str, reason: str) -> None:
        if path in self.files:
            self.files[path]['reasons'].add(reason)
            return
        require(not self.excluded(path), f'excluded runtime payload: {path}')
        info = metadata(self.at(path))
        owners = self.owners.get(path, set())
        require(info['type'] == 'directory' or len(owners) <= 1, f'ambiguous ownership: {path}')
        origins = [self.packages[p] for p in sorted(owners)]
        if path in self.generated:
            origins.append({'generated': self.generated[path]})
        require(bool(origins), f'no origin: {path}')
        self.files[path] = dict(path=path, **info, origins=origins, reasons={reason})
        if path != '/':
            self.retain(str(Path(path).parent), f'parent of {path}')

    def add(self, path: str, reason: str, executable: bool = False, inherited: tuple = (), scripts: tuple = (),
            context: dict | None = None, requested: str | None = None) -> None:
        path = normalized(path)
        physical, parents = self.resolve(path, follow_leaf=False)
        for parent in parents:
            self.add(parent, f'path link for {path}', inherited=inherited, scripts=scripts, context=context)
        self.retain(physical, reason)
        if physical in self.links:
            contract = self.links[physical]
            require(self.files[physical]['type'] == 'symlink', f'runtime link must be a symlink: {physical}')
            require(not executable and os.readlink(self.at(physical)) == contract['target'], f'runtime link target changed: {physical}')
            self.files[physical]['runtime_link'] = contract
            for required in contract['requires']:
                self.add(required, f'runtime link producer for {physical}')
            return
        if self.files[physical]['type'] == 'symlink':
            try:
                resolved, links = self.resolve(path)
            except Refusal as error:
                raise Refusal(f'broken link {path}: {error}') from None
            for link in links:
                if link == physical:
                    self.retain(link, f'symlink for {path}')
                else:
                    self.add(link, f'symlink for {path}', inherited=inherited, scripts=scripts, context=context)
            self.add(resolved, f'link target of {path}', executable, inherited, scripts, context, requested)
            return
        if executable:
            require(self.files[physical]['type'] == 'file' and self.files[physical]['mode'] & 0o111, f'not executable: {physical}')
            require(physical not in scripts, f'interpreter cycle: {physical}')
        if self.files[physical]['type'] != 'file':
            return
        data = self.at(physical).read_bytes()
        if data.startswith(b'\x7fELF'):
            info = elf_info(data, self.machine, physical)
            entry = context is None
            if entry:
                context = {'loaded': {}, 'seen': set(), 'queue': deque()}
            # Retention is global; loader discovery and first context are per entry.
            for name in (requested, info['soname']):
                if name is not None:
                    if '/' not in name:
                        require(name not in self.bindings or self.bindings[name] == physical,
                                f'ambiguous library {name}: {physical}')
                        self.bindings[name] = physical
                    require(name not in context['loaded'] or context['loaded'][name] == physical,
                            f'ambiguous library {name}: {physical}')
                    context['loaded'][name] = physical
            if physical not in context['seen']:
                context['seen'].add(physical)
                context['queue'].append((physical, info, inherited, scripts))
            if entry:
                self.elf_dependencies(context)
        elif data.startswith(b'#!'):
            line = data.split(b'\n', 1)[0]
            require(len(line) < 256, f'oversized shebang: {physical}')
            words = line[2:].decode('utf-8').strip().split(None, 1)
            require(bool(words) and words[0].startswith('/'), f'invalid shebang: {physical}')
            interp = words[0]
            try:
                self.add(interp, f'script interpreter of {physical}', True, scripts=(*scripts, physical))
                if interp == '/usr/bin/env':
                    require(len(words) == 2 and re.fullmatch(r'[A-Za-z0-9_.+-]+', words[1]), f'unsupported env shebang: {physical}')
                    found = None
                    for directory in self.path:
                        candidate, _ = self.resolve(directory + '/' + words[1], missing=True)
                        if self.at(candidate).exists():
                            found = directory + '/' + words[1]
                            break
                    require(found is not None, f'missing env command: {words[1]}')
                    self.add(found, f'env command of {physical}', True, scripts=(*scripts, physical))
            except Refusal as error:
                raise Refusal(f'script interpreter of {physical}: {error}') from None
        elif executable:
            raise Refusal(f'unsupported executable format: {physical}')

    def elf_dependencies(self, context: dict) -> None:
        while context['queue']:
            physical, info, inherited, scripts = context['queue'].popleft()
            if info['interp']:
                try:
                    self.add(info['interp'], f'ELF interpreter of {physical}', True,
                             scripts=(*scripts, physical), context=context)
                except Refusal as error:
                    raise Refusal(f'ELF interpreter of {physical}: {error}') from None
            rpath = tuple(self.search_dirs(info['rpath'], physical)) if info['runpath'] is None else ()
            runpath = self.search_dirs(info['runpath'], physical)
            ancestors = tuple(dict.fromkeys(rpath + inherited))
            search = (list(ancestors) if info['runpath'] is None else []) + runpath
            for needed in info['needed']:
                name = self.expand(needed, physical)
                if '/' in name:
                    candidates = [normalized(name)]
                else:
                    cached = self.cache.get(name, [])
                    identities = {self.resolve(p, missing=True)[0] for p in cached}
                    require(len(identities) <= 1, f'ambiguous cache library: {name}')
                    candidates = [normalized(p + '/' + name) for p in search] + cached + [normalized(p + '/' + name) for p in self.library_dirs]
                found = context['loaded'].get(name)
                for candidate in candidates if found is None else ():
                    target, links = self.resolve(candidate, missing=True)
                    for link in links:
                        link_target, _ = self.resolve(link, missing=True)
                        require(self.at(link_target).exists(), f'broken link for shared library {needed}: {candidate}')
                    if self.at(target).exists():
                        found = candidate
                        break
                require(found is not None, f'unresolved shared library {needed} for {physical}')
                canonical, _ = self.resolve(found)
                require(self.at(canonical).is_file(), f'shared library is not a file: {found}')
                require(self.at(canonical).read_bytes().startswith(b'\x7fELF'), f'shared library is not ELF: {found}')
                self.add(found, f'DT_NEEDED {needed} of {physical}', inherited=ancestors,
                         context=context, requested=name)

    def expand(self, value: str, source: str) -> str:
        value = value.replace('${ORIGIN}', str(Path(source).parent)).replace('$ORIGIN', str(Path(source).parent))
        require('$' not in value, f'unsupported loader token: {source}')
        return value

    def search_dirs(self, value: str | None, source: str) -> list[str]:
        if value is None:
            return []
        return [normalized(self.expand(part, source)) for part in value.split(':')]

    def declaration_key(self, consumer: str):
        """The declaration a consumer is under: its own name, or a family's.

        A declaration keyed `<prefix>-*` covers every package `<prefix><name>`
        (the board packages, one per board, are one declaration), so a new
        member is composed with no edit here; in the family's rules the key
        itself stands for the member."""
        if consumer in self.declarations['consumers']:
            return consumer
        families = [k for k in self.declarations['consumers']
                    if k.endswith('-*') and consumer.startswith(k[:-1]) and len(consumer) > len(k) - 1]
        require(len(families) <= 1, f'consumer in several declaration families: {consumer}')
        return families[0] if families else None

    def select(self) -> dict:
        roots = []
        for consumer in self.consumers:
            key = self.declaration_key(consumer)
            declaration = self.declarations['consumers'][key]
            require(set(declaration) == {'roots', 'runtime_links'} and declaration['roots'], f'invalid consumer declaration: {consumer}')
            for link in declaration['runtime_links']:
                require(set(link) == {'path', 'target', 'generator', 'ordering', 'test', 'requires'} and
                        all(isinstance(link[k], str) and link[k] for k in ('path', 'target', 'generator', 'ordering', 'test')) and
                        isinstance(link['requires'], list), f'invalid runtime link: {consumer}')
                path = normalized(link['path'])
                normalized(link['target'] if link['target'].startswith('/') else str(Path(path).parent) + '/' + link['target'])
                physical, _ = self.resolve(path, follow_leaf=False)
                require(physical not in self.links, f'duplicate runtime link: {physical}')
                require(link['requires'] or link['target'] == '/dev/null', f'runtime link has no producer resources: {path}')
                self.links[physical] = link
                roots.append((path, consumer, {'kind': 'resource', 'reason': 'runtime link contract'}))
            for rule in declaration['roots']:
                require(set(rule) <= {'paths', 'packages', 'kind', 'reason', 'generated', 'expect'} and
                        {'paths', 'kind', 'reason'} <= set(rule) and rule['paths'] and rule['reason'] and
                        rule['kind'] in ('executable', 'resource', 'directory'), f'invalid root rule: {consumer}')
                patterns = [p.replace('{triplet}', self.triplet) for p in rule['paths']]
                for p in patterns:
                    require(p == normalized(p) and '**' not in p, f'ambiguous root pattern: {p}')
                if rule.get('packages'):
                    require(rule.get('packages') and not rule.get('generated'), f'owned rule needs packages: {consumer}')
                    rule = dict(rule, packages=[consumer if p == key else p for p in rule['packages']])
                    for package in rule['packages']:
                        require(package in self.packages, f'root package not installed: {package}')
                        require(package in self.ownership_packages, f'missing ownership list: {package}')
                    # Match each path component: '*' never becomes recursive copying.
                    matches = [p for p in sorted(self.owners) if self.owners[p] & set(rule['packages']) and
                               any(len(p.split('/')) == len(pattern.split('/')) and
                                   all(fnmatch.fnmatchcase(a, b) for a, b in zip(p.split('/'), pattern.split('/')))
                                   for pattern in patterns) and not self.excluded(p)]
                    if rule['kind'] == 'executable':
                        matches = [p for p in matches if not stat.S_ISDIR(self.at(p).lstat().st_mode)]
                    require(bool(matches), f'empty owned runtime roots: {consumer}: {patterns}')
                else:
                    require(not any(c in p for p in patterns for c in '*?['), f'glob requires owned rule: {consumer}')
                    matches = patterns
                for path in matches:
                    physical, _ = self.resolve(path, follow_leaf=False)
                    if rule.get('generated'):
                        require(physical not in self.generated or self.generated[physical] == rule['generated'], f'ambiguous generated origin: {physical}')
                        self.generated[physical] = rule['generated']
                    roots.append((path, consumer, rule))
        for path, consumer, rule in roots:
            self.add(path, f"{consumer}: {rule['reason']}", rule['kind'] == 'executable')
            physical, _ = self.resolve(path, follow_leaf=False)
            if rule['kind'] == 'directory':
                require(self.files[physical]['type'] == 'directory', f'not a directory: {physical}')
            expected = rule.get('expect', {})
            require(set(expected) <= {'mode', 'uid', 'gid', 'xattrs', 'target', 'sha256'}, f'invalid expected metadata: {path}')
            for key, value in expected.items():
                actual = self.files[physical][key]
                if key == 'xattrs':
                    require(all(actual.get(k) == v for k, v in value.items()), f'required xattrs changed ({", ".join(value)}): {path}')
                else:
                    require(actual == value, f'required {key} changed: {path}')
        if self.cache:
            self.add('/etc/ld.so.cache', 'target loader cache used for dependency resolution')
        # Copyright links can themselves introduce another package contributor.
        licensed = set()
        while True:
            contributors = {origin['package'] for row in self.files.values() if row['type'] != 'directory'
                            for origin in row['origins'] if 'package' in origin}
            pending = contributors - licensed
            if not pending:
                break
            for package in sorted(pending):
                self.add(f'/usr/share/doc/{package}/copyright', f'license for retained package {package}')
                licensed.add(package)
        groups = {}
        for path, info in sorted(self.files.items()):
            info['reasons'] = sorted(info['reasons'])
            if info['type'] == 'file':
                st = self.at(path).stat()
                group = groups.setdefault((st.st_dev, st.st_ino), path)
                info['hardlink'] = group
        external = [dict(path=p, **metadata(self.at(p))) for p in self.paths
                    if p.startswith(('/boot/', '/usr/lib/debug/', '/usr/lib/modules/', '/usr/lib/firmware/'))]
        return dict(architecture=self.arch, consumers=self.consumers, inputs=self.inputs,
                    files=[self.files[p] for p in sorted(self.files)], external_inputs=external)

    def copy(self, report: dict, publish: bool = True) -> None:
        self.output.mkdir(exist_ok=True)
        copied_groups = {}
        for row in sorted(report['files'], key=lambda r: (r['path'].count('/'), r['path'])):
            source = self.at(row['path'])
            target = self.output / row['path'].lstrip('/')
            require(metadata(source) == {k: v for k, v in row.items() if k not in ('path', 'origins', 'reasons', 'hardlink', 'runtime_link')}, f'source changed during selection: {row["path"]}')
            if row['type'] == 'directory':
                target.mkdir(exist_ok=True)
            elif row['type'] == 'symlink':
                target.symlink_to(row['target'])
            else:
                group = row['hardlink']
                if group in copied_groups:
                    os.link(copied_groups[group], target)
                else:
                    shutil.copyfile(source, target, follow_symlinks=False)
                    copied_groups[group] = target
        # chown clears capabilities/set-ID bits. Restore mode then xattrs last.
        # Directories are last so child creation cannot change recorded mtimes.
        for row in sorted(report['files'], key=lambda r: (-r['path'].count('/'), r['path']), reverse=False):
            target = self.output / row['path'].lstrip('/')
            os.chown(target, row['uid'], row['gid'], follow_symlinks=False)
            if row['type'] != 'symlink':
                target.chmod(row['mode'])
            for name in os.listxattr(target, follow_symlinks=False):
                if name not in row['xattrs']:
                    os.removexattr(target, name, follow_symlinks=False)
            for name, value in row['xattrs'].items():
                os.setxattr(target, name, bytes.fromhex(value), follow_symlinks=False)
            os.utime(target, ns=(row['mtime_ns'], row['mtime_ns']), follow_symlinks=False)
        verify(self.output, report)
        if publish:
            with self.report.open('x') as stream:
                json.dump(report, stream, indent=2, sort_keys=True)
                stream.write('\n')


def verify(root: Path, report: dict) -> None:
    rows = {row['path']: row for row in report['files']}
    require(len(rows) == len(report['files']) and set(tree_paths(root)) == set(rows), 'runtime paths changed')
    groups = {}
    reverse_groups = {}
    for path, row in rows.items():
        require(path == normalized(path), f'ambiguous report path: {path}')
        for parent in Path(path).parents:
            require(rows[str(parent)]['type'] == 'directory', f'ancestor changed: {path}')
            require(not (root / str(parent).lstrip('/')).is_symlink(), f'ancestor changed: {path}')
        target = root / path.lstrip('/')
        expected = {k: v for k, v in row.items() if k not in ('path', 'origins', 'reasons', 'hardlink', 'runtime_link')}
        require(metadata(target) == expected, f'metadata or bytes changed: {path}')
        if row['type'] == 'file':
            st = target.stat(); inode = (st.st_dev, st.st_ino)
            group = row['hardlink']
            require(groups.setdefault(group, inode) == inode and reverse_groups.setdefault(inode, group) == group,
                    f'hardlink changed: {path}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    select = commands.add_parser('select')
    for name in ('root', 'output', 'packages', 'inventory', 'ownership', 'report'):
        select.add_argument('--' + name, required=True)
    select.add_argument('--rules', default=str(Path(__file__).with_name('consumers.json')))
    select.add_argument('--arch', choices=('amd64', 'arm64'), required=True)
    check = commands.add_parser('verify')
    check.add_argument('--root', required=True)
    check.add_argument('--report', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'verify':
            verify(host_path(args.root), json.loads(Path(args.report).read_text()))
        else:
            selector = Selector(args)
            selector.copy(selector.select())
        print('runtime selection: verified')
    except (OSError, ValueError, KeyError, TypeError, struct.error) as error:
        print(f'runtime selection refused: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
