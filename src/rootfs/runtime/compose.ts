// Connect disposable installation, explicit runtime selection and rootfs reports.
//
//   bun src/rootfs/runtime/compose.ts snapshot --root R --output J
//   bun src/rootfs/runtime/compose.ts compare --root R --snapshot J
//   bun src/rootfs/runtime/compose.ts compose --root R --output O --inputs I --arch A --epoch N --debug D --report J [--rules RULES]
//   bun src/rootfs/runtime/compose.ts measure-packed --root R --out DIR
//
// The port of rootfs/runtime/compose.py (deleted 2026-09-22), rule for rule and message for message; the reports
// and snapshots it writes are the Python's bytes (pyjson.ts).
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { canonical, load, validate, type Lineage } from './lineage.ts'
import { cmpStr, hostPath, kinds, lstatBig, lutimesNs, metadata, normalized, pyError, Refusal, require, sha256File, treePaths, xattrsOf } from './fsx.ts'
import { equal, parse, pretty, type Value } from './pyjson.ts'
import { loadReport, Selector, verify, type Declarations, type FileRow, type Report, type SelectArgs } from './select.ts'

type Obj = { [key: string]: Value }

// debootstrap setup_devices_simple creates these in the disposable installation. Capture their identity for
// transfer checks; runtime selection stays strict.
const BOOTSTRAP_DEVICES: Record<string, [number, number]> = {
  '/dev/console': [5, 1], '/dev/full': [1, 7], '/dev/null': [1, 3], '/dev/ptmx': [5, 2],
  '/dev/random': [1, 8], '/dev/tty': [5, 0], '/dev/urandom': [1, 9], '/dev/zero': [1, 5],
}

