# mica-build

The assembly of Mica OS: it composes each product's root on the
`mica-system-base` root, signs the root, kernel/support and firmware
components, and assembles the factory images and update archives of the
products under `products/`.

Everything it builds from is pinned in `locks/`
([`mica:docs/design/release-lock.md`](https://github.com/micaoss/mica/blob/main/docs/design/release-lock.md)):
one release lock and pin per producer -- the build-env images and third-party
images (`mica-build-env`), the Base root, pool, later-stage Debian packages and
apt source (`mica-system-base`), the `mica-core` and `mica-podman` pools -- and
`locks/upstream.lock` for this tree's own third-party inputs; `mica-boards` is
pinned per board (`locks/mica-boards.<board>.lock`), its board, kernel, uboot,
firmware and packer components assembled into `_out/boards/<board>/`. Design, decisions and
the task records of this repository live in
[micaoss/mica](https://github.com/micaoss/mica).

## Layout

| Path | Purpose |
|---|---|
| `products/` | The product recipes: board, profile, features, public metadata |
| `rootfs/` | Package selection, composition on the Base root and root packing |
| `boot/` | UKI/FIT packaging, initramfs, signing and development key tools |
| `build/` | Signed components, offline archives, image assembly and release records |
| `verify/`, `tests/` | Image verification, suites, labs and lifecycle acceptance |
| `tools/` | Pins, pools, sources, product builds and release assets |
| `update-server/` | The component update service |

## Build and verify

`make help` lists the entry points. A product builds with
`make product PRODUCT=<name>` (development trust material: `make os-devkeys`);
`bash build/run.sh --components --help` describes the component commands.
`.github/workflows/ci.yml` runs the gates, `release.yml` builds and attaches a
release, and `privileged.yml` runs the image pipeline on a self-hosted runner.
