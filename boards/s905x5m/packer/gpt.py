#!/usr/bin/env python3
"""Validate offline eMMC GPT payloads against the declared layout; no device operations."""
from pathlib import Path
import struct
import uuid
import zlib

MIB = 1048576


def load_layout(path):
    lines = path.read_text().splitlines()
    if not lines or lines[0] != "# mica layout v1":
        raise ValueError("not a mica layout v1")
    disk = []
    discard = []
    partitions = []
    for line in lines:
        if not line or line.startswith("#"):
            continue
        cells = line.split("\t")
        if cells[0] == "disk":
            if len(cells) != 4 or cells[2:] != ["512", "1"]:
                raise ValueError("unsupported eMMC disk row")
            disk.append(str(uuid.UUID(cells[1])))
        elif cells[0] == "discard":
            discard.append(cells[1:])
        elif cells[0] == "part":
            if len(cells) != 9 or cells[8] != "-" and cells[3] in ("raw", "preserved"):
                raise ValueError("invalid eMMC partition row")
            partitions.append((int(cells[1]), cells[2], cells[3], int(cells[4]), int(cells[5]),
                               str(uuid.UUID(cells[7])), str(uuid.UUID(cells[6]))))
        elif cells[0] != "region":
            raise ValueError("unexpected eMMC layout row")
    partitions.sort()
    if len(disk) != 1 or discard != [["no"]] or len(partitions) != 6:
        raise ValueError("eMMC layout lacks a unique disk, discard=no or six partitions")
    if [(p[0], p[1], p[2]) for p in partitions] != [
        (1, "firmware", "raw"), (2, "system", "system"), (3, "data", "data"),
        (4, "bootloader_a", "preserved"), (5, "reserved", "preserved"), (6, "env", "preserved")]:
        raise ValueError("eMMC partition roles or numbers differ")
    ranges = sorted((p[3], p[3] + p[4]) for p in partitions)
    if ranges[0][0] < 34 or any(a[1] > b[0] for a, b in zip(ranges, ranges[1:])):
        raise ValueError("eMMC partition ranges overlap")
    if any(p[3] < 262144 for p in partitions[:3]) or any(p[3] + p[4] > 262144 for p in partitions[3:]):
        raise ValueError("eMMC Mica writes overlap vendor reservations")
    return disk[0], [(p[1], p[3], p[4], p[5], p[6]) for p in partitions], partitions[2][3] + partitions[2][4] + 2048


DISK_GUID, PARTITIONS, IMAGE_SECTORS = load_layout(Path(__file__).resolve().parents[1] / "layout-emmc.tsv")


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def validate_header(header, entries):
    require(len(header) == 512 and len(entries) == 16384, "truncated GPT")
    require(header[:8] == b"EFI PART" and struct.unpack_from("<II", header, 8) == (65536, 92), "unsupported GPT header")
    require(struct.unpack_from("<I", header, 20)[0] == 0 and struct.unpack_from("<II", header, 80) == (128, 128), "unsupported GPT entry shape")
    check = bytearray(header[:92])
    check[16:20] = bytes(4)
    require(zlib.crc32(check) == struct.unpack_from("<I", header, 16)[0], "GPT header CRC mismatch")
    require(zlib.crc32(entries) == struct.unpack_from("<I", header, 88)[0], "GPT entry CRC mismatch")


def entries_from(primary, *, strict_unused=True):
    require(len(primary) == 34 * 512, "truncated primary GPT")
    validate_header(primary[512:1024], primary[1024:])
    result = []
    for offset in range(1024, len(primary), 128):
        entry = primary[offset:offset + 128]
        if entry[:16] == bytes(16):
            # The vendor leaves a size hint in its last unused entry. It is
            # covered by the array CRC but is not a partition (zero type GUID).
            require(not strict_unused or entry == bytes(128), "nonempty unused GPT entry")
            continue
        start, end, flags = struct.unpack_from("<QQQ", entry, 32)
        require(end >= start and flags == 0, "invalid GPT range or flags")
        result.append((entry[56:128].decode("utf-16-le").rstrip("\0"), start, end - start + 1,
                       str(uuid.UUID(bytes_le=bytes(entry[16:32]))), str(uuid.UUID(bytes_le=bytes(entry[:16])))))
    return result


def validate_primary(primary, sectors, partitions):
    require(primary[510:512] == b"\x55\xaa" and primary[450] == 0xee, "not a protective GPT")
    require(struct.unpack_from("<II", primary, 454) == (1, min(sectors - 1, 0xffffffff)), "protective MBR size mismatch")
    require(struct.unpack_from("<QQQQ", primary, 536) == (1, sectors - 1, 34, sectors - 34), "GPT extent mismatch")
    require(struct.unpack_from("<Q", primary, 584)[0] == 2, "GPT entries are relocated")
    require(str(uuid.UUID(bytes_le=bytes(primary[568:584]))) == DISK_GUID, "wrong eMMC disk identity")
    require(entries_from(primary) == partitions, "image is not the compiled eMMC layout")
    require(primary[1024 + len(partitions) * 128:] == bytes((128 - len(partitions)) * 128), "image partition numbers are not contiguous")


def relocate_gpt(primary, sectors):
    require(sectors >= IMAGE_SECTORS, "target eMMC is too small")
    first = bytearray(primary)
    struct.pack_into("<I", first, 458, min(sectors - 1, 0xffffffff))
    struct.pack_into("<Q", first, 544, sectors - 1)
    struct.pack_into("<Q", first, 560, sectors - 34)
    first[528:532] = bytes(4)
    struct.pack_into("<I", first, 528, zlib.crc32(first[512:604]))
    backup = bytearray(first[512:1024])
    struct.pack_into("<QQ", backup, 24, sectors - 1, 1)
    struct.pack_into("<Q", backup, 72, sectors - 33)
    backup[16:20] = bytes(4)
    struct.pack_into("<I", backup, 16, zlib.crc32(backup[:92]))
    return bytes(first), bytes(first[1024:] + backup)


