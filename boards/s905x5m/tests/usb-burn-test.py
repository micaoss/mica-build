#!/usr/bin/env python3
"""The usb-burn image kind: its v2 writer against the vendor packer, and pack/verify over a small eMMC layout.

fixtures/aml-v2-golden.img was written once by the pinned aml_image_v2_packer (source row
s905x5m-aml-image-v2-packer of locks/upstream.lock), from the payloads golden_inputs() makes and
fixtures/aml-v2-golden.cfg:
    aml_image_v2_packer -r aml-v2-golden.cfg <dir of golden_inputs()> aml-v2-golden.img
"""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import uuid
import zlib

HERE = Path(__file__).resolve().parent
PACKER = HERE.parent / "packer"
FIXTURES = HERE / "fixtures"
sys.path.insert(0, str(PACKER))
import amlimage  # noqa: E402


def blob(seed, size):
    out, i = b"", 0
    while len(out) < size:
        out += hashlib.sha256(f"{seed}{i}".encode()).digest()
        i += 1
    return out[:size]


def golden_inputs(directory):
    files = {
        "DDR.USB": blob("ddr", 1000), "aml_sdc_burn.UBOOT": blob("sd", 1501), "aml_sdc_burn.ini": b"[common]\nerase_bootloader = 1\n",
        "gpt.bin": blob("gpt", 512 * 67), "_aml_dtb.PARTITION": blob("dtb", 777), "platform.conf": b"Platform:0x0811\n",
        "usb_flow.aml": blob("flow", 33), "bootloader.PARTITION": blob("bl", 4096 * 3 + 5), "firmware.PARTITION": blob("fw", 8192),
        "system.PARTITION": blob("sys", 6000 + 3), "data.PARTITION": bytes(1000),
    }
    for name, data in files.items():
        (directory / name).write_bytes(data)


def whole(directory, rows):
    return {name: (str(directory / name), 0, (directory / name).stat().st_size) for name, _, _, _ in rows}


# A small eMMC layout gpt.py accepts: vendor slots 4-6 below sector 262144, Mica's three above it.
LAYOUT = """# mica layout v1
disk\t5A9055A0-0004-4000-8000-000000000000\t512\t1
discard\tno
part\t4\tbootloader_a\tpreserved\t8192\t24576\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000011\t-
part\t5\treserved\tpreserved\t73728\t131072\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000014\t-
part\t6\tenv\tpreserved\t221184\t32768\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000015\t-
part\t1\tfirmware\traw\t262144\t64\t8DA63339-0007-60C0-C436-083AC8230908\t5A9055A0-0004-4000-8000-000000000001\t-
part\t2\tsystem\tsystem\t262208\t128\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5A9055A0-0004-4000-8000-000000000002\t5a9055a0-0004-4000-8000-000000000102
part\t3\tdata\tdata\t262336\t64\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5A9055A0-0004-4000-8000-000000000003\t5a9055a0-0004-4000-8000-000000000103
"""


def write_gpt(path, layout_rows, sectors, disk_guid):
    """A protective MBR and primary and backup GPT over `sectors`, entries in partition-number order."""
    entries = bytearray(128 * 128)
    for number, name, start, size, type_guid, part_guid in layout_rows:
        struct.pack_into("<16s16sQQQ72s", entries, (number - 1) * 128, uuid.UUID(type_guid).bytes_le, uuid.UUID(part_guid).bytes_le,
                         start, start + size - 1, 0, name.encode("utf-16-le"))

    def header(current, backup, entries_lba):
        h = bytearray(512)
        struct.pack_into("<8sIIIIQQQQ16sQIII", h, 0, b"EFI PART", 65536, 92, 0, 0, current, backup, 34, sectors - 34,
                         uuid.UUID(disk_guid).bytes_le, entries_lba, 128, 128, zlib.crc32(entries))
        struct.pack_into("<I", h, 16, zlib.crc32(h[:92]))
        return h

    mbr = bytearray(512)
    mbr[446 + 4] = 0xEE
    struct.pack_into("<II", mbr, 454, 1, min(sectors - 1, 0xFFFFFFFF))
    mbr[446 + 2] = 2
    mbr[510:512] = b"\x55\xaa"
    with open(path, "r+b") as f:
        f.write(mbr + header(1, sectors - 1, 2) + entries)
        f.seek((sectors - 33) * 512)
        f.write(entries + header(sectors - 1, 1, sectors - 33))


