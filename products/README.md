# Products

A product is the image recipe: what one image is made of, declared in one
directory rather than reconstructed from environment variables after the
fact. `MICA_PRODUCT=<name>` is the composer's one input; `tools/product.sh
<name>` reads and validates the directory against the fetched board bundle
and prints the resolved inputs, and nothing else re-derives them.

```
products/<name>/
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
| `PRODUCT` | equals the directory name; the image name prefix |
| `BOARD` | a pinned board (a board row of `locks/`), fetched (`make board-fetch`) |
| `PROFILE` | `dev` or `prod` |
| `FEATURES` | opt-in; each a `feature-<f>.pkgs` or `radio-<r>.pkgs` of `rootfs/packages/`; a hardware feature (`wifi bluetooth display status-led can usb-gadget audio containers`) must be in the board's `BOARD_FEATURES` |
| `COMPONENTS` | optional; each a `component-<c>.pkgs` of the board bundle |
| `IMAGE_KINDS` | optional; a subset of the kinds the board's `images.tsv` declares (default: all of them; `disk` is always one). Each is packed and verified by the board's packer (`tools/image-kinds.sh`) |
| `UPDATE_KINDS` | optional; a subset of the update kinds the board's `images.tsv` declares (`full`, `root`, `kernel`; default: all of them; `full` is always one) |
| `SIZE_BUDGET_MB` | optional; defaults to the board's `BOARD_SIZE_BUDGET_MB` and may only lower it |
| `PUBLISH` | optional; `1` (default) when a scoped release builds and publishes the product, `0` for a product built locally and in CI only (`tools/release.sh`) |

`FEATURES=""` is the minimal image: the floor (`common.pkgs`) and the board
package. Every board has a `<board>-minimal` product, built locally and in CI
and never released (`PUBLISH=0`); every board has a `<board>-dev` development
image, and each release-target board a `<board>-prod` image, the dev features
with `PROFILE=prod`. A scoped release publishes the `-dev` and `-prod`
products of its scope.

## `defaults.toml`

Settings-tree defaults between the code defaults and the device's own
state (code < product < device). Validated for shape at compose time: TOML,
`version = 1`, tables only, and no key the redactor names as secret
(`psk`, `password`, `passwordHash`, `pin`, `key`) -- a password or a pairing
PIN can only travel in `provisioning.toml`. Composed into the root once
`micad` reads the file (`mica:docs/task/20260913-0440-micad-product-defaults`).

## `provisioning.toml`

The boot-time provisioning document (`mica:docs/design/provisioning.md`
section 4.1), placed on the image's boot medium. A product carrying one is
`factory-seeded` in the composition record and the lineage, which the
release gate refuses on the production channel.
