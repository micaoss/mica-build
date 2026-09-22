// Select installed runtime payloads offline; never execute a target program.
//
//   bun src/rootfs/runtime/select.ts select --root R --output O --packages P --inventory I --ownership D --report J [--rules RULES] --arch amd64|arm64
//   bun src/rootfs/runtime/select.ts verify --root R --report J
//
// Inputs reuse selected package names, manifest.tsv and captured dpkg info/*.list. Consumer declarations describe
// runtime reasons, not a second package inventory. The port of rootfs/runtime/select.py (deleted 2026-09-22), rule
// for rule and message for message; the report it writes is the Python's bytes (pyjson.ts).
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { elfInfo, readLoaderCache, type ElfInfo } from './elf.ts'
import { cmpStr, hostPath, kinds, lchown, listxattr, lstatBig, lutimesNs, metadata, normalized, privilege, pyError, Refusal, removexattr, require, setxattr, sha256File, treePaths, type Node } from './fsx.ts'
import { equal, parse, pretty, type Value } from './pyjson.ts'

export type Origin = { package: string, version: string, architecture: string } | { generated: string }
export type FileRow = Node & { path: string, origins: Origin[], reasons: string[], hardlink?: string, runtime_link?: RuntimeLink }
export type RuntimeLink = { path: string, target: string, generator: string, ordering: string, test: string, requires: string[] }
export type Report = { architecture: string, consumers: string[], inputs: Value, files: FileRow[], external_inputs: (Node & { path: string })[], [k: string]: Value }
type Rule = { paths: string[], packages?: string[], kind: string, reason: string, generated?: string, expect?: Record<string, Value> }
type Declaration = { roots: Rule[], runtime_links: RuntimeLink[] }
export type Declarations = { consumers: Record<string, Declaration>, library_dirs: string[], path: string[] }
type Context = { loaded: Map<string, string>, seen: Set<string>, queue: [string, ElfInfo, string[], string[]][] }

export type SelectArgs = { root: string, output: string, packages: string, inventory: string, ownership: string, report: string, rules: string, arch: string }

function isSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every(x => b.has(x))
}
function subset<T>(a: Set<T>, b: Set<T>): boolean {
  return [...a].every(x => b.has(x))
}
/** fnmatch.fnmatchcase over one path component. */
function fnmatch(name: string, pattern: string): boolean {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') { re += '.*' }
    else if (c === '?') { re += '.' }
    else if (c === '[') {
      let j = i + 1
      if (j < pattern.length && pattern[j] === '!') j++
      if (j < pattern.length && pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) { re += '\\[' }
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, '\\\\')
        i = j
        if (stuff[0] === '!') stuff = '^' + stuff.slice(1)
        else if (stuff[0] === '^') stuff = '\\' + stuff
        re += '[' + stuff + ']'
      }
    }
    else { re += c.replace(/[.+^${}()|\\]/g, '\\$&') }
  }
  return new RegExp(re + '$', 's').test(name)
}
function nodeOf(row: FileRow): Node {
  const { path: _p, origins: _o, reasons: _r, hardlink: _h, runtime_link: _l, ...node } = row
  return node as Node
}
function countSlashes(p: string): number {
  return p.split('/').length - 1
}
function parentOf(path: string): string {
  const d = dirname(path)
  return d
}
/** Path.parents of an absolute path, nearest first, ending with '/'. */
function parents(path: string): string[] {
  const out: string[] = []
  let p = path
  while (p !== '/') { p = dirname(p); out.push(p) }
  return out
}

export class Selector {
  readonly root: string
  readonly output: string
  readonly report: string
  readonly machine: number
  readonly triplet: string
  readonly arch: string
  readonly packages = new Map<string, { package: string, version: string, architecture: string }>()
  readonly owners = new Map<string, Set<string>>()
  readonly ownershipPackages = new Set<string>()
  readonly declarations: Declarations
  readonly inputs: Value
  readonly libraryDirs: string[]
  readonly path: string[]
  readonly consumers: string[] = []
  readonly files = new Map<string, FileRow & { reasonSet: Set<string> }>()
  readonly generated = new Map<string, string>()
  readonly links = new Map<string, RuntimeLink>()
  readonly bindings = new Map<string, string>()
  readonly paths: string[]
  readonly cache: Map<string, string[]>

