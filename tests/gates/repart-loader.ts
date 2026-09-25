// The current factory image's DATA growth policy, under real systemd-repart.
//
//   bun tests/gates/repart-loader.ts <board> <factory image> <root image>   (make os-repart-test, product-repart-test)
//
// The image is copied, grown to 8 GiB and handed to tests/suites/repart/inner.sh in the privileged lab image with
// the root it was composed from. The data partition must be the last one, since growth extends it; its identities
// come out of the fetched board's layout.tsv. It needs privileged docker, so it is a command and not a *.test.ts,
// and it fails loudly when it cannot run rather than skipping. The port of tests/gates/repart-loader-test.sh
// (deleted 2026-09-25).
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, truncateSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadLayout, partitionOf } from '../../src/image/file-layout.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

function main(argv: string[]): number {
  const [board, imageArg, rootArg] = argv
  if (board === undefined || imageArg === undefined || rootArg === undefined || argv.length !== 3) {
    console.error('usage: bun tests/gates/repart-loader.ts <board> <complete factory image> <matching composed root image>')
    return 2
  }
  const boardDir = join(REPO_ROOT, '_out/boards', board)
  if (!existsSync(join(boardDir, 'board.env'))) { console.error(`error: ${board} is not a fetched board (make board-fetch BOARD=${board})`); return 1 }
  for (const f of [imageArg, rootArg]) if (!existsSync(f)) { console.error(`error: ${f} does not exist`); return 1 }
  const image = realpathSync(imageArg), rootImage = realpathSync(rootArg)
  const layout = loadLayout(boardDir)
  const data = partitionOf(layout, 'data'), system = partitionOf(layout, 'system')
  if (data.number !== layout.partitions.length) { console.error(`error: ${board}'s data partition is not the last, so growth cannot extend it`); return 1 }

  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/data-growth.'))
  console.log(`Evidence: ${work}`)
  const run = (argv: string[], opts: { stdout?: number, timeout: number }) =>
    Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: opts.stdout ?? 'inherit', stderr: opts.stdout ?? 'inherit', timeout: opts.timeout * 1000, killSignal: 'SIGKILL' }).exitCode
  if (run(['cp', '--reflink=auto', '--sparse=always', image, join(work, 'disk.img')], { timeout: 600 }) !== 0) return 1
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
    '-e', `SYSTEM_UUID=${system.guid.toLowerCase()}`, '-e', `DISK_UUID=${layout.diskGuid.toLowerCase()}`,
    'ai-agent/mica-p2-lab', 'bash', '/harness/inner.sh'], { timeout: 240 }) === 0
    ? 0
    : 1
}

process.exit(main(Bun.argv.slice(2)))
