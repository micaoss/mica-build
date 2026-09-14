import { readFileSync } from 'node:fs'
import { pathInRoot } from './checks-root.ts'

/** Read the package inventory emitted before the finalizer removes dpkg's database. */
export function parsePackageInventory(text: string, columns = 3): ReadonlySet<string> {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line === '') continue
    const fields = line.split('\t')
    const name = fields[0] ?? ''
    if (fields.length !== columns || !/^[a-z0-9][a-z0-9+.-]+$/.test(name)
      || fields.some(f => f === '') || names.has(name)) {
      throw new Error(`invalid or duplicate package inventory row: ${line}`)
    }
    names.add(name)
  }
  if (names.size === 0) throw new Error('package inventory is empty')
  return names
}

export function installedPackages(root: string): ReadonlySet<string> {
  return parsePackageInventory(readFileSync(pathInRoot(root, '/usr/share/mica/manifest.tsv'), 'utf8'))
}
