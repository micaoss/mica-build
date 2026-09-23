import { expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../..')
for (const board of ['uefi-x64', 'uefi-arm64']) {
  for (const port of [undefined, '22345', '0', '65536', 'invalid']) {
    test(`API launcher ${board}: SSH port ${port ?? 'unset'} crosses the Docker boundary unchanged`, async () => {
      const work = mkdtempSync(join(tmpdir(), 'mica-api-launcher-'))
      const socket = createServer()
      try {
        // The harness is keyed by product: the recipe, the reader and the
        // board's pin travel with the fixture, the way the checkout has them.
        const product = `${board}-dev`
        for (const path of ['tests/suites/apid-api/run.sh', 'tests/suites/apid-api/src/qemu.ts', 'tools/product.sh',
          'tests/suites/apid-api/src/main.ts', `_out/boards/${board}/board.env`, `_out/boards/${board}/images.tsv`, 'boards/boards.tsv', 'tools/image-kinds.sh', 'src/boards/boards.ts', 'src/boards/component.ts', 'src/pool/producers.ts', 'bin/bun.sh', 'package.json', 'src/cli.ts', 'src/locks/locks.ts',
          `products/${product}/product.env`, `products/${product}/meta/updates/manifest.json`, 'src/locks/from.ts']) {
          mkdirSync(dirname(join(work, path)), { recursive: true })
          copyFileSync(join(repo, path), join(work, path))
          expect(readFileSync(join(work, path))).toEqual(readFileSync(join(repo, path)))
        }
        // The locks the board list and the images are read from.
        cpSync(join(repo, 'locks'), join(work, 'locks'), { recursive: true })
        symlinkSync(join(repo, 'build'), join(work, 'build'))
        // tools/product.sh validates the recipe's features against the engine's manifests.
        cpSync(join(repo, 'rootfs/packages'), join(work, 'rootfs/packages'), { recursive: true })
        mkdirSync(join(work, 'bin'), { recursive: true })
        copyFileSync(join(import.meta.dir, 'api-launcher-docker.ts'), join(work, 'bin/docker'))
        chmodSync(join(work, 'bin/docker'), 0o755)
        writeFileSync(join(work, 'bin/ip'), '#!/bin/sh\nprintf "2: eth0 inet 192.0.2.1/24\\n"\n', { mode: 0o755 })
        mkdirSync(join(work, 'tests/suites/signed-boot-lab'), { recursive: true })
        writeFileSync(join(work, 'tests/suites/signed-boot-lab/images.sh'), '#!/bin/bash\nexit 0 # Isolated expensive image boundary\n')
        writeFileSync(join(work, 'Makefile'), '# Isolated launcher fixture\n')
        const diskDir = join(work, '_out', 'products', product, 'qemu')
        mkdirSync(diskDir, { recursive: true })
        writeFileSync(join(diskDir, 'disk.img'), 'existing isolated fixture disk')
        const image = join(work, 'factory.img'), cert = join(work, 'boot.cert.pem')
        writeFileSync(image, 'not a bootable image'); writeFileSync(cert, 'not a signing identity')
        await new Promise<void>(resolve => socket.listen(join(work, 'daemon.sock'), resolve))
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(work, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
          DOCKER_HOST: `unix://${join(work, 'daemon.sock')}`, MICA_API_LAUNCHER_FIXTURE: work,
          MICA_PRODUCT: product, MICA_QEMU_IMAGE: image, MICA_QEMU_BOOT_CERT: cert, MICA_APID_KEEP_DISK: '1' }
        for (const key of Object.keys(env)) if (key.startsWith('MICA_QEMU_') && !['MICA_QEMU_IMAGE', 'MICA_QEMU_BOOT_CERT'].includes(key)) delete env[key]
        if (port !== undefined) Object.assign(env, { MICA_QEMU_SSH_PORT: port })
        const child = Bun.spawnSync(['bash', join(work, 'tests/suites/apid-api/run.sh')], { env, timeout: 20000 })
        expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(1)
        const outer = JSON.parse(readFileSync(join(work, 'outer.json'), 'utf8'))
        expect(outer.args.slice(-4)).toEqual(['bun', 'run', 'src/qemu.ts', '--prepare-only'])
        expect(outer.env.MICA_QEMU_SSH_PORT).toBe(port)
        expect(outer.env).toMatchObject({ MICA_BOARD: board, MICA_PRODUCT: product, MICA_QEMU_IMAGE: image, MICA_QEMU_BOOT_CERT: cert,
          MICA_QEMU_FORWARD: '1', MICA_QEMU_NETWORK: 'acceptance-fixture', MICA_QEMU_HTTPS_PORT: '18443', MICA_QEMU_HTTP_PORT: '18080' })
        const engine = JSON.parse(readFileSync(join(work, 'engine.json'), 'utf8'))
        expect(engine.exitCode).toBe(1)
        if (port === undefined || port === '22345') {
          expect(engine.stderr).toContain('QEMU container exited 73')
          const inner = JSON.parse(readFileSync(join(work, 'inner.json'), 'utf8'))
          expect(inner.env.HOSTFWD).toBe(',hostfwd=tcp::18443-:443,hostfwd=tcp::18080-:80'
            + (port === undefined ? '' : ',hostfwd=tcp::22345-:22'))
          expect(inner.args.includes('127.0.0.1:22345:22345')).toBe(port !== undefined)
        }
        else {
          expect(engine.stderr).toContain(port === '65536' ? 'Invalid forwarding port' : `Invalid positive integer: ${port}`)
          expect(existsSync(join(work, 'inner.json'))).toBe(false)
        }
      }
      finally {
        await new Promise<void>(resolve => socket.close(() => resolve()))
        rmSync(work, { recursive: true, force: true })
      }
    }, 25000)
  }
}
