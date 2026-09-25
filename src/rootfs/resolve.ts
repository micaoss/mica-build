// The package-set resolver: WHAT a build installs, from the build's inputs and the manifests beside
// rootfs/packages/.
//
//   bun src/cli.ts resolve --board cx3576 --board-dir _out/boards/cx3576/manifests \
//        --features "micad mqtt containers wifi bluetooth" [--components "..."] [--packages-dir <dir>]
//   -> mica-apid
//      mica-board-cx3576
//      mica-bluetooth
//      ...
//
// One package name per line on stdout, byte-order sorted and deduplicated, and nothing else: two runs over
// one set of inputs are byte-identical, so a diff of two resolutions is a diff of the images they compose.
// Every refusal goes to stderr and exits non-zero.
//
// The engine's manifests (common, feature-*, radio-*) are read from rootfs/packages/ -- or the directory
// --packages-dir names, which is how tests/gates/rootfs-manifest.test.ts proves its negative tests red: it
// perturbs a copy of the manifests instead of the tracked ones -- and the board's (board.pkgs,
// radio-<r>.pkgs, component-<c>.pkgs) from --board-dir, the manifests/ of the fetched board bundle
// (src/cli.ts board-pool --fetch): what a board installs travels with the board. The package set is read at
// run time from the pool rows (src/pool/pool.ts) and the producers (src/pool/producers.ts) -- the only
// authorities on which packages exist.
//
// EVERY INPUT IS AN ARGUMENT, AND NONE OF THEM IS RE-DERIVED HERE. This module does not read the board.env
// or any environment variable, and it must not learn to: the composer (src/rootfs/build.ts) owns every one
// of those decisions. A second copy of that logic here is the second table this repository keeps deleting.
// The image profile selects no package: dev and prod install the same set. The manifest format is
// documented in rootfs/packages/README.md. The port of rootfs/packages/resolve.sh (deleted 2026-09-23),
// message for message.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { rows as poolRows } from '../pool/pool.ts'
import { discover, REPO_ROOT } from '../pool/producers.ts'

export class ResolveError extends Error {}

export const PACKAGES_DIR = join(REPO_ROOT, 'rootfs/packages')

export type Inputs = { board: string, boardDir: string, features: string, components?: string, packagesDir?: string, declared?: Set<string> }

function die(message: string): never {
  throw new ResolveError(`error: ${message}`)
}

/** The packages that exist: the package rows of locks/ and the packages this tree's own producers declare. */
export async function declaredPackages(): Promise<Set<string>> {
  const declared = new Set<string>()
  for (const r of await poolRows()) declared.add(r[0])
  for (const p of discover()) for (const pkg of p.packages) declared.add(pkg)
  if (declared.size === 0) die('locks/ named no package and no producer declares one. The cross-check below would then accept every manifest line, having compared each against an empty set')
  return declared
}

