#!/usr/bin/env python3
"""Exercise the actual pinned UART and reserved-memory functions on the host."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


def function(path, name):
    text = path.read_text()
    match = re.search(r"^static int " + name + r"\(", text, re.M)
    if not match:
        raise ValueError(f"missing function: {name}")
    end = text.index("\n}\n", match.start()) + 3
    return text[match.start():end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="vendor bl33/v2023 tree")
    parser.add_argument("--dtb", type=Path, help="also test an exact packed DTB")
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()
    tests = Path(__file__).resolve().parent
    source = args.source.resolve()
    cc = shlex.split(os.environ.get("HOSTCC", "cc"))
    flags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] if args.sanitize else []
    failures = []
    with tempfile.TemporaryDirectory(prefix="mica-handoff-test-") as tmp:
        work = Path(tmp)
        rsvmem = source / "cmd/amlogic/cmd_rsvmem.c"
        for output, path, name in (
            ("vendor-serial-function.c", source / "drivers/serial/serial_meson.c", "meson_serial_pending"),
            ("vendor-rsvmem-function.c", rsvmem, "fdt_config_rsv_mem"),
            ("vendor-rsvmem-command.c", rsvmem, "do_rsvmem"),
        ):
            (work / output).write_text(function(path, name))
        libfdt = source / "scripts/dtc/libfdt"
        for case in ("serial-pending", "reserved-memory", "rsvmem-command"):
            binary = work / case
            extra = [f"-I{libfdt}", *map(str, sorted(libfdt.glob("*.c")))] if case == "reserved-memory" else []
            try:
                subprocess.run([*cc, "-std=gnu11", "-O1", "-Wall", "-Wextra", "-Werror",
                                *flags, f"-I{work}", str(tests / f"{case}.c"), *extra,
                                "-o", str(binary)], check=True)
                subprocess.run([str(binary)], check=True)
                if case == "reserved-memory" and args.dtb:
                    subprocess.run([str(binary), str(args.dtb.resolve())], check=True)
            except subprocess.CalledProcessError:
                failures.append(case)
    if failures:
        raise SystemExit("HANDOFF_REGRESSION_FAIL: " + ", ".join(failures))
    print("HANDOFF_REGRESSION_PASS", flush=True)


if __name__ == "__main__":
    main()
