# `verify` — the bun + TypeScript foundation for the image pipeline

A bun + TypeScript package that reads the **board definition** as data, hands
the rest of the build a typed model of it, and checks an assembled image against
that model. It has **no runtime dependencies**: `typescript` and `@types/bun`
are dev-only, and `bun test` needs neither — measured on 2026-08-25 by running
the suite with `node_modules/` moved aside.

Nothing here runs on the device. The image ships no bun.

## Everything reads `board.env`

`boards/<board>/board.env` is the single source of truth for a board —
partition geometry, `RAUC_BOOTLOADER`, `BOARD_RADIOS`, `BOARD_HWINIT_CONFS`. A
shell can read it with `.`, and that is the problem: a shell evaluates anything,
so a value of `$(...)` is not a lint finding, it is a **command that has already
run** by the time any checker looks at the result.

`src/board-env.ts` parses instead. It never touches a shell, it never consults
`process.env`, and it refuses — by name — everything that would be shell rather
than data.

### What it accepts, all of which is in a real board definition today

| shape | example, from the shipped files |
|-------|---------------------------------|
| bare | `LAYOUT_BOARD=uefi-x64` |
| double-quoted | `BOARD_CMDLINE_ARGS="console=tty0 console=ttyS0,115200 net.ifnames=0"` |
| single-quoted | nothing expands inside |
| reference | `EPHEMERAL_SIZE_MIB="${MICA_VAR_MIB}"` |
| interpolation | `BOOT_SLOT_REQUIRED_FILES="Image rk3576-src.dtb ${BOOT_SCRIPT_NAME} mica-verity-@SLOT@.env"` |
| arithmetic | `ESP_START_SECTOR=$((ESP_START_MIB * MIB_BYTES / SECTOR_SIZE))` |
| declared empty | `BOARD_FIRMWARE_FILES=""` — **not** the same as absent |
| comments | whole-line, and trailing after a value |

A `${NAME}` resolves only against a key declared **above** it in the same file,
the way a shell reading top to bottom would. The process environment is not
consulted, deliberately: a definition that resolved differently depending on
who ran the reader would not be a definition.

`$(( ))` is integer arithmetic over `+ - * / %`, parentheses and unary sign,
evaluated in **BigInt**. These are byte offsets; past 2⁵³ a double stops being
exact, and a size that is silently one byte out is the class of defect this
package exists to make visible.

### What it refuses, each with its own message

Command substitution in both spellings, backticks, every parameter-expansion
operator (`${X:-y}`, `${X#p}`, `${X/a/b}`, `${#X}`, `${!X}`), the shell special
parameters and a bare `$`, a reference to a key the file does not define,
unquoted whitespace, unquoted metacharacters `; & | < > ( )` and globs `* ? [`,
backslash escapes outside quotes, line continuations, an unterminated quote,
`export`/`unset`/`source`-style command prefixes, DOS line endings, ANSI-C
quoting, an unquoted `~`, and anything inside `$(( ))` that is not integer
arithmetic — including a division by zero, a hex literal, a leading-zero octal,
`**`, and assignment.

The unquoted `~` is refused for the opposite reason to the rest: a shell
**does** expand it on the right of an assignment (`A=~/foo` is `/root/foo`), so
reading it literally here would be a silent disagreement with every existing
consumer of these files. Quoted, it is a literal tilde and is accepted.

Every refusal names the file, the line, the column and the offending line.

**`${X:-}` is the subtle one, and refusing it is the point.** That idiom is how
every shell consumer of these files reads a key, and it is exactly what makes a
shell reader unable to tell *declared empty* from *not declared*. uefi-x64 declares
`BOARD_FIRMWARE_FILES=""` and `BOARD_HWINIT_CONFS=""` **on purpose** — a QEMU
machine has no radio firmware and no MAC to burn, and the emptiness is the
statement. Under `${X:-}` that is indistinguishable from a board that forgot
them. Here the first is `[]` and the second is `undefined`.

## The parser throws; the model does not

`src/board.ts` turns the parsed map into the shape the rest of the build reasons
about: an ordered partition set with typed geometry, the bootloader backend,
and the board lists.

- A file the parser **cannot read faithfully** is not a board definition, so
  `parseBoardEnv` throws.
- A definition it **can read and disagrees with** — a missing
  `LAYOUT_PARTITIONS`, a role no checker knows, a partition with no `PARTNUM` —
  is reported as absent or unknown and handed on.

