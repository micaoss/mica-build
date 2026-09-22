/** Boot a complete current UEFI image with an explicitly enrolled test key. */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { seedArguments, seedDataImage } from '../../../../src/image/seed-data.ts'
import { loadBoardFacts } from '../../../../src/image/board-facts.ts'

interface QemuArch {
  readonly binary: string
  readonly machine: string
  readonly packages: string
  readonly firmwareCode: string
  readonly firmwareVars: string
}

export const QEMU_ARCHES: Readonly<Record<string, QemuArch>> = {
  amd64: {
    binary: 'qemu-system-x86_64', machine: 'q35', packages: 'qemu-system-x86 ovmf',
    firmwareCode: '/usr/share/OVMF/OVMF_CODE_4M.secboot.fd', firmwareVars: '/usr/share/OVMF/OVMF_VARS_4M.fd',
  },
  arm64: {
    binary: 'qemu-system-aarch64', machine: 'virt', packages: 'qemu-system-arm qemu-efi-aarch64 ipxe-qemu',
    firmwareCode: '/usr/share/AAVMF/AAVMF_CODE.secboot.fd', firmwareVars: '/usr/share/AAVMF/AAVMF_VARS.fd',
  },
}

export function qemuArchFor(arch: string | undefined, board: string): QemuArch {
  const spec = arch === undefined ? undefined : QEMU_ARCHES[arch]
  if (!spec) throw new Error(`No QEMU architecture for board '${board}': ${arch ?? '<unset>'}`)
  return spec
}

export function requireSignedInputs(image: string | undefined, certificate: string | undefined, append: string | undefined): void {
  if (!image || !certificate) throw new Error('MICA_QEMU_IMAGE and MICA_QEMU_BOOT_CERT are required')
  if (append !== undefined) throw new Error('Kernel command-line overrides are forbidden; seed DATA test units instead')
}

