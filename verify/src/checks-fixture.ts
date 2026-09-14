import { chmodSync, existsSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Board } from './board.ts'
import type { ImageContext } from './checks.ts'
import { EVERY_FEATURE } from './product-conf.ts'
import { CONTRACT, mountUnitFor } from './checks-connd.ts'
import { REPO_ROOT } from './paths.ts'
import { ToolOutputError, type ToolResult, type ToolRuntime } from './tools.ts'
const NO_TOOLS: ToolRuntime = { route: 'host', announce: 'fixture', dispose: async () => {}, run: async argv => { throw new Error(`Unexpected fixture tool: ${argv.join(' ')}`) } }
export { NO_TOOLS }
export function toolsAnswering(match: RegExp, result: Partial<ToolResult>): ToolRuntime {
  return { ...NO_TOOLS, run: async argv => { if (!match.test(argv.join(' '))) return NO_TOOLS.run(argv); return { argv, code: 0, stdout: '', stderr: '', ...result } } }
}
export interface RootFixture { ctx: ImageContext, root: string, dispose: () => void }
type WriteFile = (path: string, content?: string) => void
const PURGE_THRESHOLD = 100
const TAB = '\t'
// The fstab template every board package renders (mica-boards
// common/package/fstab.in); the verifier reads the rendered one out of
// the image, and this fixture carries the same text.
const FSTAB_TEMPLATE = '# The authenticated early loader mounts root and SYSTEM read-only.\n'
  + '# DATA is the only persistent writable filesystem and the only growth target.\n'
  + '# <device> <mount> <type> <options> <dump> <pass>\n'
  + '@DATA_LINE@\n'
  + 'tmpfs /tmp tmpfs noatime,nosuid,nodev,mode=1777,size=128M,nr_inodes=32768 0 0\n'
