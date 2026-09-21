# `tools/deb/` -- this repository's Debian packaging, gate and publisher

This repository owns its packaging (mica-build-env `RULES.md` at the release
`locks/pins/mica-build-env.pin` names: consumers own their scripts). The scripts started
as mica-build-env c076e24 `deb/` and are this repository's from then on.

| File | Runs | Does |
| --- | --- | --- |
| `producers.sh` | host | discovers the producers: every directory with `producer.env` + `Dockerfile` |
| `build.sh` | host, packs in the mica-build-env `base` image at the target architecture | one producer's archives for one architecture into `_out/debs/<arch>/pool` |
| `pack.sh` | inside the build, as the `packer` context | one `.deb` from a staged tree |
| `preflight.sh` | host | every missing producer input at once, before `make pool` |
| `repo.sh` | host, in the mica-build-env `base` image | `Packages`, `SHA256SUMS`, `manifest.txt` for a pool |
| `package-gate.sh` | host, in the mica-build-env `base` image | the pool gates of `RULES.md` section 6, including a byte-identical rebuild |
| `package-inputs.sh` | host | a producer's inputs hash at one architecture, the `mica.inputs` of its pool layers |
| `version-guard.sh` | CI, after `make pool` (every board, and the one board of a release) | a board's pool against its latest release: an unchanged version has unchanged inputs and the published bytes, a version never goes back |
| `publish.sh` | CI release job | the release's board's `<registry>/<repository>:pool.<board>.<arch>.<YYYYMMDD-HHMM>`, a release-independent manifest |
| `registry.sh`, `registry.env`, `oci.sh`, `control-fields.py` | sourced / host | the registry, the release a checkout is, the OCI client, control fields without dpkg |

Images come only from `tools/from.sh`, out of `locks/mica-build-env.lock`: the
build-env images by name, third-party images by their upstream rows.

## `producer.env`

Plain `KEY=value`: no logic, no command substitution.

| Key | Required | Meaning |
| --- | --- | --- |
| `PACKAGES` | yes | the Debian packages this producer emits |
| `ARCHES` | yes | `amd64`, `arm64`, or `all` (architecture-independent, a member of every pool; not mixed with an architecture) |
| `ENABLEMENT` | yes | `<package>=<count>` of `multi-user.target.wants` links each package ships; the gate holds it |
| `BUILD_CONTEXTS` | no | `<name>=<repository-relative path>`, passed as `--build-context` |
| `FROM_IMAGES` | no | `<build-arg>=<IMAGE_ key>` further bases; `MICA_BUILD_BASE` (the packer) is always supplied |
| `BUILD_ARGS` | no | extra `<name>=<value>` build arguments |
| `PREPARE` | no | a script beside `producer.env`, run on the host first; what it leaves in `MICA_DEB_STAGE` is the `bin` context |
| `PREPARE_INPUTS` | with `PREPARE` | what the hook builds from, for the inputs hash: repository-relative paths and `image:<upstream name>` |
| `PREFLIGHT` | no | `1` when that hook honours `MICA_DEB_PREFLIGHT=1` (check inputs, build nothing) |
| `FOR_EACH` | no | a repository-relative glob of `KEY=value` files: one instance per match, named `<producer>@<directory>`; the file's assignments are set when `producer.env` is read (`boards/*/board.env` for the board and kernel producers) |
| `CONTROL_DIR` | no | where the control templates are; default `<producer dir>/control` |

The Dockerfile declares `ARG MICA_BUILD_BASE`, `FROM ${MICA_BUILD_BASE} AS pack`,
copies `pack.sh` from the `packer` context and runs it once per package with
`MICA_DEB_VERSION`, `MICA_DEB_ARCH`, `SOURCE_DATE_EPOCH` and
`MICA_DEB_SOURCE_REPO`; the control template carries `@VERSION@` and `@ARCH@`
and neither `Installed-Size` nor `Mica-Source-Repo`, which the packer writes.
No package carries a commit (`Mica-Source-Commit` is refused).

## Versions

A package is locked by its declared version
(`mica:docs/decisions/2026-09-15-package-versions.md`): a release never changes
it. Each producer declares one version for its packages in `version.env` beside
its control templates -- `<producer dir>/version.env`, or
`boards/<board>/package/version.env` for the board producer, so each board's
package moves on its own:

    VERSION=0.1.0-1
    SOURCE_DATE_EPOCH=1789430400

`<upstream>-<revision>`, with no commit, date, release or `.dirty` stamp and no
epoch; `SOURCE_DATE_EPOCH` is bumped with it. A control template pins a package
of its own producer as `(= @VERSION@)` and a package of another producer by that
package's literal version, so bumping a dependency edits its dependents'
templates and bumps them too (the gate holds every exact pin to the pool). A packaging-only change bumps the
revision; a change of what the package ships from upstream or source bumps the
upstream part and resets the revision.

`package-inputs.sh` hashes what determines a producer's bytes (its directory,
control templates, `version.env`, the instance file, what its Dockerfile copies
from its build contexts, `PREPARE_INPUTS`, `build.sh`, `pack.sh`,
`producers.sh`; not the build-env image digests), recorded on each pool layer
as `mica.inputs`. `version-guard.sh` compares every package of a board with the
board's latest release: the same version must come with the same inputs
("inputs of <package> changed without a version bump") and build to the
published bytes; a higher version is built; a lower one is refused. Its pool
manifest carrying only `mica.source-repo` and `mica.arch`, a release in which no
package was bumped publishes the same pool digest under its new tag. The first
release under these rules, whose predecessor's layers carry no `mica.inputs`,
builds and publishes everything.
