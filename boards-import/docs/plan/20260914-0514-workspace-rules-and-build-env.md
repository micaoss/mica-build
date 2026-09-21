# 20260914-0514-workspace-rules-and-build-env Bring mica-boards to the workspace rules and the released build-env

- **status**: review
- **createdAt**: 2026-09-14 05:14
- **approvedAt**: 2026-09-14 (user instruction via coordinator uj991oa2: "mica-boards严重滞后，需要让他看claude.md里面的规则和新的build-env")
- **relatedTask**: 20260914-0514-workspace-rules-and-build-env

## Context

The workspace Constraints (`mica:AGENTS.md`) and `mica-build-env:RULES.md` at
release `20260914-0128` changed what a repository takes from mica-build-env:
only `build-env-image.lock` (four images: base, c, go, rust), verified against
the release's `SHA256SUMS`; consumers own their scripts. mica-boards still
builds through the `build-env/` source pin (mica-build-env c076e24): its
`from.sh`, `images.env` (four non-build-env base images and the `LOCAL_*`
deb/openssl builder images), and the whole `deb/` toolchain (producers, build,
pack, repo, package gate, OCI publish). Branch `split-boot-inputs` already
removed the `mica-boot` pin (step 3 of the boot split, commit d1a5f3e).

Gaps against the rules, measured on d1a5f3e:

1. `deps/sources/mica-build-env.json` + `tools/deps.sh`: a `build-env/` source pin (forbidden form).
2. Images from `build-env/images.env` and `build-env/from.sh`: `IMAGE_UBUNTU_2404` (every kernel and U-Boot build, the cx3576 flash images), `IMAGE_DEBIAN_TRIXIE` (s905x5m userland and loader package), `IMAGE_ALPINE_3_24_1` (cx3576 debug rootfs), `IMAGE_REGISTRY_2` (publish test), the Dockerfile frontend digest; `LOCAL_MICA_BUILD_DEB` (packing) and `LOCAL_MICA_BUILD_OPENSSL` (trust stage) are not release images at all.
3. Packaging, gate and publish come from `build-env/deb/` (build.sh, producers.sh, pack.sh, repo.sh, preflight.sh, package-gate.sh, control-fields.py, registry.sh, oci.sh, publish.sh).
4. Versions and names: packages `VERSION+git<commit12>-1` (matches RULES section 6); OCI tags `pool.<arch>.build-<commit12>` and `board.<board>.build-<commit12>`, published by a `workflow_dispatch`, not a UTC-named release.
5. One `release.yml` with a push/PR check job and a dispatch release job on `ubuntu-latest` with QEMU for the arm64 builder images; no `ci.yml`; no native arm64 job; no caches.
6. `AGENTS.md`/`CLAUDE.md` in the repository (the workspace file is the only agent instruction file).
7. References to retired repositories: `families/common/package/copyright` names the retired `mica-system` repository; the boards' `evidence.json` cite `pkgs/mica-deploy/tests/...` (now `mica-core:crates/mica-deploy/tests/...`). Package names `mica-system`, `mica-busybox` (mica-system-base) and `mica-deploy` (mica-core) are current and stay.
8. mica-debian: nothing in the tree reads a `debian/` snapshot (the Makefile comment naming it went with d1a5f3e); no replacement input is needed.

## Proposal

A. **Build env from the lock** (direct application). Commit the verified
`build-env-image.lock` of `20260914-0128` unchanged and `build-env-release`
(tag, trust hash). `tools/build-env.sh verify|check` (network verify,
offline check). `tools/from.sh` resolves `IMAGE_MICA_BUILD_*` from the lock and
this repository's own non-build-env pins from `base-images.env`
(`IMAGE_UBUNTU_2404`, `IMAGE_DEBIAN_TRIXIE`, `IMAGE_ALPINE_3_24_1`,
`IMAGE_REGISTRY_2`, same digests as today, so kernel and U-Boot outputs do not
move); a `MICA_BUILD` key in `base-images.env` or any `LOCAL_` key is refused.
Packing and the trust stage run in `IMAGE_MICA_BUILD_BASE` (dpkg-dev, openssl).
`make deps` becomes `tools/build-env.sh verify`; `deps-bump`, `build-env`,
`tools/deps.sh` and `deps/sources/` go.

