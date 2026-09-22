import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { makeWorkDir, REPO_ROOT } from './paths.ts'
import { OPEN_TIMEOUT_MS } from './testing.ts'

type JsonObject = Record<string, unknown>

const VALIDATOR = join(REPO_ROOT, 'rootfs/scripts/validate-public-meta.sh')
const EXAMPLE = join(REPO_ROOT, 'meta.example/updates/manifest.json')
const ROOT_BUILD = join(REPO_ROOT, 'rootfs/build.sh')
const MARKER = 'DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n'
let work: string
let meta: string

setDefaultTimeout(OPEN_TIMEOUT_MS)

function example(): JsonObject {
  return JSON.parse(readFileSync(EXAMPLE, 'utf8')) as JsonObject
}

function objectAt(value: JsonObject, key: string): JsonObject {
  return value[key] as JsonObject
}

function writeManifest(value: unknown = example()): void {
  mkdirSync(join(meta, 'updates'), { recursive: true })
  writeFileSync(join(meta, 'updates/manifest.json'), `${JSON.stringify(value, null, 2)}\n`)
}

function validate(path: string = meta) {
  return spawnSync('bash', [VALIDATOR, path], { cwd: work, encoding: 'utf8', timeout: OPEN_TIMEOUT_MS })
}

function output(result: ReturnType<typeof validate>): string {
  return `${result.stdout}${result.stderr}`
}

function expectRefusal(expected: string, path: string = meta): string {
  const result = validate(path)
  const message = output(result)
  expect(result.status, message).toBe(1)
  expect(message).toContain(expected)
  return message
}

beforeEach(() => {
  work = makeWorkDir('public-meta')
  meta = join(work, 'meta')
  writeManifest()
})

afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('repair boundary cases execute the shipped root validator', () => {
  test.each([
    ['schema', '"schema":', '"schema":"DO_NOT_ECHO_DUPLICATE",'],
    ['schema', '"schema":', '"\\u0073chema":"DO_NOT_ECHO_DUPLICATE",'],
    ['product.vendor', '"vendor":', '"vendor":"DO_NOT_ECHO_DUPLICATE",'],
    ['update.policy', '"policy":', '"\\u0070olicy":"DO_NOT_ECHO_DUPLICATE",'],
  ])('duplicate member %s is refused before an earlier value is discarded', (path, key, duplicate) => {
    const raw = JSON.stringify(example()).replace(key, `${duplicate}${key}`)
    writeFileSync(join(meta, 'updates/manifest.json'), raw)
    const message = expectRefusal(path)
    expect(message).toContain('duplicate key')
    expect(message).not.toContain('DO_NOT_ECHO_DUPLICATE')
  })

  test('invalid UTF-8 bytes are refused without substitution or a value dump', () => {
    const value = example()
    objectAt(value, 'product').vendor = 'BINARY_SENTINEL'
    const parts = JSON.stringify(value).split('BINARY_SENTINEL')
    expect(parts).toHaveLength(2)
    writeFileSync(join(meta, 'updates/manifest.json'), Buffer.concat([
      Buffer.from(parts[0]!), Buffer.from([0xff]), Buffer.from('DO_NOT_ECHO_BINARY'), Buffer.from(parts[1]!),
    ]))
    const message = expectRefusal('updates/manifest.json')
    expect(message).toContain('invalid UTF-8')
    expect(message).not.toContain('DO_NOT_ECHO_BINARY')
  })

  test('unique keys, non-ASCII and escaped key-like strings preserve the full u64 boundary', () => {
    const value = example()
    objectAt(value, 'product').vendor = 'München \\"vendor": {"schema": 0}, ["schema"]\n'
    objectAt(value, 'http').credentialHosts = ['one', 'two,"schema":{},three']
    const raw = JSON.stringify(value).replace('München', 'München\\u0020').replace('1440', '18446744073709551615')
    writeFileSync(join(meta, 'updates/manifest.json'), raw)
    const result = validate()
    expect(result.status, output(result)).toBe(0)
  })

  test.each(['meta', 'meta/', 'meta/.', 'meta//./'])('ordinary relative input %s is accepted', (path) => {
    const result = validate(path)
    expect(result.status, output(result)).toBe(0)
  })

  test.each(['', '/', '/.'])('an ancestor symlink is refused with suffix %s', (suffix) => {
    const alias = join(work, 'alias-parent')
    symlinkSync(work, alias)
    expectRefusal('symlink', `${alias}/meta${suffix}`)
  })

  test.each(['/', '/.', '/../meta'])('an input symlink cannot hide behind %s', (suffix) => {
    symlinkSync(meta, join(work, 'meta-alias'))
    expectRefusal('symlink', `meta-alias${suffix}`)
  })
})

