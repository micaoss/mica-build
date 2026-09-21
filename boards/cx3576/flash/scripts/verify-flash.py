#!/usr/bin/env python3
"""Validate the current factory geometry or compare one complete readback range."""
import pathlib
import struct
import sys
import zlib


def check_image(path):
    size = path.stat().st_size
    assert size == 1299 * 1048576, "wrong factory image size"
    last = size // 512 - 1
    with path.open("rb") as image:
        def header(lba, backup, table_lba):
            image.seek(lba * 512)
            h = image.read(92)
            assert h[:8] == b"EFI PART", "missing GPT header"
            assert struct.unpack_from("<II", h, 8) == (0x10000, 92), "invalid GPT version/size"
            crc = struct.unpack_from("<I", h, 16)[0]
            assert zlib.crc32(h[:16] + b"\0" * 4 + h[20:]) == crc, "GPT header checksum mismatch"
            assert struct.unpack_from("<QQQQ", h, 24) == (lba, backup, 34, last - 33), "invalid GPT bounds"
            assert struct.unpack_from("<QII", h, 72) == (table_lba, 128, 128), "invalid GPT table geometry"
            image.seek(table_lba * 512)
            table = image.read(128 * 128)
            assert zlib.crc32(table) == struct.unpack_from("<I", h, 88)[0], "GPT table checksum mismatch"
            return table

        table = header(1, last, 2)
        assert header(last, 1, last - 32) == table, "backup GPT differs"
        entries = [table[n:n + 128] for n in range(0, len(table), 128) if any(table[n:n + 16])]
        expected = [("firmware", 64, 36863), ("system", 36864, 2134015), ("data", 2134016, 2658303)]
        assert len(entries) == 3, "factory image must have three partitions"
        for entry, (name, start, end) in zip(entries, expected):
            assert struct.unpack_from("<QQ", entry, 32) == (start, end), f"wrong {name} partition range"
            assert entry[56:128].decode("utf-16le").rstrip("\0") == name, "wrong partition label"
        image.seek(32768)
        assert image.read(4) == b"RKNS", "missing Rockchip loader"
    print(f"Factory geometry verified: {size} bytes")


def compare(source, readback, offset, length):
    assert readback.stat().st_size == length, "incomplete device readback"
    with source.open("rb") as original, readback.open("rb") as device:
        original.seek(offset)
        remaining = length
        while remaining:
            count = min(1048576, remaining)
            expected = original.read(count)
            actual = device.read(count)
            if expected != actual:
                index = next(n for n, pair in enumerate(zip(expected, actual)) if pair[0] != pair[1])
                raise ValueError(f"device readback differs at image byte {offset + length - remaining + index}")
            remaining -= count


try:
    if sys.argv[1] == "check":
        check_image(pathlib.Path(sys.argv[2]))
    elif sys.argv[1] == "compare":
        compare(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
    else:
        raise ValueError("unknown verification action")
except (AssertionError, OSError, ValueError, IndexError) as error:
    sys.exit(f"error: {error}")
