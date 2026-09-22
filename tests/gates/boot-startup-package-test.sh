#!/bin/bash
# The boot-tools launcher and recipe branches, on the host: docker is an
# argument recorder and nothing is built.
set -euo pipefail
REPO=${1:?repository root}
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT
# The launcher is real; Docker is an argument recorder, never a build here.
# Execute recipe branch bodies with acquisition/compiler commands isolated.
python3 - "$REPO" "$WORK" <<'TARGET_ROUTE'
import json
import os
from pathlib import Path
import re
import subprocess
import sys

repo, work = map(Path, sys.argv[1:])
route = work / 'route'; route.mkdir()
bin_dir = route / 'bin'; bin_dir.mkdir()
docker = bin_dir / 'docker'
docker.write_text('#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ["ROUTE_ARGV"],"a").write(json.dumps(sys.argv[1:])+"\\n")\n')
docker.chmod(0o755)
record = route / 'docker.jsonl'
(route / 'loader.deb').write_bytes(b'!<arch>\n')
env = dict(os.environ, PATH=str(bin_dir) + ':' + os.environ['PATH'], ROUTE_ARGV=str(record),
           MICA_BOOT_LOADER_DEB=str(route / 'loader.deb'))
env.pop('MICA_BOOT_TARGET', None)
cases = [(['--target', ''], {}, False), (['--target', 'invalid'], {}, False),
         (['--target', 'x64', '--target', 'aa64'], {}, False),
         ([], {'MICA_BOOT_TARGET': ''}, False), ([], {'MICA_BOOT_TARGET': 'amd64'}, False),
         (['--target', 'aa64'], {'MICA_BOOT_TARGET': 'x64'}, False),
         ([], {}, 'x64'), (['--target', 'x64'], {}, 'x64'),
         ([], {'MICA_BOOT_TARGET': 'aa64'}, 'aa64'),
         (['--target', 'aa64'], {'MICA_BOOT_TARGET': 'aa64'}, 'aa64')]
for args, extra, target in cases:
    record.write_text('')
    result = subprocess.run(['bash', str(repo / 'boot' / 'build-tools.sh'), *args],
                            env=dict(env, **extra), capture_output=True, text=True, timeout=15)
    calls = [json.loads(line) for line in record.read_text().splitlines()]
    if not target:
        assert result.returncode != 0 and not calls, (args, extra, result.stdout, result.stderr, calls)
    else:
        assert result.returncode == 0 and len(calls) == 1, result.stderr
        argv = calls[0]
        assert argv[0] == 'build' and argv[-1] == str(repo / 'stages' / 'boot')
        assert any(v.startswith('loader=') and v.endswith('/_out/boot-tools/loader-' + {'x64': 'amd64', 'aa64': 'arm64'}[target]) for v in argv)
        assert argv.count('MICA_BOOT_TARGET=' + target) == 1 and argv.count('--platform') == 1
        assert argv[argv.index('--platform') + 1] == 'linux/amd64'
        assert argv[argv.index('-t') + 1] == 'ai-agent/mica-boot-tools-' + {'x64': 'amd64', 'aa64': 'arm64'}[target]
        assert any(v.startswith('MICA_IMAGE_DEBIAN_TRIXIE=') and '@sha256:' in v for v in argv)
        assert any(v.startswith('MICA_DEBIAN_SNAPSHOT=http://snapshot.debian.org/archive/debian/') for v in argv)
    print('PASS: target launcher', args, extra, target or 'refused')

recipe = (repo / 'stages' / 'boot' / 'Dockerfile').read_text().replace('\\\n', '')
instructions = [line.strip() for line in recipe.splitlines() if line and not line.startswith('#')]
runs = [line[4:] for line in instructions if line.startswith('RUN ')]
assert instructions.count('ARG MICA_BOOT_TARGET=x64') == 1
guard = re.match(r'(case "\$MICA_BOOT_TARGET" in .*?esac;)', runs[0])
assert guard, 'target must be checked before first acquisition'
for target in ('', 'both', 'x64 aa64'):
    result = subprocess.run(['sh', '-c', guard[1]], env=dict(env, MICA_BOOT_TARGET=target), capture_output=True, timeout=10)
    assert result.returncode != 0, target
assert [line for line in instructions if line.startswith('FROM ')] == [
    'FROM ${MICA_IMAGE_DEBIAN_TRIXIE} AS tools', 'FROM tools AS artifact-tools']
for required in (
    'COPY initramfs.sh kernel.sh compression.sh elf-closure.sh /tools/',
    'LABEL mica.boot.target=${MICA_BOOT_TARGET}',
):
    assert required in instructions, required
# The loader is the Base pool's unsigned systemd-boot, never compiled here.
assert not any(word in recipe for word in ('meson', 'ninja', 'versions.env', 'systemd-boot-persistence', 'arm64-cross'))
loader = [line for line in runs if '--mount=type=bind,from=loader,target=/loader' in line]
assert len(loader) == 1 and '/loader-pkg/usr/lib/mica/systemd-boot/systemd-boot${MICA_BOOT_TARGET}.efi' in loader[0] and '/usr/lib/systemd/boot/efi/' in loader[0], loader

# These are shell branch fixtures, not target executable or image acceptance.
prefix = '''log() { printf '%s\\n' "$*" >> "$ROUTE_COMMANDS"; }
dpkg() { log dpkg "$@"; }
rm() { log rm "$@"; }; find() { log find "$@"; }
'''
for name in ('apt-get', 'dpkg-deb'):
    stub = bin_dir / name
    stub.write_text('#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$ROUTE_COMMANDS"\n')
    stub.chmod(0o755)
for target in ('x64', 'aa64'):
    root = route / target; root.mkdir()
    for directory in ('etc/apt/sources.list.d', 'etc/apt/preferences.d'):
        (root / directory).mkdir(parents=True, exist_ok=True)
    commands = root / 'commands.txt'
    for code in runs[:2]:
        code = re.sub(r'(?<![A-Za-z0-9_/])/(?:etc/|var/|arm-debs|arm64)', lambda match: str(root) + match[0], code)
        result = subprocess.run(['sh', '-eu', '-c', prefix + code], cwd=root,
                                env=dict(env, MICA_BOOT_TARGET=target, MICA_DEBIAN_SNAPSHOT='fixture', ROUTE_COMMANDS=str(commands)),
                                capture_output=True, text=True, timeout=15)
        assert result.returncode == 0, (target, code, result.stderr)
    lines = commands.read_text().splitlines()
    if target == 'x64':
        assert not any(any(word in line for word in ('--add-architecture', ':arm64', 'aarch64')) for line in lines), lines
    else:
        assert any('dpkg --add-architecture arm64' in line for line in lines)
        assert any('systemd-boot-efi:arm64' in line for line in lines)
        assert any('apt-get install' in line and 'binutils-aarch64-linux-gnu' in line for line in lines)
    print('PASS: recipe branch', target, '(commands isolated)')
print('BOOT_TOOLS_TARGET_ROUTE_TEST_PASS cases=15 productionBuilds=0 targetExecutions=0')
TARGET_ROUTE