function devNumbers(rdev: bigint): [number, number] {
  const major = Number(((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn))
  const minor = Number((rdev & 0xffn) | ((rdev >> 12n) & ~0xffn))
  return [major, minor]
}

export function snapshot(root: string): Obj {
  const rows: Obj = {}
  const groups = new Map<string, string>()
  for (const path of treePaths(root)) {
    if (path === '/mica-build-inputs' || path.startsWith('/mica-build-inputs/')) continue
    const at = join(root, path.replace(/^\/+/, ''))
    const st = lstatBig(at)
    let row: Obj
    if (kinds.isChr(st.mode) && path in BOOTSTRAP_DEVICES) {
      const numbers = devNumbers(st.rdev)
      const expected = BOOTSTRAP_DEVICES[path]!
      require(numbers[0] === expected[0] && numbers[1] === expected[1] && Number(st.mode & 0o7777n) === 0o666
        && st.uid === 0n && st.gid === 0n, `bootstrap device identity changed: ${path}`)
      row = { type: 'bootstrap-character-device', major: numbers[0], minor: numbers[1], mode: Number(st.mode & 0o7777n), uid: 0, gid: 0, mtime_ns: st.mtimeNs, xattrs: xattrsOf(at) }
    }
    else { row = metadata(at) as unknown as Obj }
    if (row.type === 'file') {
      const s = statSync(at, { bigint: true })
      const k = `${s.dev}:${s.ino}`
      if (!groups.has(k)) groups.set(k, path)
      row.hardlink = groups.get(k)!
    }
    rows[path] = row
  }
  return rows
}

function writeJson(path: string, data: Value): void {
  closeSync(openSync(path, 'wx'))
  writeFileSync(path, pretty(data) + '\n')
}

type ArchiveRecord = { package: string, version: string, architecture: string, archive_sha256: string, archive: string, source?: { package: string, version: string } }

/** Join existing lock rows and pool control records; never resolve packages. */
function archives(inputs: string, packages: Map<string, { package: string, version: string, architecture: string }>): Map<string, ArchiveRecord> {
  const records = new Map<string, ArchiveRecord>()
  const add = (name: string, version: string, arch: string, digest: string, source: string): void => {
    require(!records.has(name), `ambiguous archive identity: ${name}`)
    require(/^[0-9a-f]{64}$/.test(digest), `invalid archive identity: ${name}`)
    records.set(name, { package: name, version, architecture: arch, archive_sha256: digest, archive: source })
  }
  for (const line of lines(join(inputs, 'upstream.tsv'))) {
    const fields = line.split('\t')
    require(fields.length === 6, 'invalid upstream archive identity')
    const [name, version, arch, digest, url] = fields as [string, string, string, string, string, string]
    add(name, version, arch, digest, url)
  }
  const selected = lines(join(inputs, 'selected.pkgs'))
  for (const paragraph of readFileSync(join(inputs, 'Packages'), 'utf8').trim().split('\n\n')) {
    const fields: Record<string, string> = {}
    for (const line of paragraph.split('\n'))
      if (line.includes(': ') && !line.startsWith(' ')) { const i = line.indexOf(': '); fields[line.slice(0, i)] = line.slice(i + 2) }

    if (fields.Package !== undefined && selected.includes(fields.Package)) add(fields.Package, fields.Version!, fields.Architecture!, fields.SHA256!, fields.Filename!)
  }
  for (const [name, pkg] of packages)
    require(records.has(name) && records.get(name)!.version === pkg.version && records.get(name)!.architecture === pkg.architecture, `missing or mismatched archive identity: ${name}`)

  require(records.size === packages.size && [...records.keys()].every(n => packages.has(n)), 'archive identity set differs from installed inventory')
  const sources = new Map<string, { package: string, version: string }>()
  for (const line of lines(join(inputs, 'sources.tsv'))) {
    const fields = line.split('\t')
    require(fields.length === 3 && fields.every(f => f) && !sources.has(fields[0]!), 'invalid native source identity')
    sources.set(fields[0]!, { package: fields[1]!, version: fields[2]! })
  }
  require(sources.size === packages.size && [...sources.keys()].every(n => packages.has(n)), 'native source identity set differs from inventory')
  for (const [name, record] of records) record.source = sources.get(name)!
  return records
}

/** The lines of a text file, as str.splitlines() yields them (no trailing empty line). */
function lines(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  const out = text.split('\n')
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** Resolve exact native installer outputs, never select an unowned subtree. */
function generatedRules(engine: Selector, inputs: string, configured: Obj): Declarations {
  const rules = engine.declarations
  const roots = rules.consumers['mica-system']!.roots
  const publicProducer = 'rootfs/build.sh public-meta staging; compose-install.sh meta_install'
  const publicRules = roots.filter(r => r.generated === publicProducer)
  if (publicRules.length > 0) {
    const manifest = '/usr/share/mica/meta/updates/manifest.json'
    const product = '/usr/lib/mica/product.conf'
    const marker = '/usr/share/mica/meta/GENERATED'
    // Two declared public files -- the manifest and the product record -- and the marker, declared here when captured.
    const declared = new Map(publicRules.filter(r => r.paths.length === 1).map(r => [r.paths[0]!, r]))
    require(publicRules.length === 2 && declared.size === 2 && declared.has(manifest) && declared.has(product), 'ambiguous public metadata declaration')
    for (const directory of ['/usr/share/mica/meta', '/usr/share/mica/meta/updates', '/usr/lib/mica']) {
      const at = engine.at(directory)
      require((configured[directory] as Obj | undefined)?.type === 'directory' && existsSync(at) && lstatSync(at).isDirectory() && !lstatSync(at).isSymbolicLink(),
        `public metadata directory changed: ${directory}`)
    }
    for (const path of [manifest, product, marker]) {
      const original = configured[path] as Obj | undefined
      const at = engine.at(path)
      if (path === marker && original === undefined) {
        require(!existsSync(at) && !isLink(at), 'uncaptured public metadata marker')
        continue
      }
      require(original !== undefined && original.type === 'file' && Number(original.size) > 0, `public metadata capture must be a nonempty regular file: ${path}`)
      require(existsSync(at) && lstatSync(at).isFile() && sha256File(at) === original.sha256, `public metadata changed after capture: ${path}`)
      const expected: Obj = { mode: 0o644, uid: 0, gid: 0, sha256: original.sha256! }
      if (declared.has(path)) declared.get(path)!.expect = expected
      else roots.push({ paths: [path], kind: 'resource', reason: 'captured nonempty public development marker', generated: publicProducer, expect: expected })
    }
  }
  for (const [directory, manifest, pattern] of [['alternatives', 'alternative-names.txt', '*'], ['enablement', 'enablement-names.txt', '*.dsh-also']] as const) {
    const names = lines(join(inputs, manifest))
    const files = readdirSync(join(inputs, directory)).filter(n => pattern === '*' || n.endsWith(pattern.slice(1)))
    require(names.length === new Set(names).size && names.length === files.length && names.every(n => files.includes(n))
      && files.every(f => lstatSync(join(inputs, directory, f)).isFile() && !lstatSync(join(inputs, directory, f)).isSymbolicLink()), `captured native outputs changed: ${directory}`)
  }
  const generated = (path: string, producer: string, target?: string): void => {
    require(path === normalized(path), `invalid generated path: ${path}`)
    const row: (typeof roots)[number] = { paths: [path], kind: 'resource', reason: 'captured native installer output', generated: producer }
    if (target !== undefined) {
      const [physical] = engine.resolve(path, false)
      require(isLink(engine.at(physical)), `generated link must be a symlink: ${path}`)
      row.expect = { target }
    }
    roots.push(row)
  }
  for (const file of readdirSync(join(inputs, 'alternatives')).sort(cmpStr)) {
    const text = readFileSync(join(inputs, 'alternatives', file), 'utf8')
    const paragraphs = text.trim().split('\n\n')
    const header: Record<string, string> = {}
    for (const line of paragraphs[0]!.split('\n')) if (line.includes(': ') && !line.startsWith(' ')) { const i = line.indexOf(': '); header[line.slice(0, i)] = line.slice(i + 2) }
    const name = header.Name!, link = header.Link!, value = header.Value!
    require(/^[A-Za-z0-9+_.-]+$/.test(name) && name === file, 'invalid alternative name')
    const producer = `update-alternatives --query ${name}; captured native dpkg state`
    generated(link, producer, '/etc/alternatives/' + name)
    generated('/etc/alternatives/' + name, producer, value)
    // The header names slave links; the selected alternative names targets.
    const selected = paragraphs.slice(1).filter(p => p.split('\n')[0] === 'Alternative: ' + value)
    require(selected.length === 1, `no unique selected alternative: ${name}`)
    const pairs = (paragraph: string): Record<string, string> => Object.fromEntries(paragraph.split('\n').filter(l => l.startsWith(' ')).map((l) => { const t = l.trim(); const i = t.search(/\s/); return [t.slice(0, i), t.slice(i).trim()] }))
    const slaves = pairs(paragraphs[0]!), targets = pairs(selected[0]!)
    for (const [slave, path] of Object.entries(slaves)) {
      require(slave in targets, `missing selected alternative slave: ${slave}`)
      if (path.startsWith('/usr/share/man/') && targets[slave]!.startsWith('/usr/share/man/')) {
        require(lines(join(inputs, 'dpkg-slim.conf')).includes('path-exclude /usr/share/man/*'), 'missing manual-page exclusion authority')
        require(!(path in configured) && !(targets[slave]! in configured), `excluded alternative manual page was installed: ${path}`)
        continue
      }
      generated(path, producer, '/etc/alternatives/' + slave)
      generated('/etc/alternatives/' + slave, producer, targets[slave]!)
    }
  }
  const removed = new Map<string, string>()
  for (const line of lines(join(inputs, 'preset-removed.tsv'))) {
    const [path, source] = line.split('\t') as [string, string]
    require(!removed.has(path) && (configured[path] as Obj | undefined)?.type === 'symlink', `invalid preset removal: ${path}`)
    require(!isLink(engine.at(path)) && !existsSync(engine.at(path)), `preset removal survived: ${path}`)
    removed.set(path, source)
  }
  for (const file of readdirSync(join(inputs, 'enablement')).filter(f => f.endsWith('.dsh-also')).sort(cmpStr)) {
    for (const path of lines(join(inputs, 'enablement', file))) {
      require(path.startsWith('/etc/systemd/system/'), `unknown native enablement path: ${path}`)
      const original = configured[path] as Obj | undefined
      // update-state also records potential links under a disabled preset. Only configured outputs activate a
      // conditional producer; once captured, losing that output needs the exact removal record below.
      if (original === undefined) {
        require(!isLink(engine.at(path)) && !existsSync(engine.at(path)), `uncaptured enablement appeared: ${path}`)
        continue
      }
      require(original.type === 'symlink', `native enablement capture is not a link: ${path}`)
      if (removed.has(path)) {
        roots.push({ paths: [removed.get(path)!], kind: 'resource', reason: `preset-enforce.sh removed ${path}` })
        continue
      }
      const target = original.target as string
      const absolute = target.startsWith('/') ? target : dirname(path) + '/' + target
      const [canonicalPath] = engine.resolve(absolute, true, true)
      const owners = engine.owners.get(canonicalPath)
      if (engine.excluded(canonicalPath) || (owners !== undefined && (owners.has('apt') || owners.has('dpkg')))) {
        require(!isLink(engine.at(path)) && !existsSync(engine.at(path)), `installer enablement survived removal: ${path}`)
        continue
      }
      if (!engine.owners.has(path)) generated(path, `deb-systemd-helper ${file}; captured native enablement`, target)
    }
  }
  // A generated leaf can need a package-unowned parent. Name only those exact directory inodes, preserving their
  // configured metadata without contents.
  const explicit = new Set<string>()
  for (const c of engine.consumers) for (const r of rules.consumers[engine.declarationKey(c)!]!.roots) if (r.generated) for (const p of r.paths) explicit.add(p)
  const parentsSet = new Set<string>()
  for (const path of explicit) {
    let parent = dirname(path)
    for (;;) {
      const [physical] = engine.resolve(parent, false)
      if (!engine.owners.has(physical) && !explicit.has(physical)) parentsSet.add(physical)
      if (parent === '/') break
      parent = dirname(parent)
    }
  }
  for (const path of [...parentsSet].sort(cmpStr))
    roots.push({ paths: [path], kind: 'directory', reason: 'parent of declared generated output', generated: 'offline installation and named composition output directories' })
  return rules
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() }
  catch { return false }
}

function debugRecords(directory: string, files: Map<string, FileRow>): Obj {
  const records: Obj = {}
  for (const line of lines(join(directory, 'manifest.tsv'))) {
    if (!line || line.startsWith('#')) continue
    const fields = line.split('\t')
    require(fields.length === 6, 'invalid debug counterpart record')
    const [path, buildId, debug, before, after, digest] = fields as [string, string, string, string, string, string]
    require(files.has(path) && !(path in records) && /^[0-9a-f]{3,}$/.test(buildId), `debug counterpart has no unique shipped binary: ${path}`)
    require(debug === `.build-id/${buildId.slice(0, 2)}/${buildId.slice(2)}.debug`, `debug counterpart path: ${path}`)
    const row = files.get(path)!
    require(row.sha256 === digest && String(row.size) === after && /^[0-9]+$/.test(before), `debug counterpart differs from shipped binary: ${path}`)
    const at = hostPath(join(directory, debug))
    require(existsSync(at) && lstatSync(at).isFile(), `debug counterpart missing: ${path}`)
    records[path] = { build_id: buildId, path: debug, bytes_before: BigInt(before), ...(metadata(at) as unknown as Obj) }
  }
  return records
}

function measurements(root: string, rows: FileRow[]): Obj {
  const groups = new Map<string, FileRow>()
  for (const row of rows) if (row.type === 'file' && !groups.has(row.hardlink!)) groups.set(row.hardlink!, row)
  let allocated = 0n
  for (const p of groups.keys()) allocated += statSync(join(root, p.replace(/^\/+/, '')), { bigint: true }).blocks * 512n
  return {
    apparent_file_bytes: rows.reduce((n, r) => n + (r.size ?? 0), 0),
    unique_file_bytes: [...groups.values()].reduce((n, r) => n + r.size!, 0),
    allocated_file_bytes: allocated,
    unique_file_inodes: groups.size, directories: rows.filter(r => r.type === 'directory').length,
    symlinks: rows.filter(r => r.type === 'symlink').length,
    runtime_allocation: 'pending B7 guest evidence', rss: 'pending B7 guest evidence',
    fresh_image_comparison: 'pending B7 granted image builds',
  }
}

type ComposeArgs = { root: string, output: string, inputs: string, arch: string, epoch: string, debug: string, report: string, rules: string }

function compose(args: ComposeArgs): void {
  const inputs = hostPath(args.inputs)
  const root = hostPath(args.root)
  const epoch = BigInt(args.epoch)
  const sourceLineage: Lineage = validate(load(join(inputs, 'source-lineage.json')), args.arch, epoch)
  require(Buffer.compare(readFileSync(join(inputs, 'source-lineage.json')), Buffer.from(canonical(sourceLineage as unknown as Value))) === 0, 'noncanonical source lineage capture')
  for (const name of ['Packages', 'SHA256SUMS', 'manifest.txt']) require(sha256File(join(inputs, name)) === sourceLineage.pool.files[name], 'source lineage captured pool changed: ' + name)
  const configured = parse(readFileSync(join(inputs, 'configured.json'), 'utf8')) as Obj
  const selectArgs: SelectArgs = { root: args.root, output: args.output, report: args.report, arch: args.arch, rules: args.rules,
    inventory: join(inputs, 'manifest.tsv'), packages: join(inputs, 'selected.pkgs'), ownership: join(inputs, 'info') }
  let engine = new Selector(selectArgs)
  const records = archives(inputs, engine.packages)
  const local = new Map(sourceLineage.pool.packages.map(row => [row.package, row]))
  require(lines(join(inputs, 'selected.pkgs')).every(name => local.has(name)), 'source lineage selected package missing')
  for (const [name, row] of records) {
    if (!local.has(name)) continue
    const expected = local.get(name)!
    require(row.version === expected.version && row.architecture === expected.architecture && row.archive === expected.archive
      && row.archive_sha256 === expected.sha256, 'source lineage installed package mismatch: ' + name)
  }
  const effective = join(inputs, 'runtime-rules.json')
  writeJson(effective, generatedRules(engine, inputs, configured) as unknown as Value)
  selectArgs.rules = effective
  engine = new Selector(selectArgs)
  let report: Report = engine.select()
  const contributors = new Set<string>()
  for (const r of report.files) if (r.type !== 'directory') for (const o of r.origins) if ('package' in o) contributors.add(o.package)
  const [manifestPath] = engine.resolve('/usr/share/mica/manifest.tsv', false)
  const manifest = engine.at(manifestPath)
  require(existsSync(manifest) && lstatSync(manifest).isFile() && !isLink(manifest), 'shipping manifest must be a regular file')
  writeFileSync(manifest, '#package\tversion\tarchitecture\n' + [...contributors].sort(cmpStr).map(p => `${p}\t${records.get(p)!.version}\t${records.get(p)!.architecture}\n`).join(''))
  // The SquashFS time is the same normalization applied before selection; no output inode is rewritten after its
  // exact report has been published.
  const epochNs = epoch * 1000000000n
  require(epochNs >= 0n && epochNs <= 0xffffffffn * 1000000000n, 'invalid SquashFS epoch')
  for (const path of treePaths(root).reverse()) lutimesNs(join(root, path.replace(/^\/+/, '')), epochNs)
  engine = new Selector(selectArgs)
  report = engine.select()
  const files = new Map(report.files.map(row => [row.path, row]))
  for (const path of treePaths(root)) {
    if (path.startsWith('/usr/share/mica/meta/')) {
      require(['/usr/share/mica/meta/updates', '/usr/share/mica/meta/updates/manifest.json', '/usr/share/mica/meta/GENERATED'].includes(path) && files.has(path),
        `undeclared public metadata: ${path}`)
    }
  }
  // EVERY D-BUS ACTIVATION ENTRY MUST NAME A SYSTEMD SERVICE: dbus-daemon starts a SystemdService= entry by asking
  // systemd and forks nothing; a traditional entry would have it fork through the setuid launch helper this
  // composition drops. The one exemption is org.freedesktop.systemd1, whose name PID 1 owns from boot.
  const ownedFromBoot = new Set(['/usr/share/dbus-1/system-services/org.freedesktop.systemd1.service'])
  for (const [path, row] of files) {
    if (path.startsWith('/usr/share/dbus-1/system-services/') && row.type === 'file' && !ownedFromBoot.has(path)) {
      require(readFileSync(join(root, path.replace(/^\/+/, ''))).includes('SystemdService='),
        `traditional D-Bus activation entry: ${path} names no SystemdService=, and the setuid launch helper it would need is not in this root`)
    }
  }
  // DROPBEAR AUTHENTICATES WITHOUT PAM, and that is load-bearing: it is the only route into a fielded device.
  const dropbear = join(root, 'usr/sbin/dropbear')
  if (files.has('/usr/sbin/dropbear') && existsSync(dropbear) && lstatSync(dropbear).isFile()) {
    require(!readFileSync(dropbear).includes('libpam'),
      'the shipped dropbear links libpam: SSH would then depend on the PAM stack, which is the one thing that must not share a failure with the console')
  }
  const forbidden = ['/mica-build-inputs', '/mica-compose', '/.debian-extra', '/debootstrap',
    '/var/lib/dpkg', '/var/lib/apt', '/var/cache/apt', '/var/cache/debconf',
    '/etc/apt', '/etc/dpkg', '/usr/lib/apt', '/usr/lib/dpkg', '/usr/lib/debug']
  for (const path of files.keys()) require(!forbidden.some(prefix => path === prefix || path.startsWith(prefix + '/')), `build residue selected: ${path}`)
  for (const path of treePaths(root)) {
    if (/^\/usr\/(?:local\/)?s?bin\/[^/]+$/.test(path)) {
      const at = join(root, path.replace(/^\/+/, ''))
      // Dangling symlinks and unsupported executables must already refuse through the selector. Check every
      // surviving operator entry too.
      const st = lstatSync(at)
      if (st.isSymbolicLink() || (st.isFile() && (statSync(at).mode & 0o111) !== 0)) require(files.has(path), `operator executable omitted: ${path}`)
    }
  }
  const debug = debugRecords(hostPath(args.debug), files)
  const provenance: Obj = {}
  for (const [path, row] of files) {
    const origins = row.origins
    require(path in configured || origins.some(o => 'generated' in o), `new shipped path has no named producer: ${path}`)
    const { reasons: _r, origins: _o, ...final } = row
    provenance[path] = {
      configured: (configured[path] as Value | undefined) ?? null, final: final as unknown as Value,
      archives: origins.filter(o => 'package' in o).map(o => records.get((o as { package: string }).package)! as unknown as Value),
      generators: origins.filter(o => 'generated' in o).map(o => (o as { generated: string }).generated),
    }
    if (path in debug) (provenance[path] as Obj).debug = debug[path]!
  }
  const captureSha: Obj = {}
  const walkCapture = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmpStr(a.name, b.name))) {
      const p = join(dir, e.name)
      if (e.isDirectory() && !e.isSymbolicLink()) walkCapture(p)
      else if (e.isFile()) captureSha[p.slice(inputs.length + 1)] = sha256File(p)
    }
  }
  walkCapture(inputs)
  report.provenance = {
    source_lineage: sourceLineage as unknown as Value, build_packages: [...records.keys()].sort(cmpStr).map(p => records.get(p)! as unknown as Value),
    shipped_packages: [...contributors].sort(cmpStr).map(p => records.get(p)! as unknown as Value), files: provenance,
    configured_sha256: sha256File(join(inputs, 'configured.json')), capture_sha256: captureSha,
  }
  engine.copy(report, false)
  // THE COMPARISON THAT DID NOT EXIST: what the installed root had and the selection did not carry, classified by
  // why. Written beside the report and counted on stdout.
  const drops = engine.dropped(report)
  writeFileSync(engine.report + '.drops.tsv', drops.map(([path, why, tags]) => `${why}\t${tags}\t${path}\n`).join(''))
  const counts = { excluded: 0, owned: 0, unowned: 0 }
  for (const [, why] of drops) counts[why as keyof typeof counts]++
  const privileged = drops.filter(([, , tags]) => tags).map(([path, , tags]) => [path, tags] as const)
  const carriedCaps = report.files.filter(row => Object.keys(row.xattrs ?? {}).some(name => name.includes('capability'))).length
  console.log(`runtime selection: ${report.files.length} carried, ${drops.length} left behind `
    + `(${counts.excluded} excluded by rule, ${counts.owned} owned by a package and claimed by no consumer, `
    + `${counts.unowned} shipped by no package at all)`)
  // EVERY UNACCOUNTED ENABLEMENT LINK IS EITHER CLAIMED OR RECORDED AS A REMOVAL, and the membership comes from
  // the sweep rather than from a list.
  const carried = new Set(report.files.map(row => row.path))
  const dshAccounted = new Set<string>()
  for (const file of readdirSync(join(inputs, 'enablement')).filter(f => f.endsWith('.dsh-also'))) for (const line of lines(join(inputs, 'enablement', file))) dshAccounted.add(line)
  const presetRemoved = new Set(lines(join(inputs, 'preset-removed.tsv')).filter(l => l).map(l => l.split('\t')[0]!))
  for (const path of Object.keys(configured).sort(cmpStr)) {
    const row = configured[path] as Obj
    if (row.type !== 'symlink' || !path.startsWith('/etc/systemd/system/')) continue
    const parent = dirname(path).slice(dirname(path).lastIndexOf('/') + 1)
    if (!(parent.endsWith('.wants') || parent.endsWith('.requires'))) continue
    if (engine.owners.has(path) || dshAccounted.has(path)) continue
    require(carried.has(path) || presetRemoved.has(path),
      `${path} is an enablement link that NO PACKAGE OWNS and NO deb-systemd-helper record `
      + 'accounts for, and it is neither carried nor recorded in preset-removed.tsv. Both of '
      + 'this composer\'s proofs miss such a link, so it would be dropped in silence -- and '
      + 'the shipped preset may well say `enable`. Claim it in consumers.json, or disable its '
      + 'unit in a preset so the removal is a decision this build can point at')
  }
  for (const [path, why] of drops) {
    if (why !== 'unowned') continue
    const rule = tmpfilesRuleFor(engine, path)
    if (rule === undefined) continue
    require(carried.has(rule),
      `${path} is dropped as unowned and is recreated at boot by a tmpfiles.d rule in `
      + `${rule} -- but ${rule} is NOT carried, so nothing recreates it and nothing else `
      + 'in this composition would have noticed: no package is short a file and no '
      + 'binary is short a library')
  }
  console.log(`runtime selection: ${privileged.length} of the dropped paths are privileged`
    + (privileged.length > 0 ? ': ' + privileged.map(([p, t]) => `${p} (${t})`).join(', ') : '')
    + `; ${carriedCaps} carried file(s) hold a capability`)
  report.measurements = measurements(engine.output, report.files)
  writeJson(engine.report, report as unknown as Value)
}

