"""Write and read the Amlogic v2 burning package (`update.img`), as the pinned aml_image_v2_packer does.

The layout (superna9999/pyamlboot AML-IMAGE-FORMAT.md, and the packer's own output):
- a 64-byte header: crc, version 2, magic 0x27B51956, image size, item alignment 8, item count;
- then one 576-byte record per item;
- then the payloads.

Items are sorted by (sub type, main type). Each `[LIST_VERIFY]` row adds a `VERIFY` item holding
`sha1sum <hex>` of its payload. That item sits right after the payload it names, unaligned; every
other payload starts on the item alignment. A file named by more than one row is stored once:
each later item is a backup of the first, pointing at the same bytes. The crc is CRC-32 of
everything after its own 4 bytes, inverted.
"""
import hashlib
import re
import struct
import zlib

MAGIC = 0x27B51956
VERSION = 2
ALIGN = 8
HEADER = struct.Struct("<IIIQII36x")
ITEM = struct.Struct("<IIQQQ256s256sIHH24x")
NORMAL = 0
CHUNK = 4 * 1024 * 1024
ROW = re.compile(r'file="([A-Za-z0-9_.-]+)"\s+main_type="([A-Za-z0-9_]+)"\s+sub_type="([A-Za-z0-9_]+)"\s+file_type="normal"')


class FormatError(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise FormatError(reason)


def parse_cfg(text):
    """The rows of an image.cfg: (file, main type, sub type, verified), in file order."""
    section, rows = "", []
    for line in text.splitlines():
        line = line.strip()
        if line in ("[LIST_NORMAL]", "[LIST_VERIFY]"):
            section = line
            continue
        if not line.startswith("file="):
            continue
        match = ROW.fullmatch(line)
        require(match is not None and section != "", f"invalid image.cfg row: {line}")
        rows.append((*match.groups(), section == "[LIST_VERIFY]"))
    require(len(rows) == len({(main, sub) for _, main, sub, _ in rows}), "two image.cfg rows share a main and sub type")
    return rows


def source_chunks(source):
    """The bytes of (path, offset, size), in blocks."""
    path, offset, size = source
    with open(path, "rb") as f:
        f.seek(offset)
        while size:
            block = f.read(min(CHUNK, size))
            require(len(block) > 0, f"{path} is shorter than its payload")
            size -= len(block)
            yield block


def pack(rows, sources, output):
    """Write `output` from image.cfg `rows`; `sources` maps each file name to (path, offset, size)."""
    items = []
    for name, main, sub, verified in rows:
        require(name in sources, f"no payload for {name}")
        items.append({"name": name, "main": main, "sub": sub, "verify": int(verified), "kind": "data"})
        if verified:
            items.append({"name": name, "main": "VERIFY", "sub": sub, "verify": 0, "kind": "verify"})
    items.sort(key=lambda i: (i["sub"].encode(), i["main"].encode()))
    sha1 = {}
    for name in {i["name"] for i in items if i["kind"] == "verify"}:
        digest = hashlib.sha1()
        for block in source_chunks(sources[name]):
            digest.update(block)
        sha1[name] = f"sha1sum {digest.hexdigest()}".encode()

    first, cursor = {}, HEADER.size + ITEM.size * len(items)
    for index, item in enumerate(items):
        key = (item["kind"], item["name"])
        item["size"] = len(sha1[item["name"]]) if item["kind"] == "verify" else sources[item["name"]][2]
        if key in first:
            item["offset"], item["backup"] = items[first[key]]["offset"], first[key]
            continue
        first[key] = index
        if item["kind"] == "data":
            cursor += -cursor % ALIGN
        item["offset"], item["backup"] = cursor, None
        cursor += item["size"]

    with open(output, "xb") as out:
        out.write(bytes(HEADER.size))
        for index, item in enumerate(items):
            out.write(ITEM.pack(index, NORMAL, 0, item["offset"], item["size"], item["main"].encode(), item["sub"].encode(),
                                item["verify"], int(item["backup"] is not None), item["backup"] or 0))
        for item in items:
            if item["backup"] is not None:
                continue
            out.write(bytes(item["offset"] - out.tell()))
            if item["kind"] == "verify":
                out.write(sha1[item["name"]])
            else:
                for block in source_chunks(sources[item["name"]]):
                    out.write(block)
        size = out.tell()
    with open(output, "r+b") as out:
        out.write(HEADER.pack(0, VERSION, MAGIC, size, ALIGN, len(items)))
        out.seek(4)
        crc = 0
        while block := out.read(CHUNK):
            crc = zlib.crc32(block, crc)
        out.seek(0)
        out.write(struct.pack("<I", crc ^ 0xFFFFFFFF))


def read(path):
    """The items of a v2 image, its header and crc checked: dicts of id, main, sub, offset, size, verify, backup."""
    with open(path, "rb") as f:
        head = f.read(HEADER.size)
        require(len(head) == HEADER.size, "truncated header")
        crc, version, magic, size, align, count = HEADER.unpack(head)
        require(magic == MAGIC and version == VERSION and align == ALIGN, "not an Amlogic v2 image")
        f.seek(0, 2)
        require(f.tell() == size, "image size differs from its header")
        f.seek(4)
        check = 0
        while block := f.read(CHUNK):
            check = zlib.crc32(block, check)
        require(check ^ 0xFFFFFFFF == crc, "image crc mismatch")
        f.seek(HEADER.size)
        items = []
        for index in range(count):
            record = f.read(ITEM.size)
            require(len(record) == ITEM.size, "truncated item table")
            iid, file_type, _, offset, length, main, sub, verify, backup, backup_id = ITEM.unpack(record)
            require(iid == index and file_type == NORMAL, "unsupported item")
            require(offset + length <= size, "item outside the image")
            items.append({"id": iid, "main": main.rstrip(b"\0").decode(), "sub": sub.rstrip(b"\0").decode(),
                          "offset": offset, "size": length, "verify": verify, "backup": backup_id if backup else None})
    return items


def item(items, main, sub):
    found = [i for i in items if i["main"] == main and i["sub"] == sub]
    require(len(found) == 1, f"the image has no unique {main}/{sub} item")
    return found[0]


def chunks(path, entry):
    """The bytes of one item, in blocks."""
    return source_chunks((path, entry["offset"], entry["size"]))


def payload(path, entry):
    return b"".join(chunks(path, entry))
