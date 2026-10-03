// The current factory image's DATA growth policy, under real systemd-repart.
//
//   bun tests/gates/repart-loader.ts <board> <factory image> <root image>   (make os-repart-test, product-repart-test)
//
// The image is copied, grown to 8 GiB and handed to tests/suites/repart/inner.sh in the privileged lab image with
// the root it was composed from. The data partition must be the last one, since growth extends it; its identities
// come out of the fetched board's layout.tsv. It needs privileged docker, so it is a command and not a *.test.ts,
// and it fails loudly when it cannot run rather than skipping.
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, truncateSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadLayout, partitionOf, type FileLayout } from '../../src/image/file-layout.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

export function patternProtectedRanges(image: string, layout: FileLayout): void {
  // Seed nonzero gap evidence only where the layout forbids discard. Other layouts
  // retain the factory image's gap bytes and their existing growth policy.
  if (layout.discard !== 'no') return
  // Pattern every vendor partition and gap before DATA, leaving the image's Mica payload intact.
  const disk = openSync(image, 'r+')
  try {
    const pattern = Buffer.alloc(1048576, 0xa5)
    const fill = (start: number, size: number) => {
      for (let done = 0; done < size;) {
        const n = writeSync(disk, pattern, 0, Math.min(pattern.length, size - done), start + done)
        if (n <= 0) throw new Error('short pattern write')
        done += n
      }
    }
    let end = 34
    for (const p of layout.partitions) {
      if (p.startSector > end) fill(end * 512, (p.startSector - end) * 512)
      if (p.role === 'preserved') fill(p.startSector * 512, p.sizeSectors * 512)
      end = p.startSector + p.sizeSectors
    }
  }
  finally { closeSync(disk) }
}

function main(argv: string[]): number {
  const [board, imageArg, rootArg, storageLayout = '', helperArg] = argv
  if (board === undefined || imageArg === undefined || rootArg === undefined || argv.length < 3 || argv.length > 5) {
    console.error('usage: bun tests/gates/repart-loader.ts <board> <complete factory image> <matching composed root image> [<storage layout>] [<growth helper override>]')
    return 2
  }
  const boardDir = join(REPO_ROOT, '_out/boards', board)
  if (!existsSync(join(boardDir, 'board.env'))) { console.error(`error: ${board} is not a fetched board (make board-fetch BOARD=${board})`); return 1 }
  for (const f of [imageArg, rootArg]) if (!existsSync(f)) { console.error(`error: ${f} does not exist`); return 1 }
  const image = realpathSync(imageArg), rootImage = realpathSync(rootArg)
  const layout = loadLayout(boardDir, storageLayout)
  const data = partitionOf(layout, 'data'), system = partitionOf(layout, 'system')

  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/data-growth.'))
  console.log(`Evidence: ${work}`)
  const run = (argv: string[], opts: { stdout?: number, timeout: number }) =>
    Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: opts.stdout ?? 'inherit', stderr: opts.stdout ?? 'inherit', timeout: opts.timeout * 1000, killSignal: 'SIGKILL' }).exitCode
  if (run(['cp', '--reflink=auto', '--sparse=always', image, join(work, 'disk.img')], { timeout: 600 }) !== 0) return 1
  patternProtectedRanges(join(work, 'disk.img'), layout)
  truncateSync(join(work, 'disk.img'), 8 * 1024 ** 3)
  const log = openSync(join(work, 'tools.log'), 'w')
  try {
    if (run(['bash', 'tests/suites/signed-boot-lab/images.sh', '--lifecycle'], { stdout: log, timeout: 600 }) !== 0) {
      console.error(`error: the lab images did not build; see ${join(work, 'tools.log')}`)
      return 1
    }
  }
  finally { closeSync(log) }
  return run([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'traefik', '--privileged',
    '-v', `${hostPath(work)}:/w`, '-v', `${hostPath(rootImage)}:/rootfs.img:ro`, '-v', `${hostPath(join(REPO_ROOT, 'tests/suites/repart'))}:/harness:ro`,
    ...(helperArg ? ['-v', `${hostPath(realpathSync(helperArg))}:/growth-helper:ro`] : []),
    '-e', `PARTITION_NUMBERS=${layout.partitions.map(p => p.number).join(' ')}`, '-e', `SYSTEM_NUMBER=${system.number}`, '-e', `DATA_NUMBER=${data.number}`,
    '-e', `DISCARD_ARG=${layout.discard ? `--discard=${layout.discard}` : ''}`,
    '-e', `SYSTEM_UUID=${system.guid.toLowerCase()}`, '-e', `DISK_UUID=${layout.diskGuid.toLowerCase()}`,
    'ai-agent/mica-p2-lab', 'bash', '/harness/inner.sh'], { timeout: 240 }) === 0
    ? 0
    : 1
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
