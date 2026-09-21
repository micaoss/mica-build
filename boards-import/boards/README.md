# Boards

A board is one directory under `boards/` that carries its whole build: the
board definition, the kernel and U-Boot builds with their upstream source
pins, the package inputs, the evidence and the board's tests. Nothing of a
board's build lives in another board; what every board takes identically
comes from the top-level `common/`. `tools/new-board.sh <new> --from
<nearest>` copies a board, build included, and the copy is then the new
board's own. `tests/board-contract-test.sh` holds every board to this layout.

`boards/boards.tsv` lists the supported boards, one row per board, for this
repository's tools and for consumers (`tools/boards.sh`); a board directory is
supported only when listed. After the header line `# mica-boards boards v1`,
tab-separated and sorted by board:

```
<board>	<arch>	<boot backend>          the directory boards/<board>/, its MICA_ARCH and BOOT_BACKEND
```

What a release of a board outputs is the board's own `boards/<board>/outputs.tsv`,
which travels in its board component; a release must output exactly what it
names. After the header line `# mica-boards board outputs v1`, tab-separated rows
sorted by kind (package, file), then value:

```
package	<package>                  an archive of its pool, pool.<board>.<arch>.<release>
file	<component>	<path>           a file of one component artifact, <component>.<board>.<release>, by its
                                   path in the assembled board tree: board (board.env, evidence.json, images.tsv, manifests/,
                                   outputs.tsv, trust/), kernel (kernel/), uboot (uboot/, uboot-package/),
                                   firmware (firmware/, component-copyright)
```

```
boards/<board>/
  board.env             the board definition: BOARD_FEATURES, MICA_ARCH, the boot backend, ...
  images.tsv            what the board is flashed and updated with: image|update <kind> <packer> <runtime image> <suffix>
                        (image disk builtin and update full mandatory; builtin rows name - as runtime image)
  outputs.tsv           what a release of the board outputs: its pool's packages and each component's files
  Makefile              sets BOARD; the kernel and firmware targets and the board's own (flashing, a recovery package, a userland bridge)
  bsp.env               FIT boards: what the builds take (KERNEL_EXPECT, KERNEL_CONFIG, KERNEL_DTB, KERNEL_DTB_ARTIFACT, UBOOT_DEFCONFIG, DDR_BLOB, BL31_BLOB, KERNEL_FRAGMENTS)
  kernel/
    Dockerfile          the kernel build; context = the board directory (FIT) or kernel/ (UEFI)
    Dockerfile.dockerignore
    configure.sh        FIT: the resolved configuration and its floor
    build.sh            FIT: the compile and the artefacts
    config/             the committed configuration and fragments -- NOT the same kind of file on
                        both families; see *Which file says how a kernel was configured*
    dts/, patches/      FIT: device tree and patches (with a series file)
    hooks/              FIT: the board's hooks (below)
  loader/
    Dockerfile          FIT: the U-Boot build; context = loader/
    ...                 the loader policy: build scripts, patches, tests, vendor loader
  manifests/, package/, firmware/, evidence.json, tests/, extras/
```

## The kernel command line and the image profile

The product's image profile is one `mica.profile=dev|prod` token on the signed
kernel command line, written for both profiles (mica docs decision
2026-09-14-no-image-profile-packages).

