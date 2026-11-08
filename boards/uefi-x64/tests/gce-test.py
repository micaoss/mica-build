#!/usr/bin/env python3
"""The gce image kind (boards/uefi-x64/packer/gce): pack/verify over a small GPT disk of an odd size."""
import hashlib
import os
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
import uuid
import zlib

PACKER = Path(__file__).resolve().parent.parent / "packer" / "gce"
SECTOR = 512
GIB = 1 << 30
SECTORS = 20480 + 777  # 10 MiB and an odd tail: not a whole GiB, not a whole MiB


def crc(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def header(my_lba, alternate, first, last, entries_lba, entries_crc, disk_guid):
    h = bytearray(92)
    h[:8] = b"EFI PART"
    struct.pack_into("<IIIIQQQQ16sQIII", h, 8, 0x10000, 92, 0, 0, my_lba, alternate, first, last,
                     disk_guid, entries_lba, 128, 128, entries_crc)
    struct.pack_into("<I", h, 16, crc(h))
    return bytes(h) + bytes(SECTOR - 92)


def make_disk(path):
    """A protective MBR, three partitions with recognisable bytes and both GPT copies, as the image builder lays them."""
    entries = bytearray(128 * 128)
    parts = [(2048, 4095), (4096, 12287), (12288, SECTORS - 34)]
    for i, (start, end) in enumerate(parts):
        struct.pack_into("<16s16sQQQ", entries, i * 128, uuid.UUID(int=0xC12A7328 + i).bytes_le,
                         uuid.UUID(int=i + 1).bytes_le, start, end, 0)
        name = f"part{i}".encode("utf-16le")
        entries[i * 128 + 56:i * 128 + 56 + len(name)] = name
    mbr = bytearray(SECTOR)
    struct.pack_into("<BBBBBBBBII", mbr, 446, 0, 0, 2, 0, 0xEE, 0xFF, 0xFF, 0xFF, 1, SECTORS - 1)
    mbr[510:512] = b"\x55\xaa"
    guid = uuid.UUID(int=0xD15C).bytes_le
    last = SECTORS - 34
    with open(path, "wb") as f:
        f.truncate(SECTORS * SECTOR)
        f.write(mbr)
        f.write(header(1, SECTORS - 1, 34, last, 2, crc(entries), guid))
        f.write(entries)
        for i, (start, end) in enumerate(parts):
            f.seek(start * SECTOR)
            f.write(hashlib.sha256(f"p{i}".encode()).digest() * ((end - start + 1) * SECTOR // 32))
        f.seek((SECTORS - 33) * SECTOR)
        f.write(entries)
        f.write(header(SECTORS - 1, 1, 34, last, SECTORS - 33, crc(entries), guid))
    return parts


def run(*args, check=True):
    return subprocess.run([str(PACKER), *map(str, args)], capture_output=True, text=True, check=check)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


class Gce(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.input = self.dir / "in"
        self.input.mkdir()
        self.parts = make_disk(self.input / "disk.img")

    def tearDown(self):
        self.tmp.cleanup()

    def unpacked(self, tar):
        out = self.dir / "x"
        out.mkdir(exist_ok=True)
        subprocess.run(["tar", "-xSf", str(tar), "-C", str(out)], check=True)
        return out / "disk.raw"

    def test_pack_is_one_disk_raw_of_a_whole_gib_with_the_gpt_at_its_end(self):
        out = self.dir / "a.tar"
        run("pack", self.input, out)
        run("verify", self.input, out)
        with tarfile.open(out) as t:
            members = t.getmembers()
        self.assertEqual([m.name for m in members], ["disk.raw"])
        with open(out, "rb") as f:
            self.assertEqual(f.read(512)[257:265], b"ustar  \0")
        raw = self.unpacked(out)
        self.assertEqual(os.path.getsize(raw), GIB)
        n = GIB // SECTOR
        with open(raw, "rb") as f, open(self.input / "disk.img", "rb") as d:
            mbr, primary = f.read(SECTOR), f.read(SECTOR)
            entries = f.read(32 * SECTOR)
            self.assertEqual(struct.unpack_from("<I", mbr, 458)[0], n - 1)
            my, alternate, first, last = struct.unpack_from("<QQQQ", primary, 24)
            self.assertEqual((my, alternate, first, last), (1, n - 1, 34, n - 34))
            self.assertEqual(struct.unpack_from("<I", primary, 16)[0], crc(primary[:16] + bytes(4) + primary[20:92]))
            f.seek((n - 33) * SECTOR)
            self.assertEqual(f.read(32 * SECTOR), entries)
            backup = f.read(SECTOR)
            self.assertEqual(struct.unpack_from("<QQQ", backup, 24), (n - 1, 1, 34))
            self.assertEqual(struct.unpack_from("<Q", backup, 72)[0], n - 33)
            self.assertEqual(struct.unpack_from("<I", backup, 16)[0], crc(backup[:16] + bytes(4) + backup[20:92]))
            # Every partition's bytes are disk.img's; the old backup is zeroed.
            for start, end in self.parts:
                f.seek(start * SECTOR)
                d.seek(start * SECTOR)
                self.assertEqual(f.read((end - start + 1) * SECTOR), d.read((end - start + 1) * SECTOR))
            f.seek((SECTORS - 33) * SECTOR)
            self.assertEqual(f.read(33 * SECTOR), bytes(33 * SECTOR))

    def test_the_same_disk_packs_to_the_same_bytes(self):
        run("pack", self.input, self.dir / "a.tar")
        run("pack", self.input, self.dir / "b.tar")
        self.assertEqual(sha(self.dir / "a.tar"), sha(self.dir / "b.tar"))

    def test_verify_refuses_another_member_name_or_a_changed_byte(self):
        out = self.dir / "a.tar"
        run("pack", self.input, out)
        raw = self.unpacked(out)
        renamed = self.dir / "renamed.tar"
        subprocess.run(["tar", "--format=oldgnu", "-S", "-C", str(raw.parent), "--transform", "s/disk.raw/disk.img/",
                        "-cf", str(renamed), "disk.raw"], check=True)
        self.assertIn("one member is disk.raw", run("verify", self.input, renamed, check=False).stderr)
        with open(raw, "r+b") as f:
            f.seek(self.parts[1][0] * SECTOR + 7)
            f.write(b"\xff")
        changed = self.dir / "changed.tar"
        subprocess.run(["tar", "--format=oldgnu", "-S", "-C", str(raw.parent), "-cf", str(changed), "disk.raw"], check=True)
        self.assertIn("is not disk.img grown", run("verify", self.input, changed, check=False).stderr)

    def test_pack_refuses_a_disk_without_a_gpt(self):
        with open(self.input / "disk.img", "r+b") as f:
            f.seek(SECTOR)
            f.write(bytes(8))
        result = run("pack", self.input, self.dir / "a.tar", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("carries no GPT header", result.stderr)


if __name__ == "__main__":
    unittest.main()
