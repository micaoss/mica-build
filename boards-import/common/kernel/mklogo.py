#!/usr/bin/env python3
# mica-build-side: container -- kernel/Dockerfile runs this in the BSP builder
# against the committed master, and writes the result over the vendor tree's
# logo_linux_clut224.ppm. Nothing in this repository's checkout is touched.
#
# Convert the board splash master to the ASCII PPM the kernel's own
# drivers/video/logo/pnmtologo.c compiles into logo_linux_clut224.o.
#
#   mklogo.py <master.png> <out.ppm> <width> <height>
#
# THE MASTER IS THE ONLY SOURCE. The PPM is derived here at build time rather
# than committed beside the PNG: a generated file in the tree is a second copy
# of the artwork that nothing forces to agree with the first, and the two would
# drift the moment someone edited one of them. Deriving it means the question
# "does the PPM match the master" cannot be asked, because there is only ever
# one answer in the tree.
#
# EVERY STEP IS INTEGER AND ORDER-INDEPENDENT, because this runs inside the
# reproducibility boundary kernel/Dockerfile's four pins establish: the resample
# is exact rational area-averaging, the quantiser is a median cut whose splits
# are decided by counts and channel extents alone, and the palette is emitted in
# sorted order. Two runs on one input produce one byte string; floating point
# would make that a property of the libm build instead.
#
# pnmtologo.c's constraints, which this file exists to satisfy:
#   * MAX_LINUX_LOGO_COLORS is 224 (pnmtologo.c:43). 225 distinct colours is a
#     hard error at kernel build time, not a degraded logo.
#   * `P3` (ASCII RGB) with a maxval, read by get_number255 (pnmtologo.c:119).
#
# fbmem.c's constraints, which decide <width> and <height>:
#   * fb_prepare_logo drops the logo entirely when its HEIGHT exceeds the mode's
#     yres (fbmem.c:650-653), and fb_show_logo_line reduces the copy count to
#     zero when its WIDTH does not fit xres (fbmem.c:513). Both failures are a
#     blank screen, not a crash -- so the geometry is chosen to fit the smallest
#     mode this product's HDMI is expected to negotiate, not the largest.
import sys
import zlib


