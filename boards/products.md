# Products

A product is the image recipe: what one image is made of, declared in one
directory rather than reconstructed from environment variables after the
fact. A product is a variant of its board, named `<board>.<variant>` (`uefi-x64.basic`,
`uefi-x64.full`), and lives in the board's directory. `MICA_PRODUCT=<name>` is the composer's one input; `src/product/product.ts
<name>` reads and validates the directory against the fetched board bundle
and prints the resolved inputs, and nothing else re-derives them.

```
boards/<board>/products/<variant>/
  product.env          composition: what the signed root contains (below)
  meta/                the public factory manifest baked into the root (updates/manifest.json)
  defaults.toml        optional: validated product-level settings defaults, non-secret; not installed in the image
  provisioning.toml    optional: a factory seed, today's mica-provisioning.toml, written to the image's
                       boot medium and never into the root; secrets allowed; marks the build factory-seeded
```

## `product.env`

Plain `KEY=value`, the `board.env` discipline: no logic, no substitution.

| Key | Rule |
|---|---|
| `PROFILE` | `dev` or `prod` |
| `INIT` | optional; `systemd` (the default) or `openrc`: the init the root runs, installed from `rootfs/packages/init-<init>.pkgs` and written into `/usr/lib/mica/product.conf` for micad. Under OpenRC every package links its own services into their runlevels (micad and apid where the product carries them; SSH, time, Bluetooth and the daily update at boot, and what micad last enabled through `mica-units`), and the composer removes the links no package owns; `containers` runs on either init |
| `CONTAINER_ENGINE` | optional, only with `containers`; `podman` (the default) or `docker`: the engine installed from `rootfs/packages/engine-<engine>.pkgs` and written into `/usr/lib/mica/product.conf` for micad. podman's containers are mica-containerd's, declared through micad; docker's are made with `docker` and `docker compose`, and micad switches dockerd on and off (`rootfs/README.md`) |
| `SSH_SERVER` | optional, only with `ssh`; `dropbear` (the default) or `openssh`: the server installed from `rootfs/packages/ssh-<server>.pkgs` (mica-ssh or mica-openssh, which conflict) and written into `/usr/lib/mica/product.conf` for micad, which drives either as `mica-sshd`. OpenSSH adds about 5 MB to a systemd root and 12 MB to an OpenRC one (uncompressed): a product that switches is held to its `SIZE_BUDGET_MB` |
| `SSH` | optional, only with `ssh`; `on` or `off` (the default): whether SSH is on at first boot, written into `/usr/lib/mica/product.conf`. The composer writes it into the image's SSH settings, `/usr/lib/mica/ssh/sshd.env`, which the init follows until micad saves its own, and micad seeds `access.ssh.enabled` from it on first boot. A product without micad that names `on` takes its keys from a provisioning medium's `mica-authorized-keys` |
| `DEVICE_CODE_SOURCE` | where micad reads the device code (below): `emmc-cid`, `dt-serial`, `dmi-serial`, `dmi-uuid`, `mac` or `random`, written into `/usr/share/mica/device-code.conf`. One fixed source per board, so a printed label never stops matching: `emmc-cid` on cx3576 and s905x5m (an SD product too, the eMMC stays on the board), `dmi-serial` on the UEFI and mini boards, `mac` on qemu-armhf (tests only: every QEMU guest has the same address). An x86 product whose units carry an OEM placeholder serial names `dmi-uuid`; `random` (uefi-x64.gcp) is a code micad draws once and keeps on DATA, for an instance with no serial a label could carry: nothing derives it offline, and its owner reads it after an SSH login |
| `CLAIM_DEVICE_CODE` | optional; `required` or `off`: whether claiming the device asks for its device code, written into `/usr/lib/mica/product.conf` for micad (absent: required where the device has a code). `off` on every product for now: on the UEFI, mini and QEMU products their serials or address are placeholders no label carries, and on the ARM boards the code is shown only on the serial console. `required` stays supported for when the code is reachable another way |
| `MDNS`, `SSDP` | optional; `on` or `off`: whether micad announces the device over mDNS and SSDP, written into `/usr/lib/mica/product.conf` for micad (absent: on). uefi-x64.gcp sets both off |
| `CLOUD_ADMINS` | optional; `on` or `off`: whether the cloud's SSH users (mica-gce-agent's login accounts) are administrators while micad's `access.cloudAdmins` is unset, written into `/usr/lib/mica/product.conf` for micad (absent: off). On, micad renders their sudo rule (mica-sudo); uefi-x64.gcp sets it on |
| `WATCHDOG` | optional; the identity of the watchdog the device arms (`/sys/class/watchdog/watchdog<N>/identity`, 1 to 32 printable characters), the signed boot policy's `board.watchdog` (`src/image/kernel-package.ts`); absent, the runkit arms `watchdog0`. uefi-x64.gcp names `Software Watchdog`: Compute Engine has no i6300ESB, and its kernel's softdog stands in |
| `ENABLE_UNITS` | optional, systemd only; the `<name>.service` units the product starts at boot that their packages ship disabled. The composer presets each `enable` in `40-mica-build.preset` and links it into its `WantedBy=` targets (`stages/compose/scripts/systemd/compose-20-units.sh`); each link needs its consumer in `src/rootfs/runtime/consumers.json`. uefi-x64.gcp enables `mica-gce-agent.service` |
| `FEATURES` | opt-in; each a `feature-<f>.pkgs` or `radio-<r>.pkgs` of `rootfs/packages/`; a hardware feature (`wifi bluetooth display status-led can usb-gadget audio containers`) must be in the board's `BOARD_FEATURES` |
| `COMPONENTS` | optional; each a `component-<c>.pkgs` of the board bundle. uefi-x64's `gce` (uefi-x64.gcp) is mica-gce-agent and mica-sudo |
| `IMAGE_KINDS` | optional; a subset of the kinds the board's `images.tsv` declares (default: all of them). Each is packed and verified by the board's packer (`src/product/image-kinds.ts`). `disk` is always built, every other kind deriving from it, but a product that names its kinds and leaves `disk` out does not publish it: an eMMC product releases its USB burning package alone |
| `UPDATE_KINDS` | optional; a subset of the update kinds the board's `images.tsv` declares (`full`, `root`, `kernel`; default: all of them; `full` is always one) |
| `SIZE_BUDGET_MB` | optional; defaults to the board's `BOARD_SIZE_BUDGET_MB` and may only lower it |
| `DATA_ENCRYPTION` | optional; `on` or `off` (the default): whether DATA is LUKS2-encrypted on the device (mica-core W1). `on` writes the signed boot policy's top-level `dataEncryption` (`src/product/data-encryption.ts`), leaves the factory DATA partition zeroed for the device to format at its first boot, and puts the firmware receipt on SYSTEM as `/firmware.json`. Refused on a UBI board, on a board with no DATA cipher, and against a mica-core pin whose contract fixture has no `dataEncryption` cases; a test seed into DATA (`src/image/seed-data.ts`) refuses such an image. The cipher and the recovery key's KDF memory are the board's (`aes-xts-plain64`; 262144 KiB on x64 and generic arm64, 65536 on cx3576 and s905x5m). uefi-x64.gcp-tpm2 sets it on |
| `DATA_KEY_PROVIDERS` | only with `DATA_ENCRYPTION=on`, and then required; the key providers that unlock DATA at boot, in order, each one the board can have: `tpm2`, on uefi-x64 only |
| `DATA_ENCRYPTION_NO_PROVIDER` | optional, only with `DATA_ENCRYPTION=on`; `refuse` (the default) or `plain`: what the device does when no key provider answers at its first boot |
| `RELEASE` | optional; `yes` (the default) or `never`: a `never` product is built for a test channel only, and every release workflow refuses it by name (ci.yml's plans skip it). uefi-x64.gcp-tpm2 is one |

The name and the board come from the directory: `boards/<board>/products/<variant>/` is the product
`<board>.<variant>`, whose board is `<board>`, which must be a pinned board (a board row of `locks/`)
fetched by `make board-fetch`. A variant name is `[a-z0-9][a-z0-9-]*`.

Every board has at least one product, and a board that is a release target at least one `prod` one. No variant name
is required or default: the variant names the product's purpose and may carry suffixes (`full-docker`, `gateway`,
`radio`). `basic`, `full`, `base`, `docker` and `dev` are names products have today, not roles the tree gives a
name. Each product releases on its own, as `<board>.<variant>.<YYYYMMDD-HHMM>`
(`gh workflow run release.yml -f product=<board>.<variant>`). Whether a product is released is never read from its
name: a `PROFILE=dev` product is built locally and never released, a product of a board that is no release target
(`BOARD_RELEASE_TARGET`) is not released, and of the rest the release list decides.
That the floor (`common.pkgs` and the board package) composes on every board with no feature is proved by
`tests/gates/rootfs-manifest.test.ts`.