The schema lint is a separate consumer of the model. A model that threw on the
first fault could only ever report one, and a lint whose messages came from its
data layer would say what the model noticed rather than what a board engineer
needs to read.

Keys typed as numbers whose values are not become `Board.faults` — collected,
never thrown, never dropped.

## The lint, and where it is strict

`src/lint.ts` is the board-definition schema lint: every key a role requires is
present, and no key a role does not use is present. The second direction is the
one that earns its keep — `BOOT_ATTEMPTS_DEFAULT=3` sat in the uefi-x64 layout under
a comment claiming U-Boot's contract was identical, nothing objected, and RAUC
refused the rendered configuration on the device.

It asks `declared()` — presence, answered without consulting the value —
wherever a shell tests for emptiness with `${X:-}`. That idiom gives the same
answer for a key that is **absent** and one that is **declared empty**, so every
check built on it has a spelling that walks straight through. Four of them, each
rejected here:

| mutation of a real layout | `src/lint.ts` |
|---|---|
| `ROOTFS_A_FS_UUID=""` on a `verity-slot` | reject |
| `BOOT_ATTEMPTS_DEFAULT=""` on the grub board | reject |
| `LAYOUT_PARTITIONS=" "` | reject |
| `MICA_ARCH` deleted, but exported by the caller | reject |

The last is closed one layer down — the parser never reads `process.env`.

**Strictness that is not indiscriminate.** An empty declaration the schema does
not forbid stays a *statement*: `BOARD_RADIOS=""` means this board has none, and
uefi-x64 must keep passing with all three of its empty lists. There is a test whose
only job is to hold that line, because a lint that closed the hole by failing
every empty declaration would reject the board it exists to accept.

**Absent and empty get different sentences.** "declares no ESP_FAT_VOLUME_ID"
about a file containing `ESP_FAT_VOLUME_ID=""` sends a reader looking for a line
that is already there.

## Checking the parser against `bash`

The parser can be compared against `bash` **sourcing the same file**: every key
of both shipped boards, value for value.

| board | keys | result |
|-------|------|--------|
| cx3576 | 141 | identical to `bash` on all 141 |
| uefi-x64 | 115 | identical to `bash` on all 115 |

It is **not** shipped as a test: it would mean `source`-ing a board definition to
check the thing whose entire purpose is not to, and pointed at an untrusted file
it would execute it. Re-run it by hand when the parser changes; the recipe is in
`HARNESS.md`.

## Reading an image, without touching the host

`src/image.ts` drives five tool families, and no others: **sgdisk** for the GPT,
**mtools at an offset** for the FAT boot slots, a byte range extracted out of the
image and read with **tune2fs/debugfs**, **unsquashfs** for the packed root, and
`veritysetup verify`, which walks the hash tree in userspace and never creates a
device-mapper target, never calls losetup and never mounts anything. No loop
mounts, no host mutation, no root.

`src/tools.ts` is the seam that decides where the tools come from — this host,
or the container pinned as `upstream:alpine:3.24.1`, the same key the assembler uses,
resolved through `tools/from.sh --ref`. One container per run, prepared
once, `docker exec` per call; `MICA_VERIFY_TOOLS` forces a route.

### Four of the five tools succeed at nothing

Every one of these was measured on 2026-08-25 in the pinned `alpine:3.21`, and
every one is refused rather than returned:

| tool | driven with | what it does |
|---|---|---|
| `sgdisk -p` | 64 MiB of zeros, no GPT | prints `Creating new GPT entries in memory.`, **invents a random disk GUID** — two runs on the same file gave `82861E6A-…` then `21E337DD-…` — lists no partitions, and **exits 0** |
| `sgdisk --verify` | the same file | **"No problems found."** |
| `debugfs -R "ls -p /"` | a file that is not ext4 | **exits 0**, empty stdout, `ls: Filesystem not open` on stderr |
| `unsquashfs -d D A p/not/in/it` | a path not in the archive | **exits 0** and leaves `D` empty |
| `veritysetup verify` | a wrong root hash / a non-verity file | **exit 1 for both** — one is the failing direction of the check, the other is the tool getting nowhere |
| `mcopy -n` | a file not in the slot | exit 1, `File "::/x" not found` — the one that is honest |

