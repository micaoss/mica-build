# Rootfs package manifests

This directory decides **what** a rootfs contains. It does not build anything,
install anything or start anything: the resolver (`src/cli.ts resolve`, `src/rootfs/resolve.ts`) reads the manifests here
and prints the exact package set the composer installs with dpkg.

## Manifest format

Plain text, **one package name per line**. `#` starts a comment and runs to end
of line; blank lines are ignored. There is no logic, no conditional, no
include and no variable: a manifest is a list, and everything that decides
which lists are read is an argument to the resolver.

A line naming a package that no pin imports is refused by name.
`bash bin/bun.sh src/cli.ts pool rows` is the only authority on which packages
exist, and the resolver reads it at run time rather than carrying a copy.

A feature may add no package: `micad` and `ui` select mica-core's core
components, which are not installed into the root but composed over it at boot;
the product build selects them by the same feature names
(`src/image/core-components.ts`).

## Families

The filename is what selects a manifest. The supported families are below; a file belonging to
none of them is refused rather than ignored — a manifest nothing reads is a
package set that never reaches an image and never fails a build either.

| File | Where | Read when |
| --- | --- | --- |
| `common.pkgs` | here | always |
| `init-<init>.pkgs` | here | the product's `INIT` (`--init`, `systemd` by default): the init's packages from the Base release |
| `engine-<engine>.pkgs` | here | `--features` names `containers`: the product's `CONTAINER_ENGINE` (`--engine`, `podman` by default), its container engine's packages; a set holding both mica-podman and mica-docker is refused |
| `storage-<storage>.pkgs` | here | the board's `BOARD_STORAGE` (`--storage`, `gpt` by default): the storage model's packages; a package that stands in for others (mica-storage-ubi for e2fsprogs and fdisk) takes their place in the resolution |
| `radio-<radio>.pkgs` | here | `--features` names `<radio>` |
| `feature-<feature>.pkgs` | here | `--features` names `<feature>` |
| `board.pkgs` | the board bundle | always; the board package |
| `radio-<radio>.pkgs` | the board bundle | `--features` names `<radio>`; adds the board's transport packages |
| `component-<component>.pkgs` | the board bundle | explicitly named in `--components`; default-off |

The board's manifests live in its directory (`boards/<board>/manifests/`)
and reach this tree inside the board bundle, under `_out/boards/<board>/manifests/`
after `make board-fetch BOARD=<board>`; `--board-dir` names that directory. A
`board-*.pkgs` or `component-*.pkgs` in this directory is refused: what a board
installs travels with the board.

The `--features` tokens are the `feature-*.pkgs` basenames plus the
`radio-*.pkgs` basenames: each radio is its own token, so a product naming
`bluetooth` and not `wifi` carries Bluetooth alone, and vice versa. There is no
umbrella `radios` token. A radio and a feature sharing one name is refused as
ambiguous.

`radio-wifi.pkgs` names both `mica-wifi` and `mica-wifi-ap`: the radio name
`wifi` means the station **and** the access point, because a board declares that
it has the radio, not which of the two modes it will be asked to run.

## The resolver

```sh
bash bin/bun.sh src/cli.ts resolve \
    --board cx3576 --board-dir _out/boards/cx3576/manifests \
    --features "micad mqtt containers wifi bluetooth" --init systemd --engine podman
```

`--board` and `--features` are required; `--features ""` is how a build says
"none", and `--components`, `--init` and `--engine` are optional; `--engine` only with `containers`. Output is one package name per line, `LC_ALL=C` sorted and
deduplicated, so two runs over one set of inputs are byte-identical and a diff
of two resolutions is a diff of the images.

**Every input is an argument and none is re-derived.** The resolver does not
read `_out/boards/<board>/board.env` or the environment. `src/rootfs/build.ts`
reads the product (`boards/<board>/products/<variant>/product.env`) and hands
its board, features, init and components to the resolver. The composer owns
the decisions; this directory owns the manifest set.

### Refusals

Each has its own message, naming what was wrong and what the legal values are:

- an unknown name in `--features`, a `--board-dir` with no `board.pkgs`;
- an `--engine` no `engine-<engine>.pkgs` installs, one given without `containers`, and a set
  carrying both mica-podman and mica-docker;
- a manifest line naming a package no producer declares;
- a manifest line naming more than one package;
- a manifest whose filename belongs to no family;
- an empty resolution, or one with no board package.

`tests/gates/rootfs-manifest.test.ts` (`make os-rootfs-manifest-test`) drives all of
them, proves each red by perturbing a **copy** of this directory under `tmp/`,
and asserts the reverse direction: every package every producer declares is
reachable by some legal resolution.

The image profile selects no package: a dev and a prod image of one product
install the same set.

## Optional board components

A product's `COMPONENTS="bm201-front-panel mqtt-reference"` selects those
component packages of its board bundle; an empty list selects none. The
resolver takes the same space-separated list as `--components`. An unknown
component or one belonging to another board is refused.
