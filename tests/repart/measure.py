#!/usr/bin/env python3
"""Measure GPT identities and all protected partition bytes around DATA growth."""
import hashlib
import json
import struct
import sys
import uuid
from pathlib import Path

with open(sys.argv[1], 'rb') as disk:
    disk.seek(512)
    header = disk.read(512)
    assert header[:8] == b'EFI PART'
    entry_lba, count, size = struct.unpack_from('<QII', header, 72)
    assert count == 128 and size == 128
    disk.seek(entry_lba * 512)
    entries = disk.read(count * size)
    records = []
    for index in range(count):
        entry = entries[index * size:(index + 1) * size]
        if entry[:16] == bytes(16):
            continue
        first, last, attributes = struct.unpack_from('<QQQ', entry, 32)
        record = {'number': index + 1, 'first': first, 'last': last,
                  'type': str(uuid.UUID(bytes_le=entry[:16])),
                  'guid': str(uuid.UUID(bytes_le=entry[16:32])),
                  'attributes': attributes, 'label': entry[56:128].decode('utf-16le').rstrip('\0')}
        if index < 2:
            digest = hashlib.sha256()
            remaining = (last - first + 1) * 512
            disk.seek(first * 512)
            while remaining:
                block = disk.read(min(4194304, remaining))
                assert block
                digest.update(block)
                remaining -= len(block)
            record['sha256'] = digest.hexdigest()
        records.append(record)
    assert [record['number'] for record in records] == [1, 2, 3]
    assert [record['label'] for record in records][1:] == ['system', 'data']
Path(sys.argv[2]).write_text(json.dumps(records, indent=2) + '\n')
if len(sys.argv) == 4:
    before = json.loads(Path(sys.argv[3]).read_text())
    assert records[:2] == before[:2], 'Firmware/ESP or SYSTEM bytes/geometry changed'
    assert records[2]['last'] > before[2]['last'] + 2048 * 1024, 'DATA did not grow by at least 1 GiB'
    for key in ['first', 'type', 'guid', 'attributes', 'label', 'number']:
        assert records[2][key] == before[2][key], f'DATA {key} changed'
    print('PASS: only DATA grows; every firmware/counter/SYSTEM byte and partition identity is unchanged')
