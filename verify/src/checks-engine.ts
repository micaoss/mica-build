// Batch 4a: the container engine, the package-manager purge, and the trust store.
//
// Fifteen conclusions on each board: ten from `check_container_engine`, four
// from `check_no_package_manager`, and one from
// `check_ca_bundle`. Three families in one module because all three
// are the same act read from three sides: what the pack stage put in the root,
// what it took out, and what it GENERATED on the way through.
//
// One shape this register cannot express, measured and recorded.
// `check_container_engine` opens with an early return -- `if [ ! -e podman ] &&
// [ ! -e storage.conf ]` then `pass "this image carries no container engine at
// all ..."` -- so a WITH_CONTAINERS=0 image prints one conclusion where a normal
// image prints ten. A dedicated entry owning that one line would report `unfired`
// on both shipped boards, which is exit 1, and the nine suppressed checks have
// no shell line to compare against. So `container-engine-installed` owns both
// sentences through a `pass` matcher list and the other nine answer `skipped()`,
// which on a WITH_CONTAINERS=0 image would produce nine `orphan` rows. Neither
// shipped board produces that shape; both carry podman.
//
// The unit search excludes *.wants/* on purpose, and the oracle says so: an
// enablement symlink is the next check's subject and a dangling one can exist
// with no unit file behind it.

import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { entry, packedRoot, pathInRoot, regularFileInRoot, statInRoot } from './checks-root.ts'
import type { CheckCase, ImageContext } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { skipped, verdict } from './verdict.ts'

// The oracle's own constants, in its own order -- the message
// prints them and a reordering here would diverge on message alone.
const CONTAINER_STORAGE_CONF = '/etc/containers/storage.conf'
const CONTAINER_BINARIES = [
  '/usr/bin/podman', '/usr/bin/crun', '/usr/libexec/podman/conmon',
  '/usr/libexec/podman/netavark', '/usr/libexec/podman/aardvark-dns',
  '/usr/libexec/podman/catatonit', '/usr/libexec/podman/quadlet',
] as const
const CONTAINER_POLICY = '/etc/containers/policy.json'
const CONTAINER_CONF = '/etc/containers/containers.conf'
const CONTAINER_REGISTRIES = '/etc/containers/registries.conf'
const CONTAINER_NFT = '/usr/sbin/nft'
const QUADLET_GENERATOR = '/usr/lib/systemd/system-generators/podman-system-generator'
const QUADLET_DIR = '/etc/containers/systemd'
const QUADLET_MOUNT_UNIT = 'etc-containers-systemd.mount'

const UNIT_TREES = ['/etc/systemd', '/usr/lib/systemd', '/usr/local/lib/systemd'] as const
const ENABLEMENT_TREES = ['/etc/systemd/system', '/usr/lib/systemd/system'] as const

// the walks `find` performs, spelled once

/**
 * `[ -e "${ROOT}${path}" ]`: exists, FOLLOWING a link -- a dangling one is
 * absent. Followed inside the root, so "dangling" is a fact about the image.
 */
function existsInRoot(root: string, path: string): boolean {
  return statInRoot(root, path) !== undefined
}

/**
 * Every path at or under `trees` for which `keep` holds, root-relative and sorted.
 *
 * LSTAT, never stat: `find` without `-L` does not follow a symlink, reports the
 * LINK rather than its target, and does not descend through one. A `.wants`
 * entry is a symlink into another tree and a DANGLING one is a real shape --
 * `-e` alone would call it absent and pass on exactly the image that failed --
 * so a walk that followed links would both miss it and report the wrong path.
 */
function findUnder(
  root: string,
  trees: readonly string[],
  keep: (relative: string, name: string, stats: Stats) => boolean,
): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    }
    catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st: Stats
      try {
        st = lstatSync(full)
      }
      catch {
        continue
      }
      const relative = full.slice(root.length)
      if (keep(relative, name, st)) found.push(relative)
      if (st.isDirectory()) walk(full)
    }
  }
  // Only the entry point is resolved: the walk itself lstats and never
  // descends through a link, so nothing inside it can leave the root -- but a
  // tree named through an absolute symlink would be enumerated on the host.
  for (const tree of trees) {
    let at: string
    try {
      at = pathInRoot(root, tree)
    }
    catch {
      continue
    }
    walk(at)
  }
  return found.sort()
}

