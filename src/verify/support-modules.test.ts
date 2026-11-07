// The support image's module index against its tree: every module listed, nothing listed that is absent, every
// device alias a module declares in modules.alias.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleIndexProblem } from './support-modules.ts'

const WORK = mkdtempSync(join(tmpdir(), 'support-modules-'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

function tree(name: string, dep: string, alias: string): string {
  const dir = join(WORK, name)
  mkdirSync(join(dir, 'kernel/drivers/usb/serial'), { recursive: true })
  writeFileSync(join(dir, 'kernel/drivers/usb/serial/ftdi_sio.ko'), Buffer.from('\x7fELF\0license=GPL\0alias=usb:v0403p6001d*\0'))
  writeFileSync(join(dir, 'kernel/drivers/usb/serial/usbserial.ko'), Buffer.from('\x7fELF\0license=GPL\0'))
  writeFileSync(join(dir, 'modules.dep'), dep)
  writeFileSync(join(dir, 'modules.alias'), alias)
  return dir
}
const DEP = 'kernel/drivers/usb/serial/usbserial.ko:\nkernel/drivers/usb/serial/ftdi_sio.ko: kernel/drivers/usb/serial/usbserial.ko\n'
const ALIAS = '# Aliases extracted from modules themselves.\nalias usb:v0403p6001d* ftdi_sio\n'

test('an index that describes its tree passes, with its counts', () => {
  expect(moduleIndexProblem(tree('good', DEP, ALIAS))).toEqual({ modules: 2, aliased: 1 })
})

test.each([
  ['a module modules.dep does not list', 'kernel/drivers/usb/serial/usbserial.ko:\n', ALIAS, 'does not list 1 module'],
  ['a dependency the tree does not hold', DEP + 'kernel/drivers/x.ko:\n', ALIAS, 'names kernel/drivers/x.ko'],
  ['an alias of a module the tree does not hold', DEP, ALIAS + 'alias pci:v8086* e1000e\n', 'names e1000e'],
  ['a module whose declared alias is missing', DEP, '# none\n', 'misses the device aliases of kernel/drivers/usb/serial/ftdi_sio.ko'],
])('%s is refused', (name, dep, alias, message) => {
  expect(moduleIndexProblem(tree(name.replace(/\W+/g, '-'), dep, alias)).problem).toContain(message)
})

test('a tree without modules.alias is refused', () => {
  const dir = tree('no-alias', DEP, ALIAS)
  rmSync(join(dir, 'modules.alias'))
  expect(moduleIndexProblem(dir).problem).toBe('Support modules.alias missing')
})
