#!/usr/bin/env python3
"""Measure host wall time from QEMU harness start to full runtime acceptance."""
import subprocess
import sys
import time

start = time.monotonic_ns()
reached = None
with subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as process:
    for line in process.stdout:
        print(line, end='', flush=True)
        if line.strip() == 'FILE_AB_RUNTIME_PASS' and reached is None:
            reached = (time.monotonic_ns() - start) // 1_000_000
    result = process.wait()
if reached is not None:
    print(f'FILE_AB_BOOT_WALL_MS: {reached}')
sys.exit(result)
