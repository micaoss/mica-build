// The package-level gates of PLAN-036 section 6, over the built pools.
//
//   bun src/cli.ts pool-gate                   every pool, static checks and the rebuild
//   bun src/cli.ts pool-gate --arch <arch>     one pool (a native per-architecture CI job)
//   bun src/cli.ts pool-gate --static          every pool, no rebuild (the CI job that merges the pools)
//   bun src/cli.ts pool-gate --board <board> [--arch <arch> | --static]
//                                              that board's pool only: the producers of the packages
//                                              boards/boards.tsv lists for it, at its architecture
//
//   reads   _out/debs/<arch>/pool/*.deb          (built by `make board-pool`; MICA_POOL_DIR overrides _out/debs)
//   asserts the facts listed below, per architecture
//
// Facts are read out of the archives by src/pool/deb.ts on the host, where the shell ran dpkg-deb in the
// mica-build-env base image; expectations come from the producer discovery and each producer.env. This gate
// is over the archives this tree builds (Mica-Source-Repo names this repository); the imported archives
// beside them in the same pool are the pool's, verified by digest against locks/ when they are fetched, and
// are not looked at here.
//
//   a  no non-directory path is in two archives of one pool, except packages that every one declare mutual
//      unversioned Conflicts, by name or through a virtual name each provides; Replaces is refused.
//   b  Architecture, the package set, each archive built here at its producer's declared version
//      (version.env), and the Depends closure.
//   c  two builds under one SOURCE_DATE_EPOCH are byte-identical.
//   d  every package ships a non-empty /usr/share/doc/<package>/copyright.
//   e  each package ships as many multi-user.target.wants symlinks as its ENABLEMENT row declares.
//   f  no package carries DEBIAN/conffiles (the root is immutable).
//   g  every maintainer script parses as POSIX sh.
//   h  every producer contributed its packages and every archive maps back to a producer; PACKAGES matches
//      the control templates.
//   i  `all` archives are byte-identical across pools. A dependency on a local package is pinned exactly;
//      a Provides-only name is local-virtual; anything else is external and only reported.
//
// Not checked: an APT install into a clean root (external dependencies are the composer's). The port of
// tools/deb/package-gate.sh (deleted 2026-09-22), check for check and message for message; the shell staged
// an always-empty lock (this tree imports nothing into its own pool), whose branches are not carried.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceRepo } from './build.ts'
import { controlFields, controlTar, controlText, payloadEntries, tarEntries } from './deb.ts'
import { discover, producer as findProducer, version, type Producer, REPO_ROOT } from './producers.ts'

export class GateError extends Error {}

const POOL_ROOT = process.env.MICA_POOL_DIR || join(REPO_ROOT, '_out/debs')

export type Options = { board?: string, arch?: string, static?: boolean, poolRoot?: string, ownRepo?: string, producers?: Producer[], say?: (line: string) => void }
export type Outcome = { pass: number, fail: number, result: string }

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function boardsSh(...args: string[]): string {
  const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'tools/boards.sh'), ...args], { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new GateError(`error: tools/boards.sh ${args.join(' ')} failed (see above)`)
  return r.stdout.toString()
}

