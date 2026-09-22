# The build harness

The Bun driver produces current signed file deployments. Run it from any working
directory through `bash bin/bun.sh src/cli.ts <command>`; paths supplied to
producer CLIs resolve from the repository root. `src/cli.ts test` refuses a test
selection that runs zero tests; `bun run typecheck` and `bun run lint` are the
package's other gates.

## Modes and tool ownership

| Mode | Entry | Purpose |
| --- | --- | --- |
| default | `bun test` in `build/` | Producer, contract and tool integration tests |
| `--components` | `src/component-cli.ts` | Root, kernel/support, firmware, deployment, complete image, archive and offline firmware maintenance |
| `--release` | `src/release-cli.ts` | Independent-artifact release directory and publication gate |
| `--build-rootfs` | `src/stages-cli.ts` | Ordered root composition stages |
| `--compare-roots` | `src/compare-roots-cli.ts` | Explain two root filesystem outputs |

`MICA_BUILD_BUN` selects an explicit Bun executable. `MICA_BUILD_CONTAINER=1`
selects the digest-pinned Bun/Docker CLI image. Selecting both is refused.
Without either override, an available host Bun is used; otherwise the wrapper
uses its pinned container. Compiler and filesystem-tool ownership remains with
the declared toolsets; choosing a host Bun does not authorize a host compiler.

`src/toolbox.ts` passes argument arrays, captures stdout/stderr and provides
`run` and fail-loud `must` operations. `src/images.ts` resolves references through
`tools/from.sh`; it does not maintain another pin table. The toolbox container
needs the host Docker socket only when it orchestrates another scoped container.

Docker bind sources are host paths. `/srv/mica` is identical inside this workspace
and on the host; `/work` and `/root` aliases need translation. Keep scratch under
the project so sibling containers see the same files. Mount the narrowest needed
paths and use read-only mounts for inputs that are not modified.

## Current contract tests

| Test source under `src/image/` | Boundary exercised |
| --- | --- |
| `components.test.ts` | Canonical signed descriptors, stable identities, exact fields, board/architecture, verity geometry, public anchors, running-kernel/support association |
| `component-build.test.ts` | Root/support verity and detached signatures, module release, unchanged component bytes, stale output and forbidden kernel payload in userspace root |
| `component-archive.test.ts` | `MICAUPD1`, deduplication, lengths and digest refusal before publication |
| `file-layout.test.ts` | Exact three-partition board geometry and capacities |
| `fit-environment.test.ts` | Fixed redundant records, CRC, sequence wrap, attempt bounds and recovery selection |
| `firmware.test.ts` | Independent firmware identity, fixed destination and bounded loader range |
| `firmware-maintenance.test.ts` | Signed previous/candidate packages, recovery location, readback and scoped writes |
| `seed-data.test.ts` | Bounded current DATA fixture inputs, safe state paths and unit enabling |
| `release-manifest.test.ts` | Complete release file set, source/inventory records, signed update/firmware verification, channel and evidence restrictions, documented CLI verification |
| `stages.test.ts` | Ordered Dockerfile composition, argument ownership and recorded inputs |
| `pin-seeded-times.test.ts`, `compare-roots.test.ts` | Filesystem reproducibility and attributed differences |
| `toolbox.test.ts`, `images.test.ts`, `paths.test.ts`, `verify-package.test.ts` | Tool routing, immutable image references, repository anchors and observable failures |
| `tools/*.test.ts` | Actual filesystem tool behavior and refusal handling |

Tests use current descriptors and complete-image geometry. Removed raw-slot,
GRUB and RAUC producers have no invocation mode or compatibility fixture here.
BSP-only vendor bootloader packaging is outside the current Mica OS image contract.

## Tool facts that affect correctness

- `debugfs` can return exit status zero after a command-level error. Callers
  inspect its result and read back created files rather than treating zero alone
  as proof. The DATA seeder refuses nonregular/symlinked parent paths before
  writing, then validates the final filesystem before publishing the image.
