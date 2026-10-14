#!/usr/bin/env python3
"""Compile the production storage selector and persistence functions on the host."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import argparse

loader = Path(__file__).resolve().parents[1]
common = loader / "../../../common/uboot"
parser = argparse.ArgumentParser()
parser.add_argument("source", nargs="?", default=str(loader / "mica-file-boot.c"))
parser.add_argument("--common", default=str(common))
args = parser.parse_args()
common = Path(args.common)
source = Path(args.source).read_text()
source = source[:source.index("static void __noreturn recovery")]
source = re.sub(r"^#include <.*>\n", "", source, flags=re.M)
with tempfile.TemporaryDirectory(prefix="mica-dual-media-") as directory:
    work = Path(directory)
    work.joinpath("production.c").write_text(source)
    executable = work / "test"
    subprocess.run([*shlex.split(os.environ.get("HOSTCC", "cc")), "-std=gnu11", "-O1", "-g",
                    "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
                    "-fno-omit-frame-pointer", f"-I{work}", f"-I{common}",
                    str(Path(__file__).with_suffix(".c")), "-lz", "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