  constructor(args: SelectArgs) {
    this.root = hostPath(args.root)
    this.output = hostPath(args.output)
    this.report = hostPath(args.report)
    require(existsSync(this.root) && lstatSync(this.root).isDirectory(), 'installed root is missing')
    const under = (a: string, b: string) => a.startsWith(b + '/')
    require(!(this.root === this.output || under(this.output, this.root) || under(this.root, this.output)), 'input/output overlap')
    require(!existsSync(this.output) || (lstatSync(this.output).isDirectory() && readdirSync(this.output).length === 0), 'output must be empty')
    require(!existsSync(this.report), 'report already exists')
    require(!under(this.report, this.root) && !under(this.report, this.output), 'report must be outside runtime roots')
    ;[this.machine, this.triplet] = ({ amd64: [62, 'x86_64-linux-gnu'], arm64: [183, 'aarch64-linux-gnu'] } as Record<string, [number, string]>)[args.arch]!
    this.arch = args.arch
    for (const line of readFileSync(args.inventory, 'utf8').split('\n').slice(0, -1)) {
      if (line.startsWith('#')) continue
      const row = line.split('\t')
      require(row.length === 3 && row.every(f => f) && /^[a-z0-9][a-z0-9+.-]*$/.test(row[0]!), 'invalid manifest.tsv row')
      const [name, version, arch] = row as [string, string, string]
      require(!this.packages.has(name), `duplicate package: ${name}`)
      require(arch === args.arch || arch === 'all', `package architecture: ${name}`)
      this.packages.set(name, { package: name, version, architecture: arch })
    }
    require(this.packages.size > 0, 'empty package inventory')
    const lists = readdirSync(args.ownership).filter(f => f.endsWith('.list')).sort(cmpStr).map(f => join(args.ownership, f))
    require(lists.length > 0, 'no captured dpkg ownership lists')
    for (const file of lists) {
      const stem = file.slice(file.lastIndexOf('/') + 1, -5)
      const i = stem.indexOf(':'), name = i < 0 ? stem : stem.slice(0, i), arch = i < 0 ? '' : stem.slice(i + 1)
      require(this.packages.has(name) && (!arch || arch === this.packages.get(name)!.architecture), `unknown ownership package: ${stem}.list`)
      require(!this.ownershipPackages.has(name), `duplicate ownership list: ${name}`)
      this.ownershipPackages.add(name)
      for (const line of readFileSync(file, 'utf8').split('\n').slice(0, -1)) {
        require(line === normalized(line) || line === '/.', `ambiguous ownership path: ${line}`)
        const [canonical] = this.resolve(normalized(line), false, true)
        if (!this.owners.has(canonical)) this.owners.set(canonical, new Set())
        this.owners.get(canonical)!.add(name)
      }
    }
    this.declarations = parse(readFileSync(args.rules, 'utf8')) as unknown as Declarations
    this.inputs = {
      inventory_sha256: sha256File(args.inventory), selection_sha256: sha256File(args.packages), rules_sha256: sha256File(args.rules),
      ownership_sha256: Object.fromEntries(lists.map(p => [p.slice(p.lastIndexOf('/') + 1), sha256File(p)])),
    }
    require(isSet(new Set(Object.keys(this.declarations)), new Set(['consumers', 'library_dirs', 'path'])), 'invalid declaration fields')
    this.libraryDirs = this.declarations.library_dirs.map(p => normalized(p.replaceAll('{triplet}', this.triplet)))
    this.path = this.declarations.path.map(p => normalized(p))
    require(this.libraryDirs.length > 0 && this.path.length > 0, 'empty loader/PATH contract')
    for (const line of readFileSync(args.packages, 'utf8').split('\n').slice(0, -1)) {
      const name = line.split('#', 1)[0]!.trim()
      if (!name) continue
      require(!this.consumers.includes(name), `duplicate selected consumer: ${name}`)
      require(this.declarationKey(name) !== undefined, `no runtime declaration: ${name}`)
      require(this.packages.has(name), `selected consumer not installed: ${name}`)
      require(this.ownershipPackages.has(name), `missing ownership list: ${name}`)
      this.consumers.push(name)
    }
    require(this.consumers.length > 0, 'empty consumer selection')
    this.paths = treePaths(this.root)
    const [cache] = this.resolve('/etc/ld.so.cache', true, true)
    this.cache = existsSync(this.at(cache)) ? readLoaderCache(new Uint8Array(readFileSync(this.at(cache))), args.arch) : new Map()
    const [preload] = this.resolve('/etc/ld.so.preload', true, true)
    if (existsSync(this.at(preload))) {
      require(!readFileSync(this.at(preload), 'utf8').split('\n').some(line => line.split('#', 1)[0]!.trim()),
        'unsupported loader preload: declare and review its load policy first')
    }
  }

