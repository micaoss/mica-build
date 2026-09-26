// The board bundle contract (mica:docs/boards/contract.md, C1 of plan 20260913-0416): every board directory
// declares what the assembly reads out of its bundle, and nothing the bundle no longer carries (make
// board-contract-test).
//
//   - board.env declares BOARD_FEATURES (a subset of the vocabulary below) as a plain KEY=value line, and no
//     IMAGE_KINDS, BOARD_RADIOS, BOARD_HAS_STATUS_LED or BOARD_HAS_DISPLAY;
//   - layout.tsv declares the board's disk and holds to the layout rules, its loader region to its firmware facts;
//   - images.tsv (`# mica-boards images v1`, rows image|update <kind> <packer> <runtime image> <suffix>) has one
//     `image disk builtin` row and one `update full` row; only disk among image kinds is builtin; update kinds are
//     full, root and kernel, all builtin; a builtin row names `-` as its runtime image, any other a
//     mica-build-env:<name> image row of locks/mica-build-env.lock; kinds and suffixes unique within each type;
//   - the board carries its whole build (boards/README.md): Makefile, kernel/Dockerfile and a git row
//     <board>-kernel in locks/upstream.lock; a FIT board also bsp.env, a git row <board>-uboot,
//     kernel/configure.sh, kernel/build.sh and loader/Dockerfile; its Makefile includes nothing outside the board;
//   - manifests/board.pkgs exists and names at least one package; every manifest is one package per line and names
//     only packages a producer of this repository emits; manifests/radio-<r>.pkgs names a radio in BOARD_FEATURES,
//     manifests/component-<c>.pkgs a word; any other manifest name is refused;
//   - the authenticated boot facts agree: the firmware format is one the backend boots, a FIT board names its
//     device tree, watchdog, three load addresses and loader, and the command line carries the signed-boot floor
//     and no cgroup v1 hierarchy;
//   - a board carries no producer (producers/board runs over every board) but its extras', the board package's
//     control template and BOARD_PACKAGE_ENABLEMENT; containers.env is gone;
//   - outputs.tsv's board rows are exactly the files the board component carries;
//   - the four boot-logo artefacts move with BOARD_BOOT_LOGO, all or none (logoArtefacts, which
//     tests/gates/logo-equivalence.test.ts drives over synthetic boards: one definition, not two);
//   - a release target carries an evidence.json the release manifest can read;
//   - boards/boards.tsv lists every board directory, and its outputs.tsv are the tree's.
//
// Discovered, not listed: a board is a directory with a board.env. The port of tests/gates/board-contract-test.sh
// (deleted 2026-09-25), check for check and message for message.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { check as evidenceCheck } from '../../src/boards/evidence-schema.ts'
import { boardFactsFrom } from '../../src/image/board-facts.ts'
import { loadLayout } from '../../src/image/file-layout.ts'
import { checkLoaderPlacement } from '../../src/image/regions.ts'
import { field as upstreamField } from '../../src/locks/upstream.ts'
import { discover } from '../../src/pool/producers.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const FEATURE_VOCABULARY = ['wifi', 'bluetooth', 'display', 'status-led', 'can', 'usb-gadget', 'audio', 'containers']

