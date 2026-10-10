// The core components of a product: mica-core's packages that ship as components of the deployment
// (mica-core:docs/mica-core.md 2), composed over the root at boot instead of installed into it.
//
// A product carries the components of its pool whose features it names (FEATURES in product.env): `micad`
// selects micad, `ui` selects mica-apid-ui. The selection is refused when a component does not run on the
// root interface level this tree's roots carry, or needs a component the product does not carry or carries at
// a version outside the range it accepts -- a deployment the device would refuse when it reads it.
import { poolComponents, type Component } from '../pool/core-items.ts'
import { compareVersions, runsOn, type CoreComponent } from './components.ts'

export class CoreSelectionError extends Error {}

/** The root interface level this tree's roots carry (mica/rootfs/v1). It moves only when one of the interfaces
 * mica-core:docs/mica-core.md 6.5 lists for it changes incompatibly, not with an ordinary root release. */
export const ROOT_INTERFACE_LEVEL = 1

export type Selected = { component: Component, record: Omit<CoreComponent, 'id' | 'content'> & { content: Omit<CoreComponent['content'], 'signature'> } }

type SelectionRecord = Pick<CoreComponent, 'package' | 'version' | 'features' | 'needs' | 'root'>

/** mica-core's selection rule (component-contracts/core-set.json `selectionRule`), the one a device applies to its
 * core set: the components with a feature among `features`, in package order, each running on `rootLevel`, every
 * need selected at a version in range. Selecting nothing is not a refusal. Each refusal begins with mica-core's own
 * sentence and goes on to name the component. */
export function selectComponents<T extends SelectionRecord>(components: T[], features: string[], rootLevel: number): T[] {
  const selected = components.filter(c => c.features.some(f => features.includes(f))).sort((a, b) => (a.package < b.package ? -1 : 1))
  for (const r of selected) {
    if (!runsOn(r, rootLevel))
      throw new CoreSelectionError(`a selected core component does not run on this root's interface level: ${r.package} ${r.version} runs on root interface levels ${r.root.min}..${r.root.max ?? ''}, the root is level ${rootLevel}`)
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

/** The components of `pool` (one architecture's pool directory) the features select, sorted by package. */
export function selectCores(pool: string, arch: string, features: string[], rootLevel = ROOT_INTERFACE_LEVEL): Selected[] {
  const all = poolComponents(pool, arch).map(component => ({ component, record: JSON.parse(new TextDecoder().decode(component.record.bytes)) as Selected['record'] }))
  const chosen = new Set(selectComponents(all.map(s => s.record), features, rootLevel))
  return all.filter(s => chosen.has(s.record)).sort((a, b) => (a.record.package < b.record.package ? -1 : 1))
}
