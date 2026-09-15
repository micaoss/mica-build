# rootfs — product root composition

Composes the userspace root of a product for x64, virt-arm64, cx3576 and
s905x5m on the Base root of mica-system-base. Root, kernel/support and firmware
are independent signed components. The root contains no board kernel or module
payload and no metadata trust anchors. It is assembled into a current
three-partition complete factory image.

## The Base root

The upstream half of every root is the `rootfs.<release>` OCI image of the
mica-system-base release `locks/mica-system-base.lock` names, taken by its platform
manifest digest: the Debian trixie lock of that release installed with its
dpkg database, `mica-system`, `mica-busybox` and `mica-ca-trust`, and no APT.
This tree keeps no Debian pin of its own. `rootfs/build.sh` checks the root out
of the release's source at its commit (`tools/source.sh mica-system-base`) and
hands the composition the rows of that commit's `locks/upstream.lock` its
`packages.tsv` selects for the root, for the architecture;
`compose/compose-install.sh` refuses a root that does not carry exactly those
rows before it adds anything.

The composition then installs the resolved local packages of the imported pool
(`tools/pool.sh`) with one offline dpkg transaction, together with the upstream
Debian packages beyond the Base root that the selection needs.

## Debian packages Base pins for later stages (the `upstream` rows)

The Base release is consumed as its lock: `locks/mica-system-base.lock` and its
pin `locks/pins/mica-system-base.pin`, replaced together and verified by `make
locks-verify`; anything resolved from Debian reads the lock's `apt` row as its
only archive.

The Base root carries no container, radio or audio userland. Those generic
Debian packages are pinned by mica-system-base and published with its release
as the `upstream` rows of its lock (package, architecture, version, sha256,
snapshot url, and the roots of Base's upstream.pkgs whose closure the row
belongs to), never installed into the Base root; this tree reuses those
addresses and pins none of them itself. The groups they need (`bluetooth` 989,
`netdev` 988) are seeded by Base into every root.

`tools/base-packages.sh fetch` downloads every row into `_out/cache/debian/`,
hashes it and reads its control fields; `select` reads the Depends and
Pre-Depends of the product's selected archives, takes every dependency the Base
root's dpkg status and the pool do not satisfy as a root, selects the whole
closure of those roots, checks that the closure's own dependencies are met,
and refuses a dependency that is no root -- such a package is requested from
mica-system-base. The composition
checks each archive's bytes and control fields again, writes
`40-mica-build.preset` (system and user) with the units in
`rootfs/packages/presets.json` disabled before dpkg runs -- enabling and
disabling services is this tree's part -- and installs them in the same dpkg
transaction as the local packages.

bluez and rfkill exist for the board hardware-init layer (btattach + rfkill
unblock in `mica-bt`); with their new dependencies (libglib2.0-0, libdw1,
libelf1) they add about 11 MB of installed size (TOTAL_MB 204, budget 400) —
see `rootfs-report.txt`.

- **`wpasupplicant`** — the WiFi station role. micad's `wifi_client` reconciler
  renders `/etc/wpa_supplicant/wpa_supplicant-<iface>.conf` and drives
  `wpa_supplicant@<iface>.service`. Both are the package's own contract, not a
  preference: the template's `ExecStart` has
  `-c/etc/wpa_supplicant/wpa_supplicant-%I.conf` baked in, so the file name and
  the unit name have to agree with micad's or the supplicant starts against a
  configuration that is not there. Without this package `wifi.client` renders a
  file nothing reads and enables a unit that does not exist — which systemd
  reports on the device and nowhere else.
- **`hostapd`** — the provisioning access point. micad's `wifi_ap` reconciler
  renders `/etc/hostapd/<iface>.conf` and drives `hostapd@<iface>.service`,
  whose `ExecStart` is `/usr/sbin/hostapd -B -P /run/hostapd.%i.pid $DAEMON_OPTS
  /etc/hostapd/%i.conf`. This is the path a device with no uplink is configured
  through, so "present but not wired" is the expensive failure here.

Deliberately **not** added: `dnsmasq`. The AP hands out addresses through
systemd-networkd's own `DHCPServer=yes`, which is already in the image and
whose lifecycle is the networkd reload the AP address needs anyway.

### Both connd packages ship an enabled unit that has to be masked

