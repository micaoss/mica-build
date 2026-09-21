#!/usr/bin/env python3
"""Assert accelerator contracts in a compiled CX3576 DTB using fdtget.

Usage: python3 resource-dt-test.py <dtb>
The overlap inventory is an unresolved finding, not an ownership or bench pass.
"""
import subprocess
import sys


def get(node: str, prop: str, kind: str = "s") -> list[str]:
    return subprocess.check_output(["fdtget", "-t", kind, sys.argv[1], node, prop],
                                   text=True, timeout=5).split()


def properties(node: str) -> list[str]:
    return subprocess.check_output(["fdtget", "-p", sys.argv[1], node],
                                   text=True, timeout=5).split()


def cells(node: str, prop: str) -> list[int]:
    return [int(value, 16) for value in get(node, prop, "x")]


for node in ("/rkvenc-core@27a00000", "/rkvenc-core@27a10000"):
    assert get(node, "status") == ["okay"], node
    assert get(node, "compatible") == ["rockchip,rkv-encoder-rk3576-core"], node
    assert "operating-points-v2" not in properties(node), node
    assert get(node, "clock-names") == ["aclk_vcodec", "hclk_vcodec", "clk_core"], node
    assert len(cells(node, "clocks")) == 6, node
    assert cells(node, "rockchip,normal-rates") == [400000000, 0, 702000000], node
    assert cells(node, "assigned-clock-rates") == [400000000, 702000000], node
    assert get(node, "reset-names") == ["video_a", "video_h", "video_core"], node
    assert len(cells(node, "resets")) == 6, node
print("PASS: both encoders retain fixed rates, clocks and recovery resets")

node = "/rkvdec@27b00000"
assert get(node, "status") == ["okay"]
assert "rockchip,rkv-decoder-rk3576" in get(node, "compatible")
assert not {"operating-points-v2", "vdec-supply"}.intersection(properties(node))
assert get(node, "clock-names") == ["aclk_vcodec", "hclk_vcodec", "clk_core",
                                     "clk_cabac", "clk_hevc_cabac"]
assert len(cells(node, "clocks")) == 10
assert cells(node, "rockchip,normal-rates") == [600000000, 0, 600000000, 500000000, 1000000000]
assert get(node, "reset-names") == ["video_a", "video_h", "video_core", "video_hevc_cabac"]
assert len(cells(node, "resets")) == 8
print("PASS: decoder retains five clocks and four declared resets without DVFS supply")

npu = "/npu@27700000"
mmu = "/iommu@27702000"
assert get(npu, "status") == get(mmu, "status") == ["okay"]
assert cells(npu, "iommus") == cells(mmu, "phandle")
assert {"operating-points-v2", "rknpu-supply"}.issubset(properties(npu))
assert cells(npu, "reg") == [0, 0x27700000, 0, 0x8000, 0, 0x27708000, 0, 0x8000]
assert cells(mmu, "reg") == [0, 0x27702000, 0, 0x100, 0, 0x27702100, 0, 0x100,
                              0, 0x2770a000, 0, 0x100, 0, 0x2770a100, 0, 0x100]
print("OPEN: NPU windows contain four IOMMU ranges; exclusive ownership is unproven")
print("PASS: DT contract assertions only; no accelerator workload or physical acceptance")
