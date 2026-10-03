# mica-build

The boards and the assembly of Mica OS. A board is a directory under `boards/` carrying its whole
build (`boards/README.md`): the board definition, its kernel and U-Boot builds with their upstream
source pins, its package, its flashing formats, its evidence and its own tests. A product is a
variant of its board, `<board>.<variant>` under `boards/<board>/products/<variant>/`
(`boards/products.md`): the assembly composes its root on the floor of `mica-system-base` with one
init (systemd or OpenRC) and the features it names, signs the root, kernel/support, core and
firmware components, and assembles its factory images and update archives.

## Inputs

Everything the build reads is pinned in `locks/`
([`mica-build-tools:docs/spec/release-lock.md`](https://github.com/micaoss/mica-build-tools/blob/main/docs/spec/release-lock.md)),
one release lock and pin per producer, each the producer's latest release:

| Lock | What it pins |
|---|---|
| `mica-build-env.lock` | the build images and the third-party images the builds run in |
| `mica-system-base.lock` | the floor root, its pool (the inits, SSH, Wi-Fi, Bluetooth, time zones), the Debian packages later stages add, and its apt snapshot |
| `mica-core.lock` | the core components (micad with apid, the web console), MQTT, mica-deploy and the runkit |
| `mica-podman.lock` | the container engine |
| `upstream.lock` | this tree's own third-party inputs: the kernel, U-Boot and rkbin trees, the toolchain archives and the regulatory database (`bin/mica-tools upstream get`) |

`locks/mica-build-tools.pin` names the commit of mica-build-tools every generic rule runs from
(`bin/mica-tools`). A pin moves with `bin/mica-tools locks move <repository> <release>`.

## Layout

| Path | Purpose |
|---|---|
| `boards/` | One directory per board, its products under `products/<variant>/`; `boards.tsv` lists them |
| `common/` | What every board takes unchanged: the kernel floor, the U-Boot record format and trust helpers, trust staging, the board package producer (`board/`, `package/`) |
| `rootfs/` | What a product root contains (`rootfs/README.md`, `rootfs/packages/`) |
| `stages/` | The Dockerfiles and scripts the builds run: root composition and packing (each init's steps under `stages/compose/scripts/<init>/`), boot tools, the pool index, release compression |
| `src/` | The engine, one entry point `src/cli.ts`: boards and components, the pools, products, the root, images, verification, releases |
| `tests/` | The gates (`tests/gates/`), the suites and labs (`tests/suites/`) and their fixtures |
| `locks/` | The release locks and pins |
| `bin/` | `bun.sh` (bun on the host or in the pinned image) and the mica-build-tools bootstrap |
| `docs/` | How the engine is built: `design/packages.md` (the board packages and their pools), `design/image.md` (components, images, releases), `design/verify.md` (the image verifier) |
| `meta.example/` | The shape of a product's public metadata |

## Build and verify

`make help` lists the entry points. A board's kernel is `make <board>-kernel` (its loader
`make <board>-firmware`), the board packages `make board-pool` with `make board-package-gate`, and
the boards' gates `make board-check`. A product builds with `make product PRODUCT=<name>`
(development trust material: `make os-devkeys`), taking the board's kernel and loader from the
local build under `_out/<board>/` or, when there is none, from the latest release of this
repository that published them with the same inputs.

| Target | Checks |
|---|---|
| `make product-verify PRODUCT=<name>` | the image against the board and product contract (`docs/design/verify.md`) |
| `make lifecycle-uefi PRODUCT=<name>` | a UEFI product under QEMU: the runtime, updates and faults, with the init's shutdown evidence |
| `make os-session-probe PRODUCT=<name>` | a systemd product checking itself from inside; an OpenRC product loads no extension units and is skipped |

`.github/workflows/ci.yml` runs the gates and builds the boards and products a change touches,
and everything every three days; `release.yml` builds and publishes one product;
`privileged.yml` runs the image pipeline on a self-hosted runner.

## Releases

A release is one product, cut with `gh workflow run release.yml -f product=<board>.<variant>`
and named `<board>.<variant>.<YYYYMMDD-HHMM>`. It builds the product's board at the commit of
`main` the run started on -- a kernel or U-Boot whose inputs hash (`src/cli.ts board-inputs`, the
`mica.inputs` annotation) equals the one the latest release published is reused by digest
(`src/cli.ts reuse`), and a package is locked by its declared version (`src/cli.ts
version-guard`) -- publishes its pool as `pool.<board>.<arch>.<YYYYMMDD-HHMM>` and its built
components as `<component>.<board>.<YYYYMMDD-HHMM>` in `ghcr.io/micaoss/mica-build`, then builds,
verifies and publishes the product, and creates the GitHub release at that commit with
`mica-build.lock` attached last: the board's pool, package and component rows, the input
releases, and the product's signed deployment, image and update assets. A `dev` product is never
released, and there is no index of releases: the fleet reads the board definitions and takes each
product's latest release.

After the GitHub release is attached, the same run posts it to the resource service
(`mica-res:docs/spec/release-publishing.md`, `src/release/res.ts`): res pulls every asset by
digest, files it under `mica/<product>/<stamp>/`, records the release and feeds the device update
catalog from its full archive: `mica/catalog/v2` at `/update/v2/manifest.json` (a device's update
source is the root `/update/`) names each product's latest release, whose `index.json`
(`mica/release/v1`) names its signed descriptor and objects, every URL a `baseUrl` plus a `path`. It needs the repository secret `MICA_RES_TOKEN`, an API token with
the `res:publish` scope.

`publish-res.yml` (manual dispatch only) posts the releases this repository has already published,
so a reset res gets every existing release back without a release being cut again. With no input
it takes every published (non-draft) release that has assets, oldest first; `-f release=<tag>`
takes one; `-f dry_run=true` rebuilds each post and sends nothing (the default is to post). Each
post is rebuilt from that release's own published assets -- its `mica-build.lock`, the bundles it
pins and the signed descriptor at the head of its full update archive -- through the same
`src/release/res.ts` path the release run takes. Posting a release res already holds answers
unchanged; a release that fails is reported and the next one is posted, and the job summary lists
each release with its outcome. It creates, edits or deletes no release, tag or image.

A core release (`-f core=true`) moves only the core components: it publishes the kernel and root
of the product's previous release with this commit's core components, and its update packages are
the full one and the core one, which carries the core components alone. When the previous root's
interface level is outside a core component's range, the product is built whole.

The trust material a release embeds comes from the repository variables `MICA_VERITY_TRUST_CERT`,
`MICA_BOOT_TRUST_CERT` and `MICA_UPDATES_PUBLIC_KEY` and the secrets `MICA_RELEASE_VERITY_KEY`,
`MICA_RELEASE_BOOT_KEY` and `MICA_RELEASE_UPDATES_KEY`. A kernel embeds the dm-verity trust
certificate of the deployment it will boot (`VERITY_TRUST_CERT`, default
`meta/verity/signer.cert.pem`) and a U-Boot the FIT boot certificate (`FIT_TRUST_CERT`);
`trust-certificates.sha256` records the certificates every board build takes, and CI stops when a
variable does not hash to it.

The conventions every Mica OS repository follows -- the board contract, the release lock, release
signing -- and the public documentation live in [micaoss/mica](https://github.com/micaoss/mica).
