// EVERY input `make board-pool` needs and does not have, reported in ONE run, before any container is started.
//
//   bun src/cli.ts pool-preflight
//   bun src/cli.ts pool-preflight --producer board@cx3576
//   bun src/cli.ts pool-preflight --board cx3576       the producers of that board's packages (boards/boards.tsv)
//
// It reports missing inputs; it never produces them. Producers come from the discovery, images from the lock
// resolver, and artefacts from each PREPARE hook in check-only mode, so the checks are the build's own.
// BOARD_DIR reaches hooks as it does in `make board-pool`. The port of tools/deb/preflight.sh (deleted
// 2026-09-22), message for message.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as resolveImage } from '../locks/from.ts'
import { inputs, type Records } from '../locks/locks.ts'
import { hostArch } from './build.ts'
import { producersOf } from '../boards/boards.ts'
import { discover, producer as findProducer, version, REPO_ROOT } from './producers.ts'

export class PreflightError extends Error {}

export type Report = { missing: number, warned: number, examined: number, producers: number, breakdown: string, reports: string[] }

export function preflight(only: string, board: string, records: Records = inputs()): Report {
  const all = discover()
  if (only !== '') findProducer(only, all)
  const host = hostArch()
  let rows = board !== '' ? producersOf(board, all) : all
  if (only !== '') rows = rows.filter(p => p.name === only)
  let ctxN = 0, hookN = 0, imageN = 0, artefactN = 0, vfN = 0, missingN = 0, warnedN = 0
  const reports: string[] = []
  // Reports and counts are separate: a hook reports several inputs in one block.
  // MISSING: nothing in the run produces it, so the run is refused.
  // WARNED: the producer builds it itself at a cost; reported, not refused.
  const noteMissing = (r: string) => { reports.push(r); missingN += 1 }
  // Each (key, architecture) is checked once.
  const imageSeen = new Set<string>()
  for (const p of rows) {
    const producerDir = join(REPO_ROOT, p.dir)
    const words = (key: string) => (p.env[key] ?? '').split(/\s+/).filter(w => w !== '')
    const prepare = p.env.PREPARE ?? '', flight = p.env.PREFLIGHT ?? ''
    // Build contexts (the build driver checks these too, for single-producer builds).
    for (const entry of words('BUILD_CONTEXTS')) {
      ctxN += 1
      const i = entry.indexOf('='), name = entry.slice(0, i), path = entry.slice(i + 1)
      if (i <= 0 || path === '') { noteMissing(`error: ${p.dir}/producer.env declares the build context '${entry}', which is not <context name>=<repository-relative path>.`); continue }
      if (!existsSync(join(REPO_ROOT, path))) noteMissing(`error: ${p.dir}/producer.env declares the build context '${name}=${path}' and ${path} does not exist.\nEvery build context a producer names is a COMMITTED tree, so this is a path that\nmoved or a checkout that is incomplete -- not something a build produces.`)
    }
    // The declared version (version.env beside the control templates).
    vfN += 1
    try { version(p) }
    catch (e) { if (e instanceof Error && e.constructor.name === 'ProducersError') noteMissing(e.message); else throw e }
    // The hook file.
    if (prepare !== '') {
      hookN += 1
      if (!existsSync(join(producerDir, prepare))) noteMissing(`error: ${p.dir}/producer.env names PREPARE=${prepare} and ${p.dir}/${prepare} does not exist.\nThe hook is the producer's own half of its build: it is what produces the payload\nthe packing step copies, so without it the build stages nothing.`)
    }
    // The base images; every producer packs in the mica-build-env base image, so it is always added.
    const keys = ['mica-build-env:base', ...words('FROM_IMAGES').map(e => e.slice(e.indexOf('=') + 1))]
    for (const arch of p.arches) {
      const imageArch = arch === 'all' ? host : arch
      for (const key of keys) {
        if (imageSeen.has(`${key}/${imageArch}`)) continue
        imageSeen.add(`${key}/${imageArch}`)
        imageN += 1
        try { resolveImage(key, records) }
        catch (e) { if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) noteMissing(e.message); else throw e }
      }
    }
    // The producer's own artefacts, via its PREPARE hook in check-only mode (opt-in with PREFLIGHT, since an
    // untaught hook would do its full build). The hook gets MICA_DEB_REPO_ROOT, MICA_DEB_PRODUCER,
    // MICA_DEB_PRODUCER_DIR, MICA_DEB_ARCH and MICA_DEB_PREFLIGHT=1 (no MICA_DEB_STAGE), must print
    // `preflight-examined:`, `preflight-missing:` and `preflight-warned:` counts on every path, and exits
    // non-zero only when missing is not zero.
    if (flight !== '' && flight !== '0') {
      if (prepare === '') throw new PreflightError(`error: ${p.dir}/producer.env declares PREFLIGHT=${flight} and no PREPARE. The pre-flight mode is a mode OF the PREPARE hook; there is no other script here to run in it`)
      // An absent hook was already reported above and is not run.
      if (!existsSync(join(producerDir, prepare))) continue
      for (const arch of p.arches) {
        const r = Bun.spawnSync(['bash', join(producerDir, prepare)], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env as Record<string, string>,
          MICA_DEB_PREFLIGHT: '1', MICA_DEB_REPO_ROOT: REPO_ROOT, MICA_DEB_PRODUCER: p.name, MICA_DEB_PRODUCER_DIR: producerDir, MICA_DEB_INSTANCE: p.name.includes('@') ? p.name.slice(p.name.indexOf('@') + 1) : p.name,
          MICA_DEB_INSTANCE_ENV: p.instance === '' ? '' : join(REPO_ROOT, p.instance), MICA_DEB_ARCH: arch } })
        const out = (r.stdout.toString() + r.stderr.toString()).replace(/\n$/, '')
        const last = (key: string) => out.split('\n').filter(l => l.startsWith(`${key}: `)).at(-1)?.slice(key.length + 2) ?? ''
        const n = last('preflight-examined'), m = last('preflight-missing'), w = last('preflight-warned')
        // Each count checked on its own; only examined may not be zero.
        const bad: string[] = []
        if (!/^[0-9]+$/.test(n) || n === '0' || /^0+$/.test(n)) bad.push('preflight-examined')
        if (!/^[0-9]+$/.test(m)) bad.push('preflight-missing')
        if (!/^[0-9]+$/.test(w)) bad.push('preflight-warned')
        if (bad.length > 0) throw new PreflightError(`error: ${p.dir}/${prepare} ran in pre-flight mode for ${arch} and did not print a usable ${bad.join(' and ')} count. A hook says what it looked at with 'preflight-examined: <count>', how much of it nothing in the run can make with 'preflight-missing: <count>', and how much the producer will make for itself with 'preflight-warned: <count>' -- all three on every path, and the first above zero. Without them a hook that checked nothing reads exactly like one that checked everything, and a report naming four files is counted as one:\n${out}`)
        artefactN += Number(n)
        if (Number(m) > 0 || Number(w) > 0) {
          // The count lines are for this module, not the operator.
          reports.push(out.split('\n').filter(l => !/^preflight-(examined|missing|warned): /.test(l)).join('\n'))
          missingN += Number(m); warnedN += Number(w)
        }
        // A non-zero exit with nothing missing is a failure of the hook itself.
        if (r.exitCode !== 0 && Number(m) === 0) throw new PreflightError(`error: ${p.dir}/${prepare} exited ${r.exitCode} in pre-flight mode for ${arch} while reporting nothing missing. A hook refuses by counting what it cannot find; a non-zero exit with a zero missing count is a failure of the hook itself:\n${out}`)
      }
    }
  }
  const examined = ctxN + hookN + imageN + artefactN + vfN
  const breakdown = `${ctxN} build context(s), ${hookN} PREPARE hook(s), ${imageN} base image(s), ${vfN} declared version(s) and ${artefactN} producer artefact(s)`
  // Examining nothing is refused rather than reported green.
  if (examined === 0) throw new PreflightError(`error: the pre-flight examined 0 inputs across ${rows.length} producer(s) (${breakdown}) and would report success by having checked nothing. Every one of those counts is read out of the tree at run time; a zero means the declarations moved, not that there is nothing to build`)
  return { missing: missingN, warned: warnedN, examined, producers: rows.length, breakdown, reports }
}

