#!/usr/bin/env python3
"""Exercise the pinned ADNL wait loop with simulated USB events and time."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="vendor tree (bl33/v2023)")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()
    config = args.config.read_text().splitlines()
    for option in ("AML_NO_USB_MODULE", "ADNL_FORCE_BL1_IF_SCS"):
        if f"CONFIG_{option}=y" in config:
            raise SystemExit(f"USB_RECOVERY_WAIT_FAIL: automatic erasure path {option}")
    entries = [line for line in config if line.startswith("CONFIG_USB_TOOL_ENTRY=")]
    if len(entries) != 1:
        raise SystemExit("USB_RECOVERY_WAIT_FAIL: require one explicit USB entry")
    match = re.fullmatch(r'CONFIG_USB_TOOL_ENTRY="adnl ([0-9]+)"', entries[0])
    if not match:
        raise SystemExit("USB_RECOVERY_WAIT_FAIL: unexpected USB entry")
    timeout = int(match[1])
    source = args.source / "drivers/usb/gadget/v3_burning/v3_usb_tool/cmd_aml_dnl.c"
    text = source.read_text()
    start = text.index("#define SOF_WAIT_TIME_MIN")
    end = text.index("#ifndef CONFIG_AML_NO_USB_MODULE", start)
    cc = shlex.split(os.environ.get("HOSTCC", "cc"))
    flags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] if args.sanitize else []
    with tempfile.TemporaryDirectory(prefix="mica-usb-wait-test-") as temporary:
        work = Path(temporary)
        (work / "vendor-adnl.c").write_text(text[start:end])
        binary = work / "usb-recovery-test"
        subprocess.run([*cc, "-std=gnu11", "-O1", "-Wall", "-Wextra", "-Werror", *flags,
                        f"-I{work}", str(Path(__file__).with_suffix(".c")),
                        "-o", str(binary)], check=True)
        subprocess.run([str(binary), str(timeout)], check=True)
    if timeout != 0:
        raise SystemExit("USB_RECOVERY_WAIT_FAIL: explicit recovery must not time out")
    print("USB_RECOVERY_WAIT_PASS", flush=True)


if __name__ == "__main__":
    main()
