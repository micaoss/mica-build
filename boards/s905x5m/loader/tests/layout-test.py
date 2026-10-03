#!/usr/bin/env python3
"""Compare the loader's compiled tables with both board layouts before building."""
from pathlib import Path
import re
import uuid

loader = Path(__file__).resolve().parents[1]
source = (loader / 'mica-file-boot.c').read_text()
for name, file in [('sd', 'layout.tsv'), ('emmc', 'layout-emmc.tsv')]:
    rows = [line.split('\t') for line in (loader.parent / file).read_text().splitlines()]
    parts = sorted((r for r in rows if r[0] == 'part'), key=lambda r: int(r[1]))
    regions = {r[5]: r for r in rows if r[0] == 'region'}
    table = re.search(rf'static const struct mica_media {name}_media = {{(.*?)\n}};', source, re.S)
    assert table, f'{name}: loader medium table missing'
    values = table[1]
    for field, column in [('starts', 4), ('sizes', 5)]:
        actual = [int(v) for v in re.search(rf'\.{field} = {{([^}}]+)}}', values)[1].split(',')]
        assert actual == [int(r[column]) for r in parts[:3]], f'{name}: {field}'
    actual = re.findall(r'"([0-9a-f-]{36})"', values)
    assert actual == [r[7].lower() for r in parts[:3]], f'{name}: UUIDs'
    blocks = [int(v) for v in re.search(r'\.env_blocks = {([^}]+)}', values)[1].split(',')]
    assert blocks == [int(parts[0][4]) + int(regions[k][3]) // 512 for k in ['records-a', 'records-b']], f'{name}: record sectors'
    assert all(int(regions[k][4]) == 65536 for k in ['records-a', 'records-b'])
    disk = uuid.UUID(next(r[1] for r in rows if r[0] == 'disk'))
    compiled = re.search(rf'{name}_disk_guid\[\] = {{(.*?)}};', source, re.S)[1]
    assert bytes(int(v, 16) for v in re.findall(r'0x[0-9a-f]+', compiled)) == disk.bytes_le, f'{name}: disk GUID'
    if name == 'emmc':
        for field, column in [('starts', 4), ('sizes', 5)]:
            actual = [int(v.strip()) for v in re.search(rf'vendor_{field}\[\] = {{([^}}]+)}}', source)[1].split(',')]
            assert actual == [int(r[column]) for r in parts[3:]], f'vendor {field}'
        compiled = re.search(r'vendor_uuids\[\] = {(.*?)};', source, re.S)[1]
        assert re.findall(r'"([0-9a-f-]{36})"', compiled) == [r[7].lower() for r in parts[3:]], 'vendor UUIDs'
print('LOADER_LAYOUT_PASS')