// the container engine

/** The oracle's early-return guard: NEITHER podman nor storage.conf. */
function noEngineAtAll(root: string): boolean {
  return !existsInRoot(root, '/usr/bin/podman')
    && !existsInRoot(root, CONTAINER_STORAGE_CONF)
}

const NO_ENGINE_MESSAGE = 'this image carries no container engine at all (no podman, no storage.conf): '
  + 'a WITH_CONTAINERS=0 board, and the assertions that follow are skipped BY IDENTITY rather than '
  + 'passing vacuously'

/**
 * A check that exists only when the image carries an engine.
 *
 * The `skipped()` is the register's nearest available answer to "the oracle did
 * not run this at all", and it is reached only on an image neither shipped board
 * produces. See the header.
 */
function engineCheck(input: {
  id: string
  shell: CheckCase['shell']
  decide: (root: string, ctx: ImageContext) => Promise<CheckResult> | CheckResult
}): CheckCase {
  return {
    id: input.id,
    shell: input.shell,
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (noEngineAtAll(root)) {
        return [skipped(input.id,
          `${input.id}: this image carries no container engine, so the verification contract returns `
          + `before reaching this assertion and prints nothing for it`)]
      }
      return [await input.decide(root, ctx)]
    },
  }
}

const ENGINE_CHECKS: readonly CheckCase[] = [
  {
    // The one entry that owns BOTH of the oracle's opening sentences. See the
    // header for why a dedicated entry for the absent-engine line cannot work.
    id: 'container-engine-installed',
    shell: {
      pass: [
        'the container engine is in the image: podman, crun, conmon',
        'this image carries no container engine at all',
      ],
      fail: 'the container engine is incomplete:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (noEngineAtAll(root)) {
        return [verdict('container-engine-installed', true, NO_ENGINE_MESSAGE)]
      }
      const missing = [...CONTAINER_BINARIES, QUADLET_GENERATOR]
        .filter(b => !regularFileInRoot(root, b))
      return [verdict(
        'container-engine-installed',
        missing.length === 0,
        missing.length === 0
          ? 'the container engine is in the image: podman, crun, conmon, netavark, aardvark-dns, '
            + 'quadlet and its systemd generator'
          : `the container engine is incomplete:${missing.map(m => ` ${m}`).join('')} missing. `
            + `the engine ships installed and inert; a partial install is a switch that `
            + `turns on nothing`,
      )]
    },
  },

  engineCheck({
    // NO podman units, at all. The engine is inert because nothing can start
    // it, not because seven symlinks point at /dev/null -- podman is built from
    // source here, so upstream's contrib/ units are never installed and
    // podman.socket is not masked, it does not exist.
    id: 'container-engine-no-units',
    shell: {
      pass: 'the image contains no podman systemd unit of any name',
      fail: 'the image contains podman systemd units:',
    },
    decide: (root) => {
      const units = findUnder(root, UNIT_TREES, (relative, name) =>
        name.startsWith('podman')
        && name !== 'podman-system-generator'
        && !/\.wants\//.test(relative))
      return verdict(
        'container-engine-no-units',
        units.length === 0,
        units.length === 0
          ? 'the image contains no podman systemd unit of any name; the engine is inert by '
            + 'construction rather than by masking, so there is no mask list to keep in step with '
            + 'upstream'
          : `the image contains podman systemd units:${units.join(' ')} . mica-podman `
            + `does not run 'make install.systemd', so anything named podman* under a unit directory `
            + `arrived by a path nobody intended -- and podman.socket in particular is `
            + `SOCKET-ACTIVATED, so being disabled is not enough`,
      )
    },
  }),

  engineCheck({
    // Reached by EXEC, so no NEEDED-soname check can see it: an image can be
    // missing it and pass every soname assertion in this file.
    id: 'container-engine-nft',
    shell: {
      pass: 'nft is in the image; netavark 2.x has no iptables driver',
      fail: 'nft is not in the image.',
    },
    decide: (root) => {
      const ok = regularFileInRoot(root, CONTAINER_NFT)
        || regularFileInRoot(root, '/usr/bin/nft')
      return verdict(
        'container-engine-nft',
        ok,
        ok
          ? 'nft is in the image; netavark 2.x has no iptables driver (its FirewallImpl enum is '
            + 'Firewalld/Nftables/Fwnone) and execs nft by name off PATH, so without this binary '
            + 'every container network setup fails'
          : 'nft is not in the image. netavark execs it by name (nftables crate, NFT_EXECUTABLE = '
            + '"nft") to build every container network, and there is no fallback: the iptables driver '
            + 'was REMOVED in netavark 2.x. The device boots, the engine reports healthy, and the '
            + `first 'podman run' fails with 'unable to execute nft'`,
      )
    },
  }),

  engineCheck({
    // A third invisible category, after the exec'd nft: podman DLOPENS
    // libsystemd.so.0 by name for journald logging, so it appears in no NEEDED
    // list and ldd cannot see it. Losing it does not fail -- it loses logs.
    id: 'container-engine-libsystemd',
    shell: {
      pass: 'libsystemd.so.0 is in the image; podman dlopens it by name',
      fail: 'libsystemd.so.0 is not in the image.',
    },
    decide: (root) => {
      // `find "${ROOT}/usr/lib" -name libsystemd.so.0 -print -quit`: anywhere
      // under /usr/lib, at any depth, because the multiarch triplet follows the
      // board and naming the directory would make this an arm64 assertion.
      const found = findUnder(root, ['/usr/lib'], (_relative, name) => name === 'libsystemd.so.0')
      const ok = found.length > 0
      return verdict(
        'container-engine-libsystemd',
        ok,
        ok
          ? 'libsystemd.so.0 is in the image; podman dlopens it by name for journald logging, which '
            + 'is a dependency neither a NEEDED list nor ldd can report'
          : 'libsystemd.so.0 is not in the image. podman DLOPENS it for journald logging, so nothing '
            + 'in the link-time or loader checks above can see this missing -- and with '
            + 'log_driver=journald the symptom is container logs quietly going nowhere, not an error',
      )
    },
  }),

  engineCheck({
    // storage.conf is NOT in this list though it is equally Mica OS's own: it has
    // its own assertion below, which reports where the graphroot POINTS rather
    // than merely that a file exists. Checking it in both places would mean one
    // missing file produced two failures.
    id: 'container-engine-config-files',
    shell: {
      pass: 'mica ships its own policy.json, containers.conf, registries.conf and storage.conf',
      fail: 'container configuration is incomplete:',
    },
    decide: (root) => {
      const missing = [CONTAINER_POLICY, CONTAINER_CONF, CONTAINER_REGISTRIES]
        .filter(f => !regularFileInRoot(root, f))
      return verdict(
        'container-engine-config-files',
        missing.length === 0,
        missing.length === 0
          ? 'mica ships its own policy.json, containers.conf, registries.conf and storage.conf; the '
            + `distribution's containers-common is not installed, so these four files are the whole `
            + 'of the engine\'s configuration'
          : `container configuration is incomplete:${missing.map(m => ` ${m}`).join('')} missing. `
            + `containers-common is not installed to supply a fallback, and podman does not fail on `
            + `an absent config file -- it uses a built-in default nobody chose`,
      )
    },
  }),

  engineCheck({
    // A second config layer under /usr/share supplies settings that reading
    // /etc does not reveal: podman reads it BEFORE /etc and merges.
    id: 'container-engine-single-config-layer',
    shell: {
      pass: 'there is no /usr/share/containers/containers.conf',
      fail: '/usr/share/containers/containers.conf exists.',
    },
    decide: (root) => {
      const present = existsInRoot(root, '/usr/share/containers/containers.conf')
      return verdict(
        'container-engine-single-config-layer',
        !present,
        present
          ? '/usr/share/containers/containers.conf exists. podman reads it BEFORE '
            + '/etc/containers/containers.conf and merges, so an operator reading /etc sees only half '
            + 'the configuration'
          : 'there is no /usr/share/containers/containers.conf; /etc is the only layer, so what mica '
            + 'configured is what reading one file shows',
      )
    },
  }),

  engineCheck({
    // The default helper_binaries_dir begins with two directories under
    // /usr/local, a prefix this image makes partially writable.
    // Pinned, not searched.
    id: 'container-engine-helper-dir-pinned',
    shell: {
      pass: 'containers.conf pins helper_binaries_dir to /usr/libexec/podman',
      fail: 'containers.conf does not pin helper_binaries_dir.',
    },
    decide: (root) => {
      const ok = grepLines(root, CONTAINER_CONF)
        .some(l => /^helper_binaries_dir *= *\["\/usr\/libexec\/podman"\]/.test(l))
      return verdict(
        'container-engine-helper-dir-pinned',
        ok,
        ok
          ? "containers.conf pins helper_binaries_dir to /usr/libexec/podman; podman's built-in "
            + 'default searches /usr/local/libexec/podman and /usr/local/lib/podman FIRST, and '
            + '/usr/local on this image is a prefix with a STATE-backed writable subtree'
          : 'containers.conf does not pin helper_binaries_dir. The default (config_linux.go:24) '
            + 'searches /usr/local/libexec/podman and /usr/local/lib/podman before the image\'s own '
            + '/usr/libexec/podman, and mica deliberately makes part of /usr/local writable from STATE',
      )
    },
  }),

  engineCheck({
    // The OTHER way a unit starts. A unit file that does not exist cannot be
    // enabled -- but a dangling *.wants symlink can, and it is a real shape:
    // `-e` alone would call it absent and pass on exactly the image that failed.
    id: 'container-engine-not-enabled',
    shell: {
      pass: 'no podman unit carries an enablement symlink',
      fail: 'podman units carry an enablement symlink in the image:',
    },
    decide: (root) => {
      // `-path '*.wants/podman*'`: anything after `podman`, slashes included.
      const enabled = findUnder(root, ENABLEMENT_TREES, relative => relative.includes('.wants/podman'))
      return verdict(
        'container-engine-not-enabled',
        enabled.length === 0,
        enabled.length === 0
          ? 'no podman unit carries an enablement symlink; the engine is inert in the shipped image'
          : `podman units carry an enablement symlink in the image:${enabled.join(' ')} . `
            + `The device would run containers before anyone asked, which is the opposite of `
            + `the default-off switch`,
      )
    },
  }),

  engineCheck({
    // Image storage must use DATA. The default /var parent is immutable and
    // has no approved writable container-storage leaf.
    id: 'container-engine-graphroot-on-data',
    shell: {
      pass: ', on DATA -- the only growable partition',
      fail: [
        'container image storage is unconfigured:',
        ', under the immutable /var parent.',
        ', which is neither system DATA (/mica) nor a path this check knows.',
      ],
    },
    decide: (root) => {
      const id = 'container-engine-graphroot-on-data'
      const present = regularFileInRoot(root, CONTAINER_STORAGE_CONF)
      // `sed -n 's/^ *graphroot *= *"\(.*\)"/\1/p' | tail -n1`: the LAST such
      // line, because that is the one a later assignment in the same file wins
      // with -- and the greedy `\(.*\)` takes everything up to the final quote.
      const graph = present
        ? grepLines(root, CONTAINER_STORAGE_CONF)
          .map(l => /^ *graphroot *= *"(.*)"/.exec(l)?.[1])
          .filter((v): v is string => v !== undefined)
          .at(-1) ?? ''
        : ''
      if (!present) {
        return verdict(id, false,
          `container image storage is unconfigured: no ${CONTAINER_STORAGE_CONF} in the image, so `
          + `podman falls back to /var/lib/containers/storage under the immutable /var parent; `
          + `no writable container-storage leaf is mounted there`)
      }
      if (graph === '') {
        return verdict(id, false,
          `container image storage is unconfigured: ${CONTAINER_STORAGE_CONF} sets no graphroot, so `
          + `podman uses /var/lib/containers/storage under the immutable /var parent`)
      }
      if (graph.startsWith('/mica/')) {
        return verdict(id, true,
          `container image storage is at ${graph}, on DATA -- the only growable partition, and the `
          + `one that survives an A/B update`)
      }
      if (graph.startsWith('/var/')) {
        return verdict(id, false,
          `container image storage is at ${graph}, under the immutable /var parent. `
          + `Use the approved DATA container namespace so image writes can succeed`)
      }
      return verdict(id, false,
        `container image storage is at ${graph}, which is neither system DATA (/mica) nor a path this check `
        + `knows. Image storage grows without bound and belongs on the partition systemd-repart extends`)
    },
  }),

  engineCheck({
    // The Quadlet directory has to be writable and persistent, or the operator
    // cannot install a container at all: `quadlet --dryrun` reads /run, /etc and
    // /usr/share under containers/systemd, of which /run is tmpfs and the other
    // two are inside the read-only squashfs.
    //
    // And it must not be statically enabled. That branch is the one with teeth:
    // the bind would come up at every boot whatever container.enabled says,
    // Quadlet would generate units from STATE and they would start, so anything
    // able to write /mnt/data/state/quadlet gets a root-capable container at the next
    // reboot with no operator decision anywhere in the path.
    id: 'container-engine-quadlet-bind',
    shell: {
      pass: ' is a STATE-backed bind via etc-containers-systemd.mount (What=',
      fail: [
        `${QUADLET_MOUNT_UNIT} is not in the image,`,
        `${QUADLET_MOUNT_UNIT} mounts '`,
        `${QUADLET_MOUNT_UNIT} is backed by '`,
        `${QUADLET_MOUNT_UNIT} is STATICALLY ENABLED.`,
      ],
    },
    decide: (root) => {
      const id = 'container-engine-quadlet-bind'
      const unit = `/etc/systemd/system/${QUADLET_MOUNT_UNIT}`
      const present = regularFileInRoot(root, unit)
      const where = unitValue(root, unit, 'Where=')
      const what = unitValue(root, unit, 'What=')
      if (!present) {
        return verdict(id, false,
          `${QUADLET_MOUNT_UNIT} is not in the image, so ${QUADLET_DIR} stays on the read-only `
          + `squashfs. Quadlet reads /run, /etc and /usr/share under containers/systemd and nothing `
          + `else: /run is tmpfs and the other two are in the verity root, so an operator has NOWHERE `
          + `to install a container that survives a reboot`)
      }
      if (where !== QUADLET_DIR) {
        return verdict(id, false,
          `${QUADLET_MOUNT_UNIT} mounts '${where}', not ${QUADLET_DIR} — which is the only one of `
          + `Quadlet's three search directories an operator can be given`)
      }
      if (!what.startsWith('/mnt/data/state/')) {
        return verdict(id, false,
          `${QUADLET_MOUNT_UNIT} is backed by '${what}', not STATE. Installed containers would not `
          + `survive an A/B update`)
      }
      // `[ -L ... ]`: a SYMLINK, whether or not it dangles. A static enablement
      // whose target had been deleted would still bring the bind up.
      if (entry(root, `/etc/systemd/system/local-fs.target.wants/${QUADLET_MOUNT_UNIT}`)
        ?.isSymbolicLink() === true) {
        return verdict(id, false,
          `${QUADLET_MOUNT_UNIT} is STATICALLY ENABLED. The bind then comes up at every boot whatever `
          + `container.enabled says, Quadlet generates units from STATE, and they start — so anything `
          + `able to write /mnt/data/state/quadlet gets a root-capable container at the next reboot with no `
          + `operator decision anywhere in the path, and the container.enabled switch gates `
          + `nothing. micad's `
          + `ContainerReconciler enables it at runtime when the setting is true`)
      }
      return verdict(id, true,
        `${QUADLET_DIR} is a STATE-backed bind via ${QUADLET_MOUNT_UNIT} (What=${what}), installed `
        + `and NOT statically enabled — micad brings it up only when container.enabled is true, which `
        + `is what makes the switch mean anything at boot`)
    },
  }),
]

