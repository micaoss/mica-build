# rootfs — product root composition

Composes the userspace root of a product on the floor of mica-system-base: one init, the
product's features, the board's package and nothing else. Root, kernel/support and firmware are
independent signed components; the root carries no board kernel, no module payload and no
metadata trust anchors.

## The Base root

The upstream half of every root is the `rootfs.<release>` OCI image of the mica-system-base
release `locks/mica-system-base.lock` names, taken by its platform manifest digest: Debian's
lock of that release installed with its dpkg database, with `mica-system`, `mica-busybox` and
`mica-ca-trust`, and no init and no APT (`mica-system-base:docs/floor-and-options.md`). This tree
keeps no Debian pin of its own. `src/rootfs/build.ts` reads the release's source at its commit
(`src/cli.ts source mica-system-base`) for the rows of its own `locks/upstream.lock` that its
`locks/packages.tsv` puts in the root, and `stages/compose/compose-install.sh` refuses a root that
does not carry exactly those rows before it adds anything.

## What is added

The product (`boards/<board>/products/<variant>/product.env`, `boards/products.md`) names its
init, its features and its components; `src/cli.ts resolve` turns them and the board's
manifests into one package set (`rootfs/packages/README.md`): `common.pkgs`, `init-<init>.pkgs`,
a `feature-*.pkgs` or `radio-*.pkgs` per feature, and the board's `board.pkgs` and components.