  at(path: string): string {
    return join(this.root, path.replace(/^\/+/, ''))
  }

  resolve(path: string, followLeaf = true, missing = false): [string, string[]] {
    normalized(path)
    const pending = path.split('/').filter(part => part !== '' && part !== '.')
    const current: string[] = []
    const links: string[] = []
    while (pending.length > 0) {
      const part = pending.shift()!
      if (part === '..') {
        require(current.length > 0, `path escape: ${path}`)
        current.pop()
        continue
      }
      const candidate = '/' + [...current, part].join('/')
      const at = this.at(candidate)
      let mode: bigint
      try {
        mode = lstatBig(at).mode
      }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') {
          if (missing) return [normalized('/' + [...current, part, ...pending].join('/')), links]
          throw new Refusal(`missing path: ${candidate}`)
        }
        throw e
      }
      if (kinds.isLnk(mode) && (followLeaf || pending.length > 0)) {
        require(!links.includes(candidate) && links.length < 40, `symlink cycle: ${candidate}`)
        links.push(candidate)
        const target = readlinkSync(at)
        require(target !== '' && !/[\0\n\r\t]/.test(target), `invalid link: ${candidate}`)
        pending.unshift(...target.split('/').filter(part => part !== '' && part !== '.'))
        if (target.startsWith('/')) current.length = 0
      }
      else {
        require(pending.length === 0 || kinds.isDir(mode), `non-directory ancestor: ${candidate}`)
        current.push(part)
      }
    }
    return ['/' + current.join('/'), links]
  }

  excluded(path: string): boolean {
    return ['/boot/', '/usr/lib/debug/', '/usr/lib/modules/', '/usr/lib/firmware/'].some(p => path.startsWith(p))
      // Exact removals already performed by hwdb-remove.sh and package-manager-purge.sh, respectively. Other
      // missing owned paths still fail; this is not a missing-path filter.
      || ['/usr/bin/systemd-hwdb', '/usr/sbin/pam_getenv',
        '/usr/lib/udev/hwdb.bin', '/etc/udev/hwdb.bin', '/usr/lib/systemd/system/systemd-hwdb-update.service',
        '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service',
        '/etc/systemd/system/sysinit.target.wants/systemd-hwdb-update.service'].includes(path)
        || ['/usr/lib/udev/hwdb.d/', '/etc/udev/hwdb.d/'].some(p => path.startsWith(p))
  }

  retain(path: string, reason: string): void {
    const have = this.files.get(path)
    if (have) { have.reasonSet.add(reason); return }
    require(!this.excluded(path), `excluded runtime payload: ${path}`)
    const info = metadata(this.at(path))
    const owners = this.owners.get(path) ?? new Set<string>()
    require(info.type === 'directory' || owners.size <= 1, `ambiguous ownership: ${path}`)
    const origins: Origin[] = [...owners].sort(cmpStr).map(p => this.packages.get(p)!)
    if (this.generated.has(path)) origins.push({ generated: this.generated.get(path)! })
    require(origins.length > 0, `no origin: ${path}`)
    this.files.set(path, { path, ...info, origins, reasons: [], reasonSet: new Set([reason]) })
    if (path !== '/') this.retain(parentOf(path), `parent of ${path}`)
  }

  add(path: string, reason: string, executable = false, inherited: string[] = [], scripts: string[] = [], context: Context | null = null, requested: string | null = null): void {
    path = normalized(path)
    const [physical, pathLinks] = this.resolve(path, false)
    for (const parent of pathLinks) this.add(parent, `path link for ${path}`, false, inherited, scripts, context)
    this.retain(physical, reason)
    const row = this.files.get(physical)!
    if (this.links.has(physical)) {
      const contract = this.links.get(physical)!
      require(row.type === 'symlink', `runtime link must be a symlink: ${physical}`)
      require(!executable && readlinkSync(this.at(physical)) === contract.target, `runtime link target changed: ${physical}`)
      row.runtime_link = contract
      for (const required of contract.requires) this.add(required, `runtime link producer for ${physical}`)
      return
    }
    if (row.type === 'symlink') {
      let resolved: string, links: string[]
      try {
        ;[resolved, links] = this.resolve(path)
      }
      catch (e) {
        if (e instanceof Refusal) throw new Refusal(`broken link ${path}: ${e.message}`)
        throw e
      }
      for (const link of links) {
        if (link === physical) this.retain(link, `symlink for ${path}`)
        else this.add(link, `symlink for ${path}`, false, inherited, scripts, context)
      }
      this.add(resolved, `link target of ${path}`, executable, inherited, scripts, context, requested)
      return
    }
    if (executable) {
      require(row.type === 'file' && (row.mode & 0o111) !== 0, `not executable: ${physical}`)
      require(!scripts.includes(physical), `interpreter cycle: ${physical}`)
    }
    if (row.type !== 'file') return
    const data = new Uint8Array(readFileSync(this.at(physical)))
    if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
      const info = elfInfo(data, this.machine, physical)
      const entry = context === null
      if (context === null) context = { loaded: new Map(), seen: new Set(), queue: [] }
      // Retention is global; loader discovery and first context are per entry.
      for (const name of [requested, info.soname]) {
        if (name === null) continue
        if (!name.includes('/')) {
          require(!this.bindings.has(name) || this.bindings.get(name) === physical, `ambiguous library ${name}: ${physical}`)
          this.bindings.set(name, physical)
        }
        require(!context.loaded.has(name) || context.loaded.get(name) === physical, `ambiguous library ${name}: ${physical}`)
        context.loaded.set(name, physical)
      }
      if (!context.seen.has(physical)) {
        context.seen.add(physical)
        context.queue.push([physical, info, inherited, scripts])
      }
      if (entry) this.elfDependencies(context)
    }
    else if (data[0] === 0x23 && data[1] === 0x21) {
      const nl = data.indexOf(0x0a)
      const line = nl < 0 ? data : data.subarray(0, nl)
      require(line.length < 256, `oversized shebang: ${physical}`)
      // str.split(None, 1): the interpreter, then the rest of the line as one word.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(2)).trim()
      const words = text === '' ? [] : /\s/.test(text) ? [text.split(/\s+/)[0]!, text.replace(/^\S+\s+/, '')] : [text]
      require(words.length > 0 && words[0]!.startsWith('/'), `invalid shebang: ${physical}`)
      const interp = words[0]!
      try {
        this.add(interp, `script interpreter of ${physical}`, true, [], [...scripts, physical])
        if (interp === '/usr/bin/env') {
          require(words.length === 2 && /^[A-Za-z0-9_.+-]+$/.test(words[1]!), `unsupported env shebang: ${physical}`)
          let found: string | undefined
          for (const directory of this.path) {
            const [candidate] = this.resolve(directory + '/' + words[1], true, true)
            if (existsSync(this.at(candidate))) { found = directory + '/' + words[1]; break }
          }
          require(found !== undefined, `missing env command: ${words[1]}`)
          this.add(found, `env command of ${physical}`, true, [], [...scripts, physical])
        }
      }
      catch (e) {
        if (e instanceof Refusal) throw new Refusal(`script interpreter of ${physical}: ${e.message}`)
        throw e
      }
    }
    else if (executable) { throw new Refusal(`unsupported executable format: ${physical}`) }
  }

  elfDependencies(context: Context): void {
    while (context.queue.length > 0) {
      const [physical, info, inherited, scripts] = context.queue.shift()!
      if (info.interp) {
        try {
          this.add(info.interp, `ELF interpreter of ${physical}`, true, [], [...scripts, physical], context)
        }
        catch (e) {
          if (e instanceof Refusal) throw new Refusal(`ELF interpreter of ${physical}: ${e.message}`)
          throw e
        }
      }
      const rpath = info.runpath === null ? this.searchDirs(info.rpath, physical) : []
      const runpath = this.searchDirs(info.runpath, physical)
      const ancestors = [...new Set([...rpath, ...inherited])]
      const search = (info.runpath === null ? [...ancestors] : []).concat(runpath)
      for (const needed of info.needed) {
        const name = this.expand(needed, physical)
        let candidates: string[]
        if (name.includes('/')) { candidates = [normalized(name)] }
        else {
          const cached = this.cache.get(name) ?? []
          const identities = new Set(cached.map(p => this.resolve(p, true, true)[0]))
          require(identities.size <= 1, `ambiguous cache library: ${name}`)
          candidates = [...search.map(p => normalized(p + '/' + name)), ...cached, ...this.libraryDirs.map(p => normalized(p + '/' + name))]
        }
        let found = context.loaded.get(name)
        for (const candidate of found === undefined ? candidates : []) {
          const [target, links] = this.resolve(candidate, true, true)
          for (const link of links) {
            const [linkTarget] = this.resolve(link, true, true)
            require(existsSync(this.at(linkTarget)), `broken link for shared library ${needed}: ${candidate}`)
          }
          if (existsSync(this.at(target))) { found = candidate; break }
        }
        require(found !== undefined, `unresolved shared library ${needed} for ${physical}`)
        const [canonical] = this.resolve(found)
        require(existsSync(this.at(canonical)) && lstatSync(this.at(canonical)).isFile(), `shared library is not a file: ${found}`)
        const head = new Uint8Array(readFileSync(this.at(canonical))).subarray(0, 4)
        require(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46, `shared library is not ELF: ${found}`)
        this.add(found, `DT_NEEDED ${needed} of ${physical}`, false, ancestors, [], context, name)
      }
    }
  }

  expand(value: string, source: string): string {
    const origin = dirname(source)
    value = value.replaceAll('${ORIGIN}', origin).replaceAll('$ORIGIN', origin)
    require(!value.includes('$'), `unsupported loader token: ${source}`)
    return value
  }

  searchDirs(value: string | null, source: string): string[] {
    if (value === null) return []
    return value.split(':').map(part => normalized(this.expand(part, source)))
  }

  /**
   * The declaration a consumer is under: its own name, or a family's. A declaration keyed `<prefix>-*` covers every
   * package `<prefix><name>` (the board packages, one per board, are one declaration), so a new member is composed
   * with no edit here; in the family's rules the key itself stands for the member.
   */
  declarationKey(consumer: string): string | undefined {
    if (consumer in this.declarations.consumers) return consumer
    const families = Object.keys(this.declarations.consumers).filter(k => k.endsWith('-*') && consumer.startsWith(k.slice(0, -1)) && consumer.length > k.length - 1)
    require(families.length <= 1, `consumer in several declaration families: ${consumer}`)
    return families[0]
  }

  select(): Report {
    const roots: [string, string, Rule][] = []
    for (const consumer of this.consumers) {
      const key = this.declarationKey(consumer)!
      const declaration = this.declarations.consumers[key]!
      require(isSet(new Set(Object.keys(declaration)), new Set(['roots', 'runtime_links'])) && declaration.roots.length > 0, `invalid consumer declaration: ${consumer}`)
      for (const link of declaration.runtime_links) {
        require(isSet(new Set(Object.keys(link)), new Set(['path', 'target', 'generator', 'ordering', 'test', 'requires']))
          && (['path', 'target', 'generator', 'ordering', 'test'] as const).every(k => typeof link[k] === 'string' && link[k])
          && Array.isArray(link.requires), `invalid runtime link: ${consumer}`)
        const path = normalized(link.path)
        normalized(link.target.startsWith('/') ? link.target : dirname(path) + '/' + link.target)
        const [physical] = this.resolve(path, false)
        require(!this.links.has(physical), `duplicate runtime link: ${physical}`)
        require(link.requires.length > 0 || link.target === '/dev/null', `runtime link has no producer resources: ${path}`)
        this.links.set(physical, link)
        roots.push([path, consumer, { paths: [path], kind: 'resource', reason: 'runtime link contract' }])
      }
      for (let rule of declaration.roots) {
        const keys = new Set(Object.keys(rule))
        require(subset(keys, new Set(['paths', 'packages', 'kind', 'reason', 'generated', 'expect'])) && subset(new Set(['paths', 'kind', 'reason']), keys)
          && rule.paths.length > 0 && rule.reason && ['executable', 'resource', 'directory'].includes(rule.kind), `invalid root rule: ${consumer}`)
        const patterns = rule.paths.map(p => p.replaceAll('{triplet}', this.triplet))
        for (const p of patterns) require(p === normalized(p) && !p.includes('**'), `ambiguous root pattern: ${p}`)
        let matches: string[]
        if (rule.packages && rule.packages.length > 0) {
          require(rule.packages.length > 0 && !rule.generated, `owned rule needs packages: ${consumer}`)
          rule = { ...rule, packages: rule.packages.map(p => (p === key ? consumer : p)) }
          for (const pkg of rule.packages!) {
            require(this.packages.has(pkg), `root package not installed: ${pkg}`)
            require(this.ownershipPackages.has(pkg), `missing ownership list: ${pkg}`)
          }
          // Match each path component: '*' never becomes recursive copying.
          const wanted = new Set(rule.packages)
          matches = [...this.owners.keys()].sort(cmpStr).filter(p => [...this.owners.get(p)!].some(o => wanted.has(o))
            && patterns.some(pattern => p.split('/').length === pattern.split('/').length && p.split('/').every((a, i) => fnmatch(a, pattern.split('/')[i]!)))
            && !this.excluded(p))
          if (rule.kind === 'executable') matches = matches.filter(p => !kinds.isDir(lstatBig(this.at(p)).mode))
          require(matches.length > 0, `empty owned runtime roots: ${consumer}: ${pyList(patterns)}`)
        }
        else {
          require(!patterns.some(p => /[*?[]/.test(p)), `glob requires owned rule: ${consumer}`)
          matches = patterns
        }
        for (const path of matches) {
          const [physical] = this.resolve(path, false)
          if (rule.generated) {
            require(!this.generated.has(physical) || this.generated.get(physical) === rule.generated, `ambiguous generated origin: ${physical}`)
            this.generated.set(physical, rule.generated)
          }
          roots.push([path, consumer, rule])
        }
      }
    }
    for (const [path, consumer, rule] of roots) {
      this.add(path, `${consumer}: ${rule.reason}`, rule.kind === 'executable')
      const [physical] = this.resolve(path, false)
      const row = this.files.get(physical)!
      if (rule.kind === 'directory') require(row.type === 'directory', `not a directory: ${physical}`)
      const expected = rule.expect ?? {}
      require(subset(new Set(Object.keys(expected)), new Set(['mode', 'uid', 'gid', 'xattrs', 'target', 'sha256'])), `invalid expected metadata: ${path}`)
      for (const [k, value] of Object.entries(expected)) {
        const actual = (row as unknown as Record<string, Value>)[k]
        if (k === 'xattrs') {
          const want = value as Record<string, string>, have = (actual ?? {}) as Record<string, string>
          require(Object.entries(want).every(([n, v]) => have[n] === v), `required xattrs changed (${Object.keys(want).join(', ')}): ${path}`)
        }
        else { require(equal(actual === undefined ? null : actual, value), `required ${k} changed: ${path}`) }
      }
    }
    if (this.cache.size > 0) this.add('/etc/ld.so.cache', 'target loader cache used for dependency resolution')
    // Copyright links can themselves introduce another package contributor.
    const licensed = new Set<string>()
    for (;;) {
      const contributors = new Set<string>()
      for (const row of this.files.values()) if (row.type !== 'directory') for (const o of row.origins) if ('package' in o) contributors.add(o.package)
      const pending = [...contributors].filter(p => !licensed.has(p)).sort(cmpStr)
      if (pending.length === 0) break
      for (const pkg of pending) {
        this.add(`/usr/share/doc/${pkg}/copyright`, `license for retained package ${pkg}`)
        licensed.add(pkg)
      }
    }
    const groups = new Map<string, string>()
    const files: FileRow[] = []
    for (const path of [...this.files.keys()].sort(cmpStr)) {
      const info = this.files.get(path)!
      info.reasons = [...info.reasonSet].sort(cmpStr)
      if (info.type === 'file') {
        const st = statSync(this.at(path), { bigint: true })
        const k = `${st.dev}:${st.ino}`
        if (!groups.has(k)) groups.set(k, path)
        info.hardlink = groups.get(k)!
      }
      const { reasonSet: _s, ...row } = info
      files.push(row)
    }
    const external = this.paths.filter(p => ['/boot/', '/usr/lib/debug/', '/usr/lib/modules/', '/usr/lib/firmware/'].some(x => p.startsWith(x)))
      .map(p => ({ path: p, ...metadata(this.at(p)) }))
    return { architecture: this.arch, consumers: this.consumers, inputs: this.inputs, files, external_inputs: external }
  }

  /**
   * Every path of the installed root that the selection does not carry, classified: `excluded` is a rule saying so
   * out loud; `owned` is a path a package ships that no consumer claimed; `unowned` is a path no package ships,
   * written by a maintainer script or the bootstrap, which nothing can prove and only a declaration can keep.
   */
  dropped(report: Report): [string, string, string][] {
    const kept = new Set(report.files.map(r => r.path))
    const rows: [string, string, string][] = []
    for (const path of treePaths(this.root)) {
      if (kept.has(path)) continue
      const why = this.excluded(path) ? 'excluded' : this.owners.has(path) ? 'owned' : 'unowned'
      rows.push([path, why, privilege(this.at(path))])
    }
    return rows
  }

  copy(report: Report, publish = true): void {
    if (!existsSync(this.output)) mkdirSync(this.output)
    const copiedGroups = new Map<string, string>()
    const byDepth = [...report.files].sort((a, b) => countSlashes(a.path) - countSlashes(b.path) || cmpStr(a.path, b.path))
    for (const row of byDepth) {
      const source = this.at(row.path)
      const target = join(this.output, row.path.replace(/^\/+/, ''))
      require(equal(metadata(source) as unknown as Value, nodeOf(row) as unknown as Value), `source changed during selection: ${row.path}`)
      if (row.type === 'directory') { if (!existsSync(target)) mkdirSync(target) }
      else if (row.type === 'symlink') { symlinkSync(row.target!, target) }
      else {
        const group = row.hardlink!
        if (copiedGroups.has(group)) { linkSync(copiedGroups.get(group)!, target) }
        else {
          copyFileSync(source, target)
          copiedGroups.set(group, target)
        }
      }
    }
    // chown clears capabilities/set-ID bits. Restore mode then xattrs last. Directories are last so child creation
    // cannot change recorded mtimes.
    const deepestFirst = [...report.files].sort((a, b) => countSlashes(b.path) - countSlashes(a.path) || cmpStr(a.path, b.path))
    for (const row of deepestFirst) {
      const target = join(this.output, row.path.replace(/^\/+/, ''))
      lchown(target, row.uid, row.gid)
      if (row.type !== 'symlink') chmodSync(target, row.mode)
      for (const name of listxattr(target)) if (!(name in row.xattrs)) removexattr(target, name)
      for (const [name, value] of Object.entries(row.xattrs)) setxattr(target, name, Buffer.from(value, 'hex'))
      lutimesNs(target, BigInt(row.mtime_ns))
    }
    verify(this.output, report)
    if (publish) {
      const fd = openSync(this.report, 'wx')
      closeSync(fd)
      writeFileSync(this.report, pretty(report as unknown as Value) + '\n')
    }
  }
}

