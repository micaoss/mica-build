import { spawnSync } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { artifactFile, packSupport, type ContentSigning } from './component-build.ts'
import { canonicalJson, componentId, type BootIdentity, type KernelComponent } from './components.ts'
import type { Toolbox } from './toolbox.ts'
import { REPO_ROOT } from './paths.ts'
import { parseBoardEnv } from './verify-package.ts'
import { firmwareTarget, parseFirmware, type Firmware } from './firmware.ts'
import { Signer } from '../../shared/update-envelope.ts'
import { validateFitKernel } from './fit-board.ts'
import { loadBoardFacts, type Profile } from './board-facts.ts'

export type { Profile }

const BOOT_TOOLS = { X64: 'ai-agent/mica-boot-tools-amd64', AA64: 'ai-agent/mica-boot-tools-arm64' }
const FIT_TOOLS = 'ai-agent/mica-fit-tools-amd64'

// Every packaging tools image is linux/amd64 (boot/build-tools.sh; the target selects only the EFI ABI it
// packs), so on an arm64 host it runs under emulation: the platform is named and the budget covers it.
const TOOLS_PLATFORM = 'linux/amd64'
const DOCKER_TIMEOUT_MS = 1800000

function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS })
  if (result.error || result.signal) throw new Error(`Boot packaging failed: docker ${args[0]} ${result.signal ? `was killed by ${result.signal} after the ${DOCKER_TIMEOUT_MS} ms budget` : result.error!.message}`)
  if (result.status !== 0) throw new Error(`Boot packaging failed: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * The packager a kernel component names: the pinned inputs of its tools image (the label mica.boot.inputs,
 * boot/build-tools.sh and tools/product-build.sh), never the local image id, which a rebuild of the same
 * inputs moves.
 */
function packagerInputs(image: string) {
  const inputs = docker(['image', 'inspect', '--format', '{{index .Config.Labels "mica.boot.inputs"}}', image])
  if (!/^[0-9a-f]{64}$/.test(inputs)) throw new Error(`Packaging tools image ${image} carries no mica.boot.inputs label; rebuild it with boot/build-tools.sh`)
  return inputs
}

/** `docker run` of a packaging tools image, on the platform that image is built for. */
function runTools(image: string, mounts: string[], command: string[]) {
  return docker(['run', '--rm', '--label', 'ai-agent=true', '--network', 'traefik', '--platform', TOOLS_PLATFORM, ...mounts, image, ...command])
}

function packageBoot(mode: 'kernel' | 'firmware' | 'fit', input: string, output: string, signing: ContentSigning, efiArch: 'X64' | 'AA64') {
  runTools(mode === 'fit' ? FIT_TOOLS : BOOT_TOOLS[efiArch],
    ['-v', `${resolve(input)}:/input:ro`, '-v', `${resolve(output)}:/output`,
      '-v', `${resolve(signing.key)}:/signing/key.pem:ro`, '-v', `${resolve(signing.certificate)}:/signing/cert.pem:ro`],
    ['bash', ...(mode === 'fit' ? ['/tools/fit.sh'] : ['/tools/kernel.sh', mode, efiArch.toLowerCase()])])
}

/** Static PIE may have relocations, but never a loader or a needed library. */
function staticLifecycle(bytes: Buffer) {
  const refuse = () => { throw new Error('Invalid static lifecycle ELF') }
  const bounded = (value: bigint) => { if (value > BigInt(bytes.length)) refuse(); return Number(value) }
  const start = bounded(bytes.readBigUInt64LE(32)), count = bytes.readUInt16LE(56)
  if (count < 1 || count > 128 || bytes.readUInt16LE(54) !== 56 || start < 64 || start + count * 56 > bytes.length) refuse()
  let loads = 0, dynamic = false
  for (let n = 0; n < count; n++) {
    const at = start + n * 56, kind = bytes.readUInt32LE(at)
    const offset = bounded(bytes.readBigUInt64LE(at + 8)), size = bounded(bytes.readBigUInt64LE(at + 32))
    if (offset + size > bytes.length || kind === 3) refuse()
    if (kind === 1) loads++
    if (kind === 2) {
      if (dynamic || size < 16 || size > 65536 || size % 16 !== 0) refuse()
      dynamic = true
      let terminated = false
      for (let entry = offset; entry < offset + size; entry += 16) {
        const tag = bytes.readBigUInt64LE(entry)
        if (tag === 0n) { terminated = true; break }
        if (tag === 1n || tag === 15n || tag === 29n) refuse()
      }
      if (!terminated) refuse()
    }
  }
  if (loads === 0) refuse()
}

/**
 * The required native executable is part of the authenticated kernel identity:
 * mica-runkit, which the initramfs reaches as /init and as exitrd/shutdown.
 */
export function kernelExecutables(runkit: string, arch: 'amd64' | 'arm64') {
  const inspect = (path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('Missing required native lifecycle input')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size < 64 || stat.size > 32 * 1024 * 1024 || (stat.mode & 0o7022) !== 0 || (stat.mode & 0o500) !== 0o500) throw new Error('Invalid native lifecycle file or permissions')
    const bytes = readFileSync(path)
    if (!bytes.subarray(0, 7).equals(Buffer.from([0x7f, 69, 76, 70, 2, 1, 1])) || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64) throw new Error('Invalid native lifecycle ELF')
    if (bytes.readUInt16LE(18) !== (arch === 'amd64' ? 62 : 183)) throw new Error('Native lifecycle architecture mismatch')
    staticLifecycle(bytes)
    return artifactFile(path)
  }
  return { runkit: inspect(runkit) }
}

/**
 * The signed kernel command line of a product: the board's arguments and exactly
 * one `mica.profile=<profile>` token, written for prod too so its presence can be
 * asserted. The board's arguments may carry neither a profile nor a recovery
 * intent: the kernel component is the only writer of both, and a second token
 * would make the reader's answer depend on which one it met.
 */
export function profileCommandLine(board: string, profile: Profile): string {
  if (profile !== 'dev' && profile !== 'prod') throw new Error(`Invalid image profile: ${String(profile)}`)
  const tokens = board.split(/\s+/).filter(Boolean)
  if (tokens.some(token => token.startsWith('mica.profile') || token.startsWith('mica.recovery'))) throw new Error('Board command line names mica.profile or mica.recovery')
  return [...tokens, `mica.profile=${profile}`].join(' ')
}

export interface KernelInputs {
  /** A pinned, fetched board: its facts (board.env) decide the packaging. */
  board: string
  /** The product's image profile, carried on the signed command line. */
  profile: Profile
  kernelDirectory: string
  runkit: string
  publicKeys: string[]
  systemPartUuid: string
  dataPartUuid: string
  output: string
  contentSigning: ContentSigning
  bootSigning: ContentSigning
}

/** The kernel producer never opens a user-space rootfs. */
export async function packKernel(inputs: KernelInputs, tb: Toolbox): Promise<KernelComponent> {
  const { board, profile, kernelDirectory, runkit, publicKeys, systemPartUuid, dataPartUuid, output, contentSigning, bootSigning } = inputs
  const facts = loadBoardFacts(board)
  const { arch, efiArch, kernelImage: kernelName, fit } = facts
  const cmdline = profileCommandLine(facts.cmdline, profile)
  const executables = kernelExecutables(runkit, arch)
  const bootFile = fit ? 'boot.itb' : 'boot.efi'
  if (existsSync(output)) throw new Error(`Kernel output exists: ${output}`)
  if (publicKeys.length < 1 || publicKeys.length > 8 || publicKeys.some(key => Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key)) throw new Error('Invalid metadata trust set')
  for (const uuid of [systemPartUuid, dataPartUuid]) if (!/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(uuid)) throw new Error('Invalid storage partition UUID')
  const release = readFileSync(join(kernelDirectory, 'kernel.release'), 'utf8').trim()
  const config = readFileSync(join(kernelDirectory, 'config'), 'utf8')
  for (const symbol of ['RD_ZSTD', 'BLK_DEV_LOOP', 'BLK_DEV_DM', 'DM_VERITY', 'DM_VERITY_VERIFY_ROOTHASH_SIG', 'SYSTEM_TRUSTED_KEYRING', 'EXT4_FS', 'SQUASHFS', 'WATCHDOG_NOWAYOUT',
    ...(fit ? [fit.watchdog, 'CMDLINE_FORCE'] : ['EFI_STUB', 'I6300ESB_WDT'])]) {
    if (!config.split('\n').includes(`CONFIG_${symbol}=y`)) throw new Error(`Kernel is missing built-in ${symbol}`)
  }
  if (!/^CONFIG_SYSTEM_TRUSTED_KEYS="[^"\n]+"$/m.test(config)) throw new Error('Kernel has no embedded content anchor')
  // A FIT kernel forces its built-in command line (CMDLINE_FORCE), so the profile
  // token is part of the kernel the board repository builds for that profile.
  //
  // The refusal prints BOTH lines. It used to print only the required one,
  // which left whoever opened the job to go and find what the kernel actually
  // carries before they could see the difference -- and a permanently red job
  // is read by people deciding whether it is NEW, not by people debugging it.
  if (fit && !config.split('\n').includes(`CONFIG_CMDLINE="${cmdline}"`)) {
    const built = config.split('\n').find(line => line.startsWith('CONFIG_CMDLINE=')) ?? '<the config carries no CONFIG_CMDLINE line at all>'
    throw new Error(`FIT kernel command policy differs from authenticated packaging: the ${profile} kernel must be built with CONFIG_CMDLINE="${cmdline}"\n`
      + `  the kernel in this bundle was built with: ${built}\n`
      + `  The required line is ${board}'s own BOARD_CMDLINE_ARGS plus the profile token, so a divergence is INSIDE one board release: its declaration and its kernel disagree. CMDLINE_FORCE means the built-in line is the one the device boots with, and nothing downstream can add the missing tokens.\n`
      + `  This refusal is correct for as long as the bundle is inconsistent. A consumer pins RELEASES: a repair on the board repository's main does not reach here until it is released and locks/pins/ moves, so this stays red until then -- check the pinned release, not the board's branch, before reading it as new.`)
  }
  if (fit) {
    const image = readFileSync(join(kernelDirectory, kernelName))
    validateFitKernel(fit.addresses, image.subarray(0, 64), image.length, artifactFile(join(kernelDirectory, fit.dtb)).bytes)
  }
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const firmware = fit ? join(work, 'firmware') : undefined
    if (firmware) {
      mkdirSync(firmware)
      const boardEnv = parseBoardEnv(readFileSync(join(REPO_ROOT, '_out', 'boards', board, 'board.env'), 'utf8'), 'board.env')
      const files = boardEnv.values.get('BOARD_FIRMWARE_FILES')!.split(' ')
      for (const file of files) {
        if (!/^\/usr\/lib\/firmware\/[a-zA-Z0-9_.-]+$/.test(file)) throw new Error('Invalid board firmware path')
        const name = file.slice('/usr/lib/firmware/'.length)
        const source = join(REPO_ROOT, '_out', 'boards', board, 'firmware', name)
        artifactFile(source)
        copyFileSync(source, join(firmware, name))
      }
      const regulatoryTrust = join(kernelDirectory, 'regdb-certs.pem')
      artifactFile(regulatoryTrust)
      runTools(FIT_TOOLS, ['-v', `${resolve(firmware)}:/output`, '-v', `${resolve(regulatoryTrust)}:/regdb-certs.pem:ro`],
        ['sh', '/tools/regdb.sh', '/regdb-certs.pem', '/output'])
      copyFileSync(join(REPO_ROOT, '_out', 'boards', board, 'component-copyright'), join(firmware, 'mica-component-copyright'))
    }
    const support = await packSupport(join(kernelDirectory, 'modules.tar'), release, firmware, join(work, 'support'), contentSigning, tb)
    if (firmware) rmSync(firmware, { recursive: true })
    const input = join(work, 'input')
    const boot = join(work, 'boot')
    mkdirSync(input)
    mkdirSync(boot)
    const buildId = componentId({
      board, arch, kernel: artifactFile(join(kernelDirectory, kernelName)), config: artifactFile(join(kernelDirectory, 'config')),
      ...(fit ? { dtb: artifactFile(join(kernelDirectory, fit.dtb)), addresses: fit.addresses } : {}),
      ...executables, publicKeys, systemPartUuid, dataPartUuid, supportId: componentId(support), cmdline,
      packager: packagerInputs(fit ? FIT_TOOLS : BOOT_TOOLS[efiArch]),
      bootCertificate: artifactFile(bootSigning.certificate),
    })
    const identity: BootIdentity = { board, arch, kernelBuildId: buildId, kernelRelease: release, supportId: componentId(support) }
    writeFileSync(join(input, 'boot.json'), canonicalJson({ identity, publicKeys, systemPartUuid, dataPartUuid }))
    writeFileSync(join(input, 'cmdline'), cmdline)
    writeFileSync(join(input, 'os-release'), 'ID=mica\nPRETTY_NAME="Mica OS"\n')
    copyFileSync(join(kernelDirectory, kernelName), join(input, 'kernel'))
    if (fit) {
      copyFileSync(join(kernelDirectory, fit.dtb), join(input, 'board.dtb'))
      writeFileSync(join(input, 'fit-addresses'), `${fit.addresses.join(' ')}\n`)
    }
    copyFileSync(join(kernelDirectory, 'kernel.release'), join(input, 'kernel.release'))
    copyFileSync(runkit, join(input, 'mica-runkit'))
    if (canonicalJson(kernelExecutables(join(input, 'mica-runkit'), arch)) !== canonicalJson(executables)) throw new Error('Native lifecycle inputs changed during packaging')
    packageBoot(fit ? 'fit' : 'kernel', input, boot, bootSigning, efiArch)
    const component: KernelComponent = { schema: 'mica/kernel/v1', id: '', board, arch,
      buildId, release, boot: { format: fit ? 'fit' : 'uki', artifact: artifactFile(join(boot, bootFile)) }, support }
    component.id = componentId(component)
    for (const name of readdirSync(join(work, 'support'))) renameSync(join(work, 'support', name), join(work, name))
    for (const name of readdirSync(boot)) renameSync(join(boot, name), join(work, name))
    copyFileSync(join(input, 'boot.json'), join(work, 'boot.json'))
    copyFileSync(join(kernelDirectory, 'config'), join(work, 'config'))
    rmSync(input, { recursive: true })
    rmSync(boot, { recursive: true })
    rmSync(join(work, 'support'), { recursive: true })
    writeFileSync(join(work, 'kernel.json'), canonicalJson(component))
    renameSync(work, output)
    return component
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export type FirmwareInputs = {
  output: string, metadataKey: string, generation: number, version: string
  /** A pinned, fetched board; its firmware format decides which of the two shapes applies. */
  board: string
} & ({ bootSigning: ContentSigning } | { input: string })

