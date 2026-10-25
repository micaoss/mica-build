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
| `INIT` | optional; `systemd` (the default) or `openrc`: the init the root runs, installed from `rootfs/packages/init-<init>.pkgs` and written into `/usr/lib/mica/product.conf` for micad. Under OpenRC every package links its own services into their runlevels (micad and apid at boot; micad starts SSH, time, the radios and MQTT), and the composer removes the links no package owns; `containers` runs on either init |
| `CONTAINER_ENGINE` | optional, only with `containers`; `podman` (the default) or `docker`: the engine installed from `rootfs/packages/engine-<engine>.pkgs` and written into `/usr/lib/mica/product.conf` for micad. podman's containers are mica-containerd's, declared through micad; docker's are made with `docker` and `docker compose`, and micad switches dockerd on and off (`rootfs/README.md`) |
| `SSH_SERVER` | optional, only with `ssh`; `dropbear` (the default) or `openssh`: the server installed from `rootfs/packages/ssh-<server>.pkgs` (mica-ssh or mica-openssh, which conflict) and written into `/usr/lib/mica/product.conf` for micad, which drives either as `mica-sshd`. OpenSSH adds about 5 MB to a systemd root and 12 MB to an OpenRC one (uncompressed): a product that switches is held to its `SIZE_BUDGET_MB` |
| `DEVICE_CODE_SOURCE` | where micad reads the device code (below): `emmc-cid`, `dt-serial`, `dmi-serial`, `dmi-uuid` or `mac`, written into `/usr/share/mica/device-code.conf`. One fixed source per board, so a printed label never stops matching: `emmc-cid` on cx3576 and s905x5m (an SD product too, the eMMC stays on the board), `dmi-serial` on the UEFI and mini boards, `mac` on qemu-armhf (tests only: every QEMU guest has the same address). An x86 product whose units carry an OEM placeholder serial names `dmi-uuid` |
| `CLAIM_DEVICE_CODE` | optional; `required` or `off`: whether claiming the device asks for its device code, written into `/usr/lib/mica/product.conf` for micad (absent: required where the device has a code). `off` on the UEFI, mini and QEMU products, whose serials or address are placeholders no label carries; `required` on cx3576.full and the s905x5m products |
| `MDNS`, `SSDP` | optional; `on` or `off`: whether micad announces the device over mDNS and SSDP, written into `/usr/lib/mica/product.conf` for micad (absent: on). No product sets either |
| `FEATURES` | opt-in; each a `feature-<f>.pkgs` or `radio-<r>.pkgs` of `rootfs/packages/`; a hardware feature (`wifi bluetooth display status-led can usb-gadget audio containers`) must be in the board's `BOARD_FEATURES` |
| `COMPONENTS` | optional; each a `component-<c>.pkgs` of the board bundle |
| `IMAGE_KINDS` | optional; a subset of the kinds the board's `images.tsv` declares (default: all of them). Each is packed and verified by the board's packer (`src/product/image-kinds.ts`). `disk` is always built, every other kind deriving from it, but a product that names its kinds and leaves `disk` out does not publish it: an eMMC product releases its USB burning package alone |
| `UPDATE_KINDS` | optional; a subset of the update kinds the board's `images.tsv` declares (`full`, `root`, `kernel`; default: all of them; `full` is always one) |
| `SIZE_BUDGET_MB` | optional; defaults to the board's `BOARD_SIZE_BUDGET_MB` and may only lower it |

The name and the board come from the directory: `boards/<board>/products/<variant>/` is the product
`<board>.<variant>`, whose board is `<board>`, which must be a pinned board (a board row of `locks/`)
fetched by `make board-fetch`. A variant name is `[a-z0-9][a-z0-9-]*`.

Every board has its `basic` product, the default one; any other variant is optional and a board may
have several. The variants today are `basic` (every board), `full` (`basic` with the container engine),
`docker` (`uefi-x64.full` with `CONTAINER_ENGINE=docker`) and `dev` (`PROFILE=dev`, built locally and never released). Each product releases on its own, as
`<board>.<variant>.<YYYYMMDD-HHMM>` (`gh workflow run release.yml -f product=<board>.<variant>`); a
`dev` product and a product of a board that is no release target (`BOARD_RELEASE_TARGET`) are not
released. That the floor (`common.pkgs` and the board package) composes on every board with no feature
is proved by `tests/gates/rootfs-manifest.test.ts`.

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