function pyList(items: string[]): string {
  return '[' + items.map(s => `'${s}'`).join(', ') + ']'
}

export function verify(root: string, report: Report): void {
  const rows = new Map(report.files.map(row => [row.path, row]))
  const paths = treePaths(root)
  require(rows.size === report.files.length && paths.length === rows.size && paths.every(p => rows.has(p)), 'runtime paths changed')
  const groups = new Map<string, string>(), reverse = new Map<string, string>()
  for (const [path, row] of rows) {
    require(path === normalized(path), `ambiguous report path: ${path}`)
    for (const parent of parents(path)) {
      require(rows.get(parent)?.type === 'directory', `ancestor changed: ${path}`)
      require(!lstatSync(join(root, parent.replace(/^\/+/, ''))).isSymbolicLink(), `ancestor changed: ${path}`)
    }
    const target = join(root, path.replace(/^\/+/, ''))
    require(equal(metadata(target) as unknown as Value, nodeOf(row) as unknown as Value), `metadata or bytes changed: ${path}`)
    if (row.type === 'file') {
      const st = statSync(target, { bigint: true }), inode = `${st.dev}:${st.ino}`
      const group = row.hardlink!
      if (!groups.has(group)) groups.set(group, inode)
      if (!reverse.has(inode)) reverse.set(inode, group)
      require(groups.get(group) === inode && reverse.get(inode) === group, `hardlink changed: ${path}`)
    }
  }
}

export function loadReport(path: string): Report {
  return parse(readFileSync(path, 'utf8')) as unknown as Report
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

export async function main(argv: string[]): Promise<number> {
  const rules = resolve(import.meta.dir, 'consumers.json')
  try {
    if (argv[0] === 'verify') {
      const a = parseArgs(argv.slice(1), ['root', 'report'])
      verify(hostPath(a.root!), loadReport(a.report!))
    }
    else if (argv[0] === 'select') {
      const a = parseArgs(argv.slice(1), ['root', 'output', 'packages', 'inventory', 'ownership', 'report', 'arch'], { rules })
      require(a.arch === 'amd64' || a.arch === 'arm64', `argument --arch: invalid choice: '${a.arch}' (choose from 'amd64', 'arm64')`)
      const selector = new Selector(a as SelectArgs)
      selector.copy(selector.select())
    }
    else { throw new Refusal('the following arguments are required: command (select, verify)') }
    console.log('runtime selection: verified')
    return 0
  }
  catch (e) {
    if (e instanceof Refusal || (e instanceof Error && ('code' in e || e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError))) {
      console.error(`runtime selection refused: ${pyError(e)}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
