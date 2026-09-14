#!/usr/bin/env python3
"""Measure current update IO from guest counters and the supplied offline objects."""
import json
import re
import sys
from pathlib import Path

work = Path(sys.argv[1]).resolve()
rows = []
pattern = re.compile(r'FILE_AB_STORAGE: (before|sample|after) (system|esp) usedBytes=(\d+) capacityBytes=(\d+) writtenSectors=(\d+)')
for generation, kind in [(3, 'root'), (4, 'kernel'), (6, 'combined')]:
    directory = work / 'updates' / str(generation)
    log = (directory / 'install.log').read_text(errors='replace')
    assert 'FILE_AB_INSTALL_PASS' in log, f'{kind}: installation did not pass'
    matches = pattern.findall(log)
    assert len(matches) >= 6, f'{kind}: before/after and live samples are required'
    values = {}
    samples = {'system': [], 'esp': []}
    for phase, partition, used, capacity, sectors in matches:
        if phase == 'sample':
            samples[partition].append(tuple(map(int, (used, capacity, sectors))))
            continue
        assert (phase, partition) not in values, 'duplicate storage record'
        values[phase, partition] = tuple(map(int, (used, capacity, sectors)))
    partitions = {}
    for partition in ['system', 'esp']:
        before, after = values['before', partition], values['after', partition]
        assert samples[partition], f'{kind}/{partition}: no live samples'
        observations = [before, *samples[partition], after]
        assert all(v[1] == before[1] and 0 <= v[0] <= v[1] for v in observations)
        assert all(b[2] >= a[2] for a, b in zip(observations, observations[1:]))
        partitions[partition] = {
            'beforeUsedBytes': before[0], 'afterUsedBytes': after[0],
            'observedPeakUsedBytes': max(v[0] for v in observations),
            'liveSamples': len(samples[partition]),
            'capacityBytes': before[1], 'guestBlockWriteBytes': (after[2] - before[2]) * 512,
        }
    objects = list((directory / 'offline/objects').iterdir())
    assert objects and all(p.is_file() and re.fullmatch('[a-f0-9]{64}', p.name) for p in objects)
    rows.append({'generation': generation, 'kind': kind,
                 'suppliedOfflineObjectBytes': sum(p.stat().st_size for p in objects),
                 'suppliedOfflineEnvelopeBytes': (directory / 'offline/deployment.json').stat().st_size,
                 'partitions': partitions})
print(json.dumps({
    'scope': 'guest SYSTEM/ESP block counters around acquisition and installation; includes sync and installer GC; excludes host/device physical amplification',
    'spaceScope': 'maximum observed before/during/after acquisition and installation, with 100 ms sleep between paired SYSTEM/ESP samples; excludes peaks shorter than a sampling interval',
    'transferScope': 'offline input object bytes; these are not HTTP download measurements',
    'evidence': str(work), 'updates': rows,
    'observedPeakUsedBytes': {p: max(r['partitions'][p]['observedPeakUsedBytes'] for r in rows) for p in ['system', 'esp']},
}, indent=2))
