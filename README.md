# mica-build

The boards and the assembly of Mica OS in one repository. A board is a
directory under `boards/` carrying its whole build (`boards/README.md`): the
board definition, its kernel and U-Boot builds with their upstream source
pins, its package inputs, its flashing formats, the evidence and the board's
own tests. The assembly composes each product's root on the
`mica-system-base` root, signs the root, kernel/support and firmware
components, and assembles the factory images and update archives of the
products under `products/`.

Everything it builds from is pinned in `locks/`
([`mica:docs/design/release-lock.md`](https://github.com/micaoss/mica/blob/main/docs/design/release-lock.md)):
one release lock and pin per producer -- the build-env images and third-party
images (`mica-build-env`), the Base root, pool, later-stage Debian packages and
apt source (`mica-system-base`), the `mica-core` and `mica-podman` pools -- and
`locks/upstream.lock` for this tree's own third-party inputs: the kernel,
U-Boot and rkbin trees and the toolchain archives the boards build from
(`src/cli.ts upstream`), and the regulatory database. Design, decisions and the
task records of this repository live in
[micaoss/mica](https://github.com/micaoss/mica).

## Layout

| Path | Purpose |
|---|---|
| `boards/` | One directory per board: definition, kernel and loader builds, manifests, package inputs, firmware, tests; `boards.tsv` lists them |
| `common/` | What every board takes unchanged: the kernel floor, the U-Boot record format and trust helpers, trust staging, package templates |
| `producers/` | The board package producer (one per board) and the radio packages |
| `products/` | The product recipes: board, profile, features, public metadata |
| `rootfs/` | Package selection, composition on the Base root and root packing |
| `boot/` | UKI/FIT packaging, initramfs, signing and development key tools |
| `build/` | Signed components, offline archives, image assembly and release records |
| `verify/`, `tests/` | Image verification, suites, labs, lifecycle acceptance and the boards' gates |
| `tools/` | Pins, pools, sources, board builds and bundles, product builds and release assets; `tools/deb/` the packaging, package gate and pool publisher |

## Build and verify

`make help` lists the entry points. A board's kernel is `make <board>-kernel`
(its loader `make <board>-firmware`; `make kernels firmware` for every board),
the boards' packages `make board-pool` with `make board-package-gate`, and
the boards' gates `make board-check`. A product builds with
`make product PRODUCT=<name>` (development trust material: `make os-devkeys`),
taking the board's kernel and loader from the local build under
`_out/<board>/` or, when there is none, from the latest release of this
repository that published them with the same inputs (`tools/board-pool.sh`);
`bash bin/bun.sh src/cli.ts components --help` describes the component commands.
`.github/workflows/ci.yml` runs the gates and builds every board and product,
`release.yml` builds and attaches a release, and `privileged.yml` runs the
image pipeline on a self-hosted runner.

## Releases

A release is scoped to a board (all its products) or to one product, cut on
GitHub with `gh release create <scope>.<YYYYMMDD-HHMM> --target <commit of
main>`. `release.yml` builds the scope's board at the tag -- a kernel or
U-Boot whose inputs hash (`tools/inputs.sh`, the `mica.inputs` annotation)
equals the one the latest release published is reused by digest
(`tools/reuse.sh`), and a package is locked by its declared version
(`src/cli.ts version-guard`) -- publishes its pool as
`pool.<board>.<arch>.<YYYYMMDD-HHMM>` and its built components as
`<component>.<board>.<YYYYMMDD-HHMM>` in `ghcr.io/micaoss/mica-build`, then
builds, verifies and publishes the scope's products, and attaches
`mica-build.lock` last: the board's pool, package and component rows, the
input releases, and each product's signed deployment, image and update
assets. After every scoped release the index job cuts the Mica version index
`mica.<YYYYMMDD-HHMM>`.

The trust material a release embeds comes from the repository variables
`MICA_VERITY_TRUST_CERT`, `MICA_BOOT_TRUST_CERT` and
`MICA_UPDATES_PUBLIC_KEY` and the secrets `MICA_RELEASE_VERITY_KEY`,
`MICA_RELEASE_BOOT_KEY` and `MICA_RELEASE_UPDATES_KEY`. A kernel embeds the
dm-verity trust certificate of the deployment it will boot
(`VERITY_TRUST_CERT`, default `meta/verity/signer.cert.pem`) and a U-Boot the
FIT boot certificate (`FIT_TRUST_CERT`); `trust-certificates.sha256` records
the certificates every board build takes, and CI stops when a variable does
not hash to it.