class Board:
    """An input directory as image-kinds hands it to the packer: disk.img and board/."""

    def __init__(self, root):
        self.root = root
        board = root / "board"
        shutil.copytree(PACKER, board / "packer")
        (board / "layout-emmc.tsv").write_text(LAYOUT)
        sys.path.insert(0, str(board / "packer"))
        spec = importlib.util.spec_from_file_location("fixture_gpt", board / "packer/gpt.py")
        self.gpt = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gpt)
        sectors = self.gpt.IMAGE_SECTORS
        disk = root / "disk.img"
        with disk.open("wb") as f:
            f.truncate(sectors * 512)
        rows = [(int(c[1]), c[2], int(c[4]), int(c[5]), c[6], c[7]) for c in (line.split("\t") for line in LAYOUT.splitlines()) if c[0] == "part"]
        write_gpt(disk, rows, sectors, "5A9055A0-0004-4000-8000-000000000000")
        with disk.open("r+b") as f:
            for number, _, start, size, _, _ in rows:
                if number <= 3:
                    f.seek(start * 512)
                    f.write(blob(f"part{number}", size * 512))
        uboot = board / "uboot"
        uboot.mkdir()
        loader = bytearray(blob("loader", 416 * 4096 + 224 * 4096 + 100))
        (uboot / "u-boot.bin.signed").write_bytes(loader)
        (uboot / "u-boot.bin.sd.bin.signed").write_bytes(blob("sd", 4000))
        (uboot / "DDR.USB").write_bytes(blob("ddr", 3000))
        package = board / "uboot-package"
        (package / "emmc-recovery").mkdir(parents=True)
        (package / "emmc-recovery/aml_sdc_burn.ini").write_text("[common]\nerase_flash = 0\n")
        stage = root / "loader-stage"
        stage.mkdir()
        shutil.copyfile(uboot / "u-boot.bin.signed", stage / "bootloader.PARTITION")
        shutil.copyfile(uboot / "u-boot.bin.sd.bin.signed", stage / "aml_sdc_burn.UBOOT")
        shutil.copyfile(uboot / "DDR.USB", stage / "DDR.USB")
        for name, data in (("aml_sdc_burn.ini", b"[common]\n"), ("_aml_dtb.PARTITION", blob("dtb", 900)),
                           ("platform.conf", b"Platform:0x0811\n"), ("usb_flow.aml", blob("flow", 40))):
            (stage / name).write_bytes(data)
        rows = amlimage.parse_cfg((HERE.parent / "loader/package/config/bootloader.cfg").read_text())
        amlimage.pack(rows, whole(stage, rows), str(package / "update.img"))
        (package / "update.img.sha256").write_text(f"{hashlib.sha256((package / 'update.img').read_bytes()).hexdigest()}  update.img\n")

    def run(self, verb, output):
        return subprocess.run([str(self.root / "board/packer/usb-burn"), verb, str(self.root), str(output)], capture_output=True, text=True)


class GoldenVector(unittest.TestCase):
    def test_the_writer_reproduces_the_vendor_packer_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            golden_inputs(directory)
            rows = amlimage.parse_cfg((FIXTURES / "aml-v2-golden.cfg").read_text())
            amlimage.pack(rows, whole(directory, rows), str(directory / "out.img"))
            self.assertEqual((directory / "out.img").read_bytes(), (FIXTURES / "aml-v2-golden.img").read_bytes())

    def test_the_reader_finds_backups_and_verify_items(self):
        items = amlimage.read(str(FIXTURES / "aml-v2-golden.img"))
        bootloader_a = amlimage.item(items, "PARTITION", "bootloader_a")
        self.assertEqual(bootloader_a["backup"], amlimage.item(items, "PARTITION", "bootloader")["id"])
        verify = amlimage.payload(str(FIXTURES / "aml-v2-golden.img"), amlimage.item(items, "VERIFY", "system"))
        self.assertEqual(verify, f"sha1sum {hashlib.sha1(blob('sys', 6003)).hexdigest()}".encode())

    def test_a_changed_byte_fails_the_crc(self):
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / "x.img"
            data = bytearray((FIXTURES / "aml-v2-golden.img").read_bytes())
            data[-1] ^= 1
            image.write_bytes(data)
            with self.assertRaisesRegex(amlimage.FormatError, "crc"):
                amlimage.read(str(image))


