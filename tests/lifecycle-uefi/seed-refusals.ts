// Exercise production DATA seeding refusals against a complete factory image.
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FILE_IMAGE_TOOLS } from '../../build/src/file-image.ts'
import { parseFileLayout } from '../../build/src/file-layout.ts'
import { seedDataImage } from '../../build/src/seed-data.ts'
import { Toolbox } from '../../build/src/toolbox.ts'

const [board, input] = Bun.argv.slice(2)
if (!board || !input) throw new Error('Usage: seed-refusals.ts BOARD FACTORY_IMAGE')
const layout = parseFileLayout(readFileSync(resolve(`_out/boards/${board}/board.env`), 'utf8'))
const work = mkdtempSync(resolve('_out/seed-refusals.')), image = join(work, 'disk.img')
const data = join(work, 'data.img'), source = join(work, 'source')
writeFileSync(source, 'seed acceptance\n')
const tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [work, dirname(resolve(input))] })
try {
  await tb.must(['cp', '--sparse=always', resolve(input), image])
  const partition = layout.partitions[2]!
  await tb.must(['dd', `if=${image}`, `of=${data}`, 'bs=512', `skip=${partition.startSector}`, `count=${partition.sizeSectors}`, 'status=none'])
  for (const command of [
    'symlink /state/link-parent /state/systemd-units',
    `write ${source} /state/not-dir`,
    'symlink /state/link-file /state/not-dir',
  ]) await tb.must(['debugfs', '-w', '-R', command, data])
  const repaired = await tb.run(['e2fsck', '-fy', data])
  if (![0, 1].includes(repaired.exitCode)) throw new Error('Fixture filesystem repair failed')
  await tb.must(['e2fsck', '-fn', data])
  await tb.must(['dd', `if=${data}`, `of=${image}`, 'bs=512', `seek=${partition.startSector}`, 'conv=notrunc,fsync', 'status=none'])
} finally { await tb.close() }
async function digest() {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(image)) hash.update(chunk)
  return hash.digest('hex')
}
const before = await digest()
for (const [target, reason] of [
  ['/state/link-parent/file', 'non-directory parents'],
  ['/state/not-dir/file', 'non-directory parents'],
  ['/state/link-file', 'non-regular targets'],
] as const) {
  let refused = false
  try { await seedDataImage(board, image, [{ source, target }]) }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes(reason)) throw error
    refused = true
  }
  if (!refused || await digest() !== before) throw new Error(`Refusal modified the image: ${target}`)
  console.log(`FILE_AB_SEED_REFUSAL_PASS: ${target}`)
}
writeFileSync(join(work, 'result.json'), JSON.stringify({ board, imageSha256: before, cases: 3, unchanged: true }))
console.log(`Evidence: ${work}`)
