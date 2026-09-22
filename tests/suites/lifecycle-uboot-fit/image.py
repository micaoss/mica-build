"""Inspect the assembled cx3576 medium independently of the image producer."""
import base64
import hashlib
import json
import pathlib
import struct
import sys
import zlib

work = pathlib.Path(sys.argv[1])
disk = work / "image/disk.img"
with disk.open("rb") as stream:
    stream.seek(512)
    header = stream.read(92)
    assert header[:8] == b"EFI PART"
    checksum = struct.unpack_from("<I", header, 16)[0]
    assert zlib.crc32(header[:16] + b"\0" * 4 + header[20:]) == checksum
    table_lba, count, size, checksum = struct.unpack_from("<QIII", header, 72)
    stream.seek(table_lba * 512)
    table = stream.read(count * size)
    assert zlib.crc32(table) == checksum
    entries = [table[i:i + size] for i in range(0, len(table), size) if any(table[i:i + 16])]
    assert len(entries) == 3
    expected = [("firmware", 64, 36863), ("system", 36864, 2134015), ("data", 2134016, 2658303)]
    for entry, (name, first, last) in zip(entries, expected):
        assert struct.unpack_from("<QQ", entry, 32) == (first, last)
        assert entry[56:128].decode("utf-16le").rstrip("\0") == name
    stream.seek(32768)
    firmware = bytearray(stream.read(18 * 1048576 - 32768))

loader = (work / "firmware/u-boot-rockchip.bin").read_bytes()
assert len(loader) <= 16744448 and firmware[:len(loader)] == loader
records = json.loads((work / "factory-records.json").read_text())
manifests = [json.loads(base64.b64decode(json.loads(r["envelope"])["payload"])) for r in records]
manifests.sort(key=lambda value: -value["generation"])
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
expected_records = "v1|" + ";".join(
    f'{hashlib.sha256(canonical(value)).hexdigest()},{value["kernel"]["id"]},{value["generation"]},3'
    for value in manifests
)
for flag, absolute in enumerate([16 * 1048576, 17 * 1048576]):
    offset = absolute - 32768
    environment = firmware[offset:offset + 65536]
    assert environment[4] == flag
    assert struct.unpack_from("<I", environment)[0] == zlib.crc32(environment[5:])
    payload = b"mica_entries=" + expected_records.encode() + b"\0\0"
    assert environment[5:] == payload + b"\0" * (65531 - len(payload))
    firmware[offset:offset + 65536] = b"\0" * 65536
assert not any(firmware[len(loader):]), "unexpected data in protected firmware slack"

for name in ["system", "data"]:
    with (work / f"image/{name}.img").open("rb") as stream:
        stream.seek(1024)
        superblock = stream.read(1024)
    assert struct.unpack_from("<H", superblock, 56)[0] == 0xEF53
    compat, incompat, ro = struct.unpack_from("<III", superblock, 92)
    assert not compat & 0x1000 and not incompat & 0x2000
    assert compat & 4, "journal is required"
    if name == "data":
        assert ro & 0x100 and ro & 0x2000, "project quota is required"
print("CX3576_GPT_LOADER_COUNTERS_FILESYSTEM_PASS")
