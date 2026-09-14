import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVISIONING_DOCUMENT, assembleFileImage } from './file-image.ts'
import { parseFileLayout } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'
import type { Toolbox } from './toolbox.ts'

// A factory seed rides on the ESP, which only a UEFI board has; the refusal
// for a FIT board fires before any toolbox is opened, so no tool runs here.
test('a factory seed is refused for a FIT board, by name, before anything is assembled', async () => {
  const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'))
  const never = new Proxy({}, { get: () => { throw new Error('the toolbox must not be touched') } }) as unknown as Toolbox
  await expect(assembleFileImage(layout, [], [], '/nowhere', '/nowhere/out', never, { provisioning: '/tmp/seed.toml' }))
    .rejects.toThrow(`no ESP to carry ${PROVISIONING_DOCUMENT}`)
})

test('without a seed the two-deployment rule is the first refusal, as before', async () => {
  const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/x64/board.env'), 'utf8'))
  const never = new Proxy({}, { get: () => { throw new Error('the toolbox must not be touched') } }) as unknown as Toolbox
  await expect(assembleFileImage(layout, [], [], '/nowhere', '/nowhere/out', never)).rejects.toThrow('two deployments')
})