- `sgdisk` alignment can relocate small partitions. The image assembler pins
  sectors explicitly and reads back primary/backup GPT geometry and identities.
- `mkfs.vfat` options alone do not prove the generated filesystem geometry. The
  verifier reads the actual FAT/ESP and boot entries.
- ext4 quota metadata needs a clean `e2fsck` pass after seeded creation. Factory
  assembly pins seeded timestamps after construction and verifies a clean image.
- `touch -h` changes a symlink's timestamp; it cannot create an absent seed.
  Seed files, symlinks and directories have separate construction operations.
- The verity image is measured in data blocks and hash-tree geometry. The kernel
  requires its detached root-hash signature; an ordinary SHA-256 checksum is not
  a substitute. The negative matrix includes modified and unsigned content.

## Complete-image and failure acceptance

Unit/tool tests do not establish a boot result. The current integration surfaces
are:

| Harness | Evidence |
| --- | --- |
| `bin/bun.sh src/cli.ts verify` | Signed current image, GPT, filesystem, object, firmware receipt and packed-root checks |
| `tests/suites/lifecycle-uefi/runtime-build.sh` | Fresh complete image using the production root with explicit acceptance services |
| `tests/suites/lifecycle-uefi/updates.sh` | Root/kernel/combined updates, failed-health trial exhaustion, confirmation and unchanged firmware |
| `tests/suites/lifecycle-uefi/faults.sh` | Read-only persistence refusal, corrupt descriptor trials, exhausted records and shared storage failure |
| `tests/suites/lifecycle-uefi/confirmed-fault.sh` | Corruption of a previously confirmed descriptor and retained fallback |
| `tests/suites/lifecycle-uefi/kernel-faults.sh` | Three kernel panics or watchdog resets, persisted attempts and healthy fallback |
| `tests/suites/lifecycle-uefi/early-hang-init.sh`, `early-hang.sh` | Isolated signed fault variant hangs after watchdog activation and before SYSTEM/systemd; QMP proves reset |
| `tests/suites/lifecycle-uefi/seed-refusals.ts` | Actual DATA path refusals preserve the complete image hash |
| `mica-core:scripts/gate/file-ab-faults/run.sh` | Native transaction IO interruption and ENOSPC at observed install/confirm/GC boundaries (runs in `micaoss/mica-core`) |
| `tests/suites/lifecycle-uboot-fit/records.sh`, `firmware-io.sh` | Actual fixed firmware record parser and persistence-before-load behavior under sanitizers |
| `tests/suites/lifecycle-uboot-fit/signatures.sh` | Required FIT signature acceptance and missing/unknown/modified signature refusal |
| `tests/suites/apid-api/run.sh` | HTTPS API, authentication, native lifecycle, reset and network acceptance against a fresh complete guest |

The runtime harness also verifies readonly var parents, DATA leaf binds, identity,
quota byte/inode containment, native service receipts, firmware readback and clean
exitrd shutdown. Storage measurements report guest block counters around an
install; they do not measure physical flash amplification. Large-root measurements
separate early-init process RSS from host time through full runtime acceptance.

QEMU can prove only its emulated firmware/device behavior. cx3576 storage power
cuts, hardware watchdog coverage, RockUSB maintenance and peripheral behavior
require the named physical board and recorded interfaces.

## Run and interpret

```bash
make os-build-test
make os-verify-test
make os-release-verify-test
make os-fit-records-test
make file-transaction-faults      # in micaoss/mica-core
make docs-verify
```

Run only the relevant gate while developing, then run the affected complete suite.
For direct Bun filters, start in `build/` and use `./src/FILE.test.ts`; invoking a
package test from the repository root can make discovery traverse generated
outputs. Record the exact image/component IDs, command, logs and exit status.
A missing tool, unavailable image or zero executed tests is a failure to obtain
evidence, not a skipped success.
