# The image verifier: `src/verify/`

Reads an assembled product image, and the root it packs, without touching the host, and holds them
to the board and the product they were built for. Nothing here runs on the device.

    bash bin/bun.sh src/cli.ts verify --board <board> ...     (make product-verify PRODUCT=<board>.<variant>)
    bash bin/bun.sh src/cli.ts smoke --product <board>.<variant>
    bash bin/bun.sh src/cli.ts smoke-negative --product <board>.<variant>
    bash bin/bun.sh src/cli.ts lint                           (make os-layout-lint)

Every run ends in `RESULT: PASS|FAIL (<n> checks, <k> skipped)`; a run that checked nothing is a
failure, not a pass.

## The board and the product

| Module | Does |
| --- | --- |
| `board-env.ts` | Parses `board.env` as data: never sourced, no `process.env`, every shell construct refused by name |
| `board.ts`, `board-scope.ts` | The typed board, and the shipped boards a check applies to |
| `paths.ts` | The repository paths and the fetched boards under `_out/boards/`, each ascent anchored on a marker |
| `product-env.ts` | A product's recipe `boards/<board>/products/<variant>/product.env`, for the TypeScript entry points |
| `product-conf.ts` | The product a root was composed for, read out of `/usr/lib/mica/product.conf` in the root |
| `roles.ts` | The verifier's side of the partition roles |

## Reading an image

| Module | Does |
| --- | --- |
| `image.ts` | The disk: GPT, partitions, filesystems, verity, FIT and UKI payloads, read through the tool seam |
| `file-image.ts` | The factory image: its GPT against the board's layout, the signed factory records, every object and verity tree they name, and the root each deployment runs: its core components composed over it as the runkit composes them, refused when one would shadow a file of the root or holds anything outside `/usr` and `/etc` |
| `tools.ts` | The one place that decides how an inspection tool runs: on the host, or in its pinned container |
| `elf.ts` | Enough ELF to read a build-id and the dynamic section of a file in the packed root |
| `checks-root.ts` | Path resolution inside the packed root: symlinks are followed in the root, never on the host |
| `unit-state.ts` | How systemd resolves a unit's enablement in the root (unit dirs, presets, `.wants` links) |
| `installed-packages.ts` | The package inventory the finalizer writes before dpkg's database is removed |

## The checks

`checks.ts` registers every check; `checksFor` selects the ones a board applies to, and a check
that names features or an init (`features`, `init: 'systemd' | 'openrc'`) runs only over a product
that selected them -- a check of systemd's units is not run over an OpenRC root, and is reported
`NOT RUN` with what it needs.
Each family is its own module (`checks-*.ts`): the file root, D-Bus policies, the console, the
container engine, the Wi-Fi reconciler contract, MQTT, the firewall tool, the time policy, the
shadow file, BusyBox and the hardware database. A check returns a verdict (`verdict.ts`) that
names what it looked at; `checks-fixture.ts` builds the small roots their tests run against.

## The smoke runs

`smoke.ts` executes the self-built artifacts of a product's factory root (`smoke-register.ts`
lists them, `smoke-pins.ts` reads the version each must report from `locks/`), natively or under
emulation, with the product's core components (extracted beside the root by the composer) bound
over it. `smoke-negative.ts` breaks the root three ways and requires each run red.

## The layout lint and the parity harness

`lint-cli.ts` checks every board's layout against the schema; `parity.ts` compares a check with the
shell oracle kept as a fixture, where there is one.
