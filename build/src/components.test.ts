import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Signer } from '../../shared/update-envelope.ts'
import fixtures from '../../tests/component-contracts/cases.json'
import {
  canonicalJson, componentId, deploymentIdentity, deploymentPaths, parseDeployment, productFromConf,
  verifyDeployment, verifyObject,
} from './components.ts'

const payload = readFileSync(new URL('../../tests/component-contracts/deployment.json', import.meta.url), 'utf8')
const golden = JSON.parse(readFileSync(new URL('../../tests/component-contracts/envelope.json', import.meta.url), 'utf8'))
/** The fixture holds the envelope as a JSON object; on the wire its keys are in contract order. */
const goldenEnvelope = JSON.stringify({ schema: golden.envelope.schema, keyId: golden.envelope.keyId, payload: golden.envelope.payload, signature: golden.envelope.signature })

test('the shared deployment has stable content identities and fixed paths', () => {
  const descriptor = parseDeployment(payload)
  expect(componentId(descriptor)).toBe(fixtures.deploymentId)
  const paths = deploymentPaths(descriptor)
  expect(paths.rootfs).toBe(`roots/${descriptor.rootfs.id}/rootfs.img`)
  expect(paths.support).toBe(`kernels/${descriptor.kernel.id}/support.img`)
  expect(paths.boot).toBe(`EFI/mica/kernels/${descriptor.kernel.id}.efi`)
})

test('board-specific boot formats and multi-level verity trees use the same contract', () => {
  for (const board of ['x64', 'virt-arm64', 'cx3576', 's905x5m']) {
    for (const [blocks, treeBlocks] of [[1, 0], [128, 1], [129, 3], [16385, 132]]) {
      const value = structuredClone(fixtures.valid)
      value.board = value.kernel.board = board
      value.arch = value.kernel.arch = value.rootfs.arch = board === 'x64' ? 'amd64' : 'arm64'
      value.kernel.boot.format = board === 'x64' || board === 'virt-arm64' ? 'uki' : 'fit'
      value.rootfs.content.verity.dataBlocks = blocks!
      value.rootfs.content.verity.hashOffset = blocks! * 4096
      value.rootfs.content.image.bytes = (blocks! + treeBlocks!) * 4096
      value.kernel.id = componentId(value.kernel)
      value.rootfs.id = componentId(value.rootfs)
      const d = parseDeployment(canonicalJson(value))
      expect(deploymentPaths(d).boot.endsWith(d.kernel.boot.format === 'uki' ? '.efi' : '/boot.itb')).toBe(true)
    }
  }
})

describe('shared malformed descriptors', () => {
  for (const fixture of fixtures.invalid) {
    test(fixture.name, () => {
      const value = structuredClone(fixtures.valid) as Record<string, unknown>
      const path = fixture.pointer.slice(1).split('/')
      let parent = value
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>
      parent[path.at(-1)!] = fixture.value
      expect(() => parseDeployment(canonicalJson(value))).toThrow()
    })
  }
})

test('reject duplicate keys, unknown fields, noncanonical JSON and excessive input', () => {
  expect(() => parseDeployment(payload.replace('"generation":1', '"generation":2,"generation":1'))).toThrow()
  expect(() => parseDeployment(`${payload}\n`)).toThrow()
  expect(() => parseDeployment(' '.repeat(16385))).toThrow()
})

test('verify the existing server envelope against a separately supplied public anchor', () => {
  expect(canonicalJson(verifyDeployment(goldenEnvelope, [golden.publicKey], fixtures.context))).toBe(payload)
})

test('the product row identities come out of the authenticated descriptor', () => {
  const descriptor = parseDeployment(payload)
  expect(deploymentIdentity(goldenEnvelope, [golden.publicKey])).toEqual({ product: descriptor.product, board: descriptor.board,
    generation: descriptor.generation, deployment: fixtures.deploymentId, kernel: descriptor.kernel.id, rootfs: descriptor.rootfs.id,
    kernelBuildId: descriptor.kernel.buildId })
  expect(() => deploymentIdentity(goldenEnvelope, [Buffer.alloc(32).toString('base64')])).toThrow()
})