## `defaults.toml`

Settings-tree defaults for the product, validated by the product reader
(`src/product/product.ts`): TOML, `version = 1`, tables only, and no key the
redactor names as secret (`psk`, `password`, `passwordHash`, `pin`, `key`) -- a
password or a pairing PIN can only travel in `provisioning.toml`. The composer
does not install it and nothing on the device reads it: a device's defaults
are micad's own, and a board's network entries
(`/usr/share/mica/defaults/network.json`, `mica-core:docs/mica-core.md` 3.3).
No product carries one.

## `provisioning.toml`

The boot-time provisioning document (`mica:docs/design/provisioning.md`
section 4.1), placed on the image's boot medium. A product carrying one is
`factory-seeded` in the composition record and the lineage, which the
release gate refuses on the production channel.

`STORAGE_LAYOUT=<name>` selects the fetched board's `layout-<name>.tsv`.
An absent or empty selector uses `layout.tsv`; a missing or unsafe name is refused.
The selection binds the kernel policy, component packaging, storage package and image verification.

## The device code and the access-point secret

A device's code is what its label prints and what support asks for; micad reads it from the
source `/usr/share/mica/device-code.conf` names and prints it with `micad device-code`
(`mica-core:docs/factory-ap-key.md`). On a wifi product it also keys the factory access point,
which is on out of the box: SSID `mica-` and four characters of the code's own hash, and a key micad
derives as HMAC-SHA256 of the product secret and the code. The key is the access point's only
until the device is claimed; the claim sets the access point's own key.

The product secret is `/usr/share/mica/ap-secret` in a wifi product's root, `root:root` `0600`,
at least 32 bytes, from the build secret `MICA_AP_SECRET_FILE` (one trailing newline is not part
of it). It is never in git. CI reads it from the repository secret `MICA_AP_SECRETS`, one line
per product, `<product> <the secret, base64>` (`.github/workflows/release-product.yml`). A build
without one takes the product's development secret, public and derived from its name, and
records `#ap-secret development` in `rootfs-packages.txt`; a push builds that way, and a release
of a wifi product without its secret is refused, before its build and again at
`scoped-release publish`. Whoever holds a product's image holds its secret and can derive the
default key of every device of it from the printed code: a first-contact credential, not a
secret of the device.

The label is derived offline from the printed code and the same secret:

```
bun src/cli.ts label --secret FILE DFN4-L34C-T8N            the product secret
bun src/cli.ts label --development cx3576.full DFN4L34CT8N   a build's development secret
```

It prints `code`, `ssid`, `psk` and `qr`, the Wi-Fi QR payload `WIFI:T:WPA;S:<ssid>;P:<psk>;;`,
one per line (`src/product/device-code.ts`, `src/product/label.ts`).