// check_no_package_manager

const PKGMGR_BINARIES = [
  '/usr/bin/dpkg', '/usr/bin/dpkg-query', '/usr/bin/dpkg-deb', '/usr/bin/apt',
  '/usr/bin/apt-get', '/usr/bin/apt-cache', '/usr/bin/apt-key', '/usr/bin/perl',
] as const
// /var is relocated to /usr/share/factory/var by the pack stage, so the dpkg
// database is looked for in BOTH places: an image that kept it under the factory
// tree would restore it onto /var on the first boot, and a check that only
// looked at /var would report a clean root that repopulates itself.
const PKGMGR_TREES = [
  '/var/lib/dpkg', '/var/lib/apt', '/etc/apt', '/usr/lib/apt',
  '/usr/share/factory/var/lib/dpkg', '/usr/share/factory/var/lib/apt',
] as const
// The LOGS, which the databases and caches above do not cover and which the
// purge left behind until later: /var/log survived a purge written around
// /var/lib and /var/cache, and the pack stage then carried the whole of /var
// into the factory tree. They are listed in BOTH places for the same reason the
// trees are -- a log left under /usr/share/factory/var is restored onto /var on
// the first boot -- and one of them, dpkg.log, is 62 KB of every package
// operation this build ran, which is a build record and not device content.
// It survives as a build record instead: 90-pack's `closed` stage captures the
// three into /out/pkg-logs before the purge and the driver exports them to
// _out/<board>/pkg-logs/, so the stage-order comparison in rootfs/README.md
// still reads the same bytes. This check is what holds the image side of that.
const PKGMGR_LOGS = [
  '/var/log/dpkg.log', '/var/log/apt', '/var/log/alternatives.log',
  '/usr/share/factory/var/log/dpkg.log', '/usr/share/factory/var/log/apt',
  '/usr/share/factory/var/log/alternatives.log',
] as const