const DEFAULT_LINK = '[Match]\nOriginalName=*\n\n[Link]\n'
const ORACLE_BUILTIN_MARKUP = '<script type="module" crossorigin src="/_ui/assets/index-'
export const FIXTURE_POOL_VERSION = '0.1.0+git0123456789ab-1'
function guidOfPartition(board: Board, name: string): string { return board.get(`${name}_GUID`) ?? '' }
function seedHealthyRoot(root: string, board: Board): void {
  const file = (path: string, content = 'x\n'): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  // --- /etc/fstab, rendered from the shipped template ---
  const dataLine = [
    `PARTUUID=${guidOfPartition(board, 'DATA')}`, '/mnt/data', 'ext4', 'noatime,x-systemd.growfs', '0', '2',
  ].join(TAB)
  const fstab = FSTAB_TEMPLATE
    .replaceAll('@DATA_LINE@', dataLine)
  if (/@[A-Z_]+@/.test(fstab)) {
    throw new ToolOutputError(
      `an unrendered placeholder is left in the fixture fstab: the template has grown a placeholder `
      + `this fixture does not render, so the table under test is not the shipped one.`,
    )
  }
  file('/etc/fstab', fstab)

  // --- the mountpoints the packed root must ship ---
  for (const d of [
    '/mnt/data', '/srv', '/mica', '/var', '/home', '/root',
    '/usr/local/lib/systemd/system', '/etc/containers/systemd',
  ]) mkdirSync(join(root, d), { recursive: true })

  // --- the regular files ---
  for (const p of [
    '/usr/lib/systemd/systemd', '/usr/bin/micad',
    '/usr/lib/systemd/system/fstrim.service',
    '/usr/lib/systemd/system/serial-getty@.service',
    '/usr/lib/systemd/system/getty@.service',
    '/usr/lib/systemd/system/mica-health.service',
    '/etc/passwd', '/etc/group', '/usr/share/factory/etc/shadow',
    '/usr/lib/mica/mica-shadow-reconcile',
    '/usr/lib/mica/mica-seed-home', '/usr/lib/mica/profile.conf',
  ]) file(p)

  // --- the files a grep check reads, with content that satisfies it ---
  // health.conf carries CONTENT and not just a path: the gate's required set is
  // read out of it, and an empty file is the vacuity the check exists to catch.
  file('/etc/mica/health.conf', 'require=boot-settled\nrequire=micad\nrequire=apid\nsettle-sec=60\n')
  file('/etc/systemd/network/80-dhcp.network', '[Network]\nDHCP=yes\n')
  // systemd's own default, on every board because the systemd package ships it
  // on every board. It is here as the thing cx3576's 60-mica-mac-stable.link
  // displaces and copies from, so a fixture without it would make that pair of
  // checks assert nothing.
  file('/usr/lib/systemd/network/99-default.link', DEFAULT_LINK)
  file('/etc/systemd/journald.conf.d/00-volatile.conf', '[Journal]\nStorage=volatile\n')
  file('/usr/lib/systemd/system/micad.service', '[Service]\nBusName=com.mica.micad\n')
  file('/usr/lib/systemd/system/apid.service',
    '[Unit]\nAfter=micad.service\n[Service]\nStateDirectory=mica/apid\n')
  file('/usr/share/dbus-1/system.d/com.mica.micad.conf',
    '<busconfig>\n<policy user="root">\n<allow own="com.mica.micad"/>\n</policy>\n</busconfig>\n')
  file('/etc/systemd/system/mica-shadow-reconcile.service',
    '[Service]\nExecStart=/usr/lib/mica/mica-shadow-reconcile\n')
  file('/etc/tmpfiles.d/mica-var.conf', 'q /var/tmp 1777 root root 10d\ne /var/cache - - - 30d\n')

  // --- the enablement symlinks ---
  for (const [target, unit] of [
    ['multi-user.target.wants', 'micad.service'],
    ['multi-user.target.wants', 'apid.service'],
    ['sysinit.target.wants', 'systemd-resolved.service'],
    ['multi-user.target.wants', 'mica-health.service'],
    ['timers.target.wants', 'fstrim.timer'],
    ['multi-user.target.wants', 'mica-shadow-reconcile.service'],
  ] as const) {
    const dir = join(root, '/etc/systemd/system', target)
    mkdirSync(dir, { recursive: true })
    symlinkSync(`/usr/lib/systemd/system/${unit}`, join(dir, unit))
  }
  // The time contract (PLAN-044): the daemon enabled from its unit's own
  // WantedBy, the base-policy drop-in at the pinned values, and the default
  // timezone spelled as a UTC link. The policy content is an independent
  // transcription, like ORACLE_BUILTIN_MARKUP: seeding it from the shipped
  // drop-in or from checks-time.ts's own constants would move both sides of
  // the comparison at once.
  {
    const dir = join(root, '/etc/systemd/system/sysinit.target.wants')
    mkdirSync(dir, { recursive: true })
    symlinkSync('/lib/systemd/system/systemd-timesyncd.service',
      join(dir, 'systemd-timesyncd.service'))
  }
  file('/etc/systemd/timesyncd.conf.d/50-mica.conf',
    '# base policy, not settings\n[Time]\nPollIntervalMinSec=32\nPollIntervalMaxSec=2048\n'
    + 'ConnectionRetrySec=30\nSaveIntervalSec=60\n')
  symlinkSync('/usr/share/zoneinfo/Etc/UTC', join(root, '/etc/localtime'))

  // The two the VENDOR tree enables -- sq_enabled_any's whole reason to exist.
  for (const [target, unit] of [
    ['initrd-root-fs.target.wants', 'systemd-repart.service'],
    ['timers.target.wants', 'systemd-tmpfiles-clean.timer'],
  ] as const) {
    const dir = join(root, '/usr/lib/systemd/system', target)
    mkdirSync(dir, { recursive: true })
    symlinkSync(`/usr/lib/systemd/system/${unit}`, join(dir, unit))
  }

  // --- resolv.conf, as systemd-resolved wants it ---
  mkdirSync(join(root, '/etc'), { recursive: true })
  symlinkSync('../run/systemd/resolve/stub-resolv.conf', join(root, '/etc/resolv.conf'))

  // --- apid, carrying the built-in UI's embedded index markup ---
  file('/usr/bin/apid', `ELF ...${ORACLE_BUILTIN_MARKUP}B0gUsHaSh.js"></script>... trailer\n`)

  // --- the shipped bill of materials, one git stamp across its Mica OS rows ---
  //
  // Two Debian rows and three Mica OS rows: the check counts both and asserts the
  // stamp over the Mica OS rows only, so a fixture of only Mica OS packages would
  // leave the "Debian rows are not stamped" half of that rule untested.
  //
  // mica-busybox is among them because it is what `packed-busybox-in-manifest`
  // reads: the binary in the root and the row here are one fact, and a file that
  // arrived outside the package system would be in the image with no row -- so
  // the fixture has to be able to hold the two apart.
  file('/usr/share/mica/manifest.tsv', [
    '#package\tversion\tarchitecture',
    'libc6\t2.41-12\tamd64',
    'mica-podman\t5.8.6+git0123456789ab-1\tamd64',
    `mica-busybox\t${FIXTURE_POOL_VERSION}\tamd64`,
    `mica-system\t${FIXTURE_POOL_VERSION}\tall`,
    'systemd-timesyncd\t257.7-1\tamd64',
    'zstd\t1.5.7+dfsg-2\tamd64',
    '',
  ].join('\n'))

  if (board.radios.includes('bluetooth')) file('/usr/share/dbus-1/system.d/bluetooth.conf', '<busconfig/>')
  seedDbus(root, file)
  seedEngine(root, board, file)
  seedConnd(root, board, file)
  seedShadow(root, file)
  seedMqtt(root, file)
  seedBusybox(root, file)
  seedFirewall(root, file)
  seedUdev(root, file)
  // LAST: it prepends an ELF header to the two daemons seeded above and writes
  // the dropbear.service the shadow family also touches, so it has to see their
  // final contents rather than be overwritten by them.

}
function seedDbus(root: string, file: WriteFile): void {
  file('/usr/lib/systemd/system/dbus.service', '[Unit]\n')
  file('/usr/lib/systemd/system/dbus.socket', '[Unit]\n')
}