const REPO_ROOT = path.resolve(import.meta.dir, '../../..')
const MIB = 1048576
function integer(value: string | undefined, fallback: number): number {
  const result = Number(value ?? fallback)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid positive integer: ${value}`)
  return result
}

function innerRunSh(arch: QemuArch): string {
  return `set -euo pipefail
cd /w
if [ ! -f vars.fd ]; then
  virt-fw-vars --input ${arch.firmwareVars} --output vars.fd \\
    --set-pk 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \\
    --add-kek 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \\
    --add-db 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem --no-microsoft --sb
fi
( sleep "$RUN_SECONDS"
  printf 'system_powerdown\\n' | socat - UNIX-CONNECT:/run/mon.sock
  sleep 90
  printf 'quit\\n' | socat - UNIX-CONNECT:/run/mon.sock ) &
exec ${arch.binary} -machine ${arch.machine} -cpu max -m "$MEM" -smp 2 \\
  -monitor unix:/run/mon.sock,server,nowait -nographic -no-reboot \\
  -device i6300esb -watchdog-action reset \\
  -drive if=pflash,format=raw,unit=0,readonly=on,file=${arch.firmwareCode} \\
  -drive if=pflash,format=raw,unit=1,file=/w/vars.fd \\
  -drive if=none,id=disk0,format=raw,file=/w/disk.img \\
  -device virtio-blk-pci,drive=disk0,bootindex=0 \\
  -netdev user,id=net0$HOSTFWD -device virtio-net-pci,netdev=net0
`
}

async function main(): Promise<void> {
  const env = process.env
  requireSignedInputs(env.MICA_QEMU_IMAGE, env.MICA_QEMU_BOOT_CERT, env.MICA_QEMU_APPEND)
  const board = env.MICA_BOARD
  const product = env.MICA_PRODUCT
  if (!board || !product) throw new Error('MICA_PRODUCT and MICA_BOARD are required; run.sh sets both from the product')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(product)) throw new Error(`'${product}' is not a product name`)
  // The board is its fetched bundle (_out/boards/<board>/board.env); the
  // emulator, machine and firmware follow its facts, never its name.
  const facts = loadBoardFacts(board)
  if (facts.backend !== 'systemd-boot') throw new Error(`${board} boots a FIT; QEMU acceptance boots UEFI boards`)
  const arch = qemuArchFor(facts.arch, board)
  const image = path.resolve(env.MICA_QEMU_IMAGE!)
  const certificate = path.resolve(env.MICA_QEMU_BOOT_CERT!)
  if (!fs.lstatSync(image).isFile() || !fs.lstatSync(certificate).isFile()) throw new Error('Boot inputs must be regular files')
  // Under the product, beside its composition: two products of one board
  // never share a disk.
  const runDir = path.join(REPO_ROOT, '_out', 'products', product, 'qemu')
  const disk = path.join(runDir, 'disk.img')
  const [mode, ...args] = process.argv.slice(2)
  if (mode === '--seed') {
    const { files, enabled } = seedArguments(args)
    await seedDataImage(board, disk, files, enabled)
    return
  }
  if (!(mode === '--prepare-only' && args.length === 0) && !(mode === '--capture' && args.length === 1))
    throw new Error('Usage: qemu.ts --prepare-only | --capture FILE | --seed SOURCE /state/TARGET ...')

  if (env.MICA_QEMU_REUSE_DISK === '1') {
    if (!fs.existsSync(disk)) throw new Error('The prepared disk does not exist')
  }
  else {
    const diskMib = integer(env.MICA_QEMU_DISK_MIB, 4096)
    if (diskMib * MIB <= fs.statSync(image).size) throw new Error('Virtual medium must be larger than the factory image')
    fs.rmSync(runDir, { recursive: true, force: true })
    fs.mkdirSync(runDir, { recursive: true })
    const copied = spawnSync('cp', ['--reflink=auto', '--sparse=always', image, disk])
    if (copied.status !== 0) throw new Error('Cannot copy the factory image')
    fs.truncateSync(disk, diskMib * MIB)
    fs.copyFileSync(certificate, path.join(runDir, 'db.cert.pem'))
  }
  if (mode === '--prepare-only') {
    console.log(`Prepared ${disk}; seed DATA, then use MICA_QEMU_REUSE_DISK=1`)
    return
  }
  fs.writeFileSync(path.join(runDir, 'run.sh'), innerRunSh(arch))
  // THE SUFFIX THAT LOOKS UNIQUE AND CANNOT VARY. This was `process.pid`, and
  // it was the constant 1 -- so every run of every suite asked docker for
  // `ai-agent-mica-api-<board>-1`.
  //
  // WHAT MAKES THAT TRUE, RATHER THAN THE ASSERTION THAT IT IS: verify/
  // Dockerfile declares no ENTRYPOINT and no CMD, and the callers
  // (tests/suites/apid-api/run.sh, tests/session-probe/run.sh) pass the command
  // directly with no `--init`, so `bun run src/qemu.ts` IS pid 1. Both are
  // checkable; "this runs as PID 1" is not, and the repair below is correct
  // whether or not it stays true -- WHICH IS EXACTLY WHY THE CLAIM WOULD ROT
  // UNNOTICED. Put an init or a wrapper in front and nothing fails, the
  // sentence quietly stops being a fact, and the only reader who needs it is
  // the one proposing to go back to a pid because it is easier to debug. Two concurrent runs
  // (a session probe and a falsification, on 2026-09-20) collided: one guest
  // was killed, both reported `QEMU container exited 137` and both suites
  // printed "the probe never finished", WHICH READS AS A BROKEN HARNESS OR AN
  // IMAGE THAT DOES NOT BOOT. Nothing in either output could distinguish that
  // from the real thing; only knowing that two guests had been started could.
  //
  // randomUUID and not a counter or a clock: the collision to avoid is between
  // PROCESSES THAT CANNOT SEE EACH OTHER, in containers with their own pid
  // namespaces and their own idea of the time.
  const name = `ai-agent-mica-api-${board}-${randomUUID().slice(0, 8)}`
  const dockerArgs = ['run', '--rm', '--label', 'ai-agent=true', '--name', name,
    '--network', env.MICA_QEMU_NETWORK ?? 'traefik', '-v', `${runDir}:/w`,
    '-e', `MEM=${integer(env.MICA_QEMU_MEM, 2048)}`, '-e', `RUN_SECONDS=${integer(env.MICA_QEMU_RUN_SECONDS, 2400)}`]
  let hostfwd = ''
  if (env.MICA_QEMU_FORWARD === '1') {
    for (const [raw, fallback, guest] of [[env.MICA_QEMU_HTTPS_PORT, 18443, 443], [env.MICA_QEMU_HTTP_PORT, 18080, 80],
      ...(env.MICA_QEMU_SSH_PORT ? [[env.MICA_QEMU_SSH_PORT, 18022, 22] as const] : [])] as const) {
      const port = integer(raw, fallback)
      if (port > 65535) throw new Error('Invalid forwarding port')
      hostfwd += `,hostfwd=tcp::${port}-:${guest}`
      dockerArgs.push('-p', `127.0.0.1:${port}:${port}`)
    }
  }
  dockerArgs.push('-e', `HOSTFWD=${hostfwd}`, 'ai-agent/mica-p2-lab', 'bash', '/w/run.sh')
  const capture = fs.openSync(args[0]!, 'w')
  const stop = () => spawnSync('docker', ['stop', '--time', '10', name], { stdio: 'ignore', timeout: 15000 })
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', capture, capture] })
    const backstop = setTimeout(stop, integer(env.MICA_QEMU_TIMEOUT, 2700) * 1000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (code !== 0) throw new Error(`QEMU container exited ${code}; see ${args[0]}`)
    }
    finally { clearTimeout(backstop) }
  }
  finally {
    stop()
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    fs.closeSync(capture)
  }
}

if (import.meta.main) await main()