const TMPFILES_DIRS = ['usr/lib/tmpfiles.d', 'etc/tmpfiles.d']

/**
 * The tmpfiles.d file whose rule creates `path`, or undefined. Read from the INSTALLED root rather than from the
 * composed one; only the line's second field is compared, and only exactly.
 */
function tmpfilesRuleFor(engine: Selector, path: string): string | undefined {
  for (const directory of TMPFILES_DIRS) {
    const base = join(engine.root, directory)
    if (!existsSync(base) || !lstatSync(base).isDirectory()) continue
    for (const ruleFile of readdirSync(base).filter(f => f.endsWith('.conf')).sort(cmpStr)) {
      for (let line of readFileSync(join(base, ruleFile), 'utf8').split('\n')) {
        line = line.trim()
        if (!line || line.startsWith('#')) continue
        const fields = line.split(/\s+/)
        if (fields.length >= 2 && fields[1] === path) return '/' + directory + '/' + ruleFile
      }
    }
  }
  return undefined
}

function measurePacked(args: { root: string, out: string }): void {
  const out = hostPath(args.out)
  const path = join(out, 'rootfs-report.runtime.json')
  const report = loadReport(path)
  verify(hostPath(args.root), report)
  const env = Object.fromEntries(lines(join(out, 'rootfs-verity.env')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
  const image = join(out, 'rootfs-verity.img')
  const size = BigInt(env.SQUASHFS_BYTES!)
  const imageSize = statSync(image, { bigint: true }).size
  require(size > 0n && size < imageSize && imageSize === BigInt(env.IMAGE_BYTES!), 'invalid packed root geometry')
  const data = readFileSync(image)
  require(BigInt(data.length) >= size, 'truncated packed root')
  const digest = createHash('sha256').update(data.subarray(0, Number(size))).digest('hex')
  const m = report.measurements as Obj
  m.squashfs = { bytes: size, sha256: digest }
  m.verity_image = { bytes: imageSize, sha256: sha256File(image), geometry: env }
  m.boot_payload = 'independent signed kernel component; pending B7 matching artifact inputs'
  // This update changes measurements only, after verifying the selected tree.
  writeFileSync(path, pretty(report as unknown as Value) + '\n')
}

function parseArgs(argv: string[], names: string[], defaults: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...defaults }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!, v = argv[i + 1]
    require(k.startsWith('--') && v !== undefined && (names.includes(k.slice(2)) || k.slice(2) in defaults), `unrecognized argument: ${k}`)
    out[k.slice(2)] = v
  }
  for (const n of names) require(n in out, `the following argument is required: --${n}`)
  return out
}