So no helper decides anything by exit status alone. `sgdisk` is refused by its
own admission sentence;
`debugfs` by the rule that its stderr must be **exactly** the version banner;
`unsquashfs` by asserting each requested path landed; `veritysetup` by
distinguishing the two exit-1 messages. Every refusal names the tool, the argv,
the status and what it saw.

`--probe` drives all of them against a real image and prints what they read —
which is both the evidence they work and the fastest way to see what a check
has to work with:

```sh
bash verify/run.sh --verify --board cx3576 --probe
```

## Verifying an image

```sh
make os-verify-cx3576                        # the image contract
bash verify/run.sh --verify --board uefi-x64      # the other board
bash verify/run.sh --verify --board uefi-x64 --image PATH
```

`src/verify-cli.ts` runs the register against one assembled image and prints one
`PASS:`/`FAIL:`/`SKIP:` line per conclusion and a `RESULT:` line. That format is
a contract rather than a preference: `tests/apid-api` describes its own output as
that shape, and several `mica:docs/task/` records quote `RESULT:` lines as evidence.

It needs **docker** on a host without `sgdisk`/`mtools`/`debugfs`/`unsquashfs`/
`veritysetup`: the tools come out of the pinned `upstream:alpine:3.24.1`. It cannot
run inside the pinned bun container — see `HARNESS.md`, "Why --verify runs in
an image of its own".

## The smoke runner — "it linked", "it runs" and "it is the version we decided"

Twelve artifacts in the image are built by this repository — micad, apid,
mica-mqttd, mica-mqtt-broker, rauc, podman, quadlet, crun, conmon, netavark,
aardvark-dns, catatonit. Three different claims are easy to read as one, and
only the first is established by linking them:

| claim | what would establish it |
|-------|-------------------------|
| it linked | the build did not fail |
| it runs | the loader resolves it and it reaches `main` |
| it is the version we decided | what ran is what `upstream.lock` says |

A wrong-architecture binary, a missing soname and a version that does not match
its pin all survive to first boot, and from a build log all three look identical:
green.

```sh
bash verify/run.sh --smoke                # uefi-x64, or $MICA_BOARD
bash verify/run.sh --smoke --board cx3576
```

It loads `_out/<board>/factory-root.oci` — the packed root the build exports as
an OCI image — and runs each artifact **inside it**, at its installed path,
with `--rm --network none`.

### One list, two readers

No version string is written down in this package. Every pin is read, at run
time, out of the file that owns it: the `upstream.lock` the pinned mica-podman
archives carry, and the package rows of `locks/` for the mica-core binaries. That is the whole of what makes the third
acceptance clause true — *bumping a pin without rebuilding the artifact turns
the smoke run red* — and it is the reason the register carries identity (which
artifact, which path, which key) and never a value.

`pinCoverageFaults` checks both directions and the **runner** calls it, not only
its tests. Every git row of every `upstream.lock` must be claimed by some
artifact; a new self-built binary that arrives with a pin and no register entry
refuses the run instead of quietly not being executed.

### Four verdicts, because two would be a lie

An artifact that is neither a pass nor a fail is **unclaimed**: not invoked at
all. A run carrying one concludes `INCOMPLETE` and exits non-zero, and the names
go on the `RESULT:` line rather than only the count, because the count is
exactly the part a reader stops seeing. The alternative is a green that has
quietly stopped asking some of the artifacts for a version.

The category **cannot grow silently**. `EXPECTED_UNCLAIMED` declares who is
allowed to go unasked — it is empty, so every artifact is asked —
`unclaimedFaults` refuses any run whose register disagrees with it, and adding a
name costs three edits in one diff. Nothing infers the category at runtime: a
binary that *loses* its `--version` is a **FAIL**, not a new member. Both
directions are refused, including the good one, so a name that becomes claimed
and is left behind in the constant fails too.

The fourth is **executor-limited**, and it answers a different question: not
*was this artifact asked* but *whose limitation was the failure*. `crun` 1.29.1
re-executes libcrun through a memory file descriptor — its CVE-2024-21626
mitigation — before it parses a single argument, and `qemu-user` cannot service
that `fexecve`; under the emulated buildkit executor it therefore exits 1
without ever reaching its own `--version` handler, while the same binary in the
same root answers normally on a host that executes it natively.

