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

/** The components of `pool` (one architecture's pool directory) the features select, sorted by package. */
export function selectCores(pool: string, arch: string, features: string[], rootLevel = ROOT_INTERFACE_LEVEL): Selected[] {
  const all = poolComponents(pool, arch).map(component => ({ component, record: JSON.parse(new TextDecoder().decode(component.record.bytes)) as Selected['record'] }))
  const selected = all.filter(s => s.record.features.some(f => features.includes(f))).sort((a, b) => (a.record.package < b.record.package ? -1 : 1))
  for (const { record: r } of selected) {
    if (!runsOn(r, rootLevel))
      throw new CoreSelectionError(`the core component ${r.package} ${r.version} runs on root interface levels ${r.root.min}..${r.root.max ?? ''}; this tree's roots are level ${rootLevel}`)
    for (const need of r.needs) {
      const found = selected.find(s => s.record.package === need.package)
      if (found === undefined) throw new CoreSelectionError(`the core component ${r.package} needs ${need.package}, which the features (${features.join(' ')}) do not select`)
      const v = found.record.version
      if (compareVersions(v, need.min) < 0 || (need.max !== undefined && compareVersions(v, need.max) > 0))
        throw new CoreSelectionError(`the core component ${r.package} needs ${need.package} ${need.min}..${need.max ?? ''}; the pool carries ${v}`)
    }
  }
  return selected
}