/** One package per line, every one declared. */
function readManifest(file: string, declared: Set<string>): string[] {
  const names: string[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.forEach((raw, i) => {
    const words = raw.replace(/#.*$/, '').split(/\s+/).filter(w => w !== '')
    if (words.length === 0) return
    if (words.length !== 1) die(`${file}:${i + 1} names ${words.length} packages on one line. A manifest holds ONE package name per line, so that a line can be added, removed or blamed on its own; see rootfs/packages/README.md`)
    if (!declared.has(words[0]!)) die(`${file}:${i + 1} names the package '${words[0]}', which no package row of locks/ imports and no producer of this tree declares. A manifest may only name a pinned or an own package; \`bash bin/bun.sh src/cli.ts pool rows\` and \`bash bin/bun.sh src/cli.ts producers\` list them, and the packages that exist are: ${[...declared].sort().join(' ')} `)
    names.push(words[0]!)
  })
  return names
}

function pkgsFiles(dir: string): string[] {
  return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter(f => f.endsWith('.pkgs')).sort().map(f => join(dir, f)) : []
}

/** The resolved package names, sorted and unique. */
export async function resolve(inputs: Inputs): Promise<string[]> {
  const here = inputs.packagesDir ?? PACKAGES_DIR
  const boardDir = inputs.boardDir
  if (boardDir === '') die('--board-dir was not given. The board\'s own manifests (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs) are read out of the fetched board bundle, _out/boards/<board>/manifests; run `make board-fetch BOARD=<board>`')
  if (!existsSync(boardDir) || !statSync(boardDir).isDirectory()) die(`--board-dir ${boardDir} is not a directory; the board bundle is not fetched (make board-fetch BOARD=${inputs.board || '<board>'})`)
  // The manifests, discovered rather than listed: a manifest added to the directory is in the resolution the
  // day it lands, and one this module had to be taught about would be one it could silently omit.
  const manifestFiles = pkgsFiles(here)
  if (manifestFiles.length === 0) die(`${here} holds no *.pkgs manifest at all. Every resolution would then be empty, and a resolver with nothing to resolve reports the empty set rather than reporting this`)
  const declared = inputs.declared ?? await declaredPackages()
  // Every manifest in the directory is parsed and cross-checked on EVERY run, not just the handful this
  // resolution reads. A typo in the manifest of the other board is a typo that fails one board's build and
  // not the other's, and the run that would have caught it is the run nobody makes.
  const manifest = new Map<string, string[]>()
  const knownRadios: string[] = [], knownFeaturesList: string[] = [], boardComponents: string[] = []
  for (const file of manifestFiles) {
    const base = basename(file, '.pkgs')
    manifest.set(base, readManifest(file, declared))
    // The family is the filename's prefix, and an unrecognised one is refused rather than ignored: a manifest
    // nothing selects is a package set that never reaches an image and never fails a build either.
    if (base === 'common') continue
    if (base.startsWith('radio-')) knownRadios.push(base.slice('radio-'.length))
    else if (base.startsWith('feature-')) knownFeaturesList.push(base.slice('feature-'.length))
    else if (base.startsWith('board-') || base.startsWith('component-')) die(`${file} is a board manifest in the engine's directory. A board's manifests (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs) live in the board repository under <board>/manifests/ and arrive here in the board bundle; nothing selects this file, so it would never be read into a resolution`)
    else die(`${file} belongs to no manifest family. An engine manifest is named common.pkgs, radio-<radio>.pkgs or feature-<feature>.pkgs; nothing selects any other name, so this file would never be read into a resolution`)
  }
  // THE BOARD'S MANIFESTS, out of its bundle: board.pkgs is the board, a radio-<r>.pkgs adds the board's
  // transport packages to a radio the engine knows, a component-<c>.pkgs is an optional component a build
  // names. Every file is parsed and cross-checked whether or not this resolution reads it.
  if (!existsSync(join(boardDir, 'board.pkgs'))) die(`${boardDir} holds no board.pkgs. The board bundle carries the board's package manifest (mica:docs/boards/contract.md section 3); a board with none composes a root with no board package, which cannot boot`)
  for (const file of pkgsFiles(boardDir)) {
    const base = basename(file, '.pkgs')
    if (base === 'board') { manifest.set('board', readManifest(file, declared)) }
    else if (base.startsWith('radio-')) {
      const radio = base.slice('radio-'.length)
      if (!knownRadios.includes(radio)) die(`${file} names the radio '${radio}', for which ${here} holds no radio-${radio}.pkgs. The radios the engine knows are: ${knownRadios.length > 0 ? knownRadios.join(' ') : 'none'}`)
      manifest.set(`board-radio-${radio}`, readManifest(file, declared))
    }
    else if (base.startsWith('component-') && base.length > 'component-'.length) { manifest.set(base, readManifest(file, declared)); boardComponents.push(base.slice('component-'.length)) }
    else { die(`${file} belongs to no board manifest family (board.pkgs, radio-<radio>.pkgs, component-<component>.pkgs); nothing selects this name`) }
  }
  // A radio is a feature like any other in --features: `wifi` selects radio-wifi.pkgs and the board's
  // radio-wifi.pkgs beside it. A radio and a feature sharing one name would make that token ambiguous, so
  // the collision is refused here rather than resolved by precedence.
  for (const radio of knownRadios) {
    if (knownFeaturesList.includes(radio)) die(`${here} holds both feature-${radio}.pkgs and radio-${radio}.pkgs. The name is a --without token in both families, so declining '${radio}' would be ambiguous; one of the two manifests has to be renamed`)
    knownFeaturesList.push(radio)
  }
  const knownFeatures = [...new Set(knownFeaturesList)].sort()
  const features = inputs.features.split(/\s+/).filter(f => f !== '')
  for (const feature of features)
    if (!knownFeatures.includes(feature)) die(`--features names '${feature}', which this repository has no such thing as. The features that exist are: ${knownFeatures.join(' ')}. They come from the feature-<name>.pkgs and radio-<name>.pkgs manifests in ${here}`)

  const selected = (f: string) => features.includes(f)
  if (inputs.board === '') die('--board is empty')
  let resolved = [...(manifest.get('common') ?? []), ...(manifest.get('board') ?? [])]
  for (const radio of knownRadios) if (selected(radio)) resolved.push(...(manifest.get(`radio-${radio}`) ?? []), ...(manifest.get(`board-radio-${radio}`) ?? []))
  for (const component of (inputs.components ?? '').split(/\s+/).filter(c => c !== '')) {
    const key = `component-${component}`
    if (!manifest.has(key)) die(`component '${component}' is unavailable for board '${inputs.board}'; ${boardDir} holds: ${boardComponents.length > 0 ? boardComponents.join(' ') : 'none'}`)
    resolved.push(...manifest.get(key)!)
  }
  // A radio token has no feature-<name>.pkgs; the loop above already read its radio-<name>.pkgs.
  for (const feature of knownFeatures) if (selected(feature)) resolved.push(...(manifest.get(`feature-${feature}`) ?? []))
  // An empty resolution composes a root holding nothing but Debian, and every check downstream of it is a
  // check over an image with no Mica OS in it.
  if (resolved.length === 0) die(`the resolution for --board ${inputs.board} is EMPTY. Every manifest it reads named nothing, so the composer would install no mica package at all and every check over the result would run against a plain Debian root`)
  // A resolution with no board package has no kernel, no device tree and no rendered layout: it composes a
  // root that cannot boot on anything.
  const boardPackages = manifest.get('board') ?? []
  if (!resolved.some(p => boardPackages.includes(p))) die(`the resolution for --board ${inputs.board} carries NO board package. ${boardDir}/board.pkgs named none, so the image would have none of the layout files rendered from the board's board.env -- an artifact that composes and cannot boot`)
  resolved = [...new Set(resolved)].sort()
  return resolved
}

export async function main(argv: string[]): Promise<number> {
  const usage = 'usage: resolve --board <board> --board-dir <manifests dir> --features "<features>" [--components "<components>"] [--packages-dir <dir>]'
  try {
    let board = '', boardDir = '', features = '', components = '', packagesDir: string | undefined
    let haveBoard = false, haveFeatures = false
    for (let i = 0; i < argv.length;) {
      const a = argv[i]!
      if (a === '--board') { board = argv[i + 1] ?? ''; haveBoard = true; i += 2 }
      else if (a === '--board-dir') { boardDir = argv[i + 1] ?? ''; i += 2 }
      else if (a === '--features') { features = argv[i + 1] ?? ''; haveFeatures = true; i += 2 }
      else if (a === '--components') { if (i + 1 >= argv.length) die('--components needs a value'); components = argv[i + 1]!; i += 2 }
      else if (a === '--packages-dir') { packagesDir = argv[i + 1] ?? ''; i += 2 }
      else { console.error(`error: unknown argument '${a}'`); console.error(usage); return 1 }
    }
    // FEATURES ARE OPT-IN. A product names what it wants; --features "" is the minimal image, the floor and
    // the board package. The argument is required even when empty, so a driver that forgot to pass it cannot
    // silently compose the minimal image where a full one was meant.
    if (boardDir === '') { console.error('error: --board-dir was not given. The board\'s own manifests (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs) are read out of the fetched board bundle, _out/boards/<board>/manifests; run `make board-fetch BOARD=<board>`'); console.error(usage); return 1 }
    for (const [name, have] of [['board', haveBoard], ['features', haveFeatures]] as [string, boolean][])
      if (!have) { console.error(`error: --${name} was not given. Both are required; --features "" is how the minimal image says so, because an omitted one would resolve to a package set nothing had decided`); console.error(usage); return 1 }

    const out = await resolve({ board, boardDir, features, components, packagesDir })
    await Bun.write(Bun.stdout, out.map(p => p + '\n').join(''))
    return 0
  }
  catch (e) {
    if (e instanceof ResolveError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['PoolError', 'ProducersError', 'OciError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
