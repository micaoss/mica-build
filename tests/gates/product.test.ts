// src/product/product.ts, driven over the tracked products and over perturbed copies of them: every product
// validates against its fetched board, and each refusal of the product contract (boards/products.md) fires by
// name.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/product.test.ts     (make os-product-test; needs make board-fetch-all)
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import { product, ProductError, products, render } from '../../src/product/product.ts'
import { ARCHES } from '../../src/rootfs/runtime/arch.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'product-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const TRACKED = products()

describe('every tracked product', () => {
  test('there is at least one', () => { expect(TRACKED.length).toBeGreaterThan(0) })
  for (const p of TRACKED) {
    test(`${p} validates and names its board's architecture`, () => {
      const r = product(p)
      expect(r.board).not.toBe('')
      expect(ARCHES).toContain(r.arch as typeof ARCHES[number])
      expect(render(r)).toContain(`MICA_ARCH=${r.arch}\n`)
    })
  }
  // Every board has at least one product, its variants named for their purpose; no variant name is required. A
  // release target has at least one prod product, since a dev product is never released.
  for (const b of boards()) {
    test(`board ${b.name} has a product, and a prod one when it is a release target`, () => {
      const own = products().filter(p => p.startsWith(`${b.name}.`))
      expect(own.length, b.name).toBeGreaterThan(0)
      if (/^BOARD_RELEASE_TARGET=1$/m.test(readFileSync(join(REPO_ROOT, 'boards', b.name, 'board.env'), 'utf8')))
        expect(own.filter(p => product(p).profile === 'prod').length, b.name).toBeGreaterThan(0)
    })
  }
})

/** A copy of every board's products/ under scratch (<board>/products/<variant>/), its path. */
function mutate(name: string): string {
  const dir = join(SCRATCH, name)
  rmSync(dir, { recursive: true, force: true })
  for (const b of boards()) cpSync(join(REPO_ROOT, 'boards', b.name, 'products'), join(dir, b.name, 'products'), { recursive: true })
  return dir
}

/** A product's directory in such a copy. */
const at = (dir: string, p: string) => join(dir, p.slice(0, p.indexOf('.')), 'products', p.slice(p.indexOf('.') + 1))

function setKey(dir: string, p: string, key: string, value: string): void {
  const file = join(at(dir, p), 'product.env')
  const kept = readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith(`${key}=`))
  writeFileSync(file, `${kept.join('\n').replace(/\n*$/, '\n')}${key}=${value}\n`)
}

function refuse(label: string, fragment: string, name: string, dirs: { productsDir?: string, boardsDir?: string }): void {
  test(`${label}: refused, naming '${fragment}'`, () => {
    expect(() => product(name, dirs)).toThrow(ProductError)
    expect(() => product(name, dirs)).toThrow(fragment)
  })
}

