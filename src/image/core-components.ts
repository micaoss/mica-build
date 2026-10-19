// The core components of a product: mica-core's packages that ship as components of the deployment
// (mica-core:docs/mica-core.md 2), composed over the root at boot instead of installed into it.
//
// A product carries the components of its pool whose features it names (FEATURES in product.env): `micad`
// selects micad, `ui` selects mica-apid-ui. The selection is refused when a component does not run on the
// root interface level this tree's roots carry, requires a root package the root provides at a version outside the
// range it accepts, or needs a component the product does not carry or carries at a version outside the range it
// accepts -- a deployment the device would refuse when it reads it.
import { poolComponents, type Component } from '../pool/core-items.ts'
import { compareVersions, describeRequirement, MAX_ROOT_PROVIDES, requirementHolds, runsOn, type CoreComponent, type RootFacts } from './components.ts'

export class CoreSelectionError extends Error {}

/** The root interface level this tree's roots carry (mica/rootfs/v1). It moves only when one of the interfaces
 * mica-core:docs/mica-core.md 6.5 lists for it changes incompatibly, not with an ordinary root release. */
export const ROOT_INTERFACE_LEVEL = 1

export type Selected = { component: Component, record: Omit<CoreComponent, 'id' | 'content'> & { content: Omit<CoreComponent['content'], 'signature'> } }

type SelectionRecord = Pick<CoreComponent, 'package' | 'version' | 'features' | 'needs' | 'root' | 'requires'>

/** What a root of this tree declares to the core components: ROOT_INTERFACE_LEVEL, and as `provides` the mica-*
 * packages of its package database (an installed inventory, `#package\tversion\tarchitecture` lines, as the
 * composition captures it in build-inputs/manifest.tsv), each at its Debian version. */
export function rootFacts(inventory: string): Required<RootFacts> {
  const provides: Record<string, string> = {}
  for (const line of inventory.split('\n')) {
    const [name = '', version = ''] = line.split('\t')
    if (name.startsWith('mica-')) provides[name] = version
  }
  if (Object.keys(provides).length > MAX_ROOT_PROVIDES) throw new CoreSelectionError(`the root carries ${Object.keys(provides).length} mica-* packages, and a root provides at most ${MAX_ROOT_PROVIDES}`)
  return { level: ROOT_INTERFACE_LEVEL, provides }
}

/** mica-core's selection rule (component-contracts/set.json `selectionRule`), the one a device applies to its
 * core set: the components with a feature among `features`, in package order, each held to what it declares of
 * `root` (its interface levels, the root packages it requires), every need selected at a version in range. What a
 * component does not declare is not checked, and selecting nothing is not a refusal. Each refusal begins with
 * mica-core's own sentence and goes on to name the component and the constraint. */
export function selectComponents<T extends SelectionRecord>(components: T[], features: string[], root: RootFacts): T[] {
  const selected = components.filter(c => c.features.some(f => features.includes(f))).sort((a, b) => (a.package < b.package ? -1 : 1))
  for (const r of selected) {
    if (!runsOn(r, root.level))
      throw new CoreSelectionError(`a selected core component does not run on this root's interface level: ${r.package} ${r.version} runs on root interface levels ${r.root!.min}..${r.root!.max ?? ''}, the root is level ${root.level}`)
    const unmet = (r.requires ?? []).find(q => !requirementHolds(q, root))
    if (unmet !== undefined)
      throw new CoreSelectionError(`a selected core component's root requirement does not hold: ${r.package} ${r.version} requires ${describeRequirement(unmet)}, the root provides ${root.provides?.[unmet.package] ?? ''}`)
    for (const need of r.needs) {
      const found = selected.find(s => s.package === need.package)
      if (found === undefined) throw new CoreSelectionError(`a selected core component's need is not selected: ${r.package} needs ${need.package}, which the features (${features.join(' ')}) do not select`)
      const v = found.version
      if (compareVersions(v, need.min) < 0 || (need.max !== undefined && compareVersions(v, need.max) > 0))
        throw new CoreSelectionError(`a core component's need is outside its version range: ${r.package} needs ${need.package} ${need.min}..${need.max ?? ''}, the selection carries ${v}`)
    }
  }
  return selected
}

/** The components of `pool` (one architecture's pool directory) the features select on `root`, sorted by package. */
export function selectCores(pool: string, arch: string, features: string[], root: RootFacts = { level: ROOT_INTERFACE_LEVEL }): Selected[] {
  const all = poolComponents(pool, arch).map(component => ({ component, record: JSON.parse(new TextDecoder().decode(component.record.bytes)) as Selected['record'] }))
  const chosen = new Set(selectComponents(all.map(s => s.record), features, root))
  return all.filter(s => chosen.has(s.record)).sort((a, b) => (a.record.package < b.record.package ? -1 : 1))
}