function seedEngine(root: string, board: Board, file: WriteFile): void {
  for (const b of [
    '/usr/bin/podman', '/usr/bin/crun', '/usr/libexec/podman/conmon',
    '/usr/libexec/podman/netavark', '/usr/libexec/podman/aardvark-dns',
    '/usr/libexec/podman/catatonit', '/usr/libexec/podman/quadlet',
    '/usr/lib/systemd/system-generators/podman-system-generator',
    '/usr/sbin/nft',
  ]) file(b)

  // DLOPENed by name, so it is in no NEEDED list -- and the directory follows
  // the board's architecture, which is why the check searches /usr/lib whole
  // rather than naming a multiarch triplet.
  file(`/usr/lib/${board.arch === 'amd64' ? 'x86_64' : 'aarch64'}-linux-gnu/libsystemd.so.0`)

  file('/etc/containers/policy.json', '{"default":[{"type":"insecureAcceptAnything"}]}\n')
  file('/etc/containers/registries.conf', 'unqualified-search-registries = ["docker.io"]\n')
  file('/etc/containers/containers.conf',
    '[engine]\nhelper_binaries_dir = ["/usr/libexec/podman"]\nlog_driver = "journald"\n')
  // Container images belong on DATA; /var parents remain immutable.
  file('/etc/containers/storage.conf', '[storage]\ndriver = "overlay"\ngraphroot = "/mica/containers/storage"\n')

  file('/etc/systemd/system/etc-containers-systemd.mount',
    '[Mount]\nWhat=/mnt/data/state/quadlet\nWhere=/etc/containers/systemd\nType=none\nOptions=bind\n')

  // The purge's positive half: the licences Debian ships to satisfy the
  // redistribution terms of the GPL and everything else in the image.
  for (let i = 0; i < PURGE_THRESHOLD; i += 1) {
    file(`/usr/share/doc/pkg${String(i).padStart(3, '0')}/copyright`, 'Format: https://…\n')
  }

  // The trust store, GENERATED rather than shipped -- which is what fails when
  // ca-certificates installs without its postinst having run.
  file('/etc/ssl/certs/ca-certificates.crt',
    `${Array.from({ length: PURGE_THRESHOLD }, (_v, i) =>
      `-----BEGIN CERTIFICATE-----\ncert${i}\n-----END CERTIFICATE-----`).join('\n')}\n`)
}