describe('required refusal RED cases execute the shipped root validator', () => {
  test('an unexpected updates/root.key is refused by relative path', () => {
    writeFileSync(join(meta, 'updates/root.key'), 'synthetic off-allowlist input\n')
    expectRefusal('updates/root.key')
  })

  test('private PEM material in GENERATED is refused without echoing its bytes', () => {
    writeFileSync(join(meta, 'GENERATED'), '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_BYTES\n')
    const message = expectRefusal('GENERATED')
    expect(message).not.toContain('SYNTHETIC_PRIVATE_BYTES')
  })

  test('an unknown nested manifest key is refused by key path without its value', () => {
    const value = example()
    objectAt(value, 'update').unexpected = 'DO_NOT_ECHO_THIS_VALUE'
    writeManifest(value)
    const message = expectRefusal('update.unexpected')
    expect(message).not.toContain('DO_NOT_ECHO_THIS_VALUE')
  })
})

test.each([false, true])('the exact public set is accepted with marker=%s', (withMarker) => {
  if (withMarker) writeFileSync(join(meta, 'GENERATED'), MARKER)
  const result = validate()
  expect(result.status, output(result)).toBe(0)
})

test('root staging invokes this validator before creating the public staging tree', () => {
  const build = readFileSync(ROOT_BUILD, 'utf8')
  const validation = build.indexOf('bash "$REPO_ROOT/rootfs/scripts/validate-public-meta.sh" "$META_DIR"')
  const staging = build.indexOf('META_STAGE="$(mktemp -d')
  expect(validation).toBeGreaterThan(-1)
  expect(staging).toBeGreaterThan(validation)
})

test('required nullable source and fleet URL accept explicit null', () => {
  const value = example()
  expect(objectAt(value, 'update').source).toBeNull()
  expect(objectAt(value, 'fleet').url).toBeNull()
  const result = validate()
  expect(result.status, output(result)).toBe(0)
})

test.each([
  ['update.source', (value: JsonObject) => { delete objectAt(value, 'update').source }],
  ['fleet.url', (value: JsonObject) => { delete objectAt(value, 'fleet').url }],
])('required field %s cannot be omitted', (path, mutate) => {
  const value = example()
  mutate(value)
  writeManifest(value)
  expectRefusal(path)
})

test.each([
  ['schema', (value: JsonObject) => { value.schema = 'mica/meta/v0' }],
  ['product', (value: JsonObject) => { value.product = [] }],
  ['product.vendor', (value: JsonObject) => { objectAt(value, 'product').vendor = false }],
  ['update.source', (value: JsonObject) => { objectAt(value, 'update').source = 1 }],
  ['update.channel', (value: JsonObject) => { objectAt(value, 'update').channel = '  ' }],
  ['update.policy', (value: JsonObject) => { objectAt(value, 'update').policy = 'download' }],
  ['http.credentialHosts', (value: JsonObject) => { objectAt(value, 'http').credentialHosts = [false] }],
  ['fleet.enabled', (value: JsonObject) => { objectAt(value, 'fleet').enabled = 'false' }],
  ['fleet.url', (value: JsonObject) => { objectAt(value, 'fleet').url = false }],
])('wrong current-contract value at %s is refused', (path, mutate) => {
  const value = example()
  mutate(value)
  writeManifest(value)
  expectRefusal(path)
})

test.each(['off', 'check', 'auto'])('current update mode %s is accepted', (mode) => {
  const value = example()
  objectAt(value, 'update').policy = mode
  writeManifest(value)
  const result = validate()
  expect(result.status, output(result)).toBe(0)
})