export function main(argv: string[]): number {
  const rules = resolve(import.meta.dir, 'consumers.json')
  try {
    const action = argv[0]
    if (action === 'snapshot') {
      const a = parseArgs(argv.slice(1), ['root', 'output'])
      writeJson(hostPath(a.output!), snapshot(hostPath(a.root!)))
    }
    else if (action === 'compare') {
      const a = parseArgs(argv.slice(1), ['root', 'snapshot'])
      require(equal(snapshot(hostPath(a.root!)), parse(readFileSync(a.snapshot!, 'utf8'))), 'installation transfer changed metadata, bytes or hardlinks')
    }
    else if (action === 'measure-packed') {
      const a = parseArgs(argv.slice(1), ['root', 'out'])
      measurePacked({ root: a.root!, out: a.out! })
    }
    else if (action === 'compose') {
      const a = parseArgs(argv.slice(1), ['root', 'output', 'inputs', 'arch', 'epoch', 'debug', 'report'], { rules })
      compose(a as ComposeArgs)
    }
    else { throw new Refusal('the following arguments are required: action (snapshot, compare, measure-packed, compose)') }
    console.log('runtime composition: verified')
    return 0
  }
  catch (e) {
    if (e instanceof Error && (e instanceof Refusal || e.constructor.name === 'LineageError' || 'code' in e || e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError)) {
      console.error(`runtime composition refused: ${pyError(e)}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