class UsbBurn(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.board = Board(self.root / "input")
        (self.root / "out").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_pack_then_verify_and_the_bytes_are_the_same_twice(self):
        first, second = self.root / "out/a.burn.img", self.root / "out/b.burn.img"
        for path in (first, second):
            self.assertEqual(self.board.run("pack", path).returncode, 0)
        result = self.board.run("verify", first)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(sorted((self.root / "out").iterdir()), [first, second])
        items = amlimage.read(str(first))
        disk = (self.root / "input/disk.img").read_bytes()
        system = amlimage.payload(str(first), amlimage.item(items, "PARTITION", "system"))
        self.assertEqual(system, disk[262208 * 512:(262208 + 128) * 512])
        gpt = amlimage.payload(str(first), amlimage.item(items, "bin", "gpt"))
        self.assertEqual(gpt, disk[:34 * 512] + disk[-33 * 512:])
        self.assertEqual({i["sub"] for i in items if i["main"] == "PARTITION"}, {"_aml_dtb", "bootloader", "bootloader_a", "firmware", "system", "data"})

    def test_verify_refuses_a_package_whose_payload_is_not_the_image(self):
        out = self.root / "out/a.burn.img"
        self.assertEqual(self.board.run("pack", out).returncode, 0)
        with (self.root / "input/disk.img").open("r+b") as f:
            f.seek(262208 * 512 + 7)
            f.write(b"\xff")
        result = self.board.run("verify", out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PARTITION/system is not system.PARTITION", result.stderr)

    def test_an_image_of_another_layout_is_refused(self):
        with (self.root / "input/disk.img").open("r+b") as f:
            f.truncate(self.board.gpt.IMAGE_SECTORS * 512 + 512)
        result = self.board.run("pack", self.root / "out/a.burn.img")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not the eMMC layout", result.stderr)

    def test_a_bootloader_package_that_is_not_the_board_loader_is_refused(self):
        (self.root / "input/board/uboot/u-boot.bin.signed").write_bytes(blob("other", 416 * 4096 + 224 * 4096 + 100))
        result = self.board.run("pack", self.root / "out/a.burn.img")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not uboot/u-boot.bin.signed", result.stderr)


class SdBoot(unittest.TestCase):
    """The sd-boot image kind: the board's own bootloader package, which installs Mica OS U-Boot in eMMC boot0."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.board = Board(self.root / "input")
        (self.root / "out").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run_packer(self, verb, output):
        return subprocess.run([str(self.root / "input/board/packer/bootloader"), verb, str(self.root / "input"), str(output)],
                              capture_output=True, text=True)

    def test_pack_is_the_board_bootloader_package_and_verify_proves_it(self):
        out = self.root / "out/a.sd-boot.img"
        self.assertEqual(self.run_packer("pack", out).returncode, 0)
        self.assertEqual(out.read_bytes(), (self.root / "input/board/uboot-package/update.img").read_bytes())
        result = self.run_packer("verify", out)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_verify_refuses_bytes_that_are_not_the_board_package(self):
        out = self.root / "out/a.sd-boot.img"
        self.assertEqual(self.run_packer("pack", out).returncode, 0)
        data = bytearray(out.read_bytes())
        data[-1] ^= 1
        out.write_bytes(data)
        result = self.run_packer("verify", out)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not the board's bootloader package", result.stderr)

    def test_a_bootloader_package_that_is_not_the_board_loader_is_refused(self):
        (self.root / "input/board/uboot/u-boot.bin.signed").write_bytes(blob("other", 416 * 4096 + 224 * 4096 + 100))
        result = self.run_packer("pack", self.root / "out/a.sd-boot.img")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not uboot/u-boot.bin.signed", result.stderr)

    def test_a_package_that_is_not_its_recorded_digest_is_refused(self):
        (self.root / "input/board/uboot-package/update.img.sha256").write_text(f"{'0' * 64}  update.img\n")
        result = self.run_packer("pack", self.root / "out/a.sd-boot.img")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not the bytes its .sha256 names", result.stderr)


if __name__ == "__main__":
    unittest.main()
