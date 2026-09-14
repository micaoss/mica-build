#!/usr/bin/env python3
"""Copy a target ELF closure without executing target-architecture programs."""
import pathlib
import re
import shutil
import struct
import subprocess
import sys

runtime, destination, architecture, source, target = sys.argv[1:]
runtime = pathlib.Path(runtime)
destination = pathlib.Path(destination)
machine, triplet = {"x64": (62, "x86_64-linux-gnu"), "aa64": (183, "aarch64-linux-gnu")}[architecture]
pending = [(pathlib.Path(source), target)]
copied = set()


def find_library(name):
    for directory in [f"usr/lib/{triplet}", f"lib/{triplet}", f"usr/lib/{triplet}/systemd", "usr/lib", "lib"]:
        candidate = runtime / directory / name
        if candidate.is_file():
            return candidate, f"/{directory}/{name}"
    raise RuntimeError(f"Missing target library: {name}")


while pending:
    source, target = pending.pop()
    if target in copied:
        continue
    header = source.read_bytes()[:20]
    if header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != machine:
        raise RuntimeError(f"Wrong ELF architecture: {source}")
    output = destination / target.lstrip("/")
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output)
    output.chmod(0o755)
    copied.add(target)
    dynamic = subprocess.check_output(["readelf", "-d", str(source)], text=True, timeout=10)
    for library in re.findall(r"\(NEEDED\).*\[([^]]+)\]", dynamic):
        pending.append(find_library(library))
    program = subprocess.check_output(["readelf", "-l", str(source)], text=True, timeout=10)
    for interpreter in re.findall(r"\[Requesting program interpreter: ([^]]+)\]", program):
        library, _ = find_library(pathlib.PurePosixPath(interpreter).name)
        pending.append((library, interpreter))
