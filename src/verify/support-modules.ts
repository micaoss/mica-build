// The module index of a support image, held to its tree: what modprobe and the device managers read to load a
// driver when its device appears (udev on systemd, mica-mdev on OpenRC). depmod wrote modules.dep and modules.alias
// at build time; a module missing from them never loads by name or by device, and an entry without its module
// fails the load it names.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The module name kmod knows a module file by: its file name without .ko, - read as _. */
function moduleName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.ko$/, '').replace(/-/g, '_')
}

/** True when a module's .modinfo declares a device alias (the module a device's modalias loads). */
function declaresAlias(module: Buffer): boolean {
  for (let at = module.indexOf('alias='); at >= 0; at = module.indexOf('alias=', at + 1))
    if (at === 0 || module[at - 1] === 0) return true
  return false
}

/** Why the module index of `dir` (modules/<release>) does not describe its tree, or undefined; a summary when it does. */
export function moduleIndexProblem(dir: string): { problem?: string, modules: number, aliased: number } {
  const ko = (readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.ko') && statSync(join(dir, f)).isFile()).sort()
  for (const index of ['modules.dep', 'modules.alias']) if (!existsSync(join(dir, index))) return { problem: `Support ${index} missing`, modules: ko.length, aliased: 0 }
  const listed = new Map<string, string[]>()
  for (const line of readFileSync(join(dir, 'modules.dep'), 'utf8').split('\n').filter(Boolean)) {
    const at = line.indexOf(':')
    if (at < 0) return { problem: `Support modules.dep has a line that is not <module>: <dependencies>: ${line}`, modules: ko.length, aliased: 0 }
    listed.set(line.slice(0, at), line.slice(at + 1).trim().split(/\s+/).filter(Boolean))
  }
  const missing = ko.filter(f => !listed.has(f))
  if (missing.length > 0) return { problem: `Support modules.dep does not list ${missing.length} module(s) of the tree: ${missing.slice(0, 5).join(', ')}`, modules: ko.length, aliased: 0 }
  for (const [m, deps] of listed)
    for (const f of [m, ...deps]) if (!ko.includes(f)) return { problem: `Support modules.dep names ${f}, which the tree does not hold`, modules: ko.length, aliased: 0 }

  const names = new Set(ko.map(moduleName))
  const aliasedBy = new Set<string>()
  for (const line of readFileSync(join(dir, 'modules.alias'), 'utf8').split('\n').filter(l => l.startsWith('alias '))) {
    const module = line.trim().split(/\s+/).at(-1)!
    if (!names.has(module)) return { problem: `Support modules.alias names ${module}, which the tree does not hold`, modules: ko.length, aliased: 0 }
    aliasedBy.add(module)
  }
  const unaliased = ko.filter(f => declaresAlias(readFileSync(join(dir, f))) && !aliasedBy.has(moduleName(f)))
  if (unaliased.length > 0) return { problem: `Support modules.alias misses the device aliases of ${unaliased.slice(0, 5).join(', ')}: their devices would not load them`, modules: ko.length, aliased: aliasedBy.size }
  return { modules: ko.length, aliased: aliasedBy.size }
}