const PURGE_CHECKS: readonly CheckCase[] = [
  {
    // The timers, not just the binaries. apt-daily.timer,
    // apt-daily-upgrade.timer and dpkg-db-backup.timer are enabled by their
    // packages and survive a purge that only removes /usr/bin/apt -- they then
    // fire daily on a device with no package manager and fail daily. Found by
    // booting the x64 image, in an arm64 image that had already shipped.
    id: 'purge-no-package-timers',
    shell: {
      pass: 'no apt or dpkg systemd timer is in the image',
      fail: 'package-management timers are in the image:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const timers = findUnder(root, ['/etc/systemd', '/usr/lib/systemd'], (_r, name) =>
        name.startsWith('apt-daily') || name.startsWith('dpkg-db-backup'))
      return [verdict(
        'purge-no-package-timers',
        timers.length === 0,
        timers.length === 0
          ? 'no apt or dpkg systemd timer is in the image; removing the package manager\'s binaries '
            + 'does not remove its timers, and those fire daily whether or not anything is left for '
            + 'them to run'
          : `package-management timers are in the image:${timers.join(' ')} . Each is `
            + `enabled by its package, fires daily, and fails daily on a root with no apt and no dpkg `
            + `— journal noise shaped exactly like a real fault`,
      )]
    },
  },

  {
    // `[ -e ]` for a binary and `[ -d ]` for a tree, in the oracle's own order:
    // the binaries first, then the state directories, then the logs, each
    // appended with a trailing slash so the message says which kind it found.
    // The logs are a mixed set -- two files and a directory -- so the slash is
    // decided per path rather than per list.
    id: 'purge-no-package-manager',
    shell: {
      pass: 'the packed root carries no package manager: none of ',
      fail: 'the packed root still carries package management:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const found = [
        ...PKGMGR_BINARIES.filter(b => existsInRoot(root, b)).map(b => ` ${b}`),
        ...PKGMGR_TREES.filter(d => isDirectoryInRoot(root, d)).map(d => ` ${d}/`),
        ...PKGMGR_LOGS.filter(l => existsInRoot(root, l))
          .map(l => isDirectoryInRoot(root, l) ? ` ${l}/` : ` ${l}`),
      ]
      return [verdict(
        'purge-no-package-manager',
        found.length === 0,
        found.length === 0
          ? `the packed root carries no package manager: none of ${PKGMGR_BINARIES.join(' ')}, no `
            + `dpkg/apt state and none of ${PKGMGR_LOGS.slice(0, 3).join(' ')}, in /var or under the `
            + `factory tree`
          : `the packed root still carries package management:${found.join('')}. The root is a `
            + `read-only dm-verity squashfs and updates install signed component files, so nothing here `
            + `can install a package — but anyone who reaches a shell now has the tool to try, and it `
            + `is ~21 MB of weight that cannot be used`,
      )]
    },
  },

  {
    // ...and the purge stopped where the licences begin. This is the half a
    // size-driven cleanup gets wrong, and it fails silently: nobody notices a
    // missing copyright file until a redistribution question is asked.
    id: 'purge-licences-survived',
    shell: {
      pass: 'the licence texts survived the purge: ',
      fail: 'copyright files are left under /usr/share/doc',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      // `find ... -name copyright -type f`: -type f FOLLOWS nothing and matches
      // a regular file only, so a symlinked copyright does not count.
      const n = findUnder(root, ['/usr/share/doc'], (_r, name, st) =>
        name === 'copyright' && st.isFile() && !st.isSymbolicLink()).length
      return [verdict(
        'purge-licences-survived',
        n >= 100,
        n >= 100
          ? `the licence texts survived the purge: ${n} copyright files under /usr/share/doc`
          : `only ${n} copyright files are left under /usr/share/doc (expected the full package set, `
            + `~159). Debian ships these to satisfy the redistribution terms of the GPL and the other `
            + `licences in the image; removing them saves under a megabyte and breaches those terms`,
      )]
    },
  },

  {
    // A script whose interpreter was removed is a trap: it fails at the moment
    // it is needed, with an error about the shebang rather than about the purge.
    id: 'purge-no-dangling-perl-shebang',
    shell: {
      pass: 'no script in the packed root names perl as its interpreter',
      fail: 'perl was removed but these scripts still name it as their interpreter:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      // `grep -rlI '^#!.*perl'`: recursive, names only, and -I skips binary
      // FILES -- which matters, because /usr/bin holds thousands of them and a
      // reader without -I would match a stray byte sequence in an ELF.
      const dangling = findUnder(
        root,
        ['/usr/bin', '/usr/sbin', '/usr/lib/systemd', '/etc'],
        (_r, _name, st) => st.isFile() && !st.isSymbolicLink(),
      ).filter(p => namesPerlInterpreter(root, p))
      return [verdict(
        'purge-no-dangling-perl-shebang',
        dangling.length === 0,
        dangling.length === 0
          ? 'no script in the packed root names perl as its interpreter, so removing perl left '
            + 'nothing broken behind'
          : `perl was removed but these scripts still name it as their interpreter: `
            + `${dangling.join(' ')} . Each one fails at the moment it is invoked, reporting a `
            + `missing shebang rather than the purge that caused it`,
      )]
    },
  },
]