describe('the refusals, each on a perturbed copy', () => {
  let d = mutate('unknown-key'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'product.env'), 'COLOUR=blue\n', { flag: 'a' })
  refuse('an unknown key', 'does not name', 'uefi-x64.dev', { productsDir: d })
  d = mutate('named'); setKey(d, 'uefi-x64.dev', 'PRODUCT', 'other')
  refuse('a PRODUCT key: the directory is the name', 'declares PRODUCT, which the product contract does not name', 'uefi-x64.dev', { productsDir: d })
  d = mutate('boarded'); setKey(d, 'uefi-x64.dev', 'BOARD', 'cx3576')
  refuse('a BOARD key: the directory is the board', 'declares BOARD, which the product contract does not name', 'uefi-x64.dev', { productsDir: d })
  d = mutate('unknown-board'); cpSync(at(d, 'uefi-x64.dev'), at(d, 'nosuch.basic'), { recursive: true })
  refuse('an unpinned board', 'not a pinned board', 'nosuch.basic', { productsDir: d })
  refuse('a name that is no <board>.<variant>', 'is not a product name <board>.<variant>', 'uefi-x64', {})
  d = mutate('bad-profile'); setKey(d, 'uefi-x64.dev', 'PROFILE', 'staging')
  refuse('a profile that is neither dev nor prod', 'dev or prod', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-init'); setKey(d, 'uefi-x64.dev', 'INIT', 'runit')
  refuse('an init that is neither systemd nor openrc', 'systemd or openrc', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-engine'); setKey(d, 'uefi-x64.dev', 'CONTAINER_ENGINE', 'lxc')
  refuse('an engine that is neither podman nor docker', 'it is podman or docker', 'uefi-x64.dev', { productsDir: d })
  d = mutate('engine-without-containers'); setKey(d, 'uefi-x64.basic', 'CONTAINER_ENGINE', 'docker')
  refuse('an engine on a product without containers', 'FEATURES does not name containers', 'uefi-x64.basic', { productsDir: d })
  d = mutate('bad-device-code'); setKey(d, 'uefi-x64.dev', 'DEVICE_CODE_SOURCE', 'cpu-serial')
  refuse('a device code source micad does not read', 'DEVICE_CODE_SOURCE=cpu-serial; it is one of emmc-cid', 'uefi-x64.dev', { productsDir: d })
  d = mutate('no-device-code'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'product.env'), readFileSync(join(at(d, 'uefi-x64.dev'), 'product.env'), 'utf8').replace(/^DEVICE_CODE_SOURCE=.*\n/m, ''))
  refuse('a product naming no device code source', 'declares no DEVICE_CODE_SOURCE', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-ssh'); setKey(d, 'uefi-x64.dev', 'SSH_SERVER', 'telnetd')
  refuse('an SSH server that is neither dropbear nor openssh', 'SSH_SERVER=telnetd; it is dropbear or openssh', 'uefi-x64.dev', { productsDir: d })
  d = mutate('ssh-without-ssh'); setKey(d, 'uefi-x64.dev', 'FEATURES', '"micad"'); setKey(d, 'uefi-x64.dev', 'SSH_SERVER', 'openssh')
  refuse('an SSH server on a product without ssh', 'SSH_SERVER=openssh names an SSH server, and FEATURES does not name ssh', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-ssh-switch'); setKey(d, 'uefi-x64.dev', 'SSH', 'yes')
  refuse('an SSH switch that is neither on nor off', 'SSH=yes; it is on or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('ssh-switch-without-ssh'); setKey(d, 'uefi-x64.dev', 'FEATURES', '"micad"'); setKey(d, 'uefi-x64.dev', 'SSH', 'on')
  refuse('an SSH switch on a product without ssh', 'SSH=on turns SSH on or off, and FEATURES does not name ssh', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-claim'); setKey(d, 'uefi-x64.dev', 'CLAIM_DEVICE_CODE', 'maybe')
  refuse('a claim policy that is neither required nor off', 'CLAIM_DEVICE_CODE=maybe; it is required or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-mdns'); setKey(d, 'uefi-x64.dev', 'MDNS', 'yes')
  refuse('an mDNS setting that is neither on nor off', 'MDNS=yes; it is on or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-ssdp'); setKey(d, 'uefi-x64.dev', 'SSDP', '0')
  refuse('an SSDP setting that is neither on nor off', 'SSDP=0; it is on or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-owner-confirm'); setKey(d, 'uefi-x64.dev', 'OWNER_ENROLMENT_CONFIRM', 'yes')
  refuse('an owner enrolment confirmation that is neither on nor off', 'OWNER_ENROLMENT_CONFIRM=yes; it is on or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-watchdog'); setKey(d, 'uefi-x64.dev', 'WATCHDOG', '"a watchdog identity longer than 32 bytes"')
  refuse('a watchdog identity longer than a driver reports', 'it is a watchdog identity of 1 to 32 printable characters', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-cloud-admins'); setKey(d, 'uefi-x64.dev', 'CLOUD_ADMINS', 'yes')
  refuse('a cloud administrators default that is neither on nor off', 'CLOUD_ADMINS=yes; it is on or off', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-enable-unit'); setKey(d, 'uefi-x64.dev', 'ENABLE_UNITS', '"mica-gce-agent.timer"')
  refuse('an enabled unit that is no service', 'ENABLE_UNITS names \'mica-gce-agent.timer\', which is no <name>.service', 'uefi-x64.dev', { productsDir: d })
  d = mutate('enable-unit-openrc'); setKey(d, 'uefi-x64.openrc-full', 'ENABLE_UNITS', '"mica-gce-agent.service"')
  refuse('enabled systemd units on an OpenRC product', 'names systemd units, and INIT=openrc', 'uefi-x64.openrc-full', { productsDir: d })
  d = mutate('unknown-feature'); setKey(d, 'uefi-x64.dev', 'FEATURES', '"micad zigbee"')
  refuse('a feature no manifest defines', 'no feature-*.pkgs', 'uefi-x64.dev', { productsDir: d })
  d = mutate('radio-off-board'); setKey(d, 'uefi-x64.dev', 'FEATURES', '"micad wifi"')
  refuse('a radio the board does not have', 'does not have', 'uefi-x64.dev', { productsDir: d })
  d = mutate('unknown-component'); setKey(d, 's905x5m.dev', 'COMPONENTS', '"hologram"')
  refuse('a component the board does not ship', 'ships no manifests/component-hologram.pkgs', 's905x5m.dev', { productsDir: d })
  d = mutate('unknown-kind'); setKey(d, 'uefi-x64.dev', 'IMAGE_KINDS', '"disk floppy"')
  refuse('an image kind the board\'s images.tsv does not declare', 'the image kind floppy is not declared', 'uefi-x64.dev', { productsDir: d })
  d = mutate('unknown-update-kind'); setKey(d, 'uefi-x64.dev', 'UPDATE_KINDS', '"full delta"')
  refuse('an update kind the board\'s images.tsv does not declare', 'the update kind delta is not declared', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-key'); setKey(d, 'uefi-x64.dev', 'PUBLISH', '0')
  refuse('a key the product contract does not name', 'which the product contract does not name', 'uefi-x64.dev', { productsDir: d })
  d = mutate('over-budget'); setKey(d, 'uefi-x64.dev', 'SIZE_BUDGET_MB', '9999')
  refuse('a budget above the board\'s', 'may only lower it', 'uefi-x64.dev', { productsDir: d })
  d = mutate('not-a-number'); setKey(d, 'uefi-x64.dev', 'SIZE_BUDGET_MB', '5MB')
  refuse('a budget that is not a number', 'is not a number', 'uefi-x64.dev', { productsDir: d })
  d = mutate('substitution'); setKey(d, 'uefi-x64.dev', 'PROFILE', '"$(id)"')
  refuse('a substitution in a value', 'carries a substitution', 'uefi-x64.dev', { productsDir: d })
  d = mutate('twice'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'product.env'), 'PROFILE=dev\n', { flag: 'a' })
  refuse('a key declared twice', 'more than once', 'uefi-x64.dev', { productsDir: d })
  d = mutate('no-meta'); rmSync(join(at(d, 'uefi-x64.dev'), 'meta/updates/manifest.json'))
  refuse('a product with no public manifest', 'meta/updates/manifest.json is missing', 'uefi-x64.dev', { productsDir: d })
  d = mutate('secret-default'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'defaults.toml'), 'version = 1\n[access.device]\npassword = "hunter2"\n')
  refuse('a secret in defaults.toml', 'secret-bearing key', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-defaults'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'defaults.toml'), 'version = 2\n')
  refuse('defaults.toml without version = 1', 'version = 1 is required', 'uefi-x64.dev', { productsDir: d })
  d = mutate('not-toml-defaults'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'defaults.toml'), 'not toml [\n')
  refuse('defaults.toml that is not TOML', 'not valid TOML', 'uefi-x64.dev', { productsDir: d })
  d = mutate('bad-provisioning'); writeFileSync(join(at(d, 'uefi-x64.dev'), 'provisioning.toml'), 'not toml [\n')
  refuse('an invalid provisioning.toml', 'not a valid provisioning document', 'uefi-x64.dev', { productsDir: d })
  refuse('a product that does not exist', 'the products are: ', 'nosuch', {})
  // A board without room for the engine refuses a product that wants it.
  const bdir = join(SCRATCH, 'boards'); rmSync(bdir, { recursive: true, force: true }); cpSync(join(REPO_ROOT, '_out/boards'), bdir, { recursive: true })
  const env = join(bdir, 'uefi-x64/board.env')
  writeFileSync(env, readFileSync(env, 'utf8').replace(/^BOARD_FEATURES=.*$/m, 'BOARD_FEATURES=""'))
  refuse('containers on a board without room for the engine', 'does not have', 'uefi-x64.dev', { boardsDir: bdir })
  // A board whose kernel does not merge a kernel feature the product needs refuses it (common/kernel/features.tsv).
  const kdir = join(SCRATCH, 'kernel-boards'); rmSync(kdir, { recursive: true, force: true }); cpSync(join(REPO_ROOT, '_out/boards'), kdir, { recursive: true })
  const kenv = join(kdir, 'uefi-x64/board.env')
  writeFileSync(kenv, readFileSync(kenv, 'utf8').replace(/^KERNEL_FEATURES=.*$/m, 'KERNEL_FEATURES="storage-gpt init-systemd netdev firewall"'))
  refuse('containers on a board whose kernel does not merge them', 'does not merge the kernel feature(s) containers (feature:containers)', 'uefi-x64.dev', { boardsDir: kdir })
  const nenv = join(kdir, 'uefi-arm64/board.env')
  writeFileSync(nenv, readFileSync(nenv, 'utf8').replace(/^KERNEL_FEATURES=.*$/m, 'KERNEL_FEATURES="storage-gpt"'))
  refuse('systemd on a board whose kernel does not merge it', 'init-systemd (init:systemd)', 'uefi-arm64.basic', { boardsDir: kdir })
  const oenv = join(kdir, 'mini-x64/board.env')
  writeFileSync(oenv, readFileSync(oenv, 'utf8').replace(/^KERNEL_FEATURES=.*$/m, 'KERNEL_FEATURES="storage-gpt"'))
  test('an OpenRC product without containers needs only the storage feature', () => {
    expect(product('mini-x64.basic', { boardsDir: kdir }).board).toBe('mini-x64')
  })
  const uenv = join(kdir, 'cx3576/board.env')
  writeFileSync(uenv, readFileSync(uenv, 'utf8').replace(/^KERNEL_FEATURES=.*$/m, 'KERNEL_FEATURES="storage-ubi init-systemd netdev firewall containers"'))
  refuse('a board whose kernel storage model is not its layout\'s', 'whose kernel feature is storage-gpt', 'cx3576.dev', { boardsDir: kdir })
  refuse('an unfetched board', 'is not fetched (make board-fetch BOARD=uefi-x64)', 'uefi-x64.dev', { boardsDir: join(SCRATCH, 'no-boards') })
})

describe('the positive controls', () => {
  test('a valid defaults.toml and provisioning.toml are accepted and reported', () => {
    const d = mutate('good-optional')
    writeFileSync(join(at(d, 'uefi-x64.dev'), 'defaults.toml'), 'version = 1\n[access.ssh]\nenabled = true\n')
    writeFileSync(join(at(d, 'uefi-x64.dev'), 'provisioning.toml'), 'version = 1\n[admin]\npassword = "factory"\n')
    const r = product('uefi-x64.dev', { productsDir: d })
    expect(r.defaults).toBe(join(at(d, 'uefi-x64.dev'), 'defaults.toml'))
    expect(r.provisioning).toBe(join(at(d, 'uefi-x64.dev'), 'provisioning.toml'))
    expect(render(r)).toMatch(/^DEFAULTS=.*\/defaults\.toml$/m)
    expect(render(r)).toMatch(/^PROVISIONING=.*\/provisioning\.toml$/m)
  })
  test('a product lowering its budget keeps the lower value; the board\'s otherwise', () => {
    const d = mutate('lower-budget'); setKey(d, 'uefi-x64.dev', 'SIZE_BUDGET_MB', '100')
    expect(product('uefi-x64.dev', { productsDir: d }).sizeBudgetMb).toBe('100')
    expect(product('uefi-x64.dev').sizeBudgetMb).toBe(readFileSync(join(REPO_ROOT, '_out/boards/uefi-x64/board.env'), 'utf8').match(/^BOARD_SIZE_BUDGET_MB=(\d+)$/m)![1]!)
  })
  test('the radios of a product are the radio features it selects, and a subset of image kinds keeps disk', () => {
    const cx = product('cx3576.dev')
    expect(cx.radios.split(' ').filter(Boolean).every(r => cx.features.split(' ').includes(r))).toBe(true)
    const d = mutate('kinds-subset'); setKey(d, 'cx3576.dev', 'IMAGE_KINDS', '"disk"')
    expect(product('cx3576.dev', { productsDir: d }).imageKinds).toBe('disk')
  })
})

test('STORAGE_LAYOUT selects a fetched named layout, refuses missing or unsafe selectors, and leaves the default empty', () => {
  const d = mutate('storage-layout')
  const b = join(SCRATCH, 'storage-boards')
  cpSync(join(REPO_ROOT, '_out/boards'), b, { recursive: true })
  cpSync(join(b, 's905x5m/layout.tsv'), join(b, 's905x5m/layout-other.tsv'))
  setKey(d, 's905x5m.dev', 'STORAGE_LAYOUT', 'other')
  const selected = product('s905x5m.dev', { productsDir: d, boardsDir: b })
  expect(selected.storageLayout).toBe('other')
  expect(render(selected)).toContain('STORAGE_LAYOUT=other\n')
  expect(product('s905x5m.dev').storageLayout).toBe('')
  setKey(d, 's905x5m.dev', 'STORAGE_LAYOUT', 'missing')
  expect(() => product('s905x5m.dev', { productsDir: d, boardsDir: b })).toThrow('does not exist')
  setKey(d, 's905x5m.dev', 'STORAGE_LAYOUT', '../other')
  expect(() => product('s905x5m.dev', { productsDir: d, boardsDir: b })).toThrow('layout name')
})

describe('the x64 and generic released products', () => {
  const source = (name: string) => (JSON.parse(readFileSync(join(product(name).metaDir, 'updates/manifest.json'), 'utf8')) as { update: { source: unknown } }).update.source
  test('uefi-x64.openrc-full is uefi-x64.full on OpenRC, without iproute2', () => {
    // mica-openrc conflicts with iproute2: OpenRC networking is busybox's.
    const openrc = product('uefi-x64.openrc-full'), full = product('uefi-x64.full')
    expect([openrc.init, full.init]).toEqual(['openrc', 'systemd'])
    const features = full.features.split(' ').filter(f => f !== 'iproute2').join(' ')
    expect(full.features).not.toBe(features)
    expect([openrc.profile, openrc.features, openrc.components]).toEqual([full.profile, features, full.components])
  })
  test('the default mini-x64 is minimal: no container engine', () => {
    expect(product('mini-x64.basic').features).toBe('micad ui ssh')
    expect(product('mini-x64.basic').engine).toBe('')
  })
  test('the minimal products carry the console', () => {
    const minimal = ['cx3576.basic', 'mini-x64.basic', 'qemu-armhf.basic', 's905x5m.basic', 'ssd202d.basic', 'uefi-arm64.basic', 'uefi-x64.basic']
    expect(minimal.filter(p => !product(p).features.split(' ').includes('ui'))).toEqual([])
  })
  test('uefi-x64.docker is uefi-x64.full with docker as its engine; podman is the default engine', () => {
    const docker = product('uefi-x64.docker'), full = product('uefi-x64.full')
    expect([docker.engine, full.engine]).toEqual(['docker', 'podman'])
    expect([docker.init, docker.profile, docker.features, docker.components]).toEqual([full.init, full.profile, full.features, full.components])
    expect(render(docker)).toContain('CONTAINER_ENGINE=docker\n')
  })
  test('each product reads its device code from its board\'s source, but uefi-x64.gcp, whose instances have no serial a label carries', () => {
    const sources: Record<string, string> = { 'cx3576': 'emmc-cid', 's905x5m': 'emmc-cid', 'mini-x64': 'dmi-serial', 'uefi-x64': 'dmi-serial', 'uefi-arm64': 'dmi-serial', 'qemu-armhf': 'mac', 'ssd202d': 'mac' }
    for (const name of products()) {
      const source = name === 'uefi-x64.gcp' ? 'random' : sources[product(name).board]!
      expect(product(name).deviceCode, name).toBe(source)
      expect(render(product(name)), name).toContain(`DEVICE_CODE_SOURCE=${source}\n`)
    }
  })
  test('every product with ssh runs dropbear, the default, but cx3576.full and uefi-x64.gcp, which name openssh', () => {
    for (const name of products()) {
      const ssh = !product(name).features.split(' ').includes('ssh') ? '' : ['cx3576.full', 'uefi-x64.gcp'].includes(name) ? 'openssh' : 'dropbear'
      expect(product(name).ssh, name).toBe(ssh)
      expect(render(product(name)), name).toContain(`SSH_SERVER=${ssh}\n`)
    }
  })
  test('every product with ssh starts with SSH off, the default, but the base and the cloud image, which have no other way in', () => {
    for (const name of products()) {
      const ssh = !product(name).features.split(' ').includes('ssh') ? '' : ['uefi-x64.base', 'uefi-x64.gcp'].includes(name) ? 'on' : 'off'
      expect(product(name).sshSwitch, name).toBe(ssh)
      expect(render(product(name)), name).toContain(`SSH=${ssh}\n`)
    }
  })
  test('uefi-x64.base is the base alone: no micad or console, SSH on, updates on the auto policy', () => {
    const base = product('uefi-x64.base'), features = base.features.split(' ')
    expect(features).not.toContain('micad')
    expect(features).not.toContain('ui')
    expect(features).toContain('ssh')
    expect([base.init, base.profile, base.engine]).toEqual(['systemd', 'prod', 'podman'])
    expect((JSON.parse(readFileSync(join(base.metaDir, 'updates/manifest.json'), 'utf8')) as { update: { policy: unknown } }).update.policy).toBe('auto')
  })
  test('every product claims without the device code but uefi-x64.gcp: placeholder serials on x64 and QEMU, and for now no code reachable without the serial console on the ARM boards; the code of the cloud image is read after an SSH login', () => {
    const claims: Record<string, string> = {
      'uefi-x64.basic': 'off', 'uefi-x64.dev': 'off', 'uefi-x64.docker': 'off', 'uefi-x64.full': 'off', 'uefi-x64.openrc-full': 'off',
      'uefi-x64.gcp': 'required',
      'uefi-arm64.basic': 'off', 'uefi-arm64.dev': 'off', 'uefi-arm64.full': 'off',
      'mini-x64.basic': 'off', 'qemu-armhf.basic': 'off', 'ssd202d.basic': 'off', 'cx3576.full': 'off',
      'cx3576.basic': 'off', 'cx3576.dev': 'off',
      's905x5m.basic': 'off', 's905x5m.dev': 'off', 's905x5m.emmc-dev': 'off', 's905x5m.emmc-full': 'off', 's905x5m.sd-full': 'off',
    }
    for (const name of products()) {
      const claim = claims[name] ?? ''
      expect(product(name).claim, name).toBe(claim)
      expect(render(product(name)), name).toContain(`CLAIM_DEVICE_CODE=${claim}\n`)
    }
  })
  test('no product but uefi-x64.gcp turns mDNS or SSDP off: the others name neither, and micad announces both', () => {
    for (const name of products()) {
      const off = name === 'uefi-x64.gcp'
      expect([product(name).mdns, product(name).ssdp], name).toEqual(off ? ['off', 'off'] : ['', ''])
      expect(render(product(name)), name).toContain(off ? 'MDNS=off\nSSDP=off\n' : 'MDNS=\nSSDP=\n')
    }
  })
  test('only uefi-x64.gcp names its watchdog: Compute Engine has no i6300ESB, so its runkit arms the softdog', () => {
    for (const name of products()) {
      const watchdog = name === 'uefi-x64.gcp' ? 'Software Watchdog' : ''
      expect(product(name).watchdog, name).toBe(watchdog)
      expect(render(product(name)), name).toContain(`WATCHDOG="${watchdog}"\n`)
    }
  })
  test('only uefi-x64.gcp carries the Compute Engine agent, enables it and makes its SSH users administrators', () => {
    for (const name of products()) {
      const gcp = name === 'uefi-x64.gcp'
      expect([product(name).components, product(name).enableUnits, product(name).cloudAdmins], name)
        .toEqual(gcp ? ['gce', 'mica-gce-agent.service', 'on'] : [product(name).components, '', ''])
      if (!gcp) expect(product(name).components, name).not.toContain('gce')
      expect(render(product(name)), name).toContain(gcp ? 'CLOUD_ADMINS=on\n' : 'CLOUD_ADMINS=\n')
    }
  })
  test('uefi-x64.gcp runs docker and carries no MQTT', () => {
    const gcp = product('uefi-x64.gcp')
    expect([gcp.engine, gcp.features]).toEqual(['docker', 'micad ui ssh tools containers iproute2'])
    expect(render(gcp)).toContain('CONTAINER_ENGINE=docker\n')
  })
  test('only uefi-x64.gcp packs the gce import artefact', () => {
    for (const name of products().filter(n => n.startsWith('uefi-x64.')))
      expect(product(name).imageKinds, name).toBe(name === 'uefi-x64.gcp' ? 'disk gce' : 'disk')
  })
  test('no product asks for owner certificates to be confirmed on the console unless it names it', () => {
    for (const name of products()) expect(render(product(name)), name).toContain('OWNER_ENROLMENT_CONFIRM=off\n')
  })
  test('every released x64 and generic full product names the update root', () => {
    for (const name of ['mini-x64.basic', 'uefi-x64.openrc-full', 'uefi-x64.full', 'uefi-arm64.full'])
      expect(source(name), name).toBe('https://res.micaos.dev/update/')
  })
})