function seedBusybox(root: string, file: WriteFile): void {
  file('/usr/bin/busybox', 'ELF ... busybox\n')
  chmodSync(join(root, '/usr/bin/busybox'), 0o755)

  // The GNU set, in the shape the image ships it: everything a regular file in
  // /usr/bin except sh, which is a link to dash.
  for (const c of [
    'ls', 'cat', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'chmod', 'date',
    'dd', 'grep', 'sed', 'tar', 'mount', 'umount', 'dmesg', 'hostname', 'sync', 'sleep',
    'dash',
  ]) file(`/usr/bin/${c}`, `ELF ... ${c}\n`)
  // RELATIVE, as the shipped root has it: `usr/bin/sh -> dash`, measured on both
  // boards. An absolute link would work here and would not exercise the
  // resolution the real image needs.
  symlinkSync('dash', join(root, '/usr/bin/sh'))

  // What decides PATH here, none of it naming busybox -- and TWO OF THE FOUR
  // ARE SYMLINKS, which is how both shipped roots have them. That is the shape
  // that matters: a check reading only regular files skipped the one PATH
  // drop-in this image actually ships, and one that followed the link with the
  // image-absolute target would have read the VERIFIER HOST's file of that name.
  file('/etc/environment', 'LANG=C.UTF-8\n')
  file('/etc/profile', 'if [ "${PS1-}" ]; then\n  PS1=\'\\h:\\w\\$ \'\nfi\n')
  file('/etc/login.defs', 'ENV_SUPATH\tPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin\n'
    + 'ENV_PATH\tPATH=/usr/local/bin:/usr/bin\n')
  file('/usr/lib/systemd/profile.d/70-systemd-shell-extra.sh', '# systemd shell extras\n')
  mkdirSync(join(root, '/etc/profile.d'), { recursive: true })
  symlinkSync('/usr/lib/systemd/profile.d/70-systemd-shell-extra.sh',
    join(root, '/etc/profile.d/70-systemd-shell-extra.sh'))
  mkdirSync(join(root, '/usr/lib/environment.d'), { recursive: true })
  symlinkSync('/etc/environment', join(root, '/usr/lib/environment.d/99-environment.conf'))

  // initramfs-tools, transcribed from the composed x64 root. Neither file is
  // named for busybox and neither assigns BUSYBOXDIR, which is exactly why the
  // shipped image builds an initrd without it.
  file('/etc/initramfs-tools/initramfs.conf',
    '# BUSYBOX: [ y | n | auto ]\n#\n# Use busybox shell and utilities.\nBUSYBOX=auto\n')
  file('/usr/share/initramfs-tools/hooks/klibc-utils',
    '#!/bin/sh\nif [ "${BUSYBOX}" = "n" ] || [ -z "${BUSYBOXDIR}" ]; then\n\tcopy_exec_klibc\nfi\n')
}

function seedFirewall(root: string, file: WriteFile): void {
  // The native front-end, a regular file in /usr/sbin as the package ships it.
  file('/usr/sbin/nft', 'ELF ... nft\n')
  chmodSync(join(root, '/usr/sbin/nft'), 0o755)

  // The unit and the config it would load -- both in the composed root today,
  // from the nftables package, and neither of them enabled. The `flush ruleset`
  // first line is transcribed because it is the reason the preset exists.
  file('/usr/lib/systemd/system/nftables.service',
    '[Unit]\nDescription=nftables\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\n'
    + 'ExecStart=/usr/sbin/nft -f /etc/nftables.conf\nExecStop=/usr/sbin/nft flush ruleset\n\n'
    + '[Install]\nWantedBy=sysinit.target\n')
  file('/etc/nftables.conf',
    '#!/usr/sbin/nft -f\n\nflush ruleset\n\ntable inet filter {\n\tchain input {\n'
    + '\t\ttype filter hook input priority filter;\n\t}\n}\n')

  file('/usr/lib/systemd/system-preset/50-mica-dropbear.preset', 'disable dropbear.service\n')
  // The board preset that keeps a login prompt off HDMI. Seeded here rather
  // than only in the display suite because the healthy root is one root: a
  // fixture where getty@tty1 resolved to ENABLED would be an image this tree
  // does not ship, and the display family would have nothing green to mutate.
  file('/usr/lib/systemd/system-preset/50-mos-getty.preset', 'disable getty@.service\n')
  file('/usr/lib/systemd/system-preset/50-mica-nftables.preset', 'disable nftables.service\n')
  file('/usr/lib/systemd/system-preset/90-systemd.preset',
    '# Settings for units distributed with systemd itself.\n'
    + 'enable systemd-networkd.service\ndisable systemd-time-wait-sync.service\n')

}

