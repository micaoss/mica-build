import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FILE_IMAGE_TOOLS } from './file-image.ts'
import { parseFileLayout } from './file-layout.ts'
import { Toolbox } from './toolbox.ts'
import { readPartition } from './tools/sgdisk.ts'

/** Test configuration is seeded only into the current DATA/state namespace. */
export function seedPath(value: string): string {
  const parts = value.split('/').slice(1)
  if (!value.startsWith('/state/') || value.length > 1024 || parts.some(part =>
    !/^[A-Za-z0-9_.@-]{1,255}$/.test(part) || part === '.' || part === '..')) {
    throw new Error(`Invalid DATA seed path: ${JSON.stringify(value)}`)
  }
  return value
}

/** The caller owns an offline disposable image; publish DATA only after validation. */
export function seedArguments(args: string[]): { files: { source: string, target: string }[], enabled: string[] } {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error('Expected SOURCE /state/TARGET or --enable UNIT pairs')
  const files: { source: string, target: string }[] = []
  const enabled: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--enable') enabled.push(args[index + 1]!)
    else files.push({ source: args[index]!, target: args[index + 1]! })
  }
  return { files, enabled }
}

export async function seedDataImage(board: string, image: string, files: { source: string, target: string }[], enabled: string[] = []): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(board) || files.length === 0 || files.length > 64) throw new Error('Invalid DATA seed inputs')
  image = resolve(image)
  if (!lstatSync(image).isFile()) throw new Error('DATA seed requires a regular offline disk image')
  for (const file of files) {
    seedPath(file.target)
    const stat = lstatSync(file.source)
    if (!stat.isFile() || stat.size > 1048576) throw new Error('Seed files must be regular and at most 1 MiB')
  }
  if (new Set(files.map(file => file.target)).size !== files.length) throw new Error('Duplicate DATA seed target')
  if (enabled.length > 32 || enabled.some(unit => !/^[A-Za-z0-9_-]+\.service$/.test(unit)
    || !files.some(file => file.target === `/state/systemd-units/${unit}`))) throw new Error('Enable requires a seeded service unit')
  const layout = parseFileLayout(readFileSync(resolve(import.meta.dir, '../../_out/boards', board, 'board.env'), 'utf8'))
  const work = mkdtempSync(join(dirname(image), 'seed-data.'))
  const data = join(work, 'data.img')
  const tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [dirname(image)] })
  try {
    for (const partition of layout.partitions) {
      const found = await readPartition(tb, image, BigInt(partition.number))
      if (found.firstSector !== BigInt(partition.startSector) || found.sizeSectors !== BigInt(partition.sizeSectors)
        || found.guid.toLowerCase() !== partition.guid || found.typecode.toLowerCase() !== partition.type) {
        throw new Error('DATA seed requires the current factory partition geometry')
      }
    }
    const partition = layout.partitions[2]!
    await tb.must(['dd', `if=${image}`, `of=${data}`, 'bs=512', `skip=${partition.startSector}`, `count=${partition.sizeSectors}`, 'status=none'])
    await tb.must(['e2fsck', '-fn', data])
    const statPath = async (path: string) => {
      const result = await tb.run(['debugfs', '-R', `stat ${path}`, data])
      if (result.exitCode !== 0) throw new Error(`Cannot inspect DATA: ${result.stderr}`)
      if (result.stderr.includes('File not found')) return undefined
      const type = /Type:\s+(\w+)/.exec(result.stdout)?.[1]
      if (!type) throw new Error(`Cannot inspect DATA: ${result.stderr}`)
      return type
    }
    for (const [index, file] of files.entries()) {
      const parents = file.target.split('/').slice(1, -1)
      let parent = ''
      for (const part of parents) {
        parent += `/${part}`
        const type = await statPath(parent)
        if (type === undefined) {
          await tb.must(['debugfs', '-w', '-R', `mkdir ${parent}`, data])
          if (await statPath(parent) !== 'directory') throw new Error('DATA seed directory creation failed')
        } else if (type !== 'directory') throw new Error('DATA seed refuses non-directory parents')
      }
      const existing = await statPath(file.target)
      if (existing !== undefined) {
        if (existing !== 'regular') throw new Error('DATA seed refuses non-regular targets')
        await tb.must(['debugfs', '-w', '-R', `rm ${file.target}`, data])
      }
      const source = join(work, `input-${index}`)
      copyFileSync(file.source, source)
      await tb.must(['debugfs', '-w', '-R', `write ${source} ${file.target}`, data])
      if (await statPath(file.target) !== 'regular') throw new Error('DATA seed write failed')
      const readback = join(work, `readback-${index}`)
      await tb.must(['debugfs', '-R', `dump ${file.target} ${readback}`, data])
      if (!readFileSync(source).equals(readFileSync(readback))) throw new Error('DATA seed readback differs')
    }
    if (enabled.length) {
      const wants = '/state/systemd-units/multi-user.target.wants'
      const type = await statPath(wants)
      if (type === undefined) await tb.must(['debugfs', '-w', '-R', `mkdir ${wants}`, data])
      if (await statPath(wants) !== 'directory') throw new Error('DATA seed refuses non-directory wants path')
      for (const unit of enabled) {
        if (await statPath(`${wants}/${unit}`) !== undefined) throw new Error('Enable target already exists')
        await tb.must(['debugfs', '-w', '-R', `symlink ${wants}/${unit} ../${unit}`, data])
        const result = await tb.must(['debugfs', '-R', `stat ${wants}/${unit}`, data])
        if (!result.stdout.includes(`Fast link dest: "../${unit}"`)) throw new Error('Enabled unit symlink readback failed')
      }
    }
    // debugfs does not maintain ext4 quota accounting while importing files.
    const repair = await tb.run(['e2fsck', '-fy', data])
    if (repair.exitCode !== 0 && repair.exitCode !== 1) throw new Error(`Seeded DATA fsck failed: ${repair.stdout}\n${repair.stderr}`)
    await tb.must(['e2fsck', '-fn', data])
    await tb.must(['dd', `if=${data}`, `of=${image}`, 'bs=512', `seek=${partition.startSector}`, 'conv=notrunc,fsync', 'status=none'])
  } finally {
    await tb.close()
    rmSync(work, { recursive: true, force: true })
  }
}