Those packages come from the imported pools (`src/cli.ts pool`: the pool rows of every lock and
this tree's board packages). What they need beyond the Base root is taken from the `upstream`
rows of the Base lock: `src/cli.ts base-packages select` reads the Depends and Pre-Depends of
the selection, takes each dependency the root and the pools do not satisfy, and selects the
whole closure of those roots; a dependency that is no row is refused, and is requested from
mica-system-base. `rootfs/packages/presets.json` names the units of those packages that stay
disabled (`40-mica-build.preset`, written before dpkg runs).

`compose-install.sh` installs everything in one offline dpkg transaction, in rounds until every
pre-dependency is configured, and refuses any package it was not given.

## The init

`INIT=systemd|openrc` decides the init's packages (`init-<init>.pkgs`), is written into
`/usr/lib/mica/product.conf` for micad, and selects the init's own steps of the composition and
the pack, `stages/compose/scripts/<init>/` (`stages/compose/scripts/README.md`). Every package
carries the start-up files of its own services for both inits and enables them itself: a
`.wants` link under systemd, a runlevel link under OpenRC. Under OpenRC the pack removes the
runlevel links no package owns (what update-rc.d adds). The container engine runs on either init,
supervised by mica-podman's mica-containerd, which the package enables on neither: micad enables the
one of the product's init when `container.enabled` is on.

## The runtime selection

The packed root carries only what a consumer claims: `src/rootfs/runtime/consumers.json`
declares, per package, the executables and resources its services use and the links the
running system resolves (`runtime_links`), and a rule `when` a package names applies only where
that package is installed. The systemd and OpenRC rules are the `mica-systemd` and
`mica-openrc` entries, and each package's OpenRC scripts are its own entry's, under
`when: openrc`. Everything else is left behind and listed in the build's
`rootfs-report.runtime.json.drops.tsv`; an executable under `/usr/bin` or `/usr/sbin` that no
rule claims is refused rather than dropped.

## Image profile

The product's `PROFILE` (`boards/<board>/products/<variant>/product.env`), `dev` or `prod`;
`src/product/product.ts` rejects anything else. It selects no package: a dev and a
prod image of one product install the same set. The kernel component signs it
onto the kernel command line as exactly one `mica.profile=dev|prod` token, prod
included (the UKI's `.cmdline`; a FIT board's profile kernel forces it), and
micad reads only an exact single `mica.profile=dev` as dev. The root also
carries the value in `/usr/lib/mica/product.conf`, derived from the same product.env.

What the profile may change, and nothing else:

1. reporting the profile in system_info;
2. diagnostic verbosity and log retention;
3. developer convenience that grants no access, such as boot banners or extra
   read-only diagnostics endpoints.

In neither direction may it change SSH or console access defaults, credentials
or passwords, the update channel, trust anchors or signature checks, network
exposure, or any apid endpoint that changes state. The profile and the signing
material's grade (`/usr/share/mica/meta/GENERATED`) are independent: a prod
image may be signed with development-grade keys.

## micad

micad and apid, and the web console, are not in the root: they are mica-core's core components,
pinned by the `item core.json` and `item core.img` rows of `locks/mica-core.lock`, selected by the product's `micad` and `ui`
features, signed with the root's content key and composed over the root at boot
(mica-core:docs/mica-core.md 6.5). They carry their binaries, their systemd units and OpenRC
scripts with their enablement links, and their D-Bus policy; micad starts the services it
configures (SSH, time, the radios, MQTT), whose packages are in the root. `/var/lib/mica` is
STATE, bound from DATA.

What the core components need from the root is the root interface level, `interfaceLevel` of
`mica/rootfs/v1` (`ROOT_INTERFACE_LEVEL` in `src/image/core-components.ts`, level 1): glibc and the
libraries micad links against, which `src/rootfs/runtime/consumers.json` keeps; the init and its
service contract; mica-system and the system bus, which reads the policy the micad component composes
into `/usr/share/dbus-1/system.d`; the mount points
and runtime directories; and the root's mica-core packages. The level is raised with any
incompatible change to one of these, and a core component states the levels it runs on.

## Board hardware init

A board's package carries its hardware init: the programs and units of
`boards/<board>/package/hwinit/` and the facts they read, `boards/<board>/package/init/<n>.conf`
staged as `/etc/mica/<n>.conf` for every concern `BOARD_HWINIT_CONFS` names. A fact whose program
another package ships is staged alone (`bt.conf`, read by mica-bluetooth's `hwinit-bt`). Every
unit is condition-gated on its conf file and never blocks, delays or fails the boot.

| Unit | Conf | Does |
|---|---|---|
| `mica-modules` | `modules.conf` | `modprobe -q` the board's hardware modules; a module for an absent SKU is skipped |
| `mica-otg` | `otg.conf` | write the USB OTG role to its syscon node (`/etc/mica/otg-mode` overrides) |
| `mica-can` | `can.conf` | set bitrate / restart-ms / CAN FD and bring the interface up |
| `mica-mac` | `mac.conf` | give every `eth*` with a kernel-random MAC a stable address derived from the eMMC CID and the port's place in the bus topology |
| `mica-gadget` | `gadget.conf` | build the CDC ACM debug console gadget and bind it to the UDC |

These units are systemd's; a board whose products run OpenRC needs their OpenRC form.

`mica-mac` exists because neither cx3576 NIC has a MAC in hardware, so the
kernel invents a random one on every boot: gmac0/eth0's dts node carries
neither `mac-address` nor `nvmem-cells`, and the PCIe RTL8168 has no EEPROM and
takes `eth_hw_addr_random()`.

The address is `02:` + `md5(seed + topology)`. The seed is the eMMC CID — a
read-only chip register unaffected by reflashing the media. **The topology is
the port's own path under `/sys/devices`**, which
`/sys/class/net/<iface>/device` resolves to: `platform/2a220000.ethernet` for
the on-board GMAC, `platform/…/0000:01:00.0` for the part behind PCIe. It is the
identity udev's `ID_PATH` names, and it is where the silicon is attached rather
than when it was found. Both halves are hardware, so a board keeps its MACs —
and its DHCP reservations — across image updates and across a change in probe
order. Interfaces whose `addr_assign_type` is not `NET_ADDR_RANDOM` are left
alone. `boards/cx3576/tests/mac-stable-test.sh` drives the derivation, including the red direction.

The assignment ships as **three** files, and any one of them missing makes the
other two a no-op:

- `mica-mac.service` — the cold-plug sweep, ordered before `network-pre.target`.
  A one-shot pass cannot reach a port that registers later, and on cx3576 both
  NICs appear at 11.67 s, which may be after this unit has already run.
- `60-mica-mac-stable.rules` — the mechanism: `hwinit-mac %k` on each net `add`
  event. udev writes the device database and broadcasts the event to libudev
  listeners only after a `RUN+=` program returns, so networkd cannot configure a
  link before the address is on it.
- `60-mica-mac-stable.link` — `MACAddressPolicy=none` for `eth*`. Without it
  systemd's own `99-default.link` (`MACAddressPolicy=persistent`) assigns these
  ports an address first — keyed on the machine id and, when the port has no
  `ID_NET_NAME_*` property, on the interface name — and the kernel then records
  `NET_ADDR_SET`, which `hwinit-mac` reads as “somebody else owns this”. No rule
  number fixes that: `net_setup_link` is a builtin evaluated inline while the
  rules are matched, and `RUN+=` is deferred until they all have been.

The SoC OTP CPUID would be a deeper root of identity than the eMMC CID but has
no dts node in this tree and no hardware validation.

`mica-gadget` gives the board an out-of-band console: with the OTG port in `otg`
role the PHY enumerates as a device when a host PC is plugged in, and a udev
rule (`60-mica-gadget-getty.rules`) pulls in `serial-getty@ttyGS0` when the port
appears. The gadget serial number reuses the `mac.conf` seed, so USB identity
is stable too.

## Composition and signing

```bash
make product PRODUCT=<board>.<variant>        # compose, pack, sign and assemble
make product-verify PRODUCT=<board>.<variant> # the image contract
```

`stages/compose/*.Dockerfile` are the ordered stages (`src/image/stages.ts` validates their
arguments and records the chain); the output is `rootfs.squashfs`, `rootfs-verity.img`, the
verity geometry, the package and build reports and the factory root export. A product on an
arm64 board composes from the arm64 pools. The root verity object carries its hash tree and a
detached PKCS#7 root-hash signature by the content signer; a root update does not regenerate
the kernel component, and the image assembler verifies every component before it writes the
factory image.

## Writable namespace

The root is read-only. Only DATA grows: mica-core's runkit mounts it with its project quotas
before the init runs, the init's `mica-data-layout` lays it out, and DATA's var tree is bound
over the whole of `/var` after `mica-seed-var` copies the image's var template into it --
`var.mount` under systemd, `mica-mounts` under OpenRC. Identity and credentials stay on
DATA/state, outside the variable quota.