test('refuse envelope tampering, untrusted keys and schema substitution', () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const signer = new Signer(privateKey, true)
  const envelope = signer.sign(JSON.parse(payload))
  const check = (value: unknown, keys = [signer.publicKey]) => verifyDeployment(JSON.stringify(value), keys, fixtures.context)
  expect(canonicalJson(check(envelope))).toBe(payload)
  expect(() => check(envelope, [golden.publicKey])).toThrow()
  expect(() => check({ ...envelope, signature: Buffer.alloc(64).toString('base64') })).toThrow()
  expect(() => check({ ...envelope, keyId: '0'.repeat(64) })).toThrow()
  expect(() => check({ ...envelope, extra: true })).toThrow()
  expect(() => check({ ...envelope, payload: `${envelope.payload}\n` })).toThrow()
  expect(() => check(signer.sign({ schema: 'mica/update-catalog/v1' }))).toThrow()
  expect(() => verifyDeployment(JSON.stringify(envelope).replace('"keyId":', '"keyId":"duplicate","keyId":'), [signer.publicKey], fixtures.context)).toThrow()
})

test('bind the selected kernel and its support image to authenticated early-boot identity', () => {
  for (const [key, value] of Object.entries({ board: 'virt-arm64', arch: 'arm64', kernelBuildId: '0'.repeat(64), kernelRelease: '6.1-other', supportId: '0'.repeat(64) })) {
    expect(() => verifyDeployment(goldenEnvelope, [golden.publicKey], { ...fixtures.context, [key]: value })).toThrow()
  }
})

test('a signed descriptor cannot replace support verity metadata while retaining its claimed image digest', () => {
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  const value = structuredClone(fixtures.valid)
  value.kernel.support.rootHash = '3'.repeat(64)
  value.kernel.id = componentId(value.kernel)
  const envelope = signer.sign(JSON.parse(canonicalJson(value)))
  expect(() => verifyDeployment(JSON.stringify(envelope), [signer.publicKey], fixtures.context)).toThrow()
})

test('artifact length and digest both bind object bytes before publication', () => {
  const data = Buffer.from('component')
  const artifact = { bytes: data.length, sha256: '0'.repeat(64) }
  // Use an independently computed digest for the successful case.
  const hash = new Bun.CryptoHasher('sha256').update(data).digest('hex')
  expect(() => verifyObject(data, { ...artifact, sha256: hash })).not.toThrow()
  expect(() => verifyObject(data, artifact)).toThrow()
  expect(() => verifyObject(data, { bytes: data.length + 1, sha256: hash })).toThrow()
})

describe('the device product (contract product block and productCases)', () => {
  test('the product.conf fixture names the valid descriptor\'s product', () => {
    expect(productFromConf(fixtures.product.fixture)).toBe(fixtures.product.product)
    expect(parseDeployment(payload).product).toBe(fixtures.product.product)
  })
  for (const c of fixtures.productCases) {
    test(c.name, () => {
      const value = structuredClone(fixtures.valid) as Record<string, unknown>
      if ('remove' in c && c.remove) delete value[c.remove.slice(1)]
      const install = () => {
        const d = parseDeployment(canonicalJson(value))
        if (d.product !== c.device) throw new Error('deployment targets another product')
      }
      if (c.result === 'accepted') expect(install).not.toThrow()
      else expect(install).toThrow()
    })
  }
  test('a missing, repeated, quoted or malformed PRODUCT line is refused', () => {
    for (const conf of ['BOARD=x64\n', 'PRODUCT=x64-dev\nPRODUCT=x64-dev\n', 'PRODUCT="x64-dev"\n', 'PRODUCT=x64 dev\n', 'PRODUCT=\n']) {
      expect(() => productFromConf(conf)).toThrow()
    }
  })
})
