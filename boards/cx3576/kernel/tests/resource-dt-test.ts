// Assert accelerator contracts in a compiled CX3576 DTB using fdtget.
//
//   bun boards/cx3576/kernel/tests/resource-dt-test.ts <dtb>
//
// The overlap inventory is an unresolved finding, not an ownership or bench pass. The port of
// resource-dt-test.py (deleted 2026-09-22), assertion for assertion.
const dtb = Bun.argv[2]!

function assert(condition: unknown, message = 'AssertionError'): asserts condition {
  if (!condition) throw new Error(message)
}

function fdtget(args: string[]): string[] {
  const r = Bun.spawnSync(['fdtget', ...args], { stdout: 'pipe', stderr: 'inherit', timeout: 5000 })
  if (r.exitCode !== 0) throw new Error(`Command '${JSON.stringify(['fdtget', ...args])}' returned non-zero exit status ${r.exitCode}.`)
  return r.stdout.toString().split(/\s+/).filter(s => s !== '')
}

const get = (node: string, prop: string, kind = 's'): string[] => fdtget(['-t', kind, dtb, node, prop])
const properties = (node: string): string[] => fdtget(['-p', dtb, node])
const cells = (node: string, prop: string): number[] => get(node, prop, 'x').map(v => parseInt(v, 16))
const same = (a: unknown[], b: unknown[]): boolean => JSON.stringify(a) === JSON.stringify(b)

for (const node of ['/rkvenc-core@27a00000', '/rkvenc-core@27a10000']) {
  assert(same(get(node, 'status'), ['okay']), node)
  assert(same(get(node, 'compatible'), ['rockchip,rkv-encoder-rk3576-core']), node)
  assert(!properties(node).includes('operating-points-v2'), node)
  assert(same(get(node, 'clock-names'), ['aclk_vcodec', 'hclk_vcodec', 'clk_core']), node)
  assert(cells(node, 'clocks').length === 6, node)
  assert(same(cells(node, 'rockchip,normal-rates'), [400000000, 0, 702000000]), node)
  assert(same(cells(node, 'assigned-clock-rates'), [400000000, 702000000]), node)
  assert(same(get(node, 'reset-names'), ['video_a', 'video_h', 'video_core']), node)
  assert(cells(node, 'resets').length === 6, node)
}
console.log('PASS: both encoders retain fixed rates, clocks and recovery resets')

{
  const node = '/rkvdec@27b00000'
  assert(same(get(node, 'status'), ['okay']))
  assert(get(node, 'compatible').includes('rockchip,rkv-decoder-rk3576'))
  const props = properties(node)
  assert(!['operating-points-v2', 'vdec-supply'].some(p => props.includes(p)))
  assert(same(get(node, 'clock-names'), ['aclk_vcodec', 'hclk_vcodec', 'clk_core', 'clk_cabac', 'clk_hevc_cabac']))
  assert(cells(node, 'clocks').length === 10)
  assert(same(cells(node, 'rockchip,normal-rates'), [600000000, 0, 600000000, 500000000, 1000000000]))
  assert(same(get(node, 'reset-names'), ['video_a', 'video_h', 'video_core', 'video_hevc_cabac']))
  assert(cells(node, 'resets').length === 8)
  console.log('PASS: decoder retains five clocks and four declared resets without DVFS supply')
}

const npu = '/npu@27700000'
const mmu = '/iommu@27702000'
assert(same(get(npu, 'status'), ['okay']) && same(get(mmu, 'status'), ['okay']))
assert(same(cells(npu, 'iommus'), cells(mmu, 'phandle')))
{
  const props = properties(npu)
  assert(['operating-points-v2', 'rknpu-supply'].every(p => props.includes(p)))
}
assert(same(cells(npu, 'reg'), [0, 0x27700000, 0, 0x8000, 0, 0x27708000, 0, 0x8000]))
assert(same(cells(mmu, 'reg'), [0, 0x27702000, 0, 0x100, 0, 0x27702100, 0, 0x100, 0, 0x2770a000, 0, 0x100, 0, 0x2770a100, 0, 0x100]))
console.log('OPEN: NPU windows contain four IOMMU ranges; exclusive ownership is unproven')
console.log('PASS: DT contract assertions only; no accelerator workload or physical acceptance')