// check_ca_bundle

const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

const CA_CHECKS: readonly CheckCase[] = [
  {
    // A COUNT, not a pinned set. The assertion is that the store was
    // GENERATED, which is what fails when ca-certificates ships without its
    // postinst having run -- TLS code with nobody to believe, failing only on
    // the first outbound connection and reporting it as the remote's fault.
    id: 'ca-bundle-generated',
    shell: {
      pass: ' CA certificates (a count, not a pinned set',
      fail: [
        `${CA_BUNDLE} is missing or empty;`,
        ' certificates; the package is installed but its trust store was not generated',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      // `[ ! -s ]`: exists AND is non-empty, following links.
      const size = ((): number => {
        try {
          return statInRoot(root, CA_BUNDLE)?.size ?? 0
        }
        catch {
          return 0
        }
      })()
      if (size === 0) {
        return [verdict('ca-bundle-generated', false,
          `${CA_BUNDLE} is missing or empty; the image can speak TLS and cannot verify anyone. `
          + `Container pulls, curl and any HTTPS update fetch fail closed with 'certificate signed `
          + `by unknown authority'`)]
      }
      const n = grepLines(root, CA_BUNDLE).filter(l => l.includes('BEGIN CERTIFICATE')).length
      return [verdict(
        'ca-bundle-generated',
        n >= 100,
        n >= 100
          ? `${CA_BUNDLE} holds ${n} CA certificates (a count, not a pinned set: the assertion is `
            + `that the store was GENERATED, which is what fails when ca-certificates ships without `
            + `its postinst having run)`
          : `${CA_BUNDLE} holds only ${n} certificates; the package is installed but its trust store `
            + `was not generated`,
      )]
    },
  },
]

// small readers the checks above share

/** The file's lines, or none. `grep` over a missing file matches nothing. */
function grepLines(root: string, path: string): string[] {
  try {
    return readFileSync(pathInRoot(root, path), 'utf8').split('\n')
  }
  catch {
    return []
  }
}

/** `[ -d "${ROOT}${path}" ]`, following links inside the root. */
function isDirectoryInRoot(root: string, path: string): boolean {
  return statInRoot(root, path)?.isDirectory() === true
}

/**
 * `sed -n 's/^KEY//p' ... | tail -n1` -- the LAST assignment, empty when absent.
 *
 * The last and not the first, because systemd takes the last assignment of a
 * key in a unit file and a check reading the first would judge a unit against a
 * value it does not use.
 */
export function unitValue(root: string, path: string, key: string): string {
  const values = grepLines(root, path).filter(l => l.startsWith(key)).map(l => l.slice(key.length))
  return values.at(-1) ?? ''
}

/**
 * `grep -lI` for a perl shebang: does this file's TEXT name perl as its interpreter?
 *
 * `-I` is the half that matters and it is why the first block is read on its
 * own. /usr/bin holds thousands of ELF binaries; a reader without it would match
 * a stray byte run inside one, and reading every one of them whole to find out
 * would be a couple of hundred megabytes per run. GNU grep calls a file binary
 * when its first buffer contains a NUL, so that is the test, and only a file
 * that survives it is read through.
 *
 * The pattern is matched against ANY line, not just the first -- which is what
 * `^#!.*perl` means. A shebang is on line 1 in practice; asserting that here
 * would be a different check from the oracle's.
 */
function namesPerlInterpreter(root: string, path: string): boolean {
  const head = new Uint8Array(32768)
  let got = 0
  let fd: number
  let full: string
  try {
    full = pathInRoot(root, path)
    fd = openSync(full, 'r')
  }
  catch {
    return false
  }
  try {
    got = readSync(fd, head, 0, head.length, 0)
  }
  catch {
    return false
  }
  finally {
    closeSync(fd)
  }
  if (head.subarray(0, got).includes(0)) return false
  try {
    return readFileSync(full, 'latin1').split('\n').some(l => /^#!.*perl/.test(l))
  }
  catch {
    return false
  }
}

export const ENGINE_CHECKS_ALL: readonly CheckCase[] = [
  // The engine's checks need the containers feature; the purge and CA checks are the floor's.
  ...ENGINE_CHECKS.map(c => ({ ...c, features: ['containers'] })),
  ...PURGE_CHECKS,
  ...CA_CHECKS,
]
