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
  defaults.toml        optional: product-level settings defaults, non-secret, baked as /usr/lib/mica/defaults.toml
  provisioning.toml    optional: a factory seed, today's mica-provisioning.toml, written to the image's
                       boot medium and never into the root; secrets allowed; marks the build factory-seeded
```

## `product.env`

Plain `KEY=value`, the `board.env` discipline: no logic, no substitution.

| Key | Rule |
|---|---|
| `PROFILE` | `dev` or `prod` |
| `INIT` | optional; `systemd` (the default) or `openrc`: the init the root runs, installed from `rootfs/packages/init-<init>.pkgs` and written into `/usr/lib/mica/product.conf` for micad. Under OpenRC every package links its own services into their runlevels (micad and apid at boot; micad starts SSH, time, the radios and MQTT), and the composer removes the links no package owns; `containers` runs on either init, supervised by mica-containerd |
| `FEATURES` | opt-in; each a `feature-<f>.pkgs` or `radio-<r>.pkgs` of `rootfs/packages/`; a hardware feature (`wifi bluetooth display status-led can usb-gadget audio containers`) must be in the board's `BOARD_FEATURES` |
| `COMPONENTS` | optional; each a `component-<c>.pkgs` of the board bundle |
| `IMAGE_KINDS` | optional; a subset of the kinds the board's `images.tsv` declares (default: all of them). Each is packed and verified by the board's packer (`src/product/image-kinds.ts`). `disk` is always built, every other kind deriving from it, but a product that names its kinds and leaves `disk` out does not publish it: an eMMC product releases its USB burning package alone |
| `UPDATE_KINDS` | optional; a subset of the update kinds the board's `images.tsv` declares (`full`, `root`, `kernel`; default: all of them; `full` is always one) |
| `SIZE_BUDGET_MB` | optional; defaults to the board's `BOARD_SIZE_BUDGET_MB` and may only lower it |

The name and the board come from the directory: `boards/<board>/products/<variant>/` is the product
`<board>.<variant>`, whose board is `<board>`, which must be a pinned board (a board row of `locks/`)
fetched by `make board-fetch`. A variant name is `[a-z0-9][a-z0-9-]*`.

Every board has its `basic` product, the default one; any other variant is optional and a board may
have several. The variants today are `basic` (every board), `full` (`basic` with the container engine)
and `dev` (`PROFILE=dev`, built locally and never released). Each product releases on its own, as
`<board>.<variant>.<YYYYMMDD-HHMM>` (`gh workflow run release.yml -f product=<board>.<variant>`); a
`dev` product and a product of a board that is no release target (`BOARD_RELEASE_TARGET`) are not
released. That the floor (`common.pkgs` and the board package) composes on every board with no feature
is proved by `tests/gates/rootfs-manifest.test.ts`.

## `defaults.toml`

Settings-tree defaults between the code defaults and the device's own
state (code < product < device). Validated for shape at compose time: TOML,
`version = 1`, tables only, and no key the redactor names as secret
(`psk`, `password`, `passwordHash`, `pin`, `key`) -- a password or a pairing
PIN can only travel in `provisioning.toml`.

## `provisioning.toml`

The boot-time provisioning document (`mica:docs/design/provisioning.md`
section 4.1), placed on the image's boot medium. A product carrying one is
`factory-seeded` in the composition record and the lineage, which the
release gate refuses on the production channel.

`STORAGE_LAYOUT=<name>` selects the fetched board's `layout-<name>.tsv`.
An absent or empty selector uses `layout.tsv`; a missing or unsafe name is refused.
The selection binds the kernel policy, component packaging, storage package and image verification.