B. **Own packaging** (direct application). `tools/deb/` holds what mica-boards
uses of the old `deb/`: producer discovery with FOR_EACH, PREPARE, PREFLIGHT,
BUILD_CONTEXTS; build per architecture in the base image; pack.sh;
repo index; the package gate of RULES section 6; the OCI client. Producer
Dockerfiles take `MICA_BUILD_BASE`.

C. **Release naming and publish** (direct application). A release is
`gh release create <YYYYMMDD-HHMM>`; publishing runs only from a clean checkout
whose HEAD carries that tag, and pushes `pool.<arch>.<YYYYMMDD-HHMM>` and
`board.<board>.<YYYYMMDD-HHMM>` into the repository's own package
`ghcr.io/micaoss/mica-boards`, reading back anonymously. Package versions stay
`<VERSION>+git<commit12>-1` (RULES section 6; mica-core does the same).

D. **Workflows** (direct application, with question 1 and 2 below):
`ci.yml` on push/PR runs `make check`, `tools/build-env.sh verify` and the
per-architecture package build + gate; `release.yml` on `release: published`
checks out the tag, builds per architecture, gates, publishes, attaches
`SHA256SUMS` of the pool to the release. Latest action versions checked at
their repositories. Caches keyed on the lock, base-images and kernel pins.

E. **Clean-up** (direct application): delete `AGENTS.md`/`CLAUDE.md`; fix the
retired-repository references in (7); README, families README, changelog.

## Questions for the user (asked through uj991oa2)

1. arm64 kernels and U-Boots: cross-compiled on the x64 runner (as the Dockerfiles always did, no emulation) with each pool packed natively on its own runner, or native arm64 kernel builds (Dockerfile changes, kernel bytes may move)? Implemented: cross-compiling (the recommendation); open for the user to overrule.
2. CI trust input: the deployment's public certificates are the repository variables MICA_VERITY_TRUST_CERT and MICA_BOOT_TRUST_CERT (PEM text; vars, not secrets, since they are public; user decision 2026-09-14); no certificate is committed.
3. `families/` (raised by the user): answered -- each board carries its own kernel and U-Boot build, the uefi kernel build is copied into x64 and virt-arm64, the shared inputs go to the top-level `common/`.
4. Caching (user): approved everywhere; only third-party prefix stages are cached, saved on push to main only.
5. Held local commits (user: keep what is useful): radio kept and rebased; the SFTP board component dropped (SFTP is mica-core's, installed by the product stage); the Actions bump superseded.
6. History (user): the repository is to be one root commit of the final tree; push target pending the user's choice of repository.

## Implementation (2026-09-14)

- eba3182 build-env-image.lock, build-env-release, base-images.env, tools/build-env.sh, tools/from.sh, tools/deb/, release-labelled publishing; build-env pin, tools/deps.sh, deps/, AGENTS.md, CLAUDE.md removed; retired-repository references fixed.
- 2672e46 ci.yml, release.yml, reusable build.yml; package gate --arch/--static; make pool POOL_ARCH; BUILDX_CACHE; cx3576 splash path (broken since 080dbfd).
- 904d608 s905x5m recovery package config path (broken since 080dbfd); repo.sh reads base.env without sourcing it.
- Local gates on the new images at 904d608: make check; all four kernels; firmware; make pool (both architectures, arm64 through a docker-container builder on this x64 host); make package-gate PASS 99/99 (12 archives, rebuild compared); --static 95/95; --arch amd64 19/19; trust-stage-test 10/10; publish-boards-test 16/16; actionlint on the three workflows.

## Risks

- A full local `make pool` needs every kernel and U-Boot built (hours); run once on the new images before reporting.
- mica-build (paused) reads `build-<commit12>` tags and the old source pins; it must adopt the time-named tags.
- Radio (03f85ca) and SFTP (d5e75e6) commits on local `main` predate this and must be rebased onto the new packaging.

## Scope

`build-env-image.lock`, `build-env-release`, `base-images.env`, `tools/`, `producers/*`, `boards/*/extras/*`, `families/*` (image and packer references only), `tests/`, `Makefile`, `.github/workflows/`, `.gitignore`, `README.md`, `families/README.md`, `docs/`; removal of `deps/sources/`, `tools/deps.sh`, `AGENTS.md`, `CLAUDE.md`.
