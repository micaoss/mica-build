// The container engine, the purge and the trust store driven from the failing side.
//
// Every case asserts the check GREEN on the
// unmutated fixture, makes ONE edit, asserts RED, and asserts the message names
// the thing. The edits are the shapes these failures actually took:
//
//   - podman.socket appearing under a unit directory. It is SOCKET-ACTIVATED, so
//     being disabled is not enough, and it is the reason the check asks for no
//     podman unit of ANY name rather than for a mask list.
//   - nft missing. It is reached by exec, so no NEEDED-soname check can see it,
//     and an image can ship without it while passing every other assertion.
//   - graphroot on /var, where the immutable parent prevents image writes.
//   - the Quadlet mount STATICALLY ENABLED, which is the branch with teeth:
//     anything able to write /mnt/data/state/quadlet gets a root-capable container at
//     the next reboot with no operator decision in the path.
//   - apt's TIMERS surviving a purge that removed only /usr/bin/apt. Found by
//     booting the uefi-x64 image, in an arm64 image that had already shipped.
//   - the package-manager LOGS surviving it, on /var and under the factory tree.
//     A purge written around /var/lib and /var/cache does not reach /var/log,
//     and the factory copy is restored onto /var on the first boot.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { ENGINE_CHECKS_ALL, unitValue } from './checks-engine.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefiX64 = loadBoard(boardEnvPath('uefi-x64'))

const STORAGE_CONF = '/etc/containers/storage.conf'
const CONTAINERS_CONF = '/etc/containers/containers.conf'
const QUADLET_MOUNT = '/etc/systemd/system/etc-containers-systemd.mount'
const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