- **FIT boards (cx3576, s905x5m).** The kernel forces its built-in command line
  (`CONFIG_CMDLINE_FORCE=y`), so the token is built into the kernel: `make
  kernel` builds one kernel per profile, each with `CONFIG_CMDLINE` =
  `BOARD_CMDLINE_ARGS` + ` mica.profile=<profile>` (exactly one token;
  `common/kernel/set-profile.sh` sets it and refuses a board line that already
  names `mica.profile` or `mica.recovery`), into `_out/<board>/kernel/dev/` and
  `_out/<board>/kernel/prod/`, from one compile: dev is built whole and prod only
  relinks the Image in the same tree, with the modules, device tree and
  regulatory certificates of that build (none reads the command line).
  `make kernel-profile-test` builds prod alone, clean, and requires every file
  to be byte-identical to the relinked one. The board's kernel component carries both as
  `kernel/dev/` and `kernel/prod/`, each a complete kernel
  directory (Image, device tree, config, System.map, kernel.release,
  modules.tar, regdb-certs.pem); the assembly takes `kernel/<profile>/` for a
  product. Each profile's kernel is reproducible on its own.
  **Enforced:** U-Boot carries the FIT public key in its control DTB with
  `required = "conf"` (`common/uboot/embed-fit-trust.sh`) and is built with
  `FIT_SIGNATURE` (cx3576 also `FIT_FULL_CHECK`) and without
  `LEGACY_IMAGE_FORMAT`, `CMD_BOOTI` and `USE_PREBOOT` (`loader/build-mica.sh`),
  so its boot command boots only a FIT whose signed configuration verifies, and
  the kernel ignores any bootloader-supplied arguments: on the boot path the
  command line, profile token included, cannot be replaced by an unsigned image.
  **Not enforced against console access:** both U-Boots keep an interactive
  console (`BOOTDELAY=1`, `CMDLINE`) with `fdt`, `md`/`mw` (and `go` on
  cx3576), so someone at the serial console can alter the in-memory control DTB
  or run an unsigned binary; the same U-Boot serves both profiles. Also not
  covered: verification of U-Boot itself by the SoC boot ROM, which this
  repository does not enable or assert.
- **UEFI boards (uefi-x64, uefi-arm64).** The kernel has no built-in command line
  (`CONFIG_CMDLINE=""`) and the kernel component carries one `kernel/`. The assembly signs
  the UKI with `.cmdline` = `BOARD_CMDLINE_ARGS` + the profile token; whether a
  modified UKI is refused depends on UEFI Secure Boot, which is the assembly's
  and the platform's (mica-build).

## Which file says how a kernel was configured

**The committed `kernel/config/` is not the same kind of file on the two
families, and nothing about reading one tells you which kind you have.** Both
parse, both carry the symbols, and the answers usually agree -- two
repositories read these on 2026-09-20 to ask whether `CONFIG_MEMCG` was
present at the pinned releases, one correctly and one not, and both got `y`.

- **UEFI boards: the committed file is the RESOLVED OUTPUT.**
  `kernel/config/<board>.config` is what `olddefconfig` produced, recorded, and
  the `gate` stage of the kernel Dockerfile refuses a build whose resolution
  differs from it. Reading it in the tree answers what the kernel has.
- **FIT boards: the committed file is a VENDOR INPUT.**
  `kernel/config/kernel-<soc>.config` is the vendor's configuration, over which
  the build merges `common/kernel/mica-required.fragment` and the board
  fragments before `olddefconfig` resolves the result. **Reading it does not
  say what the kernel has** -- the floor is merged after it, and a symbol it
  sets can be overridden, dropped for unmet dependencies, or turned back on by
  a `select`.

**For a FIT board the answer is in the published component**: `kernel/dev/config`
and `kernel/prod/config` of `kernel.<board>.<release>`, at the digest that
board's release lock names. The resolved configuration is an artefact
precisely so that this question has an answer outside the builder.

**The profile axis exists only on the FIT boards.** uefi-x64 and uefi-arm64
publish one `kernel/config`; cx3576 and s905x5m publish `kernel/dev/config`
and `kernel/prod/config`. So four boards have **six** configurations, and the
two cells a four-by-two grid would leave blank do not exist rather than having
been missed.

**And the field that makes reading one profile feel safe is the field that
matches.** Measured on the published `kernel.cx3576.20260920-1536`: of the
seven files in each profile directory, `Image`, `System.map` and `config`
differ between dev and prod, while `kernel.release`, `modules.tar`,
`regdb-certs.pem` and the device tree are **byte-identical** -- one source
compiled once, relinked with a different command line. A check that compares
`kernel.release` across the two profiles compares the one field that cannot
tell them apart.

`common/` is what every board takes unchanged:

