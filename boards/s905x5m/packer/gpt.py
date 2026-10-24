#!/usr/bin/env python3
"""Validate offline eMMC GPT payloads against the declared layout, and compile its GPT; no device operations."""
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
    if len(disk) != 1 or discard != [["no"]] or len(partitions) != 4:
        raise ValueError("eMMC layout lacks a unique disk, discard=no or four partitions")
    if [(p[0], p[1], p[2]) for p in partitions] != [
        (1, "firmware", "raw"), (2, "system", "system"), (3, "data", "data"), (4, "reserved", "preserved")]:
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


def chs(lba):
    """The protective MBR's CHS address of an LBA, as sgdisk writes it (255 heads, 63 sectors a track)."""
    cylinder, rest = divmod(lba, 255 * 63)
    if cylinder > 1023:
        return bytes((0xfe, 0xff, 0xff))
    head, sector = divmod(rest, 63)
    return bytes((head, sector + 1 | (cylinder >> 2) & 0xc0, cylinder & 0xff))


def compile_gpt():
    """The layout's GPT for its image, primary (34 sectors) then backup (33), byte for byte the GPT sgdisk writes
    into the eMMC product's disk.img: the eMMC recovery package writes it, the USB burn package the image's."""
    rows = [line.split("\t") for line in (Path(__file__).resolve().parents[1] / "layout-emmc.tsv").read_text().splitlines()]
    parts = sorted((int(r[1]), r[2], int(r[4]), int(r[5]), uuid.UUID(r[6]), uuid.UUID(r[7])) for r in rows if r[0] == "part")
    entries = bytearray(16384)
    for number, name, start, size, kind, unique in parts:
        struct.pack_into("<16s16sQQQ72s", entries, (number - 1) * 128, kind.bytes_le, unique.bytes_le,
                         start, start + size - 1, 0, name.encode("utf-16-le"))
    primary = bytearray(34 * 512)
    primary[446:462] = bytes((0, 0, 2, 0, 0xee)) + chs(IMAGE_SECTORS - 1) + struct.pack("<II", 1, min(IMAGE_SECTORS - 1, 0xffffffff))
    primary[510:512] = b"\x55\xaa"
    struct.pack_into("<8sIIIIQQQQ16sQIII", primary, 512, b"EFI PART", 65536, 92, 0, 0, 1, IMAGE_SECTORS - 1, 34,
                     IMAGE_SECTORS - 34, uuid.UUID(DISK_GUID).bytes_le, 2, 128, 128, zlib.crc32(entries))
    struct.pack_into("<I", primary, 528, zlib.crc32(primary[512:604]))
    primary[1024:] = entries
    return bytes(primary) + relocate_gpt(bytes(primary), IMAGE_SECTORS)[1]


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


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 2:
        sys.exit("usage: gpt.py <output>: write the eMMC layout's GPT, primary then backup")
    Path(sys.argv[1]).write_bytes(compile_gpt())
