import { expect, test } from 'bun:test'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fixture, policy } from '../suites/rootfs-runtime/fixture.ts'

test('each S905X5M layout retains its owned storage policy and audio tool closure', () => {
  for (const name of ['mica-board-s905x5m', 'mica-board-s905x5m-emmc']) {
    const f = new Fixture()
    try {
      f.write('/etc/fstab', 'selected DATA\n')
      f.write('/usr/bin/aconnect', '#!/usr/bin/sh\nexit 0\n', 0o755)
      f.write('/usr/share/alsa/alsa.conf', 'audio resource\n')
      appendFileSync(f.manifest, `${name}\t1\tall\nalsa-utils\t1\tall\nlibasound2-data\t1\tall\n`)
      writeFileSync(f.packages, `mica-system\n${name}\n`)
      for (const [pkg, path] of [[name, '/etc/fstab'], ['alsa-utils', '/usr/bin/aconnect'], ['libasound2-data', '/usr/share/alsa\n/usr/share/alsa/alsa.conf']])
        writeFileSync(join(f.db, `${pkg}.list`), `${path}\n`)

      for (const pkg of [name, 'alsa-utils', 'libasound2-data']) {
        f.write(`/usr/share/doc/${pkg}/copyright`, 'fixture license\n')
        appendFileSync(join(f.db, `${pkg}.list`), `/usr/share/doc/${pkg}\n/usr/share/doc/${pkg}/copyright\n`)
      }

      const declarations = policy().consumers
      f.rules.consumers['mica-board-*'] = declarations['mica-board-*']!
      if (declarations[name]) f.rules.consumers[name] = declarations[name]!
      f.selected()
      for (const path of ['/etc/fstab', '/usr/bin/aconnect', '/usr/share/alsa/alsa.conf']) expect(existsSync(f.outAt(path)), `${name}: ${path}`).toBe(true)
      f.verified()
    }
    finally { f.cleanup() }
  }
})