Three conjuncts gate it, and all three are required. The **route** must be the
emulated buildkit fallback — on the native route this failure is a `FAIL`, as it
always was. The **register entry** must declare the signature; there is no
global pattern, so an entry that declares nothing can never reach this verdict.
And the observed failure must **match that signature exactly**, in the status
and in the stderr. A run carrying one concludes `PASS` and exits 0, and the
`RESULT:` line carries the count and the names — `1 executor-limited` beside
`0 fail` — so a run that softened a conclusion cannot look like one that
softened nothing.

### The commit half of the version contract

`micad` and `apid` print `<name> <version> (<commit>)`. Comparing that commit
against `git rev-parse HEAD` at run time is refused by name: it would be
trivially green on any freshly built tree, asserting that somebody just built
rather than that the embedding works. `micad:hack/build-deb.sh` — the producer hook
that compiles the binaries a composed root installs — writes the commit it
handed the compiler into a build fact instead, and the runner compares the
reported line against **that**. Where the build recorded no commit there is
nothing to compare, and the row says `commit was NOT asserted` rather than
passing quietly.

The two sides are the string compiled **into** the binary in the packed root,
read back by executing it, and the string that producer run wrote to disk — and
both descend from one `MICA_BUILD_COMMIT` in one invocation. So it is **not** a
check that the commit is right; no reader of an image could be. It closes the
distance between *the producer was told to embed X* and *the binary in the image
reports X*: a compile cargo did not re-run for a changed environment variable, an
`option_env!` that resolved to nothing so the binary answers `unknown`, a stage
that installed a binary from somewhere other than the package. The pool's stamp
and `SHA256SUMS` checks already refuse an archive built from another tree — but
they read its name and its bytes, never what was compiled into the binary
inside it.

The reported line is carried verbatim into every version verdict either way,
because a line nobody can read back is a claim nobody can check:

```
PASS  catatonit  …  == CATATONIT_VERSION=v0.2.1  [said: "tini version 0.2.1_catatonit"]
```

### It refuses rather than skipping, in four places

- **no image** — names the file and `MICA_BOARD=<b> bash rootfs/build.sh`
- **register vs pins disagree** — nothing is executed at all
- **a feature stage was declined** — read off the build's own
  `rootfs-stages.txt`; against such a root the declined feature's artifacts would
  all answer `rc=127`, and a handful of failures about binaries is the wrong
  diagnosis of one decision about one stage
- **this host cannot execute the image** — a `/bin/true` preflight, which is
  also the positive control. Without it an arm64 image on a host with no
  `binfmt_misc` gives twelve failures about twelve binaries, which is twelve
  wrong diagnoses of one condition.

### It is part of the build

`rootfs/build.sh` runs `run.sh --smoke` as its **last step, under
`set -e`**, so a root whose binaries do not run does not become an image.

In the script rather than in the `Makefile`, because two make targets run it, so
does the CI deep lane, and anyone can run it directly; a step wired into the
callers would be three copies to keep in step and bypassed by the fourth. There
is no skip and no opt-out. `make os-smoke-test` is how to ask the question on its
own, against a root that is already built.

### The three negative tests — `make os-smoke-negative-test`

A check on the check. Each case **makes** its defect in a real image built from
the real factory root and drives the real `docker run` at it:

| case | mutation | artifact |
|---|---|---|
| `wrong-arch` | `e_machine` `0x3e` → `0xb7`, one byte | `/usr/bin/crun` |
| `missing-soname` | `libjson-glib-1.0.so.0` removed — NEEDed by `rauc` and, measured, by nothing else in the register | `/usr/bin/rauc` |
| `version-skew` | replaced by a shim reporting `1.29.2` against a pin of `1.29.1` | `/usr/bin/crun` |

They are **not** unit tests, and could not be. Everything else here is driven
from a fabricated `ExecResult`, which is what makes the red branches runnable
without a daemon — but a fabricated result is a statement the test wrote, and an
exit-status map can be green throughout while being wrong about both of the
shapes this clause names. See `HARNESS.md`, "What a non-zero exit means".

Five things are asserted per case, each ruling out a different way of passing
vacuously: the image built (**a mutation that changed nothing fails the image
BUILD** — every Dockerfile asserts its own pre-state and post-state); `preflight`
still passes on the *mutated* image, so the failure is the artifact and not the
host; the *unmutated* artifact passes through the same runner in the same pass;
the failure says the right thing **and not the wrong one**; and the whole run
concludes FAIL, exit 1, with exactly one failure, named.