/** A tar member name as dpkg-deb --contents prints it, without the leading ./ and trailing /. */
function stripDots(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

/** The names in a Depends/Conflicts/Provides field: [name, rest] per entry, alternatives per Depends entry. */
function fieldEntries(value: string): string[] {
  return value.split(',').map(e => e.trim()).filter(e => e !== '')
}

export async function gate(options: Options = {}): Promise<Outcome> {
  const say = options.say ?? ((line: string) => console.log(line))
  const poolRoot = options.poolRoot ?? POOL_ROOT
  const onlyArch = options.arch ?? '', staticOnly = options.static ?? false, board = options.board ?? ''
  if (onlyArch !== '' && staticOnly) throw new GateError('error: --arch gates one pool with its rebuild and --static every pool without one; they do not combine')
  const all = options.producers ?? discover()
  let rows: Producer[]
  let boardArch = ''
  if (board !== '') {
    boardArch = boardsSh('arch', board).trim()
    rows = boardsSh('producers', board).split('\n').filter(l => l !== '').map(l => findProducer(l.split(' ')[0]!, all))
  }
  else { rows = all }
  if (rows.length === 0) throw new GateError('error: src/cli.ts producers named no producer (see its message above). Every expectation below is derived from that set, and over an empty one they all hold')
  // The architectures this repository's pool holds: what its producers declare (an `all` producer is a member
  // of every pool this repository builds for, so alone it means both) -- read from those declarations, never
  // discovered from _out/debs, so a missing pool fails.
  const declared = new Set<string>()
  for (const p of rows) {
    for (const a of p.arches) {
      if (a === 'all') { declared.add('amd64'); declared.add('arm64') }
      else { declared.add(a) }
    }
  }
  let arches = ['amd64', 'arm64'].filter(a => declared.has(a))
  if (arches.length === 0) throw new GateError('error: no producer names an architecture, so there is no pool to gate')
  // A board's pool is its architecture's alone.
  if (board !== '') arches = [boardArch]
  if (onlyArch !== '') {
    if (!arches.includes(onlyArch)) throw new GateError(`error: no producer builds for ${onlyArch}`)
    arches = [onlyArch]
  }
  for (const arch of arches)
    if (!existsSync(join(poolRoot, arch, 'pool'))) throw new GateError(`error: ${poolRoot}/${arch}/pool does not exist, so there is nothing to check for ${arch}. Build it with \`make board-pool\`; a gate that skipped the missing architecture would report on half a pool`)

  const ownRepo = options.ownRepo ?? sourceRepo()
  const work = join(REPO_ROOT, 'tmp/deb-package-gate')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  let passN = 0, failN = 0
  const pass = (m: string) => { passN += 1; say(`PASS: ${m}`) }
  const fail = (m: string) => { failN += 1; say(`FAIL: ${m}`) }

  // Each producer's declared version (version.env), which every archive it built must carry.
  const declaredVersion = new Map<string, string>()
  for (const p of rows) declaredVersion.set(p.name, version(p).version)

  const localNames: string[] = []
  const pkgProducer = new Map<string, string>(), pkgDir = new Map<string, string>(), wantsExpected = new Map<string, number>()
  for (const p of rows) {
    // PACKAGES against the control templates present, both directions.
    const controlDir = join(REPO_ROOT, p.control)
    const templates = existsSync(controlDir) ? readdirSync(controlDir).filter(f => f.endsWith('.control')).sort() : []
    const tmplNames: string[] = []
    for (const t of templates) {
      const n = /^Package:[ \t]*(.*)$/m.exec(readFileSync(join(controlDir, t), 'utf8'))?.[1]?.trim() ?? ''
      if (n === '') throw new GateError(`error: ${p.dir}/control/${t} declares no Package:, so the package it describes has no name to check the pool against`)
      tmplNames.push(n)
    }
    const want = [...p.packages].sort().join(' '), got = [...tmplNames].sort().join(' ')
    if (want !== got) throw new GateError(`error: the producer '${p.name}' declares PACKAGES='${want}' and ${p.dir}/control/ holds templates for '${got}'. Those are two statements of one fact and they have come apart: pack.sh needs a template per package, and a template nothing declares is packed by nothing and expected by nothing`)
    // ENABLEMENT needs a row per package; zero is spelled out.
    if (p.enablement === '-') throw new GateError(`error: the producer '${p.name}' declares no ENABLEMENT. Add ENABLEMENT='<package>=<count> ...' to ${p.dir}/producer.env with a row per package it emits, stating how many /etc/systemd/system/multi-user.target.wants symlinks that package ships -- 0 for a package that ships none. There is no default: a missing row and a deliberate zero look identical, and only one of them is a decision. See tools/deb/README.md`)
    const declaredPkgs: string[] = []
    for (const e of p.enablement.split(',')) {
      const i = e.indexOf('='), pkg = e.slice(0, i), count = e.slice(i + 1)
      if (i <= 0) throw new GateError(`error: the producer '${p.name}' declares ENABLEMENT entry '${e}', which is not <package>=<count>`)
      if (!/^[0-9]+$/.test(count)) throw new GateError(`error: the producer '${p.name}' declares ENABLEMENT '${e}', whose count is not a non-negative integer. It is the NUMBER of multi-user.target.wants symlinks that package ships`)
      if (!p.packages.includes(pkg)) throw new GateError(`error: the producer '${p.name}' declares ENABLEMENT for '${pkg}', which it does not emit. It emits: ${p.packages.join(' ')}`)
      wantsExpected.set(pkg, Number(count))
      declaredPkgs.push(pkg)
    }
    for (const pkg of p.packages)
      if (!declaredPkgs.includes(pkg)) throw new GateError(`error: the producer '${p.name}' emits '${pkg}' and its ENABLEMENT does not mention it. Add '${pkg}=<count>' to ${p.dir}/producer.env; a package left out has no stated enablement, and inferring one from what it happens to ship is what this gate exists to not do`)

    for (const pkg of p.packages) {
      const prior = pkgProducer.get(pkg)
      if (prior !== undefined) throw new GateError(`error: the package '${pkg}' is declared by two producers, '${prior}' and '${p.name}'. They write into one shared pool under one filename, so whichever builds second silently replaces the other`)
      pkgProducer.set(pkg, p.name); pkgDir.set(pkg, p.dir); localNames.push(pkg)
    }
  }

  let archivesN = 0, pathsN = 0, scriptsN = 0, allComparedN = 0, virtualResolvedN = 0
  const externals: string[] = [], virtuals: string[] = []
  // sha256 of every Architecture: all archive, per pool, keyed <package>|<pool>.
  const allSha = new Map<string, string>(), allPkgs: string[] = []

  for (const arch of arches) {
    const pool = join(poolRoot, arch, 'pool')
    // This repository's own archives; an imported one beside them (Mica-Source-Repo another repository) is not gated here.
    const fields = new Map<string, Record<string, string>>()
    const debs: string[] = []
    for (const d of readdirSync(pool).filter(f => f.endsWith('.deb')).sort()) {
      const f = controlFields(await controlText(join(pool, d)))
      if ((f['Mica-Source-Repo'] ?? '') !== ownRepo) continue
      fields.set(d, f); debs.push(d)
    }
    if (debs.length === 0) throw new GateError(`error: ${pool} holds no .deb. Every assertion below is a property of the archives in it, and over an empty pool they are all true`)
    archivesN += debs.length
    const field = (d: string, name: string) => fields.get(d)![name] ?? ''

    // Producers building for this pool, including every `all` producer.
    const poolProducers = rows.filter(p => p.arches.includes(arch) || p.arches.includes('all'))
    const expectedSet = [...new Set(poolProducers.flatMap(p => p.packages))].sort()
    const gotNames = debs.map(d => field(d, 'Package'))
    const poolPkgVer = new Map<string, string>()
    for (const d of debs) poolPkgVer.set(field(d, 'Package'), field(d, 'Version'))
    const gotSet = [...gotNames].sort()
    if (gotSet.join(' ') === expectedSet.join(' ')) pass(`${arch}: the pool holds exactly the packages its producers declare and the lock imports (${gotSet.join(' ')})`)
    else fail(`${arch}: the pool holds [${gotSet.join(' ')}], but the producers building for ${arch} declare and the lock imports [${expectedSet.join(' ')}]. A missing package is one the composer cannot install; an extra one is an archive no producer owns and no lock row names. \`make board-pool\` fetches the imports and builds the rest`)

    // h -- per producer, so a failure names the producer to look at.
    for (const p of poolProducers) {
      const found = p.packages.filter(pkg => gotNames.includes(pkg)), missing = p.packages.filter(pkg => !gotNames.includes(pkg))
      if (found.length === 0) fail(`${arch}: the producer '${p.name}' contributed NO archive to ${pool}, though it declares [${p.packages.join(' ')}] and builds for ${arch}. \`make board-pool\` runs every discovered producer; this one built nothing, or its output went somewhere else`)
      else if (missing.length > 0) fail(`${arch}: the producer '${p.name}' contributed only part of what it declares -- missing: ${missing.join(' ')}. A producer emits its whole package set or the pool is a half-built one`)
      else pass(`${arch}: the producer '${p.name}' contributed all of [${p.packages.join(' ')}]`)
    }
    const orphan = gotNames.filter(g => !pkgProducer.has(g))
    if (orphan.length === 0) pass(`${arch}: every archive in the pool maps back to a discovered producer or a lock row`)
    else fail(`${arch}: ${pool} holds archive(s) no discovered producer declares and no lock row names: ${orphan.join(' ')}. Most likely a producer was deleted or renamed and its output was left behind; the index lists it and the composer would install it`)

    // b -- every archive built here carries its producer's declared version.
    const wrong: string[] = []
    for (const d of debs) {
      const n = field(d, 'Package'), v = field(d, 'Version'), want = declaredVersion.get(pkgProducer.get(n) ?? '')
      if (v !== want) wrong.push(`${n}=${v}(declared ${want ?? 'none'})`)
    }
    if (wrong.length === 0) pass(`${arch}: every archive built here carries its producer's declared version (${debs.length} archive(s))`)
    else fail(`${arch}: archive(s) not at their producer's declared version (version.env): ${wrong.join(' ')}. Rebuild them with \`make board-pool\``)

    // Local-virtual names: what this pool's archives declare in Provides.
    const providedBy = new Map<string, string[]>()
    for (const d of debs) {
      for (const pe of fieldEntries(field(d, 'Provides'))) {
        const vname = pe.split(/\s+/)[0]!.split('(')[0]!
        if (vname === '') continue
        providedBy.set(vname, [...(providedBy.get(vname) ?? []), field(d, 'Package')])
      }
    }
    // a -- unversioned Conflicts only; a versioned one leaves a pair co-installable.
    const conflictsWith = new Map<string, string[]>()
    for (const d of debs) {
      for (const ce of fieldEntries(field(d, 'Conflicts'))) {
        const [cname, ...crest] = ce.split(/\s+/)
        if (crest.length > 0 || cname!.includes('(') || cname === '') continue
        conflictsWith.set(field(d, 'Package'), [...(conflictsWith.get(field(d, 'Package')) ?? []), cname!])
      }
    }
    // a -- does <a> name <b> in an unversioned Conflicts, either by its name or by a virtual name <b> provides.
    // A package that provides and conflicts with one virtual name (`Provides: mica-board`, `Conflicts: mica-board`)
    // excludes every other provider without listing them, so a new provider edits no sibling.
    const conflicts = (a: string, b: string) => (conflictsWith.get(a) ?? []).some(c => c === b || (providedBy.get(c) ?? []).includes(b))
    const mutuallyConflicting = (a: string, b: string) => conflicts(a, b) && conflicts(b, a)

    // Every owner of a path, space-separated; a later claimant must conflict with each of them.
    const owner = new Map<string, string[]>()
    for (const d of debs) {
      const deb = join(pool, d)
      const name = field(d, 'Package'), declaredArch = field(d, 'Architecture'), depends = field(d, 'Depends'), replaces = field(d, 'Replaces')
      // b/i -- architecture; `all` is correct in every pool.
      if (declaredArch === arch) { pass(`${name} ${arch}: declares Architecture: ${declaredArch}`) }
      else if (declaredArch === 'all') {
        pass(`${name} ${arch}: declares Architecture: all, a member of every pool`)
        allSha.set(`${name}|${arch}`, sha256(deb))
        if (!allPkgs.includes(name)) allPkgs.push(name)
      }
      else { fail(`${name} in the ${arch} pool declares Architecture: ${declaredArch}. It was packed in the wrong container or filed under the wrong architecture`) }

      // a -- Replaces would let an overlap install cleanly, so it is refused.
      if (replaces === '') pass(`${name} ${arch}: declares no Replaces`)
      else fail(`${name} ${arch}: declares Replaces: ${replaces}. That field exists to let one package take a path from another, which is the overlap the ownership check below refuses; no control template in this tree has one`)

      // b/i -- the Depends closure, three classes.
      const localDeps: string[] = []
      for (const entry of fieldEntries(depends)) {
        for (const alt of entry.split('|').map(a => a.trim())) {
          const depName = alt.split(/\s+/)[0]!.split('(')[0]!
          if (depName === '') continue
          if (!localNames.includes(depName)) {
            // Local-virtual before external.
            if (providedBy.has(depName)) { virtuals.push(depName); virtualResolvedN += 1; pass(`${name} ${arch}: depends on the local virtual ${depName}, provided in this pool by ${providedBy.get(depName)!.join(' ')}`) }
            else { externals.push(depName) }
            continue
          }
          localDeps.push(depName)
          // The version of the package it names, not this archive's own.
          const depVer = poolPkgVer.get(depName)
          if (alt.includes(`(= ${depVer ?? '<not in pool>'})`)) pass(`${name} ${arch}: depends on ${depName} at its exact pool version (= ${depVer})`)
          else if (alt.includes('(')) fail(`${name} ${arch}: depends on the local package ${depName} as '${alt}', which is neither unversioned nor that package's exact pool version (= ${depVer ?? '<not in pool>'})`)
          else fail(`${name} ${arch}: depends on the local package ${depName} as '${alt}', which is not that package's exact pool version (= ${depVer ?? '<not in pool>'}). These are built from one commit across interfaces that carry no compatibility promise`)
          if (!gotNames.includes(depName)) fail(`${name} ${arch}: depends on the local package ${depName}, which is not in ${pool}. The closure over our own packages has to be satisfiable from the pool itself`)
        }
      }
      // Every other package of the micad workspace must depend on micad.
      if ((pkgDir.get(name) ?? '').startsWith('pkgs/micad/') && name !== 'micad') {
        if (localDeps.includes('micad')) pass(`${name} ${arch}: pins micad`)
        else fail(`${name} ${arch}: declares no dependency on micad. Every package of the micad workspace but micad itself is built from micad's commit and speaks its interface`)
      }

      // The payload, read once and used by a, d and e.
      const listing = await payloadEntries(deb)
      // a -- unique ownership of non-directory paths within one pool. The only exemption is a set of packages
      // that all declare mutual unversioned Conflicts (no two can be co-installed); every exempted share is printed.
      const dup: string[] = [], exempt: string[] = []
      for (const entry of listing) {
        if (entry.type === '5') continue
        const path = stripDots(entry.name)
        if (path === '') continue
        pathsN += 1
        const others = owner.get(path)
        if (others !== undefined) {
          if (others.every(o => mutuallyConflicting(name, o))) { owner.set(path, [...others, name]); exempt.push(`/${path} (with ${others.join(', ')})`) }
          else { dup.push(`/${path} (also in ${others.join(', ')})`) }
        }
        else { owner.set(path, [name]) }
      }
      if (exempt.length > 0) pass(`${name} ${arch}: EXEMPT shared path(s), each claimed only by packages that declare mutual unversioned Conflicts and can never be co-installed: ${exempt.join(' ')}`)
      if (dup.length === 0) pass(`${name} ${arch}: owns no non-directory path another package in the pool owns${exempt.length > 0 ? ', beyond the exempted share(s) above' : ''}`)
      else fail(`${name} ${arch}: ships path(s) another package already owns: ${dup.join(' ')}. Two packages owning one file means whichever unpacks second wins, and there is no Replaces here to make that defined`)

      // d -- copyright, present and non-empty.
      const copyright = listing.find(e => stripDots(e.name) === `usr/share/doc/${name}/copyright` && e.type === '0')
      if (copyright !== undefined && copyright.body.length > 0) pass(`${name} ${arch}: ships /usr/share/doc/${name}/copyright (${copyright.body.length} bytes)`)
      else fail(`${name} ${arch}: ships no non-empty /usr/share/doc/${name}/copyright (size: ${copyright === undefined ? 'absent' : copyright.body.length})`)

      // e -- enablement links, counted as symlinks only.
      const links = listing.filter(e => e.type === '2' && stripDots(e.name).startsWith('etc/systemd/system/multi-user.target.wants/')).map(e => './' + stripDots(e.name)).sort()
      const want = wantsExpected.get(name)
      if (want === undefined) fail(`${name} ${arch}: no producer declares an ENABLEMENT row for it, so this gate has no enablement expectation for it`)
      else if (links.length === want) pass(`${name} ${arch}: ${links.length} multi-user.target.wants symlink(s), as ${pkgDir.get(name)}/producer.env declares${links.length > 0 ? ` (${links.join(' ')})` : ''}`)
      else fail(`${name} ${arch}: ships ${links.length} multi-user.target.wants symlink(s)${links.length > 0 ? ` (${links.join(' ')})` : ''}, but ${pkgDir.get(name)}/producer.env declares ${want}. Either the payload gained a link nothing asked for, or lost one it needs, or the declaration is behind the package`)

      // f and g -- the control archive.
      const control = new Map<string, Uint8Array>()
      for (const entry of tarEntries(await controlTar(deb))) if (entry.type === '0') control.set(stripDots(entry.name), entry.body)
      if (control.has('conffiles')) fail(`${name} ${arch}: carries DEBIAN/conffiles. This root is an immutable dm-verity squashfs; a conffile promises dpkg a three-way merge against local edits that cannot exist and cannot be applied`)
      else pass(`${name} ${arch}: carries no DEBIAN/conffiles`)
      for (const s of ['preinst', 'postinst', 'prerm', 'postrm']) {
        const body = control.get(s)
        if (body === undefined) continue
        scriptsN += 1
        const script = join(work, `${arch}-${name}-${s}`)
        writeFileSync(script, body)
        const r = Bun.spawnSync(['sh', '-n', script], { stdout: 'pipe', stderr: 'pipe' })
        if (r.exitCode === 0) pass(`${name} ${arch}: DEBIAN/${s} parses as POSIX sh`)
        else fail(`${name} ${arch}: DEBIAN/${s} is not valid POSIX sh: ${(r.stderr.toString() + r.stdout.toString()).trim()}`)
      }
    }
  }

  // i -- each `all` package is the same bytes in every pool (with one pool gated, the job that merges the pools compares them).
  if (arches.length === 1) say(`note: one pool gated (${arches.join(' ')}); the all-architecture comparison runs where every pool is present`)
  for (const pkg of allPkgs) {
    if (arches.length === 1) continue
    const seen = new Set<string>(), where: string[] = []
    for (const arch of arches) {
      const s = allSha.get(`${pkg}|${arch}`)
      if (s === undefined) continue
      allComparedN += 1
      where.push(`${arch}=${s.slice(0, 16)}`)
      seen.add(s)
    }
    if (seen.size === 1) pass(`${pkg}: Architecture: all, byte-identical in every pool (${where.join(' ')})`)
    else fail(`${pkg}: Architecture: all, but the pools hold DIFFERENT bytes under that one filename (${where.join(' ')}). One build exports into every pool; two differing copies mean the composer installs a different package depending on which pool it resolved`)
  }
  say(`note: local virtual dependencies satisfied by a Provides in the pool: ${[...new Set(virtuals)].sort().join(' ')}`)
  say(`note: external dependencies resolved by the composer, not by this pool: ${[...new Set(externals)].sort().join(' ')}`)

  const staticFail = failN
  const summary = (compared?: number) => `${passN}/${passN + failN} checks passed, ${archivesN} archives, ${pathsN} payload paths, ${scriptsN} maintainer scripts, ${compared === undefined ? '' : `${compared} rebuilt archives compared, `}${allComparedN} all-architecture archives compared, ${virtualResolvedN} local-virtual dependencies resolved`
  if (staticFail !== 0) {
    // The rebuild would overwrite the failing archives, so stop here.
    say('note: the reproducibility check was not run; fix the failures above first')
    const result = `RESULT: FAIL (${summary()})`
    say(result)
    return { pass: passN, fail: failN, result }
  }
  if (staticOnly) {
    say('note: --static: the reproducibility rebuild runs in each architecture\'s own job (--arch)')
    const result = `RESULT: PASS (${summary()})`
    say(result)
    return { pass: passN, fail: failN, result }
  }

  // c -- two builds under one SOURCE_DATE_EPOCH are byte-identical. The rebuild runs on a freshly created
  // builder (empty cache), and its log must contain pack.sh's own line for every archive compared, proving the
  // layer was not replayed. Each architecture rebuilds a different producer.
  if (Bun.spawnSync(['docker', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw new GateError('error: docker is required and not on PATH. The reproducibility check drives a real package build')
  let comparedN = 0
  const builders: string[] = []
  const removeBuilders = () => { for (const b of builders) Bun.spawnSync(['docker', 'buildx', 'rm', b], { stdout: 'pipe', stderr: 'pipe' }) }
  try {
    for (const [i, arch] of arches.entries()) {
      // The rows that build for this pool, in discovery order.
      const candidates = rows.filter(p => p.arches.includes(arch) || p.arches.includes('all'))
      if (candidates.length === 0) throw new GateError(`error: no discovered producer builds for ${arch}, yet ${poolRoot}/${arch}/pool was checked above. The reproducibility check would rebuild nothing`)
      const p = candidates[i % candidates.length]!
      const rebuildArch = p.arches.includes('all') ? 'all' : arch
      const pool = join(poolRoot, arch, 'pool'), before = join(work, 'before', arch)
      mkdirSync(before, { recursive: true })
      const names: string[] = []
      for (const pkg of p.packages) {
        const found = readdirSync(pool).filter(f => (f.startsWith(`${pkg}_`) && f.endsWith(`_${arch}.deb`)) || (f.startsWith(`${pkg}_`) && f.endsWith('_all.deb')))
        if (found.length !== 1) throw new GateError(`error: ${pool} holds ${found.length} archives matching ${pkg}_*_{${arch},all}.deb; the reproducibility check needs exactly the one the rebuild will replace`)
        copyFileSync(join(pool, found[0]!), join(before, found[0]!))
        names.push(found[0]!)
      }
      const builder = `mica-deb-gate-${arch}-${process.pid}`
      const created = Bun.spawnSync(['docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container'], { stdout: 'pipe', stderr: 'pipe' })
      if (created.exitCode !== 0) throw new GateError(`error: creating the builder ${builder} failed: ${created.stderr.toString().trim()}`)
      builders.push(builder)
      const log = join(work, `rebuild-${arch}.log`)
      say(`pool-gate: rebuilding the '${p.name}' producer at --arch ${rebuildArch} for the ${arch} pool on the empty-cache builder '${builder}'`)
      const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'pool-build', '--producer', p.name, '--arch', rebuildArch],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env as Record<string, string>, BUILDX_BUILDER: builder, BUILDKIT_PROGRESS: 'plain', MICA_POOL_DIR: poolRoot } })
      const text = r.stdout.toString() + r.stderr.toString()
      writeFileSync(log, text)
      if (r.exitCode !== 0) {
        fail(`${arch}: the second build of the '${p.name}' producer did not complete; its output is in ${log}`)
        say(text.split('\n').slice(-20).join('\n'))
        continue
      }
      for (const n of names) {
        comparedN += 1
        // pack.sh ran rather than a cached layer being replayed.
        if (text.includes(`pack.sh: ${n} `)) { pass(`${arch}: the second build re-ran pack.sh for ${n} rather than replaying a cached layer`) }
        else { fail(`${arch}: ${log} carries no 'pack.sh: ${n}' line, so the packing layer was served from cache and the comparison below is of an archive with itself. The empty-cache builder is what prevents this`); continue }
        const a = readFileSync(join(before, n)), b = readFileSync(join(pool, n))
        if (Buffer.compare(a, b) === 0) pass(`${arch}: ${n} is byte-identical across two builds at one SOURCE_DATE_EPOCH`)
        else fail(`${arch}: ${n} differs between two builds at one SOURCE_DATE_EPOCH (${a.length} bytes then, ${b.length} bytes now). Something in the packing path is not a function of its inputs`)
      }
      Bun.spawnSync(['docker', 'buildx', 'rm', builder], { stdout: 'pipe', stderr: 'pipe' })
      builders.splice(builders.indexOf(builder), 1)
    }
  }
  finally { removeBuilders() }
  if (comparedN === 0) throw new GateError('error: no archive was rebuilt and compared, so the reproducibility check asserted nothing')
  const result = `RESULT: ${failN === 0 ? 'PASS' : 'FAIL'} (${summary(comparedN)})`
  say(result)
  return { pass: passN, fail: failN, result }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const options: Options = {}
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--arch') {
        if (argv[i + 1] !== 'amd64' && argv[i + 1] !== 'arm64') throw new GateError('error: --arch takes amd64 or arm64')
        options.arch = argv[i + 1]; i += 2
      }
      else if (argv[i] === '--static') { options.static = true; i += 1 }
      else if (argv[i] === '--board') { if (!argv[i + 1]) throw new GateError('error: --board takes a board name'); options.board = argv[i + 1]; i += 2 }
      else { throw new GateError('usage: pool-gate [--board <board>] [--arch <amd64|arm64> | --static]    (it reads the pools under _out/debs)') }
    }
    const r = await gate(options)
    return r.fail === 0 ? 0 : 1
  }
  catch (e) {
    if (e instanceof GateError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['ProducersError', 'BuildError', 'Exit'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