function seedConnd(root: string, board: Board, file: WriteFile): void {
  if (!(board.radios ?? []).includes('wifi')) return
  const c = CONTRACT

  file('/usr/sbin/hostapd')
  file('/usr/sbin/wpa_supplicant')
  file(`/usr/lib/systemd/system/${c.staUnit}`,
    `[Service]\nExecStart=/usr/sbin/wpa_supplicant -c ${c.staDir}/${c.staConf.replaceAll('{interface}', '%I')} -i %I\n`)
  file(`/usr/lib/systemd/system/${c.apUnit}`,
    `[Service]\nExecStart=/usr/sbin/hostapd ${c.apDir}/${c.apConf.replaceAll('{interface}', '%i')}\n`)

  // The packages' own units, MASKED -- the only form that also blocks the D-Bus
  // activation path wpasupplicant ships. Not merely disabled, and with no
  // *.wants entry left behind by the postinst.
  for (const u of ['hostapd.service', 'wpa_supplicant.service', 'dbus-fi.w1.wpa_supplicant1.service']) {
    mkdirSync(join(root, '/etc/systemd/system'), { recursive: true })
    symlinkSync('/dev/null', join(root, '/etc/systemd/system', u))
  }

  for (const where of [c.staDir, c.apDir]) {
    const unit = mountUnitFor(where)
    file(`/etc/systemd/system/${unit}`,
      `[Mount]\nWhat=/mnt/data/state/${where.split('/').at(-1)}\nWhere=${where}\nType=none\nOptions=bind\n`)
    enableEtcUnit(root, unit, 'local-fs.target.wants')
  }

  // The regulatory database, at the path the KERNEL searches -- `/lib/firmware`,
  // as `fw_path[]` spells it -- and reached the way the real root reaches it.
  //
  // NOT A PLAIN FILE, and that is the point. Debian's wireless-regdb registers
  // the database through update-alternatives, so the shipped root carries an
  // ABSOLUTE symlink into /etc/alternatives and a second one back out. A
  // fixture that wrote a plain file would be green against a check that
  // resolves the path against the HOST -- which is what the first version of
  // this check did, and it reported the database missing from an image that
  // carries it. The chain is here so the fixture can tell those two apart.
  for (const name of ['regulatory.db', 'regulatory.db.p7s']) {
    file(`/lib/firmware/${name}-debian`)
    mkdirSync(join(root, '/etc/alternatives'), { recursive: true })
    symlinkSync(`/lib/firmware/${name}-debian`, join(root, '/etc/alternatives', name))
    mkdirSync(join(root, '/lib/firmware'), { recursive: true })
    symlinkSync(`/etc/alternatives/${name}`, join(root, '/lib/firmware', name))
  }

  // ...and the unit that loads it, enabled. A built-in cfg80211 on a board with
  // no initramfs asks for the database before the root is mounted and records
  // the failure in a pointer nothing re-reads, so the file alone is a file
  // nothing looks at. `iw` is what sends NL80211_CMD_RELOAD_REGDB.
  file('/usr/sbin/iw')
  file('/etc/systemd/system/mica-regdb-reload.service',
    '[Service]\nType=oneshot\nExecStart=/usr/sbin/iw reg reload\n')
  enableEtcUnit(root, 'mica-regdb-reload.service', 'multi-user.target.wants')

  // Nothing at /usr/sbin/dnsmasq: the AP's DHCP server is systemd-networkd's own
  // DHCPServer=yes, and a second one on the same link is a conflict.
}

function seedShadow(root: string, file: WriteFile): void {
  file('/etc/passwd', `${ACCOUNTS.map(a =>
    `${a.name}:x:${a.uid}:${a.gid}::/home/${a.name}:${a.shell}`).join('\n')}\n`)
  file('/etc/group', `root:x:0:\nshadow:x:${SHADOW_GID}:\nmica:x:1000:\n`)

  // Every entry LOCKED: `!` in the password field. A signed rootfs is
  // byte-identical across the fleet, so a usable hash here is a usable hash on
  // every device -- which is the thing the check asserts and the reason the
  // fixture must not carry one even as filler.
  file('/usr/share/factory/etc/shadow',
    `${ACCOUNTS.map(a => `${a.name}:!:20000:0:99999:7:::`).join('\n')}\n`)
  // 0640 root:shadow, and it must survive packing: unix_chkpwd is setgid
  // shadow precisely so a non-root PAM stack can read it.
  chmodSync(join(root, '/usr/share/factory/etc/shadow'), 0o640)
  ownAsRoot(root, '/usr/share/factory/etc/shadow', SHADOW_GID)

  // The path pam_unix opens, pointing at the tmpfs -- and NOTHING at the
  // destination inside the tree, because a /run/mica/shadow in the image would
  // be a credential identical on every device in the fleet.
  mkdirSync(join(root, '/etc'), { recursive: true })
  symlinkSync('/run/mica/shadow', join(root, '/etc/shadow'))

  // The reconcile unit's ordering, and the four units it orders against. An
  // ordering naming a unit that is not in the image is dropped by systemd
  // SILENTLY, so the check asserts the pair and so does the fixture.
  file('/etc/systemd/system/mica-shadow-reconcile.service',
    '[Unit]\n'
    + 'Before=micad.service dropbear.service\n'
    + 'Before=systemd-logind.service systemd-user-sessions.service\n'
    + '[Service]\nExecStart=/usr/lib/mica/mica-shadow-reconcile\n')
  file('/etc/systemd/system/dropbear.service', '[Unit]\n[Install]\nWantedBy=multi-user.target\n')
  for (const u of ['systemd-logind.service', 'systemd-user-sessions.service']) {
    file(`/usr/lib/systemd/system/${u}`, '[Unit]\n')
  }

  // The script, in the shape the check reads it: source, destination, the
  // build loop's input redirection, and the locked password field.
  file('/usr/lib/mica/mica-shadow-reconcile',
    '#!/bin/sh\n'
    + 'FACTORY="${MICA_SHADOW_FACTORY:-/usr/share/factory/etc/shadow}"\n'
    + 'SHADOW="${MICA_SHADOW_PASSWD:-/run/mica/shadow}"\n'
    + 'while IFS= read -r line; do\n'
    + '  printf \'%s\\n\' "${line}" | awk -F: \'{ $2 = "!"; print }\'\n'
    + 'done <"$FACTORY"\n')

  // Current state initializer: private radio leaves are created by ensure_dir.
  file('/usr/lib/mica/mica-seed-state', `#!/bin/sh
state=/mnt/data/state
ensure_dir() {
    [ ! -L "$state/$1" ] || exit 1
    mkdir -p "$state/$1"
    chmod "$2" "$state/$1"
}
for name in mica ssh bluetooth wpa_supplicant hostapd; do ensure_dir "$name" 0700; done
`)

}

