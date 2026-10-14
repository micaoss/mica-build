// A core set for the core-channel scenarios (core-sets.sh; mica-core:docs/mica-core.md 6.2 "Core sets"): the product's
// core components with micad changed, signed into mica/set/v1 and packed as a core archive. The kernel and the
// root are the device's own; no deployment is made here.
//
//   bun core-set.ts EVIDENCE CERT KEY CORES CHANNEL GENERATION [--micad proof|exits] [--root-max N]
//
//   --micad proof   (default) micad carries usr/share/doc/micad/core-proof naming the set, which the device must show
//   --micad exits   micad is a program that exits at once: a set whose boots never reach healthy
//   --root-max N    every component runs on root interface levels 1..N
//
// Writes EVIDENCE/core-sets/CHANNEL-GENERATION/: cores/, core.micaupd, id (the set's id) and proof.
import { createPrivateKey } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { packCoreArchive } from '../../../src/image/component-archive.ts'
import { COMPONENT_TOOLS, coreRecords, packComponent } from '../../../src/image/component-build.ts'
import { canonicalJson, componentId } from '../../../src/image/components.ts'
import { buildCoreSet, coreSetId } from '../../../src/image/core-set.ts'
import { Toolbox } from '../../../src/image/toolbox.ts'
import { Signer } from '../../../src/shared/update-envelope.ts'

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { 'micad': { type: 'string', default: 'proof' }, 'root-max': { type: 'string' } } })
const [evidenceArg, certArg, keyArg, coreDirArg, channel, generationArg] = positionals
if (!evidenceArg || !certArg || !keyArg || !coreDirArg || !channel || !generationArg || (values.micad !== 'proof' && values.micad !== 'exits'))
  throw new Error('Usage: core-set.ts EVIDENCE CERT KEY CORES CHANNEL GENERATION [--micad proof|exits] [--root-max N]')
const generation = Number(generationArg)
const rootMax = values['root-max'] === undefined ? undefined : Number(values['root-max'])
if (!Number.isSafeInteger(generation) || generation < 1 || (rootMax !== undefined && !(Number.isSafeInteger(rootMax) && rootMax >= 1))) throw new Error('Invalid generation or root level')

const evidence = resolve(evidenceArg)
const output = join(evidence, 'core-sets', `${channel}-${generation}`)
mkdirSync(output, { recursive: true })
const signer = new Signer(createPrivateKey(readFileSync(join(evidence, 'metadata.key.pem'))), true)
const signing = { certificate: resolve(certArg), key: resolve(keyArg) }
const coreDirectory = resolve(coreDirArg)
const core = coreRecords(coreDirectory)
const micad = core.find(c => c.package === 'micad')
if (micad === undefined) throw new Error('the product carries no micad core component to change')
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [evidence, coreDirectory] })
try {
  const tree = join(output, 'core-tree')
  const image = join(output, 'micad.squashfs')
  await tb.must(['dd', `if=${join(coreDirectory, 'micad', 'core.img')}`, `of=${image}`, 'bs=4096', `count=${micad.content.verity.dataBlocks}`, 'status=none'])
  await tb.must(['unsquashfs', '-no-progress', '-d', tree, image])
  const proof = `core-set=${channel}-${generation}\n`
  writeFileSync(join(tree, 'usr/share/doc/micad/core-proof'), proof)
  if (values.micad === 'exits') {
    writeFileSync(join(tree, 'usr/bin/micad'), '#!/bin/sh\necho "micad: the bad core set\'s micad exits" >&2\nexit 1\n')
    chmodSync(join(tree, 'usr/bin/micad'), 0o755)
  }
  const root = rootMax === undefined ? {} : { root: { min: 1, max: rootMax } }
  const cores = join(output, 'cores')
  for (const c of core) {
    if (c.package === 'micad') continue
    cpSync(join(coreDirectory, c.package), join(cores, c.package), { recursive: true })
    if (rootMax !== undefined) {
      const record = { ...c, id: '', ...root }
      record.id = componentId(record)
      writeFileSync(join(cores, c.package, 'core.json'), canonicalJson(record))
    }
  }
  const content = await packComponent(tree, join(cores, 'micad'), 'core', signing, tb)
  const record = { ...micad, id: '', content, ...root }
  record.id = componentId(record)
  writeFileSync(join(cores, 'micad', 'core.json'), canonicalJson(record))
  const payload = buildCoreSet({ channel, arch: micad.arch as 'amd64' | 'arm64', generation, version: micad.version, components: coreRecords(cores) })
  const envelope = JSON.stringify(signer.sign(JSON.parse(payload)))
  packCoreArchive(envelope, cores, [signer.publicKey], join(output, 'core.micaupd'))
  writeFileSync(join(output, 'core-set.json'), envelope)
  writeFileSync(join(output, 'id'), coreSetId(payload))
  writeFileSync(join(output, 'proof'), proof)
  console.log(`FILE_AB_CORE_SET_READY: ${coreSetId(payload)} ${channel} generation ${generation} (micad ${values.micad}${rootMax === undefined ? '' : `, root 1..${rootMax}`})`)
}
finally { await tb.close() }
