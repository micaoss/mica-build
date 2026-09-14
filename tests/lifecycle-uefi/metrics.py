#!/usr/bin/env python3
"""Extract measured early-init process cost and Linux startup time from a boot log."""
import json
import re
import sys
from pathlib import Path

log = Path(sys.argv[1]).read_text(errors='replace')
metrics = re.findall(r'mica-init: metrics elapsedMs=(\d+) peakRssKiB=(\d+)', log)
assert len(metrics) == 1, 'expected exactly one measured early-init record'
elapsed, rss = map(int, metrics[0])
assert elapsed > 0 and rss > 0
wall = re.findall(r'FILE_AB_BOOT_WALL_MS: (\d+)', log)
startup = re.findall(r'\[\s*([0-9.]+)\].*Startup finished in', log)
record = {'earlyInitElapsedMs': elapsed, 'earlyInitPeakRssKiB': rss,
          'runtimeAcceptanceWallMs': int(wall[-1]) if wall else None,
          'linuxStartupSeconds': float(startup[-1]) if startup else None,
          'scope': 'early-init process RSS; excludes kernel and initramfs backing memory'}
print(json.dumps(record, indent=2))