export async function main(argv: string[]): Promise<number> {
  try {
    let only = '', board = ''
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--producer') { only = argv[i + 1] ?? ''; if (only === '') throw new PreflightError('error: --producer takes a producer name'); i += 2 }
      else if (argv[i] === '--board') { board = argv[i + 1] ?? ''; if (board === '') throw new PreflightError('error: --board takes a board name'); i += 2 }
      else { throw new PreflightError('usage: pool-preflight [--producer <name> | --board <board>]') }
    }
    const r = preflight(only, board)
    if (r.reports.length > 0) console.error(r.reports.map(x => x + '\n\n').join('').replace(/\n$/, ''))
    // The warning count gets its own line so it stays visible.
    if (r.missing > 0) console.error(`preflight: ${r.missing} of ${r.examined} examined inputs are missing across ${r.producers} producer(s): ${r.breakdown}. Every one of them is listed above -- nothing was built and no container was started.`)
    else console.log(`preflight: ${r.examined - r.missing - r.warned} of ${r.examined} examined inputs are present across ${r.producers} producer(s): ${r.breakdown}`)
    if (r.warned > 0) console.error(`preflight: a further ${r.warned} of ${r.examined} are absent and will be BUILT BY THE RUN ITSELF, at the cost named in the warnings above. Making them first is how that cost is paid where it can be seen; it is not a prerequisite.`)
    return r.missing === 0 ? 0 : 1
  }
  catch (e) {
    if (e instanceof PreflightError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['ProducersError', 'BoardsError', 'ComponentError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
