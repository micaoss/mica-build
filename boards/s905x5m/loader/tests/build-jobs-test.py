#!/usr/bin/env python3
"""Exercise the vendor build dispatch without starting compilers."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_text()
start = source.index("function build_uboot() {")
end = source.index("\n\tset +e", start)
prefix = source[start:end] + "\n}\n"
with tempfile.TemporaryDirectory(prefix="mica-build-jobs-") as temporary:
    work = Path(temporary)
    script = work / "dispatch.sh"
    script.write_text(prefix + '\nbuild_uboot 0 0 0 0 0 0 0\n')
    make = work / "make"
    make.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$RECORD"\nexit "${RESULT:-0}"\n')
    make.chmod(0o755)
    env = dict(os.environ, PATH=f"{work}:{os.environ['PATH']}", RECORD=str(work / "args"),
               FIP_BUILD_FOLDER=str(work / "fip"), UBOOT_SRC_FOLDER=str(work))
    for compress in ("0", "1"):
        env["CONFIG_MDUMP_COMPRESS"] = compress
        subprocess.run(["bash", str(script)], env=env, check=True, capture_output=True)
        args = (work / "args").read_text().splitlines()
        assert args[0] == "-j2", f"unbounded or unexpected build jobs: {args}"
    env["RESULT"] = "17"
    failed = subprocess.run(["bash", str(script)], env=env, capture_output=True)
    assert failed.returncode == 17, "compiler failure must stop the vendor build"
print("BUILD_JOBS_PASS: both dispatch branches bound jobs and preserve errors")
