"""The board's bootloader package, uboot-package/update.img: checked to be the loader this board tree pins.

It is the bytes its update.img.sha256 names. It reads as an Amlogic v2 image. Its loader payloads are uboot/'s
files, and its BL33 is not empty.
"""
import hashlib
from pathlib import Path

import amlimage

PACKAGE = "uboot-package/update.img"
# The loader payloads, by their item in the bootloader package, and the uboot/ file each must equal.
LOADER = {
    "DDR.USB": (("USB", "DDR"), "uboot/DDR.USB"),
    "aml_sdc_burn.UBOOT": (("UBOOT", "aml_sdc_burn"), "uboot/u-boot.bin.sd.bin.signed"),
    "bootloader.PARTITION": (("PARTITION", "bootloader"), "uboot/u-boot.bin.signed"),
    "_aml_dtb.PARTITION": (("PARTITION", "_aml_dtb"), None),
    "platform.conf": (("conf", "platform"), None),
    "usb_flow.aml": (("aml", "usb_flow"), None),
}


class LoaderError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise LoaderError(reason)


def digest(chunks):
    h = hashlib.sha256()
    for block in chunks:
        h.update(block)
    return h.hexdigest()


def whole(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), f"{path} is not a regular file")
    return (str(path), 0, path.stat().st_size)


def sha256_of(path):
    return digest(amlimage.source_chunks(whole(path)))


def payloads(board):
    """The checked package's loader payloads, by file name, as (path, offset, size) in it."""
    board = Path(board)
    package = board / PACKAGE
    recorded = (board / f"{PACKAGE}.sha256").read_text().split()[0]
    require(sha256_of(package) == recorded, f"{PACKAGE} is not the bytes its .sha256 names")
    try:
        items = amlimage.read(str(package))
    except amlimage.FormatError as e:
        raise LoaderError(f"{PACKAGE}: {e}") from e
    out = {}
    for name, ((main, sub), equal) in LOADER.items():
        entry = amlimage.item(items, main, sub)
        out[name] = (str(package), entry["offset"], entry["size"])
        if equal is not None:
            require(digest(amlimage.chunks(str(package), entry)) == sha256_of(board / equal),
                    f"the bootloader package's {name} is not {equal}")
    path, offset, _ = out["bootloader.PARTITION"]
    bl33 = b"".join(amlimage.source_chunks((path, offset + 416 * 4096, 224 * 4096)))
    require(sum(b != 0 for b in bl33) > 65536, "the loader has an empty or truncated BL33")
    return out
