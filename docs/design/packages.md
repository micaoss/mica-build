# Debian packaging, the package gate and the pool publisher

The generic rules are implemented once, by mica-build-tools at the commit
`locks/mica-build-tools.pin` names (`bin/mica-tools`, and the library
`@mica/build-tools`): the packer, the inputs hash, the archive reader, the
Debian version order and the OCI client. What is here is this repository's own:
its producers, their build, its gates and its scoped board releases.

| File | Runs | Does |
| --- | --- | --- |
| `src/pool/producers.ts` (`bun src/cli.ts producers`) | host | discovers the producers: every directory with `producer.env` + `Dockerfile`; their declared version and their inputs hash |
| `src/pool/build.ts` (`pool-build`) | host, packs in the mica-build-env `base` image at the target architecture | one producer's archives for one architecture into `_out/debs/<arch>/pool` |
| mica-build-tools `deb pack` | inside the build, as the `tooling` context | one `.deb` from a staged tree (its design 3.3.2) |
| `src/pool/preflight.ts` (`pool-preflight`) | host | every missing producer input at once, before `make board-pool` |
| `src/pool/gate.ts` (`pool-gate`) | host | the package gates, including a byte-identical rebuild |
| `src/pool/version-guard.ts` (`version-guard`) | CI, after `make board-pool` (every board, and the one board of a release) | a board's pool against its latest release: an unchanged version has unchanged inputs and the published bytes, a version never goes back |
| `src/pool/publish.ts` (`pool-publish`) | CI release job | the release's board's `<registry>/<repository>:pool.<board>.<arch>.<YYYYMMDD-HHMM>`, a release-independent manifest |
| `src/pool/registry.ts`, `src/pool/registry.env` | host | the registry declaration, the token, the release a checkout is, the latest published lock |

Images come only from `bin/mica-tools from` (and `src/locks/inputs.ts` in the
engine), out of `locks/mica-build-env.lock`: the build-env images by name,
third-party images by their upstream rows.

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
| `PREFLIGHT` | no | `1` when that hook honours `MICA_DEB_PREFLIGHT=1` (check inputs, build nothing) |
| `FOR_EACH` | no | a repository-relative glob of `KEY=value` files: one instance per match, named `<producer>@<directory>`; the file's assignments are set when `producer.env` is read (`boards/*/board.env` for the board producer) |
| `CONTROL_DIR` | no | where the control templates are; default `<producer dir>/control` |

The Dockerfile declares `ARG MICA_BUILD_BASE`, `FROM ${MICA_BUILD_BASE} AS pack`,
copies `src/` of the `tooling` context and runs
`bun /tooling/src/cli.ts deb pack --root <tree> --control <template> --arch "$MICA_DEB_ARCH" --out /out`
once per package, with `SOURCE_DATE_EPOCH` and `MICA_DEB_SOURCE_REPO` declared
as `ARG`s. The template carries `@ARCH@` and neither `Installed-Size` nor
`Mica-Source-Repo`, which the packer writes; a `${shlibs:Depends}` is expanded
by the caller's `--substitute`. No package carries a commit.

## Versions and inputs

A package is locked by its declared version: a release never changes it. Each producer declares one version for its packages in its control
templates, the same in every template of one producer:

    Version: 0.0.1-1
    Source-Date-Epoch: 1789430400

`<upstream>-<revision>`, with no commit, date, release or `.dirty` stamp;
`Source-Date-Epoch` is bumped with it and is never later than the build. A
control template pins a package of another producer by that package's literal
version, so bumping a dependency edits its dependents' templates and bumps them
too (the gate holds every exact pin to the pool). A packaging-only change bumps
the revision; a change of what the package ships from upstream or source bumps
the upstream part and resets the revision.

Each producer declares what determines its bytes in `mica-inputs` (mica-build-tools
design 3.3.1) beside its control templates -- the producer directory, or
`boards/<board>/package/` for an instance of the board producer -- whose own
directory is always an input: the packages, the `path`s outside it (the
producer directory of an instance, the instance file, what its Dockerfile
copies from its build contexts, what a `PREPARE` hook builds from) and the
upstream `image`s. Its hash is recorded on each pool layer as `mica.inputs`.
`version-guard` compares every package of a board with the board's latest
release: the same version must come with the same inputs ("inputs of <package>
changed without a version bump") and build to the published bytes; a higher
version is built; a lower one is refused. Its pool manifest carrying only
`mica.source-repo` and `mica.arch`, a release in which no package was bumped
publishes the same pool digest under its new tag.