function seedMqtt(root: string, file: WriteFile): void {
  file('/usr/bin/mica-mqttd')
  file('/usr/bin/mica-mqtt-broker')

  // A STATIC identity, a broker EnvironmentFile on a STATE-backed bind, and a
  // mandatory root-rendered topic identity under /run.
  file('/usr/lib/systemd/system/mica-mqttd.service',
    '[Unit]\n'
    + 'ConditionPathExists=/run/mica/mqttd-device.env\n'
    + '[Service]\n'
    + 'User=mica-mqttd\n'
    + 'EnvironmentFile=-/var/lib/mica/mqttd.env\n'
    + 'EnvironmentFile=/run/mica/mqttd-device.env\n'
    + 'ExecStart=/usr/bin/mica-mqttd --device-id ${MICA_MQTT_DEVICE_ID} '
    + '--broker-host ${MICA_MQTT_BROKER_HOST}\n')
  file('/usr/lib/systemd/system/mica-mqtt-broker.service',
    '[Service]\nUser=mica-mqtt-broker\n')

  // The bind that makes /var/lib/mica writable and persistent. The check looks
  // for a unit whose Where= is the EnvironmentFile's directory, so the fixture
  // ships the same unit the image does rather than a stand-in.
  file('/etc/systemd/system/var-lib-mica.mount',
    '[Mount]\nWhat=/mnt/data/state/mica\nWhere=/var/lib/mica\nType=none\nOptions=bind\n')

  // Empty is valid: no application is remotely published until its package
  // installs both an exact enrollment file and its exact Item1 policy.
  mkdirSync(join(root, '/usr/lib/mica/mqtt-applications.d'), { recursive: true })

  // NOT enabled: no *.wants symlink for either. micad starts them from
  // mqtt.enabled, and an enablement baked into the image is the one thing that
  // switch cannot override.
}