The parts that decide *whether the cases run at all* — an empty list, a case
naming an artifact the register does not have, an empty mutation body, a skew
that is not a skew — are in `src/smoke-negative.test.ts` and need no daemon,
because those are the failures that would otherwise be silent.

## Running

```sh
make os-verify-test          # the whole suite
make os-layout-lint          # the schema lint, over every board this tree ships
make os-smoke-test           # execute the built artifacts in the factory root (docker)
make os-smoke-negative-test  # break that root three ways, require each red (docker)
make os-factory-root-gate    # is the OCI export the tree that ships? (docker)
```

or, equivalently, `bash verify/run.sh` — install if needed, `typecheck`,
then `bun test`, with a guard that turns a run asserting nothing red. See
`HARNESS.md` for why that guard exists and how to drive it. `bash
verify/run.sh --lint [board.env ...]` is the lint; the flag has to come
first, so it can never be mistaken for a `bun test` filter.

Directly, with bun on the host:

```sh
cd verify
bun install
bun run typecheck
bun test
```

**bun is not required on the host.** A host without one runs the same three
targets unchanged: `run.sh` falls back to the bun pinned by digest as
`mica-build-env:base` in `locks/mica-build-env.lock`, which needs docker and nothing else.
There is no separate command to remember and no flag to pass — the route is
chosen automatically and announced on the first line of output:

```
verify: 1.4.0 in oven/bun:1@sha256:5ff6… (no bun on this host)
RESULT: PASS (26/26 checks)
```

`MICA_VERIFY_CONTAINER=1` forces that route on a host that *does* have bun, which
is how the two are compared; `MICA_VERIFY_BUN` names a binary instead. Setting
both is refused.

`make os-layout-lint` needs bun like the suite does, so the container route is
what keeps a board definition checkable on a host that has only docker, rather
than a convenience. `.github/workflows/ci.yml` installs no bun for exactly
this reason: the runner takes the container route, so the pin is exercised on
every push. See `HARNESS.md` for the mount, which is an identity mount and not
a `/w`, and why.

## Layout

```
run.sh              the entry point; the only place that decides how bun is invoked
src/board-env.ts    the parser: board.env text -> assignments, faithfully or not at all
src/board.ts        the typed model: assignments -> partitions, roles, bootloader, lists
src/board-scope.ts  the shipped boards, and the predicates a board-conditional check is scoped by
src/lint.ts         the schema lint: the model -> a verdict and the sentence for it
src/lint-cli.ts     argv, printing and an exit status; every decision is in lint.ts
src/paths.ts        where the package sits, anchored rather than counted
src/tools.ts        the tool seam: this host, or the pinned alpine; one place decides
src/image.ts        sgdisk / mtools / tune2fs+debugfs / unsquashfs / veritysetup, typed
src/image-layout.ts the layout walk for ONE image, with the crossing number read off it
src/layout.ts       the board definition walked into the table it describes
src/boot-slots.ts   the two boot slots, and where each one's filesystem begins
src/checks.ts       the check register, and what a check is handed
src/checks-*.ts     the check families: GPT, boot slots, RAUC, ext4, root, cmdline, boot chain,
                    D-Bus, engine, fstab, home, MQTT, shadow, shape, connd, system, board,
                    busybox
src/checks-fixture.ts  a synthetic image, for driving a check RED
src/script-commands.ts the commands a shell script invokes, and whether each resolves in the root
src/verdict.ts      how a check spells its conclusion
src/parity.ts       CheckResult, Verdict, and the per-check identity a conclusion is matched by
src/verify-cli.ts   argv, printing and an exit status for --verify
src/smoke-pins.ts   where a recorded version is READ from; no version string lives here
src/smoke-register.ts  the twelve artifacts: identity and installed path, never a value
src/smoke.ts        the runner: the exec seam, the verdicts, the refusals, the count guard
src/smoke-cli.ts    argv, printing and an exit status; every decision is in smoke.ts
src/smoke-negative.ts   the three deliberate defects, and what each run must say
src/smoke-negative-cli.ts  argv and orchestration for --smoke-negative
src/probe.ts        drives every helper against a real image and prints what it read
src/*.test.ts       the suite; every refusal has a positive control beside it
```
