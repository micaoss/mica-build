#!/usr/bin/env python3
"""Record QMP events while running the existing complete-image boot harness.

Event semantics: https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html
"""
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

output, *command = sys.argv[1:]
assert command, 'boot command required'
endpoint = '/w/boot-events.sock'
Path(endpoint).unlink(missing_ok=True)
process = subprocess.Popen(command, start_new_session=True)
try:
    with socket.socket(socket.AF_UNIX) as connection:
        deadline = time.monotonic() + 60
        while True:
            try:
                connection.connect(endpoint)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                assert process.poll() is None and time.monotonic() < deadline, 'QMP connection failed'
                time.sleep(0.05)
        connection.settimeout(0.5)
        connection.sendall(b'{"execute":"qmp_capabilities"}\r\n')
        pending = b''
        with open(output, 'x') as log:
            while True:
                try:
                    data = connection.recv(65536)
                except socket.timeout:
                    if process.poll() is not None:
                        break
                    continue
                if not data:
                    break
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    record = json.loads(line)
                    assert 'error' not in record, record
                    if 'event' in record:
                        log.write(json.dumps(record) + '\n')
                        log.flush()
    sys.exit(process.wait(timeout=10))
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