Measured on `hostapd` / `wpasupplicant` 2:2.10-12+deb12u3 arm64 (`dpkg -L`, and
the postinst's links under `/etc/systemd/system/multi-user.target.wants/`), not
assumed:

| Unit | Ships | Enabled by the package | What the image does |
|---|---|---|---|
| `wpa_supplicant@.service` | yes, `-c/etc/wpa_supplicant/wpa_supplicant-%I.conf` | no | left installed and unenabled — micad owns it |
| `hostapd@.service` | yes, `… /etc/hostapd/%i.conf`, `ConditionFileNotEmpty=/etc/hostapd/%i.conf` | no | left installed and unenabled — micad owns it |
| `hostapd.service` | yes, non-templated, reads `/etc/hostapd/hostapd.conf` | **yes** | **masked** |
| `wpa_supplicant.service` | yes, D-Bus mode, no condition | **yes** | **masked** |
| `dbus-fi.w1.wpa_supplicant1.service` | `Alias=` link created by the postinst | — | **masked** (same unit under another name) |

`hostapd.service` is condition-gated on `/etc/hostapd/hostapd.conf` being
non-empty, so today it does not actually start — but that is one operator `cp`
away from a second hostapd fighting the reconciler for the radio while
`hostapd@wlan0.service` still reports healthy. `wpa_supplicant.service` has no
condition and does start; it also carries `RuntimeDirectory=wpa_supplicant`, so
systemd deletes `/run/wpa_supplicant` when it stops — taking the control socket
of the templated instance micad started with it.

Masked rather than disabled because `wpasupplicant` ships
`/usr/share/dbus-1/system-services/fi.w1.wpa_supplicant1.service`: a plain
`systemctl disable` leaves the D-Bus activation path open, and masking does not.

### Config directories

`/etc/wpa_supplicant` and `/etc/hostapd` are both mode **0700** — once a device
is configured they hold pre-shared keys in the clear. The root is a read-only
dm-verity squashfs, so each is a STATE-backed bind
(`etc-wpa_supplicant.mount`, `etc-hostapd.mount`) exactly as `/etc/ssh` is; a
reconciler rendering into a read-only path fails on device and nowhere else.

## Image profile

The product's `PROFILE` (`products/<name>/product.env`), `dev` or `prod`;
`tools/product.sh` rejects anything else. It selects no package: a dev and a
prod image of one product install the same set. The kernel component signs it
onto the kernel command line as exactly one `mica.profile=dev|prod` token, prod
included (the UKI's `.cmdline`; a FIT board's profile kernel forces it), and
micad reads only an exact single `mica.profile=dev` as dev. The root also
carries the value in `/usr/lib/mica/product.conf` and
`/usr/share/mica/release-identity.env`, derived from the same product.env.

What the profile may change (user decision 2026-09-14), and nothing else:

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

The management packages are mica-core release archives, pinned by the package
rows of `locks/mica-core.lock` and fetched into the local package pool by `tools/pool.sh`. The producer supplies the binaries, systemd units and exact D-Bus
policies; the runtime needs no package manager or compiler.

`/var/lib/mica` binds DATA/state/mica. Persistent credentials retain restricted
subdirectory/file ownership. The outer directory allows traversal for the
explicitly group-readable WireGuard key store used by systemd-network.
MQTT application enrollment remains package-specific; mqttd has no management
D-Bus grant. Optional feature selection is resolved before root composition.

## Board hardware init

Board-agnostic mechanism, and the content is filed per board: the units and
their scripts come from `mica-boards:<board>/hwinit/` (six of each on cx3576; x64
has no such directory and stages an empty one), and the board-specific facts
they read — module names, sysfs paths, UART device, CAN defaults, MAC seed,
gadget IDs — come from conf files staged from `BOARD_DIR/init/`, falling back to
the board's `bsp/init/`, into `/etc/mica/`. Both are package
payload now: `mica-board-<board>` installs the programs, the units and the confs
that `BOARD_HWINIT_CONFS` names, and refuses a fact no script reads or a script
with no unit to run it. Every unit is condition-gated on
its conf file and never blocks, delays, or fails the boot; WiFi association / BT
pairing stay with connd. The units are enabled via `multi-user.target.wants`
symlinks like micad.

| Unit | Conf | Does |
|---|---|---|
| `mica-modules` | `modules.conf` | `modprobe -q` the board's hardware modules; a module for an absent SKU is skipped |
| `mica-otg` | `otg.conf` | write the USB OTG role to its syscon node (`/etc/mica/otg-mode` overrides) |
| `mica-can` | `can.conf` | set bitrate / restart-ms / CAN FD and bring the interface up |
| `mica-bt` | `bt.conf` | rfkill unblock + `btattach` on the configured UART (ordered after `mica-modules`) |
| `mica-mac` | `mac.conf` | give every `eth*` with a kernel-random MAC a stable address derived from the eMMC CID and the port's place in the bus topology |
| `mica-gadget` | `gadget.conf` | build the CDC ACM debug console gadget and bind it to the UDC |

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
alone. `make os-mac-test` drives the derivation, including the red direction.

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

The Bluetooth adapter name needs no unit of its own: bluez's hostname plugin
is loaded by default and overrides `Name`, so the adapter follows the system
hostname as long as `/etc/bluetooth/main.conf` does not pin one.

---

## Root composition and signing

The imported package pool is fetched and indexed first (`make os-pool`).
`rootfs/packages/resolve.sh` selects the pinned packages of the board and the
enabled features. No compilation or dependency discovery occurs inside the
offline installation step.

`rootfs/compose/*.Dockerfile` contains the ordered composition stages;
`build/src/stages.ts` validates their arguments and records the chain. Scripts
under `rootfs/scripts/` implement reusable package, filesystem and artifact checks.
The output includes rootfs.squashfs, rootfs-verity.img, explicit verity geometry,
package/build reports and the factory root export.

```bash
make os-pool
MICA_PRODUCT=x64-dev bash rootfs/build.sh     # the product's meta/ is its public manifest
```

A product on an arm64 board composes from the arm64 pool. All signing inputs are explicit in the component
producer, separate from public factory defaults. Follow
[the complete build guide](https://github.com/micaoss/mica/blob/main/docs/design/build.md) to package root, kernel/support,
firmware and signed deployment records, then assemble a fresh complete image.

The root verity object contains its hash tree. The detached PKCS#7 root-hash
signature is made by the content signer. A root update does not regenerate the
kernel package; kernel/support changes do not regenerate the userspace root.
The image assembler verifies every named component before writing the factory
image. There is no raw rootfs-slot installer or old image conversion.

## Writable namespace and boot ordering

Only DATA grows. SYSTEM stores authenticated deployment files; UEFI uses a
separate ESP and cx3576 a fixed firmware partition. Physical DATA namespaces
include state, meta, system/user application data and bounded disposable paths.
The native loader establishes machine identity on DATA before starting PID 1.

The root remains read-only; DATA/var is bound over the whole `/var` tree.
`mica-data-layout` establishes directories and byte/inode project limits before
`mica-seed-var` copies the initial template and `var.mount` exposes it. Protected
identity and management credentials remain on DATA/state, outside the general
var quota. New services can use `StateDirectory=` without another bind mount.
Persistent extension units are separate from the immutable boot chain.

DATA/containers is independently mounted at `/mica/containers`. Container and
system/user projects retain separate accounting without byte/inode limits; only
variable data has a bounded project limit. Service bounding
sets remove CAP_SYS_RESOURCE so ordinary root services cannot bypass those quotas.
Unbounded writers can fill DATA, including space needed by state/meta. Directory reset
uses allowlisted physical DATA paths and preserves identity and deployment records;
it does not restore arbitrary application writes during OS rollback.

Logs use volatile storage. Capture journal and boot evidence before stopping a
test. The exitrd shutdown path releases DATA/SYSTEM, verity mappings and loop
backing files cleanly. See [readonly root](https://github.com/micaoss/mica/blob/main/docs/design/ro-root.md) and
[storage](https://github.com/micaoss/mica/blob/main/docs/design/storage.md) for the exact mount policy.

## Verification and reproducibility

`make os-rootfs-manifest-test` and `make os-install-closure-gate` check selected
package coverage, archive freshness,
installed ELF/unit/account closure and reduced feature selections.
`verify/run.sh --verify` checks the complete current image and its packed root.
Runtime acceptance additionally exercises leaf binds, identity, quotas, health,
component updates and shutdown on x64 and virt-arm64.

Seed timestamps, machine identity placeholders, shadow dates, ext4 checksums and
squashfs ordering are controlled by the packing scripts. Build reports state the
source and package identities. `build/run.sh --compare-roots` attributes differences;
never describe a dirty source stamp as a reproducible clean commit.