function seedUdev(root: string, file: WriteFile): void {
  file('/usr/lib/systemd/systemd-udevd')
  file('/usr/bin/udevadm')
  file('/usr/lib/systemd/system/systemd-udevd.service',
    '[Unit]\nDescription=Rule-based Manager for Device Events and Files\n'
    + 'After=systemd-sysusers.service\n[Service]\nType=notify\n')

  const rules: ReadonlyArray<readonly [string, string]> = [
    ['50-udev-default.rules',
      'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", IMPORT{builtin}="usb_id"\n'
      + 'SUBSYSTEM=="net", IMPORT{builtin}="net_driver"\n'
      + 'SUBSYSTEM=="tty", KERNEL=="ptmx", GROUP="tty", MODE="0666"\n'
      + 'SUBSYSTEM=="block", GROUP="disk"\n'
      + 'KERNEL=="tun", MODE="0666", OPTIONS+="static_node=net/tun"\n'],
    ['60-input-id.rules',
      'SUBSYSTEM=="input", ENV{ID_INPUT}=="", IMPORT{builtin}="input_id"\n'],
    ['60-persistent-storage.rules',
      'ENV{ID_FS_UUID_ENC}=="?*", SYMLINK+="disk/by-uuid/$env{ID_FS_UUID_ENC}"\n'],
    ['60-serial.rules',
      'SUBSYSTEMS=="usb", IMPORT{builtin}="usb_id"\n'
      + 'IMPORT{builtin}="path_id"\n'
      + 'ENV{ID_PATH}=="?*", SYMLINK+="serial/by-path/$env{ID_PATH}"\n'
      + 'ENV{ID_BUS}=="?*", SYMLINK+="serial/by-id/$env{ID_BUS}-$env{ID_SERIAL}"\n'],
    ['71-seat.rules',
      'SUBSYSTEM=="drm", KERNEL=="card[0-9]*", TAG+="seat", TAG+="master-of-seat"\n'],
    ['75-net-description.rules',
      'SUBSYSTEM!="net", GOTO="net_end"\n'
      + 'SUBSYSTEMS=="usb", IMPORT{builtin}="usb_id"\n'
      + 'IMPORT{builtin}="net_id"\n'
      + 'LABEL="net_end"\n'],
    ['78-sound-card.rules',
      'KERNEL!="card*", GOTO="sound_end"\n'
      + 'ENV{SOUND_INITIALIZED}="1"\n'
      + 'IMPORT{builtin}="path_id"\n'
      + 'LABEL="sound_end"\n'],
    ['80-drivers.rules',
      'ENV{MODALIAS}=="?*", RUN{builtin}+="kmod load"\n'],
    ['90-iocost.rules',
      'ENV{IOCOST_SOLUTIONS}!="", RUN+="iocost apply $env{DEVNAME}"\n'],
    ['99-systemd.rules',
      'SUBSYSTEM=="block", TAG+="systemd"\n'],
  ]
  for (const [name, body] of rules) file(`/usr/lib/udev/rules.d/${name}`, body)
}

function ownAsRoot(root: string, path: string, gid: number): void {
  try {
    chownSync(join(root, path), 0, gid)
  }
  catch (error) {
    throw new ToolOutputError(
      `the packed-root fixture cannot own ${path} as 0:${gid}: `
      + `${error instanceof Error ? error.message : String(error)}.\n`
      + `  The image packs that file 0640 root:shadow and a check asserts it, so the fixture has to `
      + `reproduce it -- which needs root. This suite runs as root on the host and in the pinned bun `
      + `container; a non-root run cannot seed this fixture.`,
    )
  }
}

function enableEtcUnit(root: string, unit: string, target: string): void {
  const dir = join(root, '/etc/systemd/system', target)
  mkdirSync(dir, { recursive: true })
  symlinkSync(`/etc/systemd/system/${unit}`, join(dir, unit))
}

function enable(root: string, unit: string, target = 'multi-user.target.wants'): void {
  const dir = join(root, '/etc/systemd/system', target)
  mkdirSync(dir, { recursive: true })
  symlinkSync(`/usr/lib/systemd/system/${unit}`, join(dir, unit))
}
const SHADOW_GID = 42

/**
 * The accounts, as `/etc/passwd` and the factory `/etc/shadow` template.
 *
 * Small on purpose -- the real images carry 25 -- because what the checks read
 * is the RELATION between the two files: every name in passwd has an entry in
 * the template, and every entry in the template is locked. A hundred accounts
 * would test the same relation more slowly.
 *
 * `mica-mqttd` and `mica-mqtt-broker` are here because the MQTT checks assert
 * their units run as identities the image actually defines; that is one fact
 * about one file and it belongs in one place.
 */
const ACCOUNTS: readonly { name: string, uid: number, gid: number, shell: string }[] = [
  { name: 'root', uid: 0, gid: 0, shell: '/bin/bash' },
  { name: 'mica', uid: 1000, gid: 1000, shell: '/bin/bash' },
  { name: 'mica-mqttd', uid: 970, gid: 970, shell: '/usr/sbin/nologin' },
  { name: 'mica-mqtt-broker', uid: 969, gid: 969, shell: '/usr/sbin/nologin' },
]