/** Firmware maintenance has its own signed artifact, independent of deployments. */
export function packBootFirmware(inputs: FirmwareInputs): Firmware {
  const { output, board } = inputs
  if (existsSync(output)) throw new Error(`Firmware output exists: ${output}`)
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const facts = loadBoardFacts(board)
    const fw = facts.firmware
    const filename = fw.format === 'efi' ? fw.loaderName : fw.binName
    if (fw.format === 'efi') {
      if (!('bootSigning' in inputs)) throw new Error(`Board ${board} boots efi: the firmware is built and signed here (--boot-key, --boot-cert), not taken from --input`)
      packageBoot('firmware', work, work, inputs.bootSigning, facts.efiArch)
    } else {
      if (!('input' in inputs)) throw new Error(`Board ${board} boots a ${fw.format}: the firmware is the board's loader, taken from --input`)
      const artifact = artifactFile(inputs.input)
      if (fw.format === 'rockchip-loader' && (artifact.bytes > fw.maxBytes || readFileSync(inputs.input).subarray(0, fw.magic.length).toString('ascii') !== fw.magic)) throw new Error('Invalid bounded Rockchip loader')
      if (fw.format === 'amlogic-boot0' && (artifact.bytes < fw.minBytes || artifact.bytes > fw.maxBytes)) throw new Error('Invalid bounded Amlogic boot0 payload')
      copyFileSync(inputs.input, join(work, filename))
    }
    const value = { schema: 'mica/firmware/v1', id: '', board, arch: facts.arch,
      generation: inputs.generation, version: inputs.version, artifact: artifactFile(join(work, filename)), target: firmwareTarget(facts) }
    value.id = componentId(value)
    const component = parseFirmware(canonicalJson(value), facts)
    const signer = new Signer(createPrivateKey(readFileSync(inputs.metadataKey)), false)
    writeFileSync(join(work, 'firmware.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(component)))))
    renameSync(work, output)
    return component
  } finally { rmSync(work, { recursive: true, force: true }) }
}
