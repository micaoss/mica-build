#!/usr/bin/env python3
"""Compile the real vendor init/remove functions against controlled OPP services.

Usage: python3 rkvenc-devfreq-test.py <kernel-source>
Run against c6157104418d012823413c02f9222f3fe123dd25 before and after patches.
The missing-table stub models rockchip_init_opp_info's of_parse_phandle failure;
it does not stand in for the fixed-rate selection under test.
"""
from pathlib import Path
import subprocess
import sys
import tempfile


def function(source: str, name: str) -> str:
    start = source.index(f"static int {name}(")
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


source = (Path(sys.argv[1]) / "drivers/video/rockchip/mpp/mpp_rkvenc2.c").read_text()
fixture = Path(__file__).with_name("rkvenc-devfreq-fixture.c").read_text()
functions = "\n".join(function(source, name) for name in
                      ("rkvenc_devfreq_init", "rkvenc_devfreq_remove"))
with tempfile.TemporaryDirectory(prefix="mica-rkvenc-test-") as temporary:
    path = Path(temporary)
    (path / "test.c").write_text(fixture.replace("/* VENDOR_FUNCTIONS */", functions))
    subprocess.run(["gcc", "-std=gnu11", "-Wall", "-Wextra", "-Werror",
                    "-Wno-unused-parameter", str(path / "test.c"),
                    "-o", str(path / "test")], check=True, timeout=20)
    subprocess.run([str(path / "test")], check=True, timeout=10)
