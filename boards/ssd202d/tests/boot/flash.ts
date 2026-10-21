// Assemble the boot test's flash image: bun flash.ts <flash.tsv> <u-boot.bin> <boot.itb> <work> <output> [tries]
// One deployment, its kernel the FIT; on trial when [tries] is given.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assembleFlash } from '../../../../src/image/flash-image.ts'
import { parseFlashLayout } from '../../../../src/image/flash-layout.ts'
import { Toolbox } from '../../../../src/image/toolbox.ts'
import { MTD_UTILS } from '../../../../src/image/toolsets.ts'

const [table, loader, fit, work, output, tries] = Bun.argv.slice(2).map((a, i) => (i < 5 ? resolve(a) : a)) as string[]
const layout = parseFlashLayout(readFileSync(table!, 'utf8'), 'ssd202d', table)
const kernelId = createHash('sha256').update(readFileSync(fit!)).digest('hex')
const id = createHash('sha256').update(`deployment ${kernelId}`).digest('hex')
mkdirSync(join(work!, 'system', 'deployments'), { recursive: true })
await Bun.write(join(work!, 'system', 'deployments', `${id}.json`), '{}\n')
const tb = await Toolbox.open(MTD_UTILS, { mounts: [work!, dirname(loader!), dirname(fit!), dirname(output!)], cwd: work })
try {
  await assembleFlash(tb, layout, dirname(table!), { loader: loader!, system: join(work!, 'system'),
    records: [{ id, kernelId, generation: 1, tries: tries === undefined ? null : Number(tries) }],
    objects: [{ volume: `k-${kernelId}`, file: fit! }] }, work!, output!)
}
finally { await tb.close() }
console.log(`deployment ${id} kernel ${kernelId}`)
