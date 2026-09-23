# Rootfs package manifests

This directory decides **what** a rootfs contains. It does not build anything,
install anything or start anything: the resolver (`src/cli.ts resolve`, `src/rootfs/resolve.ts`) reads the manifests here
and prints the exact package set the composer hands to APT.

## Manifest format

Plain text, **one package name per line**. `#` starts a comment and runs to end
of line; blank lines are ignored. There is no logic, no conditional, no
include and no variable: a manifest is a list, and everything that decides
which lists are read is an argument to the resolver.

A line naming a package that no pin imports is refused by name.
`bash bin/bun.sh src/cli.ts pool rows` is the only authority on which packages
exist, and the resolver reads it at run time rather than carrying a copy.

## Families

The filename is what selects a manifest. The supported families are below; a file belonging to
none of them is refused rather than ignored — a manifest nothing reads is a
package set that never reaches an image and never fails a build either.

| File | Where | Read when |
| --- | --- | --- |
| `common.pkgs` | here | always |
| `radio-<radio>.pkgs` | here | `--radios` names `<radio>` and `--without` does **not** |
| `feature-<feature>.pkgs` | here | `--without` does **not** name `<feature>` |
| `board.pkgs` | the board bundle | always; the board package |
| `radio-<radio>.pkgs` | the board bundle | selected board and non-declined radio; adds the board's transport packages |
| `component-<component>.pkgs` | the board bundle | explicitly named in `--components`; default-off |

The board's manifests live in its directory (`boards/<board>/manifests/`)
and reach this tree inside the board bundle, under `_out/boards/<board>/manifests/`
after `make board-fetch BOARD=<board>`; `--board-dir` names that directory. A
`board-*.pkgs` or `component-*.pkgs` in this directory is refused: what a board
installs travels with the board.

The `--without` tokens are the `feature-*.pkgs` basenames plus the
`radio-*.pkgs` basenames: each radio is its own decline token, so
`MICA_ROOTFS_WITHOUT=bluetooth` keeps Wi-Fi and vice versa. There is no
umbrella `radios` token -- `--radios` is the board's statement of which radios
the hardware has, `--without <radio>` is the build's decision to leave one out
anyway, and the two compose per radio. A radio and a feature sharing one name
is refused as ambiguous.

`radio-wifi.pkgs` names both `mica-wifi` and `mica-wifi-ap` because the single
radio name `wifi` has always meant `wpasupplicant` **and** `hostapd`: a board
declares that it has the radio, not which of station and access-point mode it
will be asked to run.

## The resolver

```sh
bash bin/bun.sh src/cli.ts resolve \
    --board cx3576 --board-dir _out/boards/cx3576/manifests \
    --features "micad mqtt containers wifi bluetooth"
```

`--board` and `--features` are required; `--features ""` is how a build says
"none", and `--components` is optional. Output is one package name per line, `LC_ALL=C` sorted and
deduplicated, so two runs over one set of inputs are byte-identical and a diff
of two resolutions is a diff of the images.

**Every input is an argument and none is re-derived.** The resolver does not
read `_out/boards/<board>/board.env`, or
`WITH_MICAD` / `WITH_CONTAINERS` / `MICA_ROOTFS_WITHOUT` from the
environment. `rootfs/build.sh` already owns every one of those decisions —
which board file is read, which environment variable beats which file, how the
historical `WITH_*` spellings fold into one decline list. A second copy of that
logic here is the second table this repository keeps deleting, and the two would
disagree about a build the day either changed. The driver owns the decisions;
this directory owns the manifest set.

### Refusals

Each has its own message, naming what was wrong and what the legal values are:

- an unknown feature in `--without` or `--radios` entry, a `--board-dir` with no `board.pkgs`;
- a manifest line naming a package no producer declares;
- a manifest line naming more than one package;
- a manifest whose filename belongs to no family;
- an empty resolution, or one with no board package.

`tests/gates/rootfs-manifest-test.sh` (`make os-rootfs-manifest-test`) drives all of
them, proves each red by perturbing a **copy** of this directory under `tmp/`,
and asserts the reverse direction: every package every producer declares is
reachable by some legal resolution.

The image profile selects no package: a dev and a prod image of one product
install the same set.

## Optional board components

`MICA_ROOTFS_COMPONENTS="bm201-front-panel mqtt-reference" MICA_BOARD=s905x5m
bash rootfs/build.sh` selects those component packages. Leave the variable
unset to omit both. The resolver accepts the same space-separated list as
`--components`. An unknown component or one belonging to another board is
refused.