function checkNamed(id: string): CheckCase {
  const found = ENGINE_CHECKS_ALL.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no engine check is registered as '${id}'. Registered: `
      + ENGINE_CHECKS_ALL.map(c => c.id).join(', '))
  }
  return found
}

async function only(fx: RootFixture, id: string): Promise<CheckResult> {
  const got = await checkNamed(id).run(fx.ctx)
  expect(got.length).toBe(1)
  return got[0] as CheckResult
}

async function verdictOf(fx: RootFixture, id: string): Promise<Verdict> {
  return (await only(fx, id)).verdict
}

async function messageOf(fx: RootFixture, id: string): Promise<string> {
  return (await only(fx, id)).message
}

/** Green first, then one edit. A fixture red before the mutation proves nothing. */
async function mutated(id: string, mutate: (root: string) => void, board: Board = cx3576): Promise<RootFixture> {
  const fx = packedRootFixture(board)
  expect(await verdictOf(fx, id)).toBe('pass')
  mutate(fx.root)
  return fx
}

function rewrite(root: string, path: string, edit: (text: string) => string): void {
  writeFileSync(join(root, path), edit(readFileSync(join(root, path), 'utf8')))
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

describe('the healthy image', () => {
  test('every engine, purge and trust-store check PASSES on both boards', async () => {
    // Fifteen conclusions on EACH shipped board, measured against both boards'
    // real oracle output on 2026-08-26. Board-unconditional throughout: the
    // engine is an image property, not a board declaration -- which is exactly
    // why the WITH_CONTAINERS=0 branch cannot be scoped by `boards:`.
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of ENGINE_CHECKS_ALL) {
          const got = await c.run(fx.ctx)
          expect(`${board.name}/${c.id}: ${got.map(r => r.verdict).join(',')}`)
            .toBe(`${board.name}/${c.id}: pass`)
        }
      }
      finally {
        fx.dispose()
      }
    }
    for (const c of ENGINE_CHECKS_ALL) expect(`${c.id}: ${c.boards}`).toBe(`${c.id}: undefined`)
  })
})

describe('the engine is installed', () => {
  test('one helper missing fails, and the message names THAT helper', async () => {
    const fx = await mutated('container-engine-installed',
      root => rmSync(join(root, '/usr/libexec/podman/conmon')))
    try {
      expect(await verdictOf(fx, 'container-engine-installed')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-installed'))
        .toContain('the container engine is incomplete: /usr/libexec/podman/conmon missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('the systemd GENERATOR is in the set: without it a Quadlet file does nothing', async () => {
    const fx = await mutated('container-engine-installed',
      root => rmSync(join(root, '/usr/lib/systemd/system-generators/podman-system-generator')))
    try {
      expect(await messageOf(fx, 'container-engine-installed'))
        .toContain('podman-system-generator missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('a helper that became a SYMLINK to nothing fails', async () => {
    // `[ -f ]` follows the link, so a dangling one is not a regular file. This
    // is the shape a package move takes, and it passes an `-e` test.
    const fx = await mutated('container-engine-installed', (root) => {
      rmSync(join(root, '/usr/bin/crun'))
      symlinkSync('/usr/bin/crun-1.0', join(root, '/usr/bin/crun'))
    })
    try {
      expect(await messageOf(fx, 'container-engine-installed')).toContain('/usr/bin/crun missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('with NEITHER podman NOR storage.conf it passes by identity, and says so', async () => {
    // The WITH_CONTAINERS=0 board. Reproduced rather than improved on: the
    // oracle returns here and prints nothing for the nine assertions that
    // follow, so this entry owns both of its opening sentences.
    const fx = packedRootFixture(cx3576)
    try {
      rmSync(join(fx.root, '/usr/bin/podman'))
      rmSync(join(fx.root, STORAGE_CONF))
      const got = await only(fx, 'container-engine-installed')
      expect(got.verdict).toBe('pass')
      expect(got.message).toContain('this image carries no container engine at all')
      expect(got.message).toContain('skipped BY IDENTITY rather than passing vacuously')
    }
    finally {
      fx.dispose()
    }
  })

  test('podman gone but storage.conf STILL THERE is a broken install, not an absent engine', async () => {
    // The guard needs BOTH absent. An image that lost podman and kept its
    // configuration is a partial install -- the exact thing the check exists
    // for -- and reading the guard as `||` would pass it.
    const fx = await mutated('container-engine-installed',
      root => rmSync(join(root, '/usr/bin/podman')))
    try {
      expect(await verdictOf(fx, 'container-engine-installed')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-installed')).toContain('/usr/bin/podman missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('the other nine SKIP on an engine-less image rather than passing vacuously', async () => {
    // A LIMITATION, recorded rather than hidden. The oracle prints nothing at
    // all for these; the register cannot say "this check does not exist on this
    // image", so a skip is the nearest available answer and on such an image
    // the parity run would report nine `orphan` rows. Neither shipped board
    // produces this shape -- both carry podman.
    const fx = packedRootFixture(cx3576)
    try {
      rmSync(join(fx.root, '/usr/bin/podman'))
      rmSync(join(fx.root, STORAGE_CONF))
      for (const id of [
        'container-engine-no-units', 'container-engine-nft', 'container-engine-libsystemd',
        'container-engine-config-files', 'container-engine-single-config-layer',
        'container-engine-helper-dir-pinned', 'container-engine-not-enabled',
        'container-engine-graphroot-on-data', 'container-engine-quadlet-bind',
      ]) expect(`${id}: ${await verdictOf(fx, id)}`).toBe(`${id}: skip`)
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the engine is INERT', () => {
  test('podman.socket under a unit directory fails, and it is named', async () => {
    // Socket-activated: the root REST API comes up on first connection, so
    // "disabled" is not a defence. mica-podman does not run `make install.systemd`,
    // so anything named podman* under a unit directory arrived by a path
    // nobody intended.
    const fx = await mutated('container-engine-no-units',
      root => write(root, '/usr/lib/systemd/system/podman.socket', '[Socket]\nListenStream=%t/podman/podman.sock\n'))
    try {
      expect(await verdictOf(fx, 'container-engine-no-units')).toBe('fail')
      const message = await messageOf(fx, 'container-engine-no-units')
      expect(message).toContain('/usr/lib/systemd/system/podman.socket')
      expect(message).toContain('SOCKET-ACTIVATED')
    }
    finally {
      fx.dispose()
    }
  })

  test('/usr/local/lib/systemd is searched too -- the STATE-backed unit directory', async () => {
    // That prefix is writable from STATE, so a unit installed
    // there survives a reboot. It is the one unit directory an operator can
    // actually write to, and leaving it out of the search would exempt it.
    const fx = await mutated('container-engine-no-units',
      root => write(root, '/usr/local/lib/systemd/system/podman-auto-update.service', '[Unit]\n'))
    try {
      expect(await messageOf(fx, 'container-engine-no-units'))
        .toContain('/usr/local/lib/systemd/system/podman-auto-update.service')
    }
    finally {
      fx.dispose()
    }
  })

  test('the GENERATOR is excluded by name, so shipping it does not trip this check', async () => {
    // It lives under /usr/lib/systemd and is named podman-system-generator; it
    // is REQUIRED by the check above. Two checks that contradicted each other
    // would make one of them unsatisfiable.
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'container-engine-no-units')).toBe('pass')
      expect(await verdictOf(fx, 'container-engine-installed')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a *.wants entry does NOT trip the unit check -- it is the next check\'s subject', async () => {
    // Deliberately excluded, not overlooked. Two checks firing on one mutation
    // say less than two that each name a distinct way the engine could start,
    // and a dangling wants symlink can exist with no unit file behind it.
    const fx = packedRootFixture(cx3576)
    try {
      mkdirSync(join(fx.root, '/etc/systemd/system/multi-user.target.wants'), { recursive: true })
      symlinkSync('/usr/lib/systemd/system/podman.service',
        join(fx.root, '/etc/systemd/system/multi-user.target.wants/podman.service'))
      expect(await verdictOf(fx, 'container-engine-no-units')).toBe('pass')
      expect(await verdictOf(fx, 'container-engine-not-enabled')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a DANGLING enablement symlink still fails: the walk lstats and never follows', async () => {
    // `-e` alone would call this absent and pass on exactly the image that
    // failed. `find` reports the link, and so does this.
    const fx = await mutated('container-engine-not-enabled', (root) => {
      mkdirSync(join(root, '/etc/systemd/system/sockets.target.wants'), { recursive: true })
      symlinkSync('/usr/lib/systemd/system/podman.socket',
        join(root, '/etc/systemd/system/sockets.target.wants/podman.socket'))
    })
    try {
      expect(await verdictOf(fx, 'container-engine-not-enabled')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-not-enabled'))
        .toContain('/etc/systemd/system/sockets.target.wants/podman.socket')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the dependencies no linker can see', () => {
  test('nft missing fails, and the message says there is no fallback', async () => {
    const fx = await mutated('container-engine-nft', root => rmSync(join(root, '/usr/sbin/nft')))
    try {
      expect(await verdictOf(fx, 'container-engine-nft')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-nft'))
        .toContain('the iptables driver was REMOVED in netavark 2.x')
    }
    finally {
      fx.dispose()
    }
  })

  test('nft at /usr/bin instead of /usr/sbin still passes -- either path is on PATH', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      rmSync(join(fx.root, '/usr/sbin/nft'))
      write(fx.root, '/usr/bin/nft', 'x\n')
      expect(await verdictOf(fx, 'container-engine-nft')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('libsystemd.so.0 missing fails, and the message says ldd cannot report it', async () => {
    const fx = await mutated('container-engine-libsystemd', (root) => {
      for (const t of ['aarch64', 'x86_64']) {
        try {
          rmSync(join(root, `/usr/lib/${t}-linux-gnu/libsystemd.so.0`))
        }
        catch { /* the other board's triplet */ }
      }
    })
    try {
      expect(await verdictOf(fx, 'container-engine-libsystemd')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-libsystemd')).toContain('podman DLOPENS it')
    }
    finally {
      fx.dispose()
    }
  })

  test('the library is found at ANY depth under /usr/lib, not at a named triplet', async () => {
    // Pinning the multiarch directory is how the crypt(3) check came to report
    // that libcrypt "does not resolve to a regular file" on uefi-x64 -- true of a
    // path that board never had. Both boards are exercised here.
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        expect(`${board.name}: ${await verdictOf(fx, 'container-engine-libsystemd')}`)
          .toBe(`${board.name}: pass`)
      }
      finally {
        fx.dispose()
      }
    }
  })
})

describe('the engine reads the configuration mica wrote', () => {
  test('a missing registries.conf fails and is named', async () => {
    const fx = await mutated('container-engine-config-files',
      root => rmSync(join(root, '/etc/containers/registries.conf')))
    try {
      expect(await messageOf(fx, 'container-engine-config-files'))
        .toContain('container configuration is incomplete: /etc/containers/registries.conf missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('a SECOND config layer under /usr/share fails: podman merges it first', async () => {
    const fx = await mutated('container-engine-single-config-layer',
      root => write(root, '/usr/share/containers/containers.conf', '[engine]\nlog_driver = "k8s-file"\n'))
    try {
      expect(await verdictOf(fx, 'container-engine-single-config-layer')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-single-config-layer'))
        .toContain('an operator reading /etc sees only half the configuration')
    }
    finally {
      fx.dispose()
    }
  })

  test('an UNPINNED helper_binaries_dir fails, naming the writable prefix', async () => {
    // The default begins with two directories under /usr/local, a prefix this
    // image makes partially writable from STATE -- so an unpinned search is a
    // path from "write a file on the device" to "podman execs it".
    const fx = await mutated('container-engine-helper-dir-pinned',
      root => rewrite(root, CONTAINERS_CONF, t => t.replace(/^helper_binaries_dir.*$/m, '')))
    try {
      expect(await verdictOf(fx, 'container-engine-helper-dir-pinned')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-helper-dir-pinned'))
        .toContain('/usr/local/libexec/podman')
    }
    finally {
      fx.dispose()
    }
  })

  test('a helper_binaries_dir pinned somewhere ELSE fails', async () => {
    const fx = await mutated('container-engine-helper-dir-pinned',
      root => rewrite(root, CONTAINERS_CONF, t =>
        t.replace('["/usr/libexec/podman"]', '["/usr/local/libexec/podman"]')))
    try {
      expect(await verdictOf(fx, 'container-engine-helper-dir-pinned')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('image storage is on DATA', () => {
  test('a graphroot on /var fails with the current immutable-parent diagnosis', async () => {
    const fx = await mutated('container-engine-graphroot-on-data',
      root => rewrite(root, STORAGE_CONF, t =>
        t.replace('/mica/containers/storage', '/var/lib/containers/storage')))
    try {
      expect(await verdictOf(fx, 'container-engine-graphroot-on-data')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-graphroot-on-data'))
        .toContain('under the immutable /var parent')
    }
    finally {
      fx.dispose()
    }
  })

  test('a graphroot on neither tier fails as its own branch', async () => {
    const fx = await mutated('container-engine-graphroot-on-data',
      root => rewrite(root, STORAGE_CONF, t => t.replace('/mica/containers/storage', '/opt/containers')))
    try {
      expect(await messageOf(fx, 'container-engine-graphroot-on-data'))
        .toContain('which is neither system DATA (/mica) nor a path this check knows')
    }
    finally {
      fx.dispose()
    }
  })

  test('storage.conf with NO graphroot fails: podman falls back to /var', async () => {
    const fx = await mutated('container-engine-graphroot-on-data',
      root => write(root, STORAGE_CONF, '[storage]\ndriver = "overlay"\n'))
    try {
      expect(await messageOf(fx, 'container-engine-graphroot-on-data'))
        .toContain('sets no graphroot')
    }
    finally {
      fx.dispose()
    }
  })

  test('the LAST graphroot wins, as the oracle\'s tail -n1 does', async () => {
    // Two assignments in one file is a real shape -- a drop-in appended by a
    // build step -- and reading the first would judge the image against a value
    // podman does not use.
    const fx = await mutated('container-engine-graphroot-on-data',
      root => rewrite(root, STORAGE_CONF, t => `${t}graphroot = "/var/lib/containers/storage"\n`))
    try {
      expect(await verdictOf(fx, 'container-engine-graphroot-on-data')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-graphroot-on-data'))
        .toContain('/var/lib/containers/storage')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the Quadlet directory is writable, persistent and NOT enabled', () => {
  test('the mount unit absent fails, naming Quadlet\'s three search directories', async () => {
    const fx = await mutated('container-engine-quadlet-bind',
      root => rmSync(join(root, QUADLET_MOUNT)))
    try {
      expect(await verdictOf(fx, 'container-engine-quadlet-bind')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-quadlet-bind'))
        .toContain('Quadlet reads /run, /etc and /usr/share under containers/systemd')
    }
    finally {
      fx.dispose()
    }
  })

  test('a mount RETARGETED away from /etc/containers/systemd fails', async () => {
    const fx = await mutated('container-engine-quadlet-bind',
      root => rewrite(root, QUADLET_MOUNT, t =>
        t.replace('Where=/etc/containers/systemd', 'Where=/usr/share/containers/systemd')))
    try {
      expect(await messageOf(fx, 'container-engine-quadlet-bind'))
        .toContain('mounts \'/usr/share/containers/systemd\'')
    }
    finally {
      fx.dispose()
    }
  })

  test('a mount backed by a tmpfs rather than STATE fails', async () => {
    const fx = await mutated('container-engine-quadlet-bind',
      root => rewrite(root, QUADLET_MOUNT, t => t.replace('What=/mnt/data/state/quadlet', 'What=/run/quadlet')))
    try {
      expect(await messageOf(fx, 'container-engine-quadlet-bind'))
        .toContain('Installed containers would not survive an A/B update')
    }
    finally {
      fx.dispose()
    }
  })

  test('a STATICALLY ENABLED mount fails -- the branch with teeth', async () => {
    // The bind would come up at every boot whatever container.enabled says,
    // Quadlet would generate units from STATE and they would start. micad's
    // ContainerReconciler is what may enable it, at runtime.
    const fx = await mutated('container-engine-quadlet-bind', (root) => {
      mkdirSync(join(root, '/etc/systemd/system/local-fs.target.wants'), { recursive: true })
      symlinkSync('/etc/systemd/system/etc-containers-systemd.mount',
        join(root, '/etc/systemd/system/local-fs.target.wants/etc-containers-systemd.mount'))
    })
    try {
      expect(await verdictOf(fx, 'container-engine-quadlet-bind')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-quadlet-bind'))
        .toContain('the container.enabled switch gates nothing')
    }
    finally {
      fx.dispose()
    }
  })

  test('a DANGLING static enablement fails too: `[ -L ]` does not follow', async () => {
    // A symlink whose target was deleted still brings the bind up, and an
    // existence test that followed the link would call it absent.
    const fx = await mutated('container-engine-quadlet-bind', (root) => {
      mkdirSync(join(root, '/etc/systemd/system/local-fs.target.wants'), { recursive: true })
      symlinkSync('/etc/systemd/system/gone.mount',
        join(root, '/etc/systemd/system/local-fs.target.wants/etc-containers-systemd.mount'))
    })
    try {
      expect(await verdictOf(fx, 'container-engine-quadlet-bind')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('the unit reader takes the LAST Where=, as systemd does', () => {
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, QUADLET_MOUNT, t => `${t}Where=/somewhere/else\n`)
      expect(unitValue(fx.root, QUADLET_MOUNT, 'Where=')).toBe('/somewhere/else')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the package manager is gone, and the licences are not', () => {
  test('an apt timer surviving the purge fails, and it is named', async () => {
    const fx = await mutated('purge-no-package-timers',
      root => write(root, '/usr/lib/systemd/system/apt-daily.timer', '[Timer]\nOnCalendar=daily\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-package-timers')).toBe('fail')
      const message = await messageOf(fx, 'purge-no-package-timers')
      expect(message).toContain('/usr/lib/systemd/system/apt-daily.timer')
      expect(message).toContain('journal noise shaped exactly like a real fault')
    }
    finally {
      fx.dispose()
    }
  })

  test('dpkg-db-backup counts too -- it is a different package\'s timer', async () => {
    const fx = await mutated('purge-no-package-timers',
      root => write(root, '/usr/lib/systemd/system/dpkg-db-backup.timer', '[Timer]\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-package-timers')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a leftover binary fails, and the message distinguishes it from a tree', async () => {
    const fx = await mutated('purge-no-package-manager',
      root => write(root, '/usr/bin/dpkg-query', '#!/bin/sh\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-package-manager')).toBe('fail')
      expect(await messageOf(fx, 'purge-no-package-manager'))
        .toContain('still carries package management: /usr/bin/dpkg-query.')
    }
    finally {
      fx.dispose()
    }
  })

  test('the FACTORY copy of the dpkg database fails, not only the one on /var', async () => {
    // /var is relocated to /usr/share/factory/var by the pack stage, so an
    // image that kept the database under the factory tree would restore it onto
    // /var on the first boot -- a clean root that repopulates itself.
    const fx = await mutated('purge-no-package-manager',
      root => mkdirSync(join(root, '/usr/share/factory/var/lib/dpkg'), { recursive: true }))
    try {
      expect(await messageOf(fx, 'purge-no-package-manager'))
        .toContain('/usr/share/factory/var/lib/dpkg/')
    }
    finally {
      fx.dispose()
    }
  })

  test('the dpkg LOG left on /var fails, and the message names it as a file', async () => {
    // The residue a purge written around /var/lib and /var/cache does not
    // reach. 62 KB of every package operation the build ran, and the trailing
    // slash is absent because it is a file, not a tree.
    const fx = await mutated('purge-no-package-manager',
      root => write(root, '/var/log/dpkg.log', '2026-08-28 00:00:00 install bash\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-package-manager')).toBe('fail')
      expect(await messageOf(fx, 'purge-no-package-manager'))
        .toContain('still carries package management: /var/log/dpkg.log.')
    }
    finally {
      fx.dispose()
    }
  })

  test('the FACTORY copy of the dpkg log fails, not only the one on /var', async () => {
    // Same first-boot restore as the database above: /var is relocated to
    // /usr/share/factory/var by the pack stage, so a log left under the factory
    // tree lands back on /var on the first boot.
    const fx = await mutated('purge-no-package-manager',
      root => write(root, '/usr/share/factory/var/log/dpkg.log', 'x\n'))
    try {
      expect(await messageOf(fx, 'purge-no-package-manager'))
        .toContain('/usr/share/factory/var/log/dpkg.log.')
    }
    finally {
      fx.dispose()
    }
  })

  test('the apt log DIRECTORY fails, and gets the trailing slash a file does not', async () => {
    // /var/log/apt is the one entry of the log set that is a tree --
    // history.log, term.log and eipp.log.xz -- so the message decides the slash
    // per path rather than per list.
    const fx = await mutated('purge-no-package-manager',
      root => mkdirSync(join(root, '/var/log/apt'), { recursive: true }))
    try {
      expect(await verdictOf(fx, 'purge-no-package-manager')).toBe('fail')
      expect(await messageOf(fx, 'purge-no-package-manager'))
        .toContain('still carries package management: /var/log/apt/.')
    }
    finally {
      fx.dispose()
    }
  })

  test('the alternatives log fails on both boards', async () => {
    for (const board of [cx3576, uefiX64]) {
      const fx = await mutated('purge-no-package-manager',
        root => write(root, '/var/log/alternatives.log', 'update-alternatives\n'), board)
      try {
        expect(`${board.name}: ${await verdictOf(fx, 'purge-no-package-manager')}`)
          .toBe(`${board.name}: fail`)
      }
      finally {
        fx.dispose()
      }
    }
  })

  test('perl counts as a package-management binary', async () => {
    // It is in the oracle's list on purpose: it is what dpkg's maintainer
    // scripts are written in, and ~21 MB of it.
    const fx = await mutated('purge-no-package-manager',
      root => write(root, '/usr/bin/perl', 'x\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-package-manager')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('ONE copyright file short of the threshold fails, and the count is printed', async () => {
    // The fixture seeds exactly the threshold, so the mutation is one deletion
    // and the boundary is what the case is about.
    const fx = await mutated('purge-licences-survived',
      root => rmSync(join(root, '/usr/share/doc/pkg000/copyright')))
    try {
      expect(await verdictOf(fx, 'purge-licences-survived')).toBe('fail')
      expect(await messageOf(fx, 'purge-licences-survived'))
        .toContain('only 99 copyright files are left under /usr/share/doc')
    }
    finally {
      fx.dispose()
    }
  })

  test('a purge that took the whole doc tree fails, naming the redistribution terms', async () => {
    const fx = await mutated('purge-licences-survived',
      root => rmSync(join(root, '/usr/share/doc'), { recursive: true }))
    try {
      expect(await messageOf(fx, 'purge-licences-survived'))
        .toContain('breaches those terms')
    }
    finally {
      fx.dispose()
    }
  })

  test('a script naming perl as its interpreter fails, and it is named', async () => {
    const fx = await mutated('purge-no-dangling-perl-shebang',
      root => write(root, '/usr/bin/mica-report', '#!/usr/bin/perl\nprint "hi";\n'))
    try {
      expect(await verdictOf(fx, 'purge-no-dangling-perl-shebang')).toBe('fail')
      const message = await messageOf(fx, 'purge-no-dangling-perl-shebang')
      expect(message).toContain('/usr/bin/mica-report')
      expect(message).toContain('reporting a missing shebang rather than the purge that caused it')
    }
    finally {
      fx.dispose()
    }
  })

  test('/etc is searched too, not only the binary directories', async () => {
    const fx = await mutated('purge-no-dangling-perl-shebang',
      root => write(root, '/etc/cron.daily/logrotate', '#!/usr/bin/env perl\n'))
    try {
      expect(await messageOf(fx, 'purge-no-dangling-perl-shebang'))
        .toContain('/etc/cron.daily/logrotate')
    }
    finally {
      fx.dispose()
    }
  })

  test('a BINARY carrying the same byte run is skipped, as `grep -I` does', async () => {
    // /usr/bin holds thousands of ELF objects and a reader without -I would
    // match a stray sequence inside one. The NUL is what makes a file binary to
    // GNU grep, and it is what makes this one skipped.
    const fx = packedRootFixture(cx3576)
    try {
      writeFileSync(join(fx.root, '/usr/bin/mica-apid'),
        Buffer.concat([Buffer.from('\x7fELF\0\0\0\0'), Buffer.from('\n#!/usr/bin/perl\n')]))
      expect(await verdictOf(fx, 'purge-no-dangling-perl-shebang')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the trust store was generated', () => {
  test('an EMPTY bundle fails, naming what breaks first', async () => {
    const fx = await mutated('ca-bundle-generated', root => write(root, CA_BUNDLE, ''))
    try {
      expect(await verdictOf(fx, 'ca-bundle-generated')).toBe('fail')
      expect(await messageOf(fx, 'ca-bundle-generated'))
        .toContain('fail closed with \'certificate signed by unknown authority\'')
    }
    finally {
      fx.dispose()
    }
  })

  test('an ABSENT bundle takes the same branch as an empty one', async () => {
    const fx = await mutated('ca-bundle-generated', root => rmSync(join(root, CA_BUNDLE)))
    try {
      expect(await messageOf(fx, 'ca-bundle-generated')).toContain('is missing or empty;')
    }
    finally {
      fx.dispose()
    }
  })

  test('a bundle ONE certificate short fails as "not generated", not as missing', async () => {
    // The two failures are different faults with different repairs, and the
    // fixture sits exactly on the threshold so one deletion separates them.
    const fx = await mutated('ca-bundle-generated',
      root => rewrite(root, CA_BUNDLE, t => t.replace('-----BEGIN CERTIFICATE-----\ncert0\n', '')))
    try {
      expect(await messageOf(fx, 'ca-bundle-generated'))
        .toContain('holds only 99 certificates; the package is installed but its trust store was not generated')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the packed root is read INSIDE the root, never against the host', () => {
  // RFCT-358's discriminating case for this file's readers: an ABSOLUTE symlink
  // whose target exists on the machine running the suite and not in the image.
  // Host resolution -- what `statSync(join(root, path))` did -- answers PASS on
  // it; resolving inside the root answers FAIL, which is the only true answer
  // about the image. A test that exercised only the new helper could not tell
  // the two implementations apart.

  test('nft pointing at a host regular file is nft ABSENT', async () => {
    const fx = await mutated('container-engine-nft', (root) => {
      rmSync(join(root, '/usr/sbin/nft'))
      symlinkSync('/proc/version', join(root, '/usr/sbin/nft'))
    })
    try {
      expect(await verdictOf(fx, 'container-engine-nft')).toBe('fail')
      expect(await messageOf(fx, 'container-engine-nft')).toContain('nft is not in the image')
    }
    finally {
      fx.dispose()
    }
  })
})