export function packedRootFixture(board: Board): RootFixture {
  const dir = mkdtempSync(join(tmpdir(), 'mica-root-fixture-'))
  const root = join(dir, 'root')
  mkdirSync(root)
  seedHealthyRoot(root, board)
  const ctx: ImageContext = { board, product: EVERY_FEATURE, image: '(fixture)', tools: NO_TOOLS, workDir: dir, outDir: dir, unpackRoot: async () => root }
  return { root, ctx, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}
export const ELF_TYPE_EXEC = 2
/** ET_REL -- what a kernel module is. */
export const ELF_TYPE_REL = 1
/** SHT_PROGBITS. */
const SHT_PROGBITS = 1
/** SHT_NOTE, and SHT_NOBITS for a note whose content was moved out. */
const SHT_NOTE = 7
const SHT_NOBITS = 8
/** EM_AARCH64. Nothing here reads it; a plausible value beats a zero. */
const EM_AARCH64 = 183

export interface SyntheticSection {
  readonly name: string
  /** Defaults to SHT_PROGBITS. */
  readonly type?: number
  readonly content: Uint8Array
}

/** A `.note.gnu.build-id` section body carrying `id`, which must be hex. */
export function buildIdNote(id: string): Uint8Array {
  const desc = Buffer.from(id, 'hex')
  const name = Buffer.from('GNU\0', 'latin1')
  const body = Buffer.alloc(12 + name.length + ((desc.length + 3) & ~3))
  body.writeUInt32LE(name.length, 0)
  body.writeUInt32LE(desc.length, 4)
  body.writeUInt32LE(3, 8) // NT_GNU_BUILD_ID
  name.copy(body, 12)
  desc.copy(body, 12 + name.length)
  return body
}

export interface SyntheticElfOptions {
  /** Defaults to [`ELF_TYPE_EXEC`]. */
  readonly type?: number
  /** The GNU build-id to embed; omitted means no note section at all. */
  readonly buildId?: string
  /** Written as SHT_NOBITS, the shape `objcopy --strip-debug` leaves behind. */
  readonly buildIdNobits?: boolean
  readonly sections?: readonly SyntheticSection[]
}

/**
 * A minimal 64-bit little-endian ELF, written to `path`.
 *
 * Header, then each section's content, then the section header table. No
 * program headers: nothing here is executed, and `elf.ts` reads `e_shoff`.
 */
export function writeSyntheticElf(path: string, options: SyntheticElfOptions = {}): void {
  const sections: SyntheticSection[] = [...(options.sections ?? [])]
  if (options.buildId !== undefined) {
    sections.unshift({
      name: '.note.gnu.build-id',
      type: options.buildIdNobits === true ? SHT_NOBITS : SHT_NOTE,
      content: buildIdNote(options.buildId),
    })
  }
  // Section 0 is SHT_NULL and has no name; `.shstrtab` is last and names them.
  const names = ['', ...sections.map(s => s.name), '.shstrtab']
  const nameOffsets: number[] = []
  let strtab = ''
  for (const n of names) {
    nameOffsets.push(strtab.length)
    strtab += `${n}\0`
  }
  const strtabBytes = Buffer.from(strtab, 'latin1')

  const bodies = [Buffer.alloc(0), ...sections.map(s => Buffer.from(s.content)), strtabBytes]
  const types = [0, ...sections.map(s => s.type ?? SHT_PROGBITS), 3 /* SHT_STRTAB */]

  const HEADER = 64
  const ENTRY = 64
  const offsets: number[] = []
  let cursor = HEADER
  for (const b of bodies) {
    offsets.push(cursor)
    cursor += b.length
  }
  const shoff = cursor

  const table = Buffer.alloc(ENTRY * bodies.length)
  for (let i = 0; i < bodies.length; i += 1) {
    const o = i * ENTRY
    table.writeUInt32LE(nameOffsets[i] as number, o)
    table.writeUInt32LE(types[i] as number, o + 4)
    table.writeBigUInt64LE(0n, o + 8) // sh_flags
    table.writeBigUInt64LE(0n, o + 16) // sh_addr
    table.writeBigUInt64LE(BigInt(i === 0 ? 0 : (offsets[i] as number)), o + 24)
    table.writeBigUInt64LE(BigInt((bodies[i] as Buffer).length), o + 32)
    table.writeUInt32LE(0, o + 40) // sh_link
    table.writeUInt32LE(0, o + 44) // sh_info
    table.writeBigUInt64LE(1n, o + 48) // sh_addralign
    table.writeBigUInt64LE(0n, o + 56) // sh_entsize
  }

  const header = Buffer.alloc(HEADER)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0)
  header.writeUInt16LE(options.type ?? ELF_TYPE_EXEC, 16)
  header.writeUInt16LE(EM_AARCH64, 18)
  header.writeUInt32LE(1, 20)
  header.writeBigUInt64LE(BigInt(shoff), 40)
  header.writeUInt16LE(HEADER, 52)
  header.writeUInt16LE(ENTRY, 58)
  header.writeUInt16LE(bodies.length, 60)
  header.writeUInt16LE(bodies.length - 1, 62)

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([header, ...bodies, table]))
}