test.each(['0', '18446744073709551615'])('checkIntervalMinutes=%s is inside the runtime integer contract', (literal) => {
  const raw = readFileSync(EXAMPLE, 'utf8').replace('1440', literal)
  writeFileSync(join(meta, 'updates/manifest.json'), raw)
  const result = validate()
  expect(result.status, output(result)).toBe(0)
})

test.each([
  ['-1', 'non-negative integer'],
  ['1.5', 'non-negative integer'],
  ['1e3', 'non-negative integer'],
  ['18446744073709551616', 'unsigned 64-bit range'],
])('checkIntervalMinutes=%s is outside the runtime integer contract', (literal, reason) => {
  const raw = readFileSync(EXAMPLE, 'utf8').replace('1440', literal)
  writeFileSync(join(meta, 'updates/manifest.json'), raw)
  const message = expectRefusal('update.checkIntervalMinutes')
  expect(message).toContain(reason)
})

test.each([
  ['manifest missing', () => rmSync(join(meta, 'updates/manifest.json')), 'updates/manifest.json'],
  ['manifest empty', () => writeFileSync(join(meta, 'updates/manifest.json'), ''), 'updates/manifest.json'],
  ['updates directory missing', () => rmSync(join(meta, 'updates'), { recursive: true }), 'updates'],
])('%s is refused', (_name, mutate, expected) => {
  mutate()
  expectRefusal(expected)
})

test('malformed JSON is refused without dumping its bytes', () => {
  writeFileSync(join(meta, 'updates/manifest.json'), '{"schema":"SECRET_SENTINEL"')
  const message = expectRefusal('invalid JSON')
  expect(message).not.toContain('SECRET_SENTINEL')
})

test.each([
  ['root dotfile', '.hidden'],
  ['nested extra', 'updates/extra.json'],
])('off-allowlist %s is refused', (_name, relative) => {
  writeFileSync(join(meta, relative), 'synthetic extra\n')
  expectRefusal(relative)
})

test.each([
  ['manifest.unexpected', (value: JsonObject) => { value.unexpected = true }],
  ['product.unexpected', (value: JsonObject) => { objectAt(value, 'product').unexpected = true }],
  ['http.unexpected', (value: JsonObject) => { objectAt(value, 'http').unexpected = true }],
  ['fleet.unexpected', (value: JsonObject) => { objectAt(value, 'fleet').unexpected = true }],
])('unknown key %s is refused at its exact level', (path, mutate) => {
  const value = example()
  mutate(value)
  writeManifest(value)
  expectRefusal(path)
})

test.each(['updates/manifest.json', 'GENERATED'])('%s cannot be a symlink', (relative) => {
  const target = join(work, relative === 'GENERATED' ? 'marker-target' : 'manifest-target')
  writeFileSync(target, relative === 'GENERATED' ? MARKER : readFileSync(EXAMPLE))
  rmSync(join(meta, relative), { force: true })
  symlinkSync(target, join(meta, relative))
  expectRefusal(relative)
})

test('the updates parent cannot be a symlink', () => {
  const target = join(work, 'updates-target')
  mkdirSync(target)
  writeFileSync(join(target, 'manifest.json'), readFileSync(EXAMPLE))
  rmSync(join(meta, 'updates'), { recursive: true })
  symlinkSync(target, join(meta, 'updates'))
  expectRefusal('updates')
})

test('the public input directory cannot itself be a symlink', () => {
  const alias = join(work, 'meta-alias')
  symlinkSync(meta, alias)
  expectRefusal('public metadata directory', alias)
})

test.each(['updates/manifest.json', 'GENERATED'])('%s must be a regular file', (relative) => {
  rmSync(join(meta, relative), { force: true })
  const fifo = spawnSync('mkfifo', [join(meta, relative)], { encoding: 'utf8' })
  expect(fifo.status, output(fifo)).toBe(0)
  expectRefusal(relative)
})

test.each(['updates/manifest.json', 'GENERATED'])('private material is scanned in %s', (relative) => {
  const sentinel = '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_SENTINEL_BYTES\n'
  writeFileSync(join(meta, relative), sentinel)
  const message = expectRefusal(relative)
  expect(message).not.toContain('PRIVATE_SENTINEL_BYTES')
})
