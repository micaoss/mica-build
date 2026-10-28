import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChecks, featuresMissing, type CheckCase } from './checks.ts'
import { packedRootFixture } from './checks-fixture.ts'
import { EVERY_FEATURE, PRODUCT_CONF, parseProductConf, readProductConf } from './product-conf.ts'
import { SHIPPED } from './board-scope.ts'
import { verdict } from './verdict.ts'

const CONF = 'PRODUCT=cx3576.dev\nBOARD=cx3576\nPROFILE=dev\nFEATURES="micad mqtt containers wifi bluetooth"\nCOMPONENTS=""\n'

describe('product.conf', () => {
  test('is read as the product, its features and its components', () => {
    const p = parseProductConf(CONF)
    expect(p.name).toBe('cx3576.dev')
    expect(p.board).toBe('cx3576')
    expect([...p.features].sort()).toEqual(['bluetooth', 'containers', 'micad', 'mqtt', 'wifi'])
    expect(p.components.size).toBe(0)
  })
  test('names its init, systemd when absent', () => {
    expect(parseProductConf(CONF).init).toBe('systemd')
    expect(parseProductConf(`${CONF}INIT=openrc\n`).init).toBe('openrc')
  })
  test('names its container engine with containers, podman when absent, and none without containers', () => {
    expect(parseProductConf(CONF).engine).toBe('podman')
    expect(parseProductConf(`${CONF}CONTAINER_ENGINE=docker\n`).engine).toBe('docker')
    expect(parseProductConf(CONF.replace(' containers', '')).engine).toBe('')
  })
  test('names its SSH server with ssh, dropbear when absent, and none without ssh', () => {
    const ssh = CONF.replace('micad', 'micad ssh')
    expect(parseProductConf(ssh).ssh).toBe('dropbear')
    expect(parseProductConf(`${ssh}SSH_SERVER=openssh\n`).ssh).toBe('openssh')
    expect(parseProductConf(CONF).ssh).toBe('')
  })
  test('turns SSH on at first boot only with ssh and SSH=on', () => {
    const ssh = CONF.replace('micad', 'micad ssh')
    expect(parseProductConf(ssh).sshOn).toBe(false)
    expect(parseProductConf(`${ssh}SSH=on\n`).sshOn).toBe(true)
    expect(parseProductConf(`${ssh}SSH=off\n`).sshOn).toBe(false)
    expect(parseProductConf(`${CONF}SSH=on\n`).sshOn).toBe(false)
  })
  test('names its claim policy where it carries one', () => {
    expect(parseProductConf(`${CONF}CLAIM_DEVICE_CODE=off\n`).name).toBe('cx3576.dev')
    expect(parseProductConf(`${CONF}CLAIM_DEVICE_CODE=required\n`).name).toBe('cx3576.dev')
  })
  test('names its mDNS and SSDP settings where it carries them', () => {
    expect(parseProductConf(`${CONF}MDNS=off\nSSDP=on\n`).name).toBe('cx3576.dev')
  })
  test('the minimal image selects nothing', () => {
    expect(parseProductConf(CONF.replace(/FEATURES=.*/, 'FEATURES=""')).features.size).toBe(0)
  })
  test.each([
    ['a missing key', CONF.replace(/PROFILE=.*\n/, ''), 'declares no PROFILE'],
    ['a profile that is neither', CONF.replace('PROFILE=dev', 'PROFILE=staging'), 'neither dev nor prod'],
    ['a line that is not KEY=value', `${CONF}export X=1\n`, 'not a KEY=value line'],
    ['a key twice', `${CONF}PRODUCT=other\n`, 'declared twice'],
    ['an init that is neither', `${CONF}INIT=runit\n`, 'neither systemd nor openrc'],
    ['an engine that is neither', `${CONF}CONTAINER_ENGINE=lxc\n`, 'neither podman nor docker'],
    ['an SSH server that is neither', `${CONF.replace('micad', 'micad ssh')}SSH_SERVER=telnetd\n`, 'neither dropbear nor openssh'],
    ['an SSH switch that is neither', `${CONF}SSH=yes\n`, 'SSH \'yes\' is neither on nor off'],
    ['a claim policy that is neither', `${CONF}CLAIM_DEVICE_CODE=maybe\n`, 'neither required nor off'],
    ['an mDNS setting that is neither', `${CONF}MDNS=yes\n`, 'MDNS \'yes\' is neither on nor off'],
    ['an SSDP setting that is neither', `${CONF}SSDP=\n`, 'SSDP \'\' is neither on nor off'],
  ])('%s is refused by name', (_label, text, fragment) => {
    expect(() => parseProductConf(text)).toThrow(fragment)
  })
  test('a root without the file is refused, naming the composer', () => {
    const fx = packedRootFixture(SHIPPED[0]!)
    try {
      expect(() => readProductConf(fx.root)).toThrow('composed by another composer')
      mkdirSync(join(fx.root, 'usr/lib/mica'), { recursive: true })
      writeFileSync(join(fx.root, PRODUCT_CONF), CONF)
      expect(readProductConf(fx.root).name).toBe('cx3576.dev')
    }
    finally { fx.dispose() }
  })
})

