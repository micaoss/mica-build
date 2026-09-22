// mica-build-side: container -- the board kernel Dockerfiles run this in a stage on the build-env base
// image (the one with bun) against the committed master, and hand the result to the BSP build stage, which
// writes it over the vendor tree's logo_linux_clut224.ppm. Nothing in this repository's checkout is touched.
//
// Convert the board splash master to the ASCII PPM the kernel's own
// drivers/video/logo/pnmtologo.c compiles into logo_linux_clut224.o.
//
//   bun mklogo.ts <master.png> <out.ppm> <width> <height>
//
// THE MASTER IS THE ONLY SOURCE. The PPM is derived here at build time rather
// than committed beside the PNG: a generated file in the tree is a second copy
// of the artwork that nothing forces to agree with the first, and the two would
// drift the moment someone edited one of them. Deriving it means the question
// "does the PPM match the master" cannot be asked, because there is only ever
// one answer in the tree.
//
// EVERY STEP IS INTEGER AND ORDER-INDEPENDENT, because this runs inside the
// reproducibility boundary kernel/Dockerfile's four pins establish: the resample
// is exact rational area-averaging, the quantiser is a median cut whose splits
// are decided by counts and channel extents alone, and the palette is emitted in
// sorted order. Two runs on one input produce one byte string; floating point
// would make that a property of the libm build instead. (Integers here stay
// below 2^53, so a JavaScript number carries them exactly.)
//
// pnmtologo.c's constraints, which this file exists to satisfy:
//   * MAX_LINUX_LOGO_COLORS is 224 (pnmtologo.c:43). 225 distinct colours is a
//     hard error at kernel build time, not a degraded logo.
//   * `P3` (ASCII RGB) with a maxval, read by get_number255 (pnmtologo.c:119).
//
// fbmem.c's constraints, which decide <width> and <height>:
//   * fb_prepare_logo drops the logo entirely when its HEIGHT exceeds the mode's
//     yres (fbmem.c:650-653), and fb_show_logo_line reduces the copy count to
//     zero when its WIDTH does not fit xres (fbmem.c:513). Both failures are a
//     blank screen, not a crash -- so the geometry is chosen to fit the smallest
//     mode this product's HDMI is expected to negotiate, not the largest.
//
// The port of mklogo.py (deleted 2026-09-22), step for step; the PPM it writes is the Python's bytes.
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

type Pixel = [number, number, number]

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Decode a non-interlaced truecolour PNG to [w, h, rows of [r, g, b] at 8 bits]. */
function readPng(path: string): [number, number, Pixel[][]] {
  const data = readFileSync(path)
  if (!data.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))) exit(`${path}: not a PNG`)
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0
  const idat: Buffer[] = []
  while (pos < data.length) {
    const ln = data.readUInt32BE(pos)
    const tag = data.subarray(pos + 4, pos + 8).toString('latin1')
    const body = data.subarray(pos + 8, pos + 8 + ln)
    pos += 12 + ln
    if (tag === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4)
      depth = body[8]!; ctype = body[9]!
      if (body[12] !== 0) exit(`${path}: interlaced PNG is not supported`)
    }
    else if (tag === 'IDAT') { idat.push(body) }
    else if (tag === 'IEND') { break }
  }
  if (ctype !== 2 || (depth !== 8 && depth !== 16)) exit(`${path}: need truecolour (type 2) at 8 or 16 bits, got type ${ctype}/${depth}`)
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 3 * (depth / 8)
  const stride = w * bpp
  const out: Pixel[][] = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1)
    const ft = raw[off]!
    const line = Buffer.from(raw.subarray(off + 1, off + 1 + stride))
    // The five PNG filters, unfiltered in place against the previous row.
    if (ft === 1) {
      for (let i = bpp; i < stride; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xFF
    }
    else if (ft === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i]! + prev[i]!) & 0xFF
    }
    else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp]! : 0
        line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xFF
      }
    }
    else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0
        const b = prev[i]!
        const c = i >= bpp ? prev[i - bpp]! : 0
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
        line[i] = (line[i]! + pr) & 0xFF
      }
    }
    else if (ft !== 0) { exit(`${path}: unknown PNG filter ${ft} on row ${y}`) }
    prev = line
    // 16-bit channels are taken by their high byte: pnmtologo rescales to
    // 0..255 anyway, and the low byte cannot survive a 224-colour palette.
    const step = bpp / 3
    const row: Pixel[] = []
    for (let x = 0; x < w; x++) row.push([line[x * bpp]!, line[x * bpp + step]!, line[x * bpp + 2 * step]!])
    out.push(row)
  }
  return [w, h, out]
}