```
common/
  scripts/   fetch-source.sh, apply-patches.sh, buildx.sh (the builders' shared steps);
             buildx.sh (docker buildx build, with the CI cache of a build's third-party prefix stage)
  kernel/    mica-required.fragment (the shared kernel floor), floor-check.sh (the floor, asserted after olddefconfig),
             kernel-config-test.sh (the committed configs against it), export-regdb-certs.py (the regulatory
             database certificates the kernel trusts), mklogo.py (the boot-logo renderer); the kernel builds' `mica-common` context
  uboot/     mica-records.h (the signed-boot record format), embed-fit-trust.sh (the FIT trust into the control DTB);
             the U-Boot builds' `mica-common` context
  trust/     stage.sh with stage-inner.sh: validates a public certificate bundle (PEM certificates only, no private key,
             parseable by OpenSSL) and stages it as the `mica-trust` / `mica-boot-trust` context; VERITY_TRUST_CERT and
             FIT_TRUST_CERT are the only trust inputs
  package/   fstab.in and copyright, the board package render and copyright fallback (the producers' `common` context)
```

Each board's copy of its build is its own: the two UEFI boards (uefi-x64,
uefi-arm64) carry the same kernel Dockerfile today, and no check holds the
copies identical -- a change to one board's build is that board's change.
The prefix stage of every kernel and U-Boot Dockerfile (`source`, the UEFI
`src`) holds only the toolchain and the upstream source; CI caches that stage
alone (`common/scripts/buildx.sh`).

## The hooks

A FIT board's kernel build calls these scripts from its `kernel/hooks/` when
they exist. Each receives the source tree first; CROSS_COMPILE is in the
environment where the build sets it.

| Hook | When | Arguments | For |
|---|---|---|---|
| `prepare.sh` | after the patches, before the configuration | `<src> <board-dir> <common/kernel>` | what a board derives into the tree (cx3576 renders its boot logo) |
| `configure.sh` | after `LOCALVERSION_AUTO` is disabled, before the floor is merged | `<src>` | the board's `scripts/config` edits |
| `assert.sh` | after `olddefconfig` and the shared floor check | `<src>` (s905x5m: `<src> <config-dir>`) | the board's own required and refused options |
| `verify.sh` | after the build and the device tree | `<src> <dtb>` | source and device-tree assertions |
| `modules.sh` (s905x5m) | after the in-tree modules are installed, before depmod | `<src> <install-root> <board-dir>` | the board's out-of-tree modules |
| `modules-verify.sh` (s905x5m) | after depmod | `<module-dir>` | the indexed set carries them once |

The artefacts are reproducible (`KBUILD_BUILD_*` and `SOURCE_DATE_EPOCH` are
pinned, and the kernel and U-Boot builders take their toolchain from the
digest-pinned mica-build-env `bsp` image of `locks/mica-build-env.lock` rather
than installing it): the proof of a change to a board's build is its kernel and U-Boot
byte-identical to the build before it, where the change was not meant to move
them.

## The boot logo and tty1

`BOARD_BOOT_LOGO=1` is one switch behind five artefacts that move together
(`tests/board-contract-test.sh`, with the refusals exercised over synthetic
boards in `tests/logo-equivalence-fixtures.sh`): `CONFIG_LOGO` and
`CONFIG_LOGO_LINUX_CLUT224` in the board's fragments, the `mklogo.py` render
where the board renders one, `fbcon=logo-pos:center,logo-count:1` with
`vt.global_cursor_default=0` in `BOARD_CMDLINE_ARGS`, the logind drop-in,
and `/etc/systemd/system/getty@tty1.service` as a symlink to `/dev/null`.

**The mask and the preset are not the same rule, and the mask is the stronger
one.** A preset decides whether a unit is ENABLED; the mask decides whether it
can be STARTED AT ALL, including by logind's on-demand `autovt@tty1`, which no
preset touches -- a disabled template remains startable. So if anybody ever
wants a getty on tty1 for one board, the preset would let them and the mask
will not, and the failure will look like the preset being ignored. **Enabling
tty1 means REMOVING THE MASK, not only changing the preset.**