describe('the register is scoped to the product', () => {
  const needsMqtt: CheckCase = { id: 'needs-mqtt', features: ['mqtt'], shell: { pass: 'mqtt ok' },
    run: async () => [verdict('needs-mqtt', true, 'mqtt ok')] }
  const floor: CheckCase = { id: 'floor', shell: { pass: 'floor ok' }, run: async () => [verdict('floor', true, 'floor ok')] }
  test('a check whose feature the product did not select is not run, and says so', async () => {
    const fx = packedRootFixture(SHIPPED[0]!)
    try {
      const minimal = { ...EVERY_FEATURE, name: 'minimal', features: new Set<string>() }
      const run = await runChecks({ ...fx.ctx, product: minimal }, [needsMqtt, floor])
      expect(run.results.map(r => r.id)).toEqual(['floor'])
      expect(run.notRun).toEqual([{ id: 'needs-mqtt', features: ['mqtt'] }])
      const full = await runChecks(fx.ctx, [needsMqtt, floor])
      expect(full.results.map(r => r.id).sort()).toEqual(['floor', 'needs-mqtt'])
      expect(full.notRun).toEqual([])
    }
    finally { fx.dispose() }
  })
  test('featuresMissing names exactly the features the product lacks', () => {
    expect(featuresMissing({ id: 'x', features: ['mqtt', 'wifi'], shell: { pass: 'x' } }, { ...EVERY_FEATURE, features: new Set(['wifi']) })).toEqual(['mqtt'])
    expect(featuresMissing({ id: 'x', shell: { pass: 'x' } }, { ...EVERY_FEATURE, features: new Set() })).toEqual([])
  })
  test('a check of the other init is not run, and says which init it needs', () => {
    const openrc = { ...EVERY_FEATURE, init: 'openrc' as const }
    expect(featuresMissing({ id: 'x', init: 'systemd', features: ['mqtt'], shell: { pass: 'x' } }, openrc)).toEqual(['INIT=systemd'])
    expect(featuresMissing({ id: 'x', init: 'openrc', shell: { pass: 'x' } }, openrc)).toEqual([])
    expect(featuresMissing({ id: 'x', shell: { pass: 'x' } }, openrc)).toEqual([])
  })
  test('a check of the other container engine is not run, and says which engine it needs', () => {
    const docker = { ...EVERY_FEATURE, engine: 'docker' as const }
    expect(featuresMissing({ id: 'x', engine: 'podman', features: ['containers'], shell: { pass: 'x' } }, docker)).toEqual(['CONTAINER_ENGINE=podman'])
    expect(featuresMissing({ id: 'x', engine: 'docker', features: ['containers'], shell: { pass: 'x' } }, docker)).toEqual([])
  })
})