/** Exact rational area-average. Integer throughout: no float, no rounding drift. */
function resample(src: Pixel[][], sw: number, sh: number, dw: number, dh: number): Pixel[][] {
  const rows: Pixel[][] = []
  for (let dy = 0; dy < dh; dy++) {
    const y0n = dy * sh, y1n = (dy + 1) * sh // source span is [y0n/dh, y1n/dh)
    const row: Pixel[] = []
    for (let dx = 0; dx < dw; dx++) {
      const x0n = dx * sw, x1n = (dx + 1) * sw
      let accR = 0, accG = 0, accB = 0, area = 0
      for (let sy = Math.floor(y0n / dh); sy < Math.floor((y1n + dh - 1) / dh); sy++) {
        // Overlap of source row sy with the destination span, in 1/dh units.
        const wy = Math.min(y1n, (sy + 1) * dh) - Math.max(y0n, sy * dh)
        if (wy <= 0) continue
        const srow = src[sy]!
        for (let sx = Math.floor(x0n / dw); sx < Math.floor((x1n + dw - 1) / dw); sx++) {
          const wx = Math.min(x1n, (sx + 1) * dw) - Math.max(x0n, sx * dw)
          if (wx <= 0) continue
          const [r, g, b] = srow[sx]!
          const a = wx * wy
          accR += r * a; accG += g * a; accB += b * a
          area += a
        }
      }
      row.push([Math.floor((accR + Math.floor(area / 2)) / area), Math.floor((accG + Math.floor(area / 2)) / area), Math.floor((accB + Math.floor(area / 2)) / area)])
    }
    rows.push(row)
  }
  return rows
}

const key = (p: Pixel): number => (p[0] << 16) | (p[1] << 8) | p[2]
/** Python's tuple order on (r, g, b). */
const cmpPixel = (a: Pixel, b: Pixel): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Median cut to at most `limit` colours, then map every pixel onto the result. */
function quantise(rows: Pixel[][], limit: number): Pixel[][] {
  const hist = new Map<number, number>()
  const colours = new Map<number, Pixel>()
  for (const row of rows) for (const px of row) { const k = key(px); hist.set(k, (hist.get(k) ?? 0) + 1); colours.set(k, px) }
  if (hist.size <= limit) return rows
  const count = (c: Pixel): number => hist.get(key(c))!
  // Boxes are (colours, total count). Split the one with the widest channel
  // extent, breaking ties on population then on the colour tuple, so the
  // choice never depends on dict or set iteration order.
  const boxes: Pixel[][] = [[...colours.values()].sort(cmpPixel)]
  const extent = (box: Pixel[], ch: number): number => {
    let lo = 255, hi = 0
    for (const c of box) { if (c[ch]! < lo) lo = c[ch]!; if (c[ch]! > hi) hi = c[ch]! }
    return hi - lo
  }
  while (boxes.length < limit) {
    let best = -1
    let bestKey: [number, number, number] | undefined
    boxes.forEach((box, i) => {
      if (box.length < 2) return
      const spread = Math.max(extent(box, 0), extent(box, 1), extent(box, 2))
      const k: [number, number, number] = [spread, box.reduce((n, c) => n + count(c), 0), -i]
      if (bestKey === undefined || k[0] > bestKey[0] || (k[0] === bestKey[0] && (k[1] > bestKey[1] || (k[1] === bestKey[1] && k[2] > bestKey[2])))) { best = i; bestKey = k }
    })
    if (best < 0) break
    let box = boxes[best]!
    // max(range(3), key=lambda k: (extent, -k)): the widest channel, the lowest index on a tie.
    let ch = 0
    for (const k of [1, 2]) if (extent(box, k) > extent(box, ch)) ch = k
    box = [...box].sort((a, b) => a[ch]! - b[ch]! || cmpPixel(a, b))
    // Split at the population median, so both halves carry real pixels.
    const total = box.reduce((n, c) => n + count(c), 0)
    let run = 0, cut = 1
    for (let j = 0; j < box.length; j++) {
      run += count(box[j]!)
      if (run * 2 >= total) { cut = Math.min(Math.max(j, 1), box.length - 1); break }
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut))
  }
  const mapping = new Map<number, Pixel>()
  for (const box of boxes) {
    const n = box.reduce((s, c) => s + count(c), 0)
    const rep: Pixel = [
      Math.floor(box.reduce((s, c) => s + c[0] * count(c), 0) / n),
      Math.floor(box.reduce((s, c) => s + c[1] * count(c), 0) / n),
      Math.floor(box.reduce((s, c) => s + c[2] * count(c), 0) / n),
    ]
    for (const c of box) mapping.set(key(c), rep)
  }
  return rows.map(row => row.map(px => mapping.get(key(px))!))
}

function main(): void {
  const argv = Bun.argv.slice(2)
  if (argv.length !== 4) exit('usage: mklogo.ts <master.png> <out.ppm> <width> <height>')
  const [srcPath, outPath] = argv as [string, string, string, string]
  const dw = parseInt(argv[2]!, 10), dh = parseInt(argv[3]!, 10)
  const [sw, sh, src] = readPng(srcPath)
  const rows = quantise(resample(src, sw, sh, dw, dh), 224)
  const colours = new Set<number>()
  for (const row of rows) for (const px of row) colours.add(key(px))
  if (colours.size > 224) exit(`${outPath}: ${colours.size} colours, and pnmtologo.c refuses more than 224`)
  const body = rows.map(row => row.map(([r, g, b]) => `${r} ${g} ${b}`).join(' '))
  const master = srcPath.slice(srcPath.lastIndexOf('/') + 1)
  writeFileSync(outPath, `P3\n# Generated from ${master} by mklogo.ts -- do not edit.\n${dw} ${dh}\n255\n${body.join('\n')}\n`)
  console.log(`logo: ${sw}x${sh} -> ${dw}x${dh}, ${colours.size} colours, ${outPath}`)
}

main()