/** KEY=value or KEY="value" and nothing else: the value without its quotes; undefined when absent or not plain. */
export function plainValue(file: string, key: string): string | undefined {
  const line = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`${key}=`))
  if (line === undefined || /\$\(|`|\$\{/.test(line)) return undefined
  return line.slice(key.length + 1).replace(/^"/, '').replace(/"$/, '')
}

const grepTree = (dir: string, re: RegExp): boolean => {
  if (!existsSync(dir)) return false
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), s = lstatSync(p)
    if (s.isDirectory()) { if (grepTree(p, re)) return true }
    else if (s.isFile() && readFileSync(p, 'utf8').split('\n').some(l => re.test(l))) { return true }
  }
  return false
}

/**
 * THE BOOT LOGO'S FOUR ARTEFACTS MOVE TOGETHER. BOARD_BOOT_LOGO is the one switch, and a board either has all four
 * or none: the kernel symbol (a fragment line, or `scripts/config --enable LOGO` over a vendor config that says it is
 * not set), the command line's two words (the position AND the cursor), the mklogo render (the board's kernel
 * prepare hook or its kernel Dockerfile), and the logind drop-in that keeps the logo's VT idle. A drop-in that
 * outlives its logo removes a working VT login to protect nothing.
 *
 * The getty@tty1 mask is not one of them: every root carries it (src/rootfs/runtime/consumers.json), logo or none,
 * and a root composed without it is refused. It was counted here while every board drew a logo; the first board that
 * does not (mini-x64, mica:docs/plan/20260926-0930-mini-images-on-128-mb.md) could compose no root at all. The
 * contract holds it as its own rule (below).
 */
export function logoArtefacts(dir: string): { flag: boolean, have: number } {
  const env = readFileSync(join(dir, 'board.env'), 'utf8')
  const cmdline = /^BOARD_CMDLINE_ARGS=(.*)$/m.exec(env)?.[1] ?? ''
  let have = 0
  if (grepTree(join(dir, 'kernel'), /^CONFIG_LOGO=y$|--enable LOGO( |$)/)) have++
  if (/fbcon=logo-pos:.*vt\.global_cursor_default=0|vt\.global_cursor_default=0.*fbcon=logo-pos:/.test(cmdline)) have++
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : '')
  if (read('kernel/hooks/prepare.sh').includes('mklogo') || read('kernel/Dockerfile').includes('mklogo')) have++
  if (existsSync(join(dir, 'package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf'))) have++
  return { flag: /^BOARD_BOOT_LOGO=1$/m.test(env), have }
}

export const logoAgrees = ({ flag, have }: { flag: boolean, have: number }) => (flag && have === 4) || (!flag && have === 0)

/** The getty@tty1 mask every root carries, shipped by the board package. */
export function hasGettyMask(dir: string): boolean {
  try { return lstatSync(join(dir, 'package/overlay/etc/systemd/system/getty@tty1.service')).isSymbolicLink() }
  catch { return false }
}

/** Every refusal of the contract for one board directory, in the order the shell reported them. */
export function contract(board: string, root = REPO_ROOT): string[] {
  const fails: string[] = []
  const fail = (m: string) => fails.push(m)
  const dir = join(root, 'boards', board), env = join(dir, 'board.env'), rel = `boards/${board}`
  const pv = (k: string) => plainValue(env, k)
  const envText = readFileSync(env, 'utf8')

  const features = pv('BOARD_FEATURES')
  if (features === undefined) fail(`${rel}/board.env declares no BOARD_FEATURES (or not as a plain KEY=value line)`)
  else for (const f of features.split(/\s+/).filter(Boolean)) if (!FEATURE_VOCABULARY.includes(f)) fail(`${board}: BOARD_FEATURES names '${f}', not in: ${FEATURE_VOCABULARY.join(' ')}`)
  if (/^IMAGE_KINDS=/m.test(envText)) fail(`${board}: board.env declares IMAGE_KINDS; the image kinds are ${rel}/images.tsv`)

  // layout.tsv: the board's disk, held to the layout rules and its loader region to its firmware facts.
  if (!existsSync(join(dir, 'layout.tsv'))) { fail(`${rel}/layout.tsv is missing; every board declares its disk there (src/image/file-layout.ts)`) }
  else {
    try { checkLoaderPlacement(loadLayout(dir), boardFactsFrom(env)) }
    catch (e) { fail(`FAIL: ${rel}/board.env: ${String(e)}`) }
  }

  // images.tsv: what the board is flashed and updated with.
  const images = `${rel}/images.tsv`
  if (!existsSync(join(root, images))) { fail(`${images} is missing; every board declares at least its disk image and its full update`) }
  else if (readFileSync(join(root, images), 'utf8').split('\n')[0] !== '# mica-boards images v1') { fail(`${images}: line 1 is not '# mica-boards images v1'`) }
  else {
    const rows = readFileSync(join(root, images), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'))
    const bad = rows.filter(r => (r[0] !== 'image' && r[0] !== 'update') || r.length !== 5 || !/^[a-z0-9][a-z0-9-]*$/.test(r[1]!) || r[2] === '' || r[3] === '' || !/^[a-z0-9][a-z0-9.-]*$/.test(r[4]!))
    if (bad.length > 0) fail(`${images}: rows that are not image|update TAB <kind> TAB <packer> TAB <runtime image> TAB <suffix>: ${bad.map(r => r.join('\t')).join('\n')}`)
    if (rows.filter(r => r[0] === 'image' && r[1] === 'disk' && r[2] === 'builtin').length !== 1) fail(`${images}: no single image disk row with the packer builtin; disk is the canonical image every other kind derives from`)
    if (rows.some(r => r[0] === 'image' && r[1] !== 'disk' && r[2] === 'builtin')) fail(`${images}: an image kind other than disk names the packer builtin; only the disk image is the assembly's own`)
    if (rows.filter(r => r[0] === 'update' && r[1] === 'full').length !== 1) fail(`${images}: no single update full row; every board can be updated whole`)
    if (rows.some(r => r[0] === 'update' && !/^(full|root|kernel)$/.test(r[1]!))) fail(`${images}: an update kind other than full, root or kernel (firmware waits until a device can install it)`)
    if (rows.some(r => r[0] === 'update' && r[2] !== 'builtin')) fail(`${images}: an update row whose packer is not builtin; the assembly signs and packs update packages itself`)
    for (const type of ['image', 'update']) {
      const of = rows.filter(r => r[0] === type)
      if (new Set(of.map(r => r[1])).size !== of.length) fail(`${images}: an ${type} kind is declared twice`)
      if (new Set(of.map(r => r[4])).size !== of.length) fail(`${images}: an ${type} suffix is declared twice`)
    }
    const lock = readFileSync(join(root, 'locks/mica-build-env.lock'), 'utf8').split('\n').map(l => l.split('\t'))
    for (const [type, kind, packer, runtime] of rows) {
      if (packer === 'builtin') {
        if (runtime !== '-') fail(`${images}: the builtin ${type} ${kind} names the runtime image '${runtime}'; a builtin row runs in the assembly and names -`)
        continue
      }
      if (runtime?.startsWith('mica-build-env:')) {
        if (!lock.some(r => r[0] === 'image' && r[1] === 'mica-build-env' && r[2] === runtime.slice('mica-build-env:'.length))) fail(`${images}: ${type} ${kind} runs in ${runtime}, which locks/mica-build-env.lock names no image row for`)
      }
      else { fail(`${images}: ${type} ${kind} runs in '${runtime}', not a mica-build-env:<name> image of locks/mica-build-env.lock`) }
    }
  }

  // The board's own build: nothing of it lives outside the board but common/.
  for (const f of ['Makefile', 'kernel/Dockerfile']) if (!existsSync(join(dir, f))) fail(`${rel}/${f} is missing; a board carries its own kernel build`)
  const trees = [`${board}-kernel`]
  if (pv('BOOT_BACKEND') === 'uboot-fit') {
    for (const f of ['bsp.env', 'kernel/configure.sh', 'kernel/build.sh', 'loader/Dockerfile']) if (!existsSync(join(dir, f))) fail(`${rel}/${f} is missing; a FIT board carries its own kernel and U-Boot build`)
    trees.push(`${board}-uboot`)
  }
  for (const tree of trees) {
    try { upstreamField(['git', tree, 'commit'], join(root, 'locks')) }
    catch { fail(`locks/upstream.lock pins no git tree ${tree}; a board's kernel and U-Boot sources are pinned there`) }
  }
  if (existsSync(join(dir, 'Makefile')) && /^[ \t]*-?include[ \t]+\.\.\//m.test(readFileSync(join(dir, 'Makefile'), 'utf8'))) fail(`${rel}/Makefile includes a file outside the board`)

  // The manifests: one package per line, each one a producer of this repository emits.
  if (!existsSync(join(dir, 'manifests/board.pkgs'))) fail(`${rel}/manifests/board.pkgs is missing; the bundle would carry no board package manifest`)
  const declared = new Set(discover(root).flatMap(p => p.packages))
  const radios = (features ?? '').split(/\s+/).filter(Boolean)
  for (const f of existsSync(join(dir, 'manifests')) ? readdirSync(join(dir, 'manifests')).filter(n => n.endsWith('.pkgs')).sort() : []) {
    const m = `${rel}/manifests/${f}`, base = f.slice(0, -'.pkgs'.length)
    if (base.startsWith('radio-')) { if (!radios.includes(base.slice('radio-'.length))) fail(`${m} names a radio the board's BOARD_FEATURES does not (${features || 'none'})`) }
    else if (base !== 'board' && !/^component-.+/.test(base)) { fail(`${m} belongs to no manifest family (board, radio-<r>, component-<c>)`) }
    let n = 0
    for (const [i, raw] of readFileSync(join(root, m), 'utf8').split('\n').entries()) {
      const words = raw.replace(/#.*$/, '').split(/\s+/).filter(Boolean)
      if (words.length === 0) continue
      if (words.length !== 1) { fail(`${m}:${i + 1} names ${words.length} packages on one line`); continue }
      if (!declared.has(words[0]!)) fail(`${m}:${i + 1} names '${words[0]}', which no producer of this repository emits`)
      n++
    }
    if (n === 0) fail(`${m} names no package`)
  }

  // The authenticated boot facts the kernel component and firmware package read.
  const backend = pv('BOOT_BACKEND') ?? '', format = pv('FIRMWARE_FORMAT') ?? ''
  if (!['systemd-boot:efi', 'uboot-fit:rockchip-loader', 'uboot-fit:amlogic-boot0'].includes(`${backend}:${format}`))
    fail(`${board}: BOOT_BACKEND=${backend || 'unset'} with FIRMWARE_FORMAT=${format || 'unset'}; systemd-boot boots efi, uboot-fit a rockchip-loader or an amlogic-boot0`)
  if (backend === 'uboot-fit') {
    for (const key of ['FIT_DTB', 'FIT_WATCHDOG', 'FIT_LOAD_ADDRESSES', 'UBOOT_BIN_NAME', 'UBOOT_MAX_BYTES']) if (!pv(key)) fail(`${board}: a FIT board declares ${key}`)
    const addrs = pv('FIT_LOAD_ADDRESSES') ?? ''
    if (addrs.split(/\s+/).filter(a => /^0x[0-9a-fA-F]+$/.test(a)).length !== 3) fail(`${board}: FIT_LOAD_ADDRESSES is three hexadecimal addresses (kernel, initramfs, device tree), not '${addrs}'`)
    const perFormat: Record<string, string[]> = { 'amlogic-boot0': ['UBOOT_MIN_BYTES', 'UBOOT_PAYLOAD_OFFSET_BYTES'], 'rockchip-loader': ['LOADER_MAGIC_HEX'] }
    for (const key of perFormat[format] ?? []) if (!pv(key)) fail(`${board}: a${format.startsWith('a') ? 'n' : ''} ${format} board declares ${key}`)
  }
  const cmdline = pv('BOARD_CMDLINE_ARGS') ?? ''
  for (const arg of ['dm_verity.require_signatures=1', 'rdinit=/init']) if (!` ${cmdline} `.includes(` ${arg} `)) fail(`${board}: BOARD_CMDLINE_ARGS is the authenticated command line and lacks ${arg}`)
  for (const key of ['BOARD_RADIOS', 'BOARD_HAS_STATUS_LED', 'BOARD_HAS_DISPLAY'])
    if (new RegExp(`^${key}=`, 'm').test(envText)) fail(`${board}: board.env still declares ${key}; BOARD_FEATURES is the capability set and its readers read it`)

  // The board is data: no producer of its own, and the one control template it carries is the board package's.
  const stray: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (p === join(dir, 'extras')) continue; if (lstatSync(p).isDirectory()) walk(p); else if (f === 'producer.env') stray.push(relative(root, p)) } }
  walk(dir)
  if (stray.length > 0) fail(`${rel} carries a producer.env outside extras/ (${stray.join(' ')}); a board is data, the producers are under producers/`)
  if (!existsSync(join(dir, `package/control/mica-board-${board}.control`))) fail(`${rel}/package/control/mica-board-${board}.control is missing; the board package's control template`)
  if (!/^BOARD_PACKAGE_ENABLEMENT=[0-9]+$/m.test(envText)) fail(`${board}: board.env declares no BOARD_PACKAGE_ENABLEMENT (how many units the board package enables; the gate holds it)`)
  if (existsSync(join(dir, 'containers.env'))) fail(`${rel}/containers.env exists; that switch moved to the product`)

  // The board component is data this directory carries, and outputs.tsv is the list the assembly holds it to;
  // layout.tsv's region files and partition seeds travel in it.
  const listed = readFileSync(join(dir, 'outputs.tsv'), 'utf8').split('\n').map(l => l.split('\t'))
    .filter(r => r[0] === 'file' && r[1] === 'board' && !r[2]!.startsWith('trust/')).map(r => r[2]!).sort()
  const regions = existsSync(join(dir, 'layout.tsv')) ? readFileSync(join(dir, 'layout.tsv'), 'utf8').split('\n').map(l => l.split('\t')).filter(r => r[0] === 'region' && r[5]?.startsWith('file:')).map(r => r[5]!.slice('file:'.length)) : []
  const present = new Set<string>()
  const collect = (p: string) => {
    if (!existsSync(join(dir, p))) return
    if (statSync(join(dir, p)).isDirectory()) for (const f of readdirSync(join(dir, p))) collect(join(p, f))
    else present.add(p)
  }
  for (const p of ['board.env', 'evidence.json', 'images.tsv', 'layout.tsv', 'outputs.tsv', 'manifests', 'partitions', ...regions]) collect(p)
  const have = [...present].sort()
  if (listed.join('\n') !== have.join('\n')) {
    const only = [...listed.filter(f => !present.has(f)).map(f => `only in outputs.tsv: ${f}`), ...have.filter(f => !listed.includes(f)).map(f => `not listed by outputs.tsv: ${f}`)]
    fail(`${board}: outputs.tsv's board rows and the files ${rel} carries differ: ${only.join(' ')}`)
  }

  const logo = logoArtefacts(dir)
  if (!logoAgrees(logo)) fail(`${board}: BOARD_BOOT_LOGO=${logo.flag ? 1 : 0} with ${logo.have} of the four logo artefacts present (CONFIG_LOGO, fbcon=logo-pos: with vt.global_cursor_default=0, the mklogo render, the logind drop-in). They move together or not at all`)
  if (!hasGettyMask(dir)) fail(`${board}: the board package ships no getty@tty1 mask (package/overlay/etc/systemd/system/getty@tty1.service -> /dev/null); every root carries it (src/rootfs/runtime/consumers.json), logo or none`)

  // THE UNIFIED CGROUP HIERARCHY, which no kernel symbol can express: under v1 podman validates on its v1 branch,
  // where a memory limit is discarded with a warning and the container runs unbounded.
  const line = ` ${(/^BOARD_CMDLINE_ARGS=(.*)$/m.exec(envText)?.[1] ?? '').replace(/"/g, '')} `
  if (line.includes(' systemd.unified_cgroup_hierarchy=0 ') || line.includes(' cgroup_no_v1'))
    fail(`${board}: BOARD_CMDLINE_ARGS selects a cgroup v1 hierarchy; podman would validate on its v1 branch, where a memory limit is discarded with a warning and the container runs unbounded`)

  // A release target owes an evidence document the release manifest reads.
  if (/^BOARD_RELEASE_TARGET=1$/m.test(envText)) {
    if (!existsSync(join(dir, 'evidence.json'))) { fail(`${rel}/evidence.json is missing and BOARD_RELEASE_TARGET=1; the assembly's release manifest requires it and takes the product's bootAssurance from it`) }
    else {
      try { evidenceCheck(join(dir, 'evidence.json'), board) }
      catch (e) { fail(e instanceof Error ? e.message : String(e)) }
    }
  }
  return fails
}