def read_png(path):
    """Decode a non-interlaced truecolour PNG to (w, h, rows of (r, g, b) at 8 bits)."""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path}: not a PNG')
    pos, idat, w, h, depth, ctype = 8, [], 0, 0, 0, 0
    while pos < len(data):
        ln = int.from_bytes(data[pos:pos + 4], 'big')
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if tag == b'IHDR':
            w = int.from_bytes(body[0:4], 'big')
            h = int.from_bytes(body[4:8], 'big')
            depth, ctype = body[8], body[9]
            if body[12] != 0:
                raise SystemExit(f'{path}: interlaced PNG is not supported')
        elif tag == b'IDAT':
            idat.append(body)
        elif tag == b'IEND':
            break
    if ctype != 2 or depth not in (8, 16):
        raise SystemExit(f'{path}: need truecolour (type 2) at 8 or 16 bits, got type {ctype}/{depth}')
    raw = zlib.decompress(b''.join(idat))
    bpp = 3 * (depth // 8)
    stride = w * bpp
    out, prev = [], bytearray(stride)
    for y in range(h):
        off = y * (stride + 1)
        ft = raw[off]
        line = bytearray(raw[off + 1:off + 1 + stride])
        # The five PNG filters, unfiltered in place against the previous row.
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise SystemExit(f'{path}: unknown PNG filter {ft} on row {y}')
        prev = line
        # 16-bit channels are taken by their high byte: pnmtologo rescales to
        # 0..255 anyway, and the low byte cannot survive a 224-colour palette.
        step = bpp // 3
        out.append([(line[x * bpp], line[x * bpp + step], line[x * bpp + 2 * step]) for x in range(w)])
    return w, h, out


def resample(src, sw, sh, dw, dh):
    """Exact rational area-average. Integer throughout: no float, no rounding drift."""
    rows = []
    for dy in range(dh):
        y0n, y1n = dy * sh, (dy + 1) * sh          # source span is [y0n/dh, y1n/dh)
        row = []
        for dx in range(dw):
            x0n, x1n = dx * sw, (dx + 1) * sw
            acc_r = acc_g = acc_b = area = 0
            for sy in range(y0n // dh, (y1n + dh - 1) // dh):
                # Overlap of source row sy with the destination span, in 1/dh units.
                wy = min(y1n, (sy + 1) * dh) - max(y0n, sy * dh)
                if wy <= 0:
                    continue
                srow = src[sy]
                for sx in range(x0n // dw, (x1n + dw - 1) // dw):
                    wx = min(x1n, (sx + 1) * dw) - max(x0n, sx * dw)
                    if wx <= 0:
                        continue
                    r, g, b = srow[sx]
                    a = wx * wy
                    acc_r += r * a
                    acc_g += g * a
                    acc_b += b * a
                    area += a
            row.append(((acc_r + area // 2) // area,
                        (acc_g + area // 2) // area,
                        (acc_b + area // 2) // area))
        rows.append(row)
    return rows


def quantise(rows, limit):
    """Median cut to at most `limit` colours, then map every pixel onto the result."""
    hist = {}
    for row in rows:
        for px in row:
            hist[px] = hist.get(px, 0) + 1
    if len(hist) <= limit:
        return rows
    # Boxes are (colours, total count). Split the one with the widest channel
    # extent, breaking ties on population then on the colour tuple, so the
    # choice never depends on dict or set iteration order.
    boxes = [sorted(hist.keys())]
    while len(boxes) < limit:
        best, best_key = None, None
        for i, box in enumerate(boxes):
            if len(box) < 2:
                continue
            spread = max(max(c[ch] for c in box) - min(c[ch] for c in box) for ch in range(3))
            key = (spread, sum(hist[c] for c in box), -i)
            if best_key is None or key > best_key:
                best, best_key = i, key
        if best is None:
            break
        box = boxes[best]
        ch = max(range(3), key=lambda k: (max(c[k] for c in box) - min(c[k] for c in box), -k))
        box = sorted(box, key=lambda c: (c[ch], c))
        # Split at the population median, so both halves carry real pixels.
        total = sum(hist[c] for c in box)
        run, cut = 0, 1
        for j, c in enumerate(box):
            run += hist[c]
            if run * 2 >= total:
                cut = min(max(j, 1), len(box) - 1)
                break
        boxes[best:best + 1] = [box[:cut], box[cut:]]
    palette, mapping = [], {}
    for box in boxes:
        n = sum(hist[c] for c in box)
        rep = (sum(c[0] * hist[c] for c in box) // n,
               sum(c[1] * hist[c] for c in box) // n,
               sum(c[2] * hist[c] for c in box) // n)
        palette.append(rep)
        for c in box:
            mapping[c] = rep
    return [[mapping[px] for px in row] for row in rows]


def main():
    if len(sys.argv) != 5:
        raise SystemExit('usage: mklogo.py <master.png> <out.ppm> <width> <height>')
    src_path, out_path, dw, dh = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    sw, sh, src = read_png(src_path)
    rows = quantise(resample(src, sw, sh, dw, dh), 224)
    colours = {px for row in rows for px in row}
    if len(colours) > 224:
        raise SystemExit(f'{out_path}: {len(colours)} colours, and pnmtologo.c refuses more than 224')
    body = []
    for row in rows:
        body.append(' '.join(f'{r} {g} {b}' for r, g, b in row))
    with open(out_path, 'w') as fh:
        fh.write(f'P3\n# Generated from {src_path.rsplit("/", 1)[-1]} by mklogo.py -- do not edit.\n')
        fh.write(f'{dw} {dh}\n255\n')
        fh.write('\n'.join(body))
        fh.write('\n')
    print(f'logo: {sw}x{sh} -> {dw}x{dh}, {len(colours)} colours, {out_path}')


main()
