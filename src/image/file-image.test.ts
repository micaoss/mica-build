import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PROVISIONING_DOCUMENT, assembleFileImage, checkKernelLayout } from './file-image.ts'
import { loadLayout } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'
import type { Toolbox } from './toolbox.ts'

// A factory seed rides on the ESP, which only a UEFI board has; the refusal
// for a FIT board fires before any toolbox is opened, so no tool runs here.
test('a factory seed is refused for a FIT board, by name, before anything is assembled', async () => {
  const layout = loadLayout(join(REPO_ROOT, 'boards/cx3576'))
  const never = new Proxy({}, { get: () => { throw new Error('the toolbox must not be touched') } }) as unknown as Toolbox
  await expect(assembleFileImage(layout, [], [], '/nowhere', '/nowhere/out', never, { provisioning: '/tmp/seed.toml' }))
    .rejects.toThrow(`no ESP to carry ${PROVISIONING_DOCUMENT}`)
})

test('without a seed the two-deployment rule is the first refusal, as before', async () => {
  const layout = loadLayout(join(REPO_ROOT, 'boards/uefi-x64'))
  const never = new Proxy({}, { get: () => { throw new Error('the toolbox must not be touched') } }) as unknown as Toolbox
  await expect(assembleFileImage(layout, [], [], '/nowhere', '/nowhere/out', never)).rejects.toThrow('two deployments')
})

test('assembly refuses a boot policy or storage UUID that differs from the selected layout', async () => {
  const { boardFactsFrom } = await import('./board-facts.ts')
  const { partitionOf } = await import('./file-layout.ts')
  const layout = loadLayout(join(REPO_ROOT, 'boards/cx3576'))
  const facts = boardFactsFrom(join(REPO_ROOT, 'boards/cx3576/board.env'))
  const policy = { board: facts.policy, systemPartUuid: partitionOf(layout, 'system').guid, dataPartUuid: partitionOf(layout, 'data').guid }
  expect(() => checkKernelLayout(policy, facts, layout)).not.toThrow()
  expect(() => checkKernelLayout({ ...policy, board: { ...facts.policy, records: { ...facts.policy.records!, startSector: 262144 } } }, facts, layout)).toThrow('policy')
  expect(() => checkKernelLayout({ ...policy, systemPartUuid: '00000000-0000-4000-8000-000000000002' }, facts, layout)).toThrow('UUID')
  expect(() => checkKernelLayout({ ...policy, dataPartUuid: '00000000-0000-4000-8000-000000000003' }, facts, layout)).toThrow('UUID')
})
