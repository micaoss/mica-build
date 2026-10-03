# The image engine: `src/image/`

Builds the signed components of a product, assembles its factory image and update archives, and
gates its release directory. It dispatches on a board's facts, never on its name
(`tests/gates/board-name-lint.test.ts`, `tests/gates/board-fact-lint.test.ts`). Nothing here runs
on the device.

    bash bin/bun.sh src/cli.ts components <component> ...     (one signed component)
    bash bin/bun.sh src/cli.ts build-rootfs ...               (the composition stages of a product root)
    bash bin/bun.sh src/cli.ts release assemble|gate ...      (a product's release directory)

`src/product/build.ts` drives these for `make product PRODUCT=<board>.<variant>`.

## The board

| Module | Does |
| --- | --- |
| `board-facts.ts` | The facts a board is dispatched on, from its `board.env` and `layout.tsv`, and the signed boot policy's `board` section (`BOARD_DATA_QUOTAS=0` turns DATA's project quotas off) |
| `file-layout.ts` | The disk `layout.tsv` declares, held to its rules, the reserves and the capacity check |
| `backends/` | The boot backends: `systemd-boot` (UKI on an ESP) and `uboot-fit` (FIT with boot records) |
| `firmware-formats.ts`, `firmware.ts` | The firmware formats and the firmware receipt a device authenticates |
| `fit-board.ts`, `fit-environment.ts` | A FIT board's load map, and its redundant boot record copies |
| `roles/` | The partition roles (`esp`, `system`, `data`, `raw`, `vfat`, `ext4`), the one dispatch point on a role |
| `regions.ts` | The bytes of a raw partition's regions |

## Components and images

| Module | Does |
| --- | --- |
| `components.ts` | Component identities: canonical JSON, the ids a deployment binds, and the contract of `mica/deployment/v1` (a `mica/rootfs/v1` root's interface level, 1 or more, the `mica/core/v1` core components) |
| `core-components.ts` | The core components a product's features select out of the pool, refused when one does not run on this tree's root interface level or needs a component at a version the product does not carry |
| `component-build.ts`, `component-archive.ts`, `component-cli.ts` | Packing a signed component (a core component is signed with the content key, its record completed with the signature and its id), the update archives (`full`, `root`, `kernel`, and `core`: the core components' objects alone), and the `components` command |
| `kernel-package.ts` | The kernel component: UKI or FIT, the boot policy, the initramfs executables |
| `file-image.ts`, `image-name.ts` | The factory disk: two deployments with their objects on SYSTEM (`roots/`, `kernels/`, `cores/<id>/core.{img,roothash,roothash.p7s}`), the seeded DATA, the image's file name |
| `firmware-maintenance.ts` | The firmware a deployment carries and the target it writes |
| `seed-data.ts`, `qemu-seed-data.ts` | Test files seeded into DATA of a factory image copy |
| `stages.ts`, `stages-cli.ts` | The rootfs composition Dockerfiles as data, and `build-rootfs` |
| `pin-seeded-times.ts` | Fixed timestamps on the seeded filesystems |

## Release

`release-cli.ts` and `release-manifest.ts` assemble a product's release directory and gate it: the
source identity, the lock rows, the release manifest, and the board being a release target.
`release-verify.md` holds the verification commands a release consumer runs, which
`release-manifest.test.ts` executes.

## The tools

`toolbox.ts` is the seam every external tool runs through (on the host or in its pinned
container); `toolsets.ts` names the tool sets, and `tools/` wraps each (`sgdisk`, `mtools`, `dd`,
`veritysetup`, `e2fsprogs`). `images.ts` resolves an image selector to its locked reference, and
`verify-package.ts` is the one import from `src/verify/` (the board parser and the repository paths);
`paths.ts` adds this package's own directory and scratch root.
