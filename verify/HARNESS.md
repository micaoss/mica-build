# The verify harness

`verify/run.sh` is the single entry point. It finds bun — on the host, or
failing that in the container pinned as `mica-build-env:base` — installs the dev
dependencies if `node_modules/` is absent, typechecks `src/`, runs the step the
mode asks for, and then checks that step actually ran.

    make os-verify-test                 # the whole suite
    make os-layout-lint                 # the schema lint over every shipped board
    make os-verify-cx3576            # verify an assembled image
    bash verify/run.sh --help
    bash verify/run.sh -t "arith"    # extra arguments go to `bun test`
    bash verify/run.sh --lint FILE   # the lint instead of the suite
    bash verify/run.sh --verify --board x64 --probe
    bash verify/run.sh --smoke --board x64

---

## 1. The modes

`--lint`, `--verify`, `--smoke` and `--smoke-negative` are **modes**, and each is
recognised only in first position, so none can be mistaken for a `bun test`
filter. A flag in a later position is refused by name rather than forwarded:
forwarded, `bun test` ignores the unknown flag and reports a green suite in
answer to a request for the lint.

| mode | what it runs |
|---|---|
| *(none)* | the suite |
| `--lint [board.env …]` | the board-definition schema lint over the named layouts, or over every shipped board |
| `--verify [--board NAME] [--image PATH]` | the check register against one assembled image — one PASS/FAIL/SKIP line per conclusion, then a `RESULT:` line |
| `--smoke [--board NAME]` | every self-built artifact in the packed root, executed, against the version this repository pins |
| `--smoke-negative [--board NAME]` | three deliberately defective images, each of which the smoke run must reject |

All four share the install, the typecheck and the `run_bun` seam; only the last
step differs, which is what keeps ONE place deciding how bun is invoked.
`--lint`'s file arguments are made absolute before they are handed on, because
`run_bun` cds into the package first.

The three docker-driving modes need a daemon whatever else the host has.
`--lint` and the suite do not.

## 2. The bun seam

Exactly one function decides how bun is invoked, and it has two routes:

```sh
run_bun() {
    if [ "${ROUTE}" = container ]; then
        docker run --rm "${MOUNTS[@]}" -w "${HERE}" "${BUN_IMAGE}" bun "$@"
    else
        ( cd "${HERE}" && "${BUN}" "$@" )
    fi
}
```

Every caller passes an argv and reads an exit status, and none can tell which
route answered. The image is `mica-build-env:base` in `locks/mica-build-env.lock`,
resolved through `tools/from.sh --ref` — the one resolver; nothing here
re-pins or re-validates it.

| condition | route |
|---|---|
| `MICA_VERIFY_BUN` set | that binary |
| `MICA_VERIFY_CONTAINER=1` | the pinned container, even where a host bun exists |
| both set | **refused** — they are two different buns |
| `bun` on `PATH`, else `~/.bun/bin/bun` | that binary |
| none of the above | the pinned container |
| none of the above, and no docker | **refused**, naming both |

The route is chosen once and **announced on the first line of output**, so a run
is never ambiguous about which bun produced it:

    verify: 1.4.0 at /srv/bkd/runtime/bun
    verify: 1.4.0 in oven/bun:1@sha256:5ff6… (no bun on this host)

A well-formed digest naming no image is refused **by the key**, before any run:
`docker run` would return exit 125, which is indistinguishable at this seam from
bun exiting 125.

### Why the repository is mounted at its own path

`-v "${REPO_ROOT}:${REPO_ROOT}"`, not `/w` or `/work` like the image assemblers.
Those containers **run a script** and build their paths inside; this one is a
**tool handed paths from outside**. `--lint`'s file arguments are absolutised
against the caller's cwd before `run_bun` sees them, and `paths.ts` resolves the
shipped boards by climbing from `import.meta.dir` — both produce *host* absolute
paths. Under a `/w` mount they would name nothing inside the container, and the
fix would be a prefix rewrite: a second path arithmetic, on the one input whose
identity the verdict is about.

An identity mount has no rewrite to get wrong. A board file **outside** the
repository gets its directory mounted at its own path too, read-only.

### A bind mount under /tmp succeeds and carries nothing

On this host a bind mount of anything under `/tmp` propagates as an **empty
directory** rather than failing. So every path a run depends on is asserted
visible *inside the container* before any of them is used — one extra container,
~260 ms, which also carries the version.

That guard buys the **cause, not the verdict**. With it disabled, all three ways
in still fail and all three exit 1: the lint's own `existsSync` says
`<path> not found`, `bun test` over a vanished package says `No tests found!`
(exit 1 — not the 0 it gives a file that declares no tests), and
`bun run src/lint-cli.ts` says `Module not found`. Nothing reports a false
green. But each of those sentences describes a *missing file*, and on this route
the file is exactly where the caller said it was — it is the mount that is
empty. Sending a reader to look for a path they can `cat` is its own defect.

`--lint` on a board file under `/tmp` is therefore refused, naming the path and
the empty mount rather than the file.

### The two routes agree

Ten cases, each run both ways, comparing **stdout and stderr separately** and
the exit status: both shipped boards, each alone and together, four negative
fixtures, a copy outside the repository, and a mixed in-repo/out-of-repo run.
All ten identical.

Compared as a single interleaved stream they appear to differ, and that is an
artefact worth knowing: docker delivers stderr ahead of stdout where a native
process writing to one redirected file does not. The lines are the same lines.

### Where the container pin is exercised

`.github/workflows/ci.yml`'s `suites` job installs **no bun**, so the
runner takes the container route on every push. The job asserts that it did — it
greps the announce line for the reference `from.sh` resolves — because the
suite's exit status proves the tests ran, not which bun ran them. Forced onto a
host bun, the step exits 1.

## 3. The image tools

`src/tools.ts` decides where `sgdisk`, `mtools`, `tune2fs`/`debugfs`,
`unsquashfs` and `veritysetup` come from, exactly as `run_bun` decides where bun
comes from: two routes, one function, a caller that passes an argv and reads a
status and cannot tell which answered.

| condition | route |
|---|---|
| `MICA_VERIFY_TOOLS=host` | this host — **refused**, naming them, if any are missing |
| `MICA_VERIFY_TOOLS=container` | the pinned `upstream:alpine:3.24.1`, even where the host has them |
| every tool on `PATH` | this host |
| any tool missing | the pinned container |
| any tool missing, and no docker | **refused**, naming both |

The route is announced, as bun's is, and the announce line is the only thing
that says which tools produced a verdict:

    verify: image tools in alpine:3.21@sha256:48b0309c… (no sgdisk, mdir, mcopy, mlabel, unsquashfs, veritysetup on this host)

The container is created **once** per run and each call is a `docker exec` into
it. `docker run` costs ~200 ms and `apk add` costs seconds; a design that made
one container per tool call would pay both per call, and the register makes
hundreds. The image is obtained up front for the reason `run_bun` obtains the
bun image up front: a well-formed digest naming no image arrives as `docker run`
exit 125, indistinguishable at the seam from the tool exiting 125.

Mounts are **identity mounts**, and every path the run depends on is asserted
visible *inside* the container before any tool runs — same reasoning as the bun
seam, and the same `/tmp` quirk behind it.

`extractRange` is TypeScript rather than `dd`. The substitution is measured
rather than argued: against ROOTFS-A of the real cx3576 image both produce
`sha256:565af2a3…142b777`.

### Why --verify runs in an image of its own

`--verify` cannot take the plain pinned bun container. It drives docker itself:
`src/tools.ts` reads the image with the tools out of `upstream:alpine:3.24.1`, which
on a tool-less host is always. Inside the bun container that is
docker-in-docker, and `mica-build-env:base` has no docker client:

```
$ docker run --rm oven/bun:1@sha256:5ff6… sh -c 'command -v docker || echo NO-DOCKER-CLI'
NO-DOCKER-CLI
```

— no `curl`, `wget`, `nc`, `python3` or `socat` in it either. **Mounting the
daemon socket alone does not help**: what is missing is the CLIENT.

So `verify/Dockerfile` is the pinned bun image plus a docker client pinned as
`upstream:docker:28-cli` — a static binary, which is what lets an alpine-built
client run on a debian base. `run.sh` builds it on demand for `--verify` only,
tagged with **both** input digests so a bumped pin cannot silently reuse the old
image, and mounts the daemon socket.

On a host with nothing but docker:

    env -i PATH=/usr/bin:/bin HOME=<empty>    (no bun, no image tools)
    run.sh --verify --board x64     RESULT: PASS (290/290 checks, 22 skipped)  rc=0
    make os-verify-cx3576        RESULT: FAIL (387/395 checks, 3 skipped)   rc=1

cx3576's eight FAILs are the BSP byte-compares whose source tree a checkout does
not carry: `_out/boards/cx3576/` is not populated by a clone, so eight conclusions
read `… compare source not found: …/_out/boards/cx3576/…` and `u-boot is 0 bytes`. The
verifier **expresses that absence rather than populating the tree**: a
populated `_out/boards/<b>/` would turn those eight FAILs into passes, which changes the
measurement rather than making it. Both directions have fixtures, so the
byte-compare's passing side is driven even though no shipped tree takes it.

**What the socket costs, said plainly.** Mounting `/var/run/docker.sock` into a
container is a privilege grant, and no other target in this tree takes one.
Nested containers are SIBLINGS on the host daemon rather than children — which
is exactly why the identity mounts still resolve inside them, and equally why
anything in that container can do anything the daemon can. It is confined to
`--verify`, and a host with bun never takes the route. The suite and the lint
are unaffected: both run in plain `mica-build-env:base` on a host with nothing but
docker, neither mounts the socket, and CI takes that route on every push.

## 4. Zero tests is a failure, and bun does not agree

Measured with bun 1.4.0:

| situation | `bun test` exit status |
|-----------|------------------------|
| no test **file** matches the glob | 1 |
| a file matches and declares **no tests** | **0** — "Ran 0 tests across 1 file" |

The second row is the failure shape this tree keeps finding in its own
checkers: a checker that is green while being wrong, because its counters never
moved.

So `run.sh` reads the count out of the run — the `Ran N tests` line — and turns
`N = 0` red with an exit status and a sentence. It also refuses a run that exits
0 without printing that line at all, because the exit status alone cannot tell a
green suite from one that never executed.

The count pattern accepts `Ran 1 test` as well as `Ran 66 tests`. A pattern that
insisted on the plural would read a single-test filter as vacuous and fail it.

## 5. Every guard driven from the failing side

Each guard in `run.sh` is run against the condition it exists to catch, and each
returns 1.

| driven | what it prints |
|--------|----------------|
| bash present, no bun on `PATH`, no `~/.bun` | runs the pinned container, from a stock `PATH=/usr/bin:/bin` under `env -i` |
| the same, and no docker either | refuses, naming bun, `MICA_VERIFY_BUN` and `mica-build-env:base` |
| `mica-build-env:base` set to a well-formed digest naming no image | refuses by the key, before any run |
| `mica-build-env:base` set to a tag, or removed | `from.sh`'s own refusal, naming the key and the file |
| `MICA_VERIFY_BUN` and `MICA_VERIFY_CONTAINER` both set | refused; they are two different buns |
| `--lint` on a board file under `/tmp`, container route | refuses, naming the path and the empty mount rather than the file |
| a copy whose `REPO_ROOT` has no `Makefile` | the computed `HERE` and `REPO_ROOT`, and that one of them is stale |
| a suite whose only test file declares no tests | the vacuity refusal above |
| a suite with one deliberately red test | `RESULT: FAIL (bun test exited 1; 0 passed of 1 run)` |
| `--lint` on a file that is not there | `error: <abs path> not found`, and the path is the one it actually looked at |
| `--lint` on a relative path, from three different cwds | the same verdict each time — the absolutising works |
| `--lint` in a NON-first position | refused, rather than forwarded to `bun test` |

The same for the image-tool seam:

| driven | what it does |
|---|---|
| `MICA_VERIFY_TOOLS=hsot` | refused up front — the route is decided once, before any tool runs |
| `MICA_VERIFY_TOOLS=host` on a tool-less host | refused, naming `sgdisk, mdir, mcopy, mlabel, unsquashfs, veritysetup` |
| `upstream:alpine:3.24.1` = a well-formed digest naming no image | refused **by the key**, at the pull |
| `upstream:alpine:3.24.1` = a tag | `from.sh`'s refusal, naming the key and the file |
| no image tools **and** no docker | refused, naming both and `upstream:alpine:3.24.1` |
| `--work` under `/tmp` | refused, naming the sentinel and the mount |
| `--board x86` | `'x86' is not a board this tree ships … boards/ holds cx3576, x64` |
| `--board` with no value | refused; an option taking the next flag as its value verifies something nobody asked for |
| `--image` with two boards | refused; one image cannot be both boards' |
| `--image` naming a file that is not there | refused |

`src/verify-cli.ts` declines to default the board at all. `MICA_BOARD` unset once
checked an x64 image against cx3576's eleven-partition GPT and reported 191
failures that were all the harness's.

The path anchors are checked the same way in `src/paths.test.ts`: each ascent is
asserted at the count it uses **and at the counts on either side**, and the
neighbours must fail. An anchor satisfied by more than one answer is not an
anchor.

### One mutation, one check

A check that PASSES and a check that CANNOT FAIL both report green against a
healthy image, so every check in the register lands with the fixture that fails
it. Two things carry that:

**End to end, against a real image edited on disk.** A real cx3576 image is
mutated with `sgdisk -c 9:stat` and BOOT-B's FAT label set to `BOOT`, and the
run reports two FAIL lines, one per mutation, with every other conclusion
unmoved. That is what proves the whole pipeline reports the failing
direction — the tools, the extraction, the check and the verdict.

**And, per check, against a synthetic image.** The end-to-end run cannot be one
mutation per check: it is a 1.3 GB copy and a three-minute run each time, and
half the mutations — a partition that is not the last one, a table with a
partition missing — cannot be made with sgdisk without turning three other
checks red at the same time, so the failure would not name one check. So each
check is also driven against a table built in memory: one mutation, one check,
one named failure, no image and no container. The baseline is asserted GREEN
first in every case.

Fixtures are built from the SHIPPED inputs, not from an idea of them.
`/etc/fstab` is rendered from `boot/common/fstab.in` with the
board's own GUIDs, because a fixture built from this package's idea of the table
would test that idea rather than the shipped one, and an `fstab.in` that grew a
new placeholder would go on passing. The renderer refuses a leftover
placeholder, which is how that stays true.

## 6. The tools, and what the harness does about each

Every tool binding in `src/image.ts` is driven against a malformed input before
it is trusted, in the pinned `alpine:3.21`. `--probe` drives them all against a
real image and prints what each read. These are the runs where a tool did
something other than the obvious, which is why they are written down rather than
summarised.

### e2fsck

| driven with | rc |
|---|---|
| zeros, an empty file, a squashfs, a directory, a missing file | **8**, naming the superblock |
| errors left uncorrected | 4 |
| **a truncated filesystem** | **0** |

`e2fsck -fn` exits **0** on a truncated filesystem, after printing *"The
filesystem size (according to the superblock) is 8192 blocks / The physical size
of the device is 4096 blocks / Either the superblock or the partition table is
likely to be corrupt!"*. A check that discards both streams and reads the status
alone therefore concludes `e2fsck -fn on data is clean` about a filesystem
`e2fsck` has just called likely corrupt, and the branch is reachable: the ext4
extract takes `count=${size_mib}` MiB at the layout's offset, so an image whose
tail is short produces exactly that file.

The harness reproduces that read rather than hardening it, and asserts the
vacuous pass as its own case in `src/checks-ext4.test.ts` — removing the
reproduction has to remove the record of it too.

### debugfs

`debugfs -R "ls -p /"` exits **0** on a file it never opened: stdout is empty
and `Filesystem not open` goes to stderr, which a trailing `|| true` drops. An
empty listing is the **passing** direction for META, STATE and DATA, so that
transcript reads as `factory: meta is empty at build (nothing but lost+found)`
about a partition holding no filesystem at all. The SAME transcript on EPHEMERAL
FAILs, which is what shows the pass is vacuous. Both directions are asserted.

### tune2fs

`tune2fs -l` on a file it cannot open exits 1 — and prints its **version
banner** on stdout first:

    tune2fs raw exit = 1
    info             = "tune2fs 1.47.1 (20-May-2024)"     <-- NOT the empty string

So a guard written as `if [ -z "$info" ]` never fires. That output feeds three
value-describing checks: the label and the UUID both FAIL on it, and the feature
list does not — `sed -n 's/^Filesystem features://p'` finds nothing in the
banner, `grep -w orphan_file` matches nothing, and the conclusion is
**`no orphan_file feature`** about a filesystem nothing opened. `dumpe2fs -h`
has the same `|| true` shape one function over, and its empty output makes
`fs_bytes` 0 and FAILs.

`ext4SuperOrNone` reproduces the shape exactly: it returns `undefined` only for
a `tune2fs` that EXITED NON-ZERO, and an exit-0 output whose magic is not
`0xEF53` still throws.

### getcap

`getcap -r DIR` on a directory that is not there exits **0** and writes
`<path> (No such file or directory)` to stderr. A packed inventory read that way
comes out EMPTY — and on both shipped images the SOURCE inventory is empty too,
so the comparison passes with `both EMPTY` about a root nothing read. Both trees
genuinely carry no file capabilities, which is what makes this survivable rather
than urgent. Asserted in `src/checks-shape.test.ts`, with an environment probe
beside it that keeps the pair from passing for the wrong reason.

### fdtget

The first tool here that refuses honestly on every input it cannot read, with
one exception.

| driven with | what it did |
|---|---|
| 64 MiB of zeros, or an empty file | `Error at '/leds/status-red': FDT_ERR_BADMAGIC` on **stderr**, exit 1, EMPTY stdout |
| a path that is not there | `Couldn't open blob from '…': No such file or directory`, exit 1 |
| a node or property not in the tree | `FDT_ERR_NOTFOUND`, exit 1 |
| **`-t x` on a STRING property** | **exit 0**, printing the string's BYTES as cells — `73 74 61 74 75 73 2d 72 65 64 0` for `status-red` |
| `-t x` vs the default radix | `6b 1d 1` against `107 29 1`: `-t x` is hexadecimal, the default is DECIMAL |

The `-t x` row is REPRODUCED rather than refused: a `gpios` property that had
become a string yields the third BYTE of that string as the GPIO flags cell, and
a helper that threw would turn a FAIL into a run that died.

### sgdisk, unsquashfs, veritysetup, mcopy

Given a file that is not a GPT, `sgdisk` **invents a disk GUID and exits 0** —
where `fdtget`, given the same file, refuses. `unsquashfs` extracts nothing at
exit 0. `veritysetup` uses one status for an answer and for a failure. `mcopy`
exits 0 having written nothing. Each is driven against its malformed input in
`src/image.test.ts` before any check reads it.

### The uImage header

A file that is not there, or shorter than four bytes, yields `''` rather than a
throw, because the comparison is against `od -An -tx1 -N4 2>/dev/null | tr -d`
output. A file shorter than 64 bytes yields `undefined`, not a struct of zeros:
`imageType` 0 means "invalid", not "absent".

### Two conclusions that disagree with each other

Both ship, both are asserted, neither is repaired here.

`src/checks-shadow.ts` carries two checks that read the same field differently.
`factory-shadow-locked` treats an EMPTY password field as **locked** — its awk
is `$2 !~ /^[!*]/ && $2 != ""`. `factory-shadow-accounts-locked` treats the same
field as the **worst** case: an empty field is passwordless login, and
`pam_unix` accepts any password including none. The second is right; the first
would PASS an image the second FAILs. Driven in `src/checks-shadow.test.ts`.

`devLineCount` in `src/checks-system.ts` returns the literal `'0\n0'` for a file
that exists with no `^/dev/` line, because `grep -cE '^/dev/' … || echo 0`
prints `0` **and** exits 1, so the fallback fires as well. The value is
interpolated into a FAIL message, putting a raw newline in the middle of a
conclusion. Neither shipped image reaches the branch — both have two device
lines — and the case is asserted as its own.

`check_container_engine`'s early return has no register expression. On a
`WITH_CONTAINERS=0` image one conclusion stands in for ten, and the register
cannot say "this check does not exist on this image": an entry owning that one
line would report `unfired` on both shipped boards. So
`container-engine-installed` owns BOTH sentences and the other nine answer
`skipped()`. On such an image `--verify` prints one PASS and nine SKIP lines.
No shipped board produces the shape.

## 7. The matcher, and where it runs out

Each registered check carries a **matcher**: a substring that identifies the
conclusion it owns. The claim the register enforces is "exactly one registered
check matches this line". `assertRegisterWellFormed` refuses a check that
registers **no** matcher at all, because such an entry would report `unfired`
forever and read exactly like a matcher that had gone stale.

Two widenings, each forced by a shape the register could not otherwise express:

* **`pass` is OPTIONAL.** Several families print N conclusions on the board that
  has the hardware and ONE `skip` on the board that does not — five firmware
  paths against one `the board radio-firmware set (…)`. A line can have exactly
  one owner, so that skip needs a register entry of its own, and such an entry
  genuinely has no PASS line on any board it applies to.
* **`fail` may be a LIST.** Pass branches say one thing; failure branches fork.
  `check_status_led`'s three failure sentences, and the reconciler-ordering
  check's three, share no substring that is not also in some other check's line
  — `mica-status-led.service ` is in the overlay family's failures too. One loose
  matcher covering all three is how a check claims a neighbour's conclusion;
  three exact ones cannot. Each element is still a plain substring: a list
  widens what ONE check answers for, never what two may share.

**One shape remains unexpressible.** A matcher list lets a check claim several
DIFFERENT sentences, but every sentence must still be a contiguous substring. A
failure branch whose only commonality with its siblings is a word that also
appears in a neighbouring check's line cannot be claimed at all without making
that neighbour `ambiguous`. The shadow family hits this, and resolves it with a
three-element list rather than a looser matcher.

**Where a substring is not enough, the entry is generated per board.**
`exactly ${EXPECT_PARTS} partitions` has no substring that is both unique and
board-independent: ` partitions` claims three conclusions on each board,
`exactly ` claims thirteen and eight, and the only token left is the COUNT. So
there is one entry per board, generated from that board's own
`LAYOUT_PARTITIONS` length — `exactly 11 partitions` and `exactly 9 partitions`
— and a board that changes its layout changes both sides at once. The same shape
covers the boot-slot files: ONE `one` check per (board, slot, required file),
generated at module load from `BOOT_SLOT_REQUIRED_FILES` with `@SLOT@`
substituted, so the matcher is `BOOT-A contains Image` — one line, on one board.

A matcher too loose to identify one check is caught by the instrument rather
than by a reviewer: the register names the line numbers it found and attributes
neither.

`src/parity.ts` holds this machinery. `CheckResult`, `Verdict`,
`matcherAlternatives` and `RegisteredCheck` are what the register is built on.
`parseShellRun`, `diffParity` and `formatReport` have **no production caller**
and are driven only by `src/parity.test.ts` against synthetic transcripts — said
plainly here because unreachable code with a passing test reads as live.

## 8. What the suite covers

| file | what it proves |
|------|----------------|
| `src/board-env.test.ts` | every shape a real `board.env` contains, and every refusal — each with a positive control beside it, so a parser that rejected everything would not satisfy it |
| `src/board.test.ts` | the model against **both** shipped boards: cx3576's 11 partitions, raw loader, redundant U-Boot environment, radios and hwinit confs; x64's 9, no loader, GRUB with no attempt counters, and the lists it declares **empty on purpose**. Plus a real board definition with a `$(…)` injected, which must be refused by name |
| `src/lint.test.ts` | the board-definition schema lint: fourteen cases over mutated real layouts, eleven empty-declaration spellings, three inputs that are not data, both shipped layouts accepted — and the positive control that x64's three deliberately empty lists are a statement rather than a fault |
| `src/paths.test.ts` | the ascents, at the count used and at the counts on either side |
| `src/checks-board.test.ts` | the board-conditional families, each driven three ways — green on the board with the hardware, RED on a mutation of it, and SKIPPED on the board that declares it absent, including `check_status_led`'s `BOARD_HAS_STATUS_LED=0` branch in its FAILING direction |
| `src/checks-mqtt.test.ts` | the MQTT bridge and broker: present, startable, and INERT — plus the D-Bus policy read with its attributes wrapped across lines and a rule commented out, which is the shape a naive read gets wrong |
| `src/checks-shadow.test.ts` | the transient-password contract end to end, and the two locked-field checks that disagree about an EMPTY password field |
| `src/image.test.ts` | every tool, driven against a malformed input first: sgdisk inventing a GPT, debugfs opening nothing at exit 0, unsquashfs extracting nothing at exit 0, veritysetup using one status for an answer and a failure, `fdtget -t x` reading a string as cells, `e2fsck -fn` exiting 0 on a truncated filesystem, mcopy exiting 0 having written nothing |
| `src/checks-ext4.test.ts` | the four storage tiers, and the three vacuous passes their tools produce — each asserted as its own case, with the SAME transcript failing on the tier where the direction is inverted |
| `src/checks-bootchain.test.ts` | the U-Boot chain, including the BSP byte-compare's PASSING direction, which no shipped tree reaches; and a `mutate()` helper that refuses an edit which changed nothing |
| `src/checks-cmdline.test.ts` | one set of conclusions over TWO readers — a U-Boot verity env and a GRUB command line composed from `grub.cfg` and the slot's own fragment — with nearly every case run against both |
| `src/checks-shape.test.ts` | the partition count as a per-board derivation, and the capability pair including the environment probe that keeps it from passing for the wrong reason |
| `src/checks-freshness.test.ts` | that an image is dated by ITS OWN board's artefacts: both failing directions, the vacuous-green case turned into a skip, and the reported cross-board tree, asserted in both directions so a check that simply never looked at the other board could not satisfy it |

A model exercised only on fixtures its author wrote is a model of its author's
expectations. Anything that passes on cx3576 alone is half tested.

The check register is board-derived throughout: `board-scope.ts`,
`boot-slots.ts` and `image-layout.ts` hold everything more than one module
derives, so a third board in `boards/` is covered by whatever its own
definition selects, with no register entry edited. The board directory comes
from the board's own name and the artefact names from that board's
`BOOT_SLOT_REQUIRED_FILES`; the only transcribed board facts are the status-LED
polarities (`status-red:on:1:active-low`, `status-blue:off:0:active-high`),
which have nowhere board-side to be derived from —
`boards/cx3576/board.env` declares `BOARD_HAS_STATUS_LED=1` and nothing about
polarity, and the two other statements of those facts live in `mica-boards:cx3576/bsp/` — the
dts the kernel build compiles, and that build's Dockerfile — which this package
does not read, because depending on a BSP tree a checkout does not carry would
make every run of it conditional on one. The SCOPE is still derived
(`boardsWhere(hasLed)`).

## 9. Checking the board parser against bash

`src/board-env.ts` is verified against `bash` sourcing the same board
definitions, key for key. That check is **deliberately not in the suite** — it
would mean `source`-ing a board definition to test the thing whose entire
purpose is not to, and pointed at an untrusted file it would execute it.

Run it by hand when `src/board-env.ts` changes. From the repository root:

```sh
cat > /tmp/dump.ts <<'EOF'
// Imported dynamically and by absolute path: this file lives in /tmp, so a
// relative specifier would resolve against /tmp rather than the repository.
const { parseBoardEnv } = await import(`${process.cwd()}/verify/src/board-env.ts`)
const { readFileSync } = await import('node:fs')
const path = process.argv[2]!
for (const [k, v] of parseBoardEnv(readFileSync(path, 'utf8'), path).values)
  console.log(`${k}=${v}`)
EOF

for b in cx3576 x64; do
  P="$PWD/boards/$b/board.env"
  bun run /tmp/dump.ts "$P" > "/tmp/ts-$b.txt"
  cut -d= -f1 "/tmp/ts-$b.txt" > "/tmp/keys-$b.txt"
  n=$(wc -l < "/tmp/keys-$b.txt")
  [ "$n" -gt 50 ] || { echo "refusing: only $n keys from $b"; continue; }
  bash -c 'set -euo pipefail; . "$1"
           while read -r k; do printf "%s=%s\n" "$k" "${!k}"; done < "$2"' \
      _ "$P" "/tmp/keys-$b.txt" > "/tmp/sh-$b.txt"
  diff -u "/tmp/sh-$b.txt" "/tmp/ts-$b.txt" && echo "$b: agrees on all $n keys"
done
```

Expected: cx3576 **141/141**, x64 **115/115**.

The `[ "$n" -gt 50 ]` guard is not decoration. Run from the wrong directory,
both dumps come out empty and the comparison reports that the parser agrees with
the shell **on all 0 keys** — a comparison of two empty files is the same green
as a comparison that passed. Any comparison in this package that could read
nothing carries a guard of that shape.

## 10. Where the lint is stricter

`src/lint.ts` is measured against a `${NAME:-}`-idiom reader over the same 30
mutated copies of the real layouts — fourteen structural cases, eleven
empty-declaration spellings, three inputs that are not data at all, and both
boards unmutated:

| | cases |
|---|---|
| both reject | 24 |
| both accept | 2 (`cx3576`, `x64`, unmutated) |
| **the looser reader accepts, this one rejects** | **4** |
| the looser reader rejects, this one accepts | 0 |

Every divergence is in one direction. The four are
`forbidden-role-key-empty`, `boot-attempts-on-grub-empty`,
`partition-set-whitespace` and `command-substitution`. Each is a measured hole
in reading a declaration through that idiom, or in `source`ing a file rather
than parsing it.

They are marked `shellPassed: true` in `src/lint.test.ts`, each carries a `why`,
and a test asserts that set **by name** — so removing the strictness that closes
one has to remove the record of it too. `README.md` gives the four sentences the
lint prints where a looser reader would say nothing.

## 11. The smoke runner

`--smoke` loads `_out/<board>/factory-root.oci` — the packed root the build
exports as an OCI image — and EXECUTES every self-built artifact inside it,
requiring exit 0 and that the version each one reports equals the version this
repository pins. `rootfs/build.sh` runs it as its last step under `set
-e`, so a root whose binaries do not run does not become an image.

It refuses rather than skipping when the image is absent.

### The twelve, and what each one reports

| artifact | installed path | `--version`, line 1 of stdout | pin |
|----------|----------------|-------------------------------|-----|
| rauc | `/usr/bin/rauc` | `rauc 1.13` | `RAUC_VERSION=v1.13` |
| podman | `/usr/bin/podman` | `podman version 5.8.6` | `PODMAN_VERSION=v5.8.6` |
| quadlet | `/usr/libexec/podman/quadlet` | `5.8.6` | `PODMAN_VERSION` |
| crun | `/usr/bin/crun` | `crun version 1.29.1` | `CRUN_VERSION=1.29.1` |
| conmon | `/usr/libexec/podman/conmon` | `conmon version 2.2.1` | `CONMON_VERSION=v2.2.1` |
| netavark | `/usr/libexec/podman/netavark` | `netavark 2.1.0` | `NETAVARK_VERSION=v2.1.0` |
| aardvark-dns | `/usr/libexec/podman/aardvark-dns` | `aardvark-dns 2.1.0` | `AARDVARK_VERSION=v2.1.0` |
| catatonit | `/usr/libexec/podman/catatonit` | `tini version 0.2.1_catatonit` | `CATATONIT_VERSION=v0.2.1` |
| mica-mqttd | `/usr/bin/mica-mqttd` | `mica-mqttd 0.1.0` | `micad:mqttd/Cargo.toml` |
| mica-mqtt-broker | `/usr/bin/mica-mqtt-broker` | `mica-mqtt-broker 0.1.0` | `micad:broker/Cargo.toml` |
| micad | `/usr/bin/micad` | `micad 0.1.0 (<commit>)` | `micad:micad/Cargo.toml` |
| apid | `/usr/bin/mica-apid` | `apid 0.1.0 (<commit>)` | `micad:apid/Cargo.toml` |

**Five of the seven container binaries are not in `/usr/bin`.**
`podman-install.sh` writes them through a `${VAR}`-assembled destination, so the
literal path appears nowhere in it; the paths above are read off a real image.

Ten sentences, ten shapes. That is why there is one tokeniser and not twelve
parsers: a per-artifact regex fails **open** when upstream reflows a banner — no
match yields no version, and "no version" is easy to mistake for "no mismatch".

### The version comparison

`versionTokens` takes maximal digit-and-dot runs off the reported line;
`expectedFromRecorded` strips a leading `v` followed by a digit off the pin.
Then the two are compared for **equality against an extracted token, never a
substring test**.

catatonit is the case that shows why. The pin is `v0.2.1`, the binary says
`tini version 0.2.1_catatonit`, and neither string contains the other:

| side | step | result |
|------|------|--------|
| pin | strip leading `v` before a digit | `v0.2.1` → `0.2.1` |
| output | maximal digit-and-dot runs | `tini version 0.2.1_catatonit` → `["0.2.1"]` |

`_catatonit` is upstream's fork marker; it terminates the token rather than
being trimmed by a rule written for this one artifact. A loose `includes()` on
the raw line would pass on almost anything, and the suite proves that rather
than asserting it: `"tini version 0.2.1_catatonit"` contains `0.2`, `2.1`,
`0.2.1_cat` and `version 0.2.1`, and `judge` must go **red** on every one of
those as a pin while the loose test goes green. The skew is caught the other way
too — a `0.2.1` binary does not satisfy a `0.2.10` pin.

`versionTokens` carries a LEFT guard and no right-hand one. The left guard is
load-bearing: without it `11.29.1` satisfies a pin of `1.29.1`. A right-hand
`(?![.0-9])` is not, because greed already gives that property — after
`[0-9]+(?:\.[0-9]+)+` has matched, the next character cannot be a digit. What
such a guard *does* change is a trailing dot: on `crun version 1.29.1.` it
rejects the greedy match, backtracking finds nothing shorter, and the line
yields **no token at all** — reported as "reports NO version at all" for a
binary that printed the right version and ended its sentence with a full stop.

The parser is measured against the shapes it will meet rather than reasoned
about:

| line | tokens |
|------|--------|
| `micad 0.1.0 (abc1234)` | `["0.1.0"]` |
| `micad 0.1.0-dirty (abc1234-dirty)` | `["0.1.0"]` |
| `apid 0.1.0 (unknown)` | `["0.1.0"]` |
| `micad 0.1.0 (0123456)` — all-digit sha | `["0.1.0"]` |
| `micad 0.10.0 (abc1234)` | `["0.10.0"]` |
| `micad 0.1.0-rc.1 (abc1234)` | `["0.1.0"]` — a **recorded limit** |

The last is a boundary rather than a bug: a pre-release pin and a pre-release
output would both carry the suffix, the token would be the numeric head only,
and the run would go **red naming both sides**. Visible, not a silent pass.

### The commit is printed, not asserted

The handlers report the git commit beside the version — `-dirty` when the
worktree was, `unknown` when absent. Nothing in the build records a git
provenance fact for the runner to compare it against: `factory-root.txt` carries
ref, platform, target, archive, bytes, sha256 and source-date-epoch;
`rootfs-stages.txt` carries per-stage content hashes; `rootfs-verity.env`
carries verity parameters; `rootfs-report.txt` is a package inventory. So the
whole reported line is carried into the verdict message verbatim and nothing
claims to have checked it:

    PASS  catatonit  …  reports 0.2.1 == CATATONIT_VERSION=v0.2.1  [said: "tini version 0.2.1_catatonit"]

Comparing the reported sha against `git rev-parse HEAD` at run time is refused
by name: it would assert that somebody just built, not that the embedding works.
A binary built three commits ago would go red for being stale rather than wrong,
and one built from this commit would go green whether the handler embedded a
real sha or echoed the environment. Closing that assertion needs a recorded
build fact to exist first — a change to the **build**, not to the runner.

### What a non-zero exit means

Measured against docker 29.7.2, in exactly the shape `dockerArgv` produces — no
shell, so the artifact *is* the container's init and a failure to exec it
surfaces as a `docker run` failure:

| shape | rc | first line |
|---|---|---|
| wrong-arch ELF (`e_machine` → `0xB7`) | **255** | `exec <path>: exec format error` |
| missing soname | **127** | `<path>: error while loading shared libraries: … cannot open shared object file` |
| present, mode 000 | 126 | `docker: … exec: "<path>": permission denied.` |
| path genuinely absent | 127 | `docker: … exec: "<path>": stat <path>: no such file or directory.` |
| controls | 0 / 1 | `/bin/true`, `/bin/false` |

Note that **126 is produced by neither of the two shapes the diagnosis exists
for**: a wrong-arch binary never runs, and a missing soname is a binary that is
there. Reading these off `docker run`'s documented convention instead of
measuring them gets both wrong.

### The pin loop

Bumping an `upstream.lock` pin without rebuilding the artifact turns the run red,
naming both sides:

    # mica-podman upstream.lock: git crun ... 1.29.1  ->  1.29.2   (nothing rebuilt)
    $ bash verify/run.sh --smoke --board x64
    FAIL  crun  /usr/bin/crun  exit 0 but reports 1.29.1, and _out/debs/mica-podman/upstream.lock pins
                crun=1.29.2 (expected 1.29.2). Its --version line was
                "crun version 1.29.1". Either the pin was bumped without rebuilding the
                artifact, or the artifact was built from something other than the pin.
    RESULT: FAIL (11 pass, 1 fail, 0 unclaimed, of 12)          exit 1

    # reverted
    RESULT: PASS (12 pass, 0 fail, 0 unclaimed, of 12)          exit 0

It is driven in the suite as a **loop**, not as a comparison: one fixture
`upstream.lock`, one binary output held constant, one edit, and the verdict flips
`pass → fail → pass`. Asserting `judge` on two literals would test the
comparison and say nothing about whether the pin is re-read from the file it
lives in.

Coverage is checked in **both** directions — a pin with no register entry, and a
register entry with no pin — so a pin that nothing reads is a fault rather than
a silence.

### The unclaimed category cannot grow silently

`unclaimed` is the verdict that lets a run stay non-green without failing, and a
category like that decays in one direction only: something loses its
`--version`, somebody marks it unclaimed to get the pipeline moving, and the
gate quietly stops asking. Nothing about the resulting run looks different — the
summary already says INCOMPLETE, it just says it about three things instead of
two.

So the set is **declared** in `EXPECTED_UNCLAIMED`, `unclaimedFaults` refuses
any run whose register disagrees with it, and `smokeRun` calls that **before a
container starts**. Adding one costs three edits in one diff — the register
entry, the constant, and the lock in `smoke-register.test.ts`. The set is empty
today.

**It is never inferred.** There is deliberately no code path that computes "this
binary did not answer, so call it unclaimed". A binary that is asked for a
version and does not give one is a **FAIL**. That is the difference between a
regression and a category membership somebody chose.

Both directions fail, including the good one: an artifact that *gains* a
`--version` and is still listed refuses too, because the constant is the record
of what is outstanding and a stale record understates the gap.

**The names go on the RESULT line, not just the count**:

    RESULT: INCOMPLETE (10 pass, 0 fail, 2 unclaimed, of 12). UNCLAIMED: micad, apid. …

A count alone habituates: the number is precisely the part a reader stops
seeing.

### The negative tests

`--smoke-negative` builds three images from the board's factory root, each
carrying one deliberately made defect, and requires the smoke run to go red on
each:

| case | mutation | artifact |
|---|---|---|
| wrong-arch | `e_machine` `0x3e` → `0xb7`, one byte | `/usr/bin/crun` |
| missing-soname | `libjson-glib-1.0.so.0` removed — NEEDed by `rauc` and, measured, by nothing else in the register | `/usr/bin/rauc` |
| version-skew | replaced by a shim reporting `1.29.2` against a pin of `1.29.1` | `/usr/bin/crun` |

**Five assertions per case**, each ruling out a different way of passing
vacuously: the image built; `preflight` still passes on the MUTATED image, so
the failure is the artifact and not the host; the UNMUTATED artifact passes
through the same runner in the same pass; the failure says the right thing **and
not the wrong one**; and the whole run concludes FAIL, exit 1, with exactly one
failure, named.

**Every mutation refuses to be a no-op.** Each Dockerfile asserts its own
pre-state and post-state, so a no-op fails the image BUILD: writing `0x3e` back
instead of `0xb7` gives `REFUSING: the write did not take` and the case reports
DID NOT HOLD.

These are not unit tests, and that is the point. Both `judge` branches are
reachable from a unit test only through a **fabricated** `ExecResult`, where the
test chooses the status whose diagnosis it then asserts — which is how a module
can hold a measured exit status and an assumed one at the same time, hundreds of
lines apart, with nothing comparing them. Driving one case through the real seam
is what catches that.

### The arm64 preflight

`preflight` checks that this host can execute the image's platform **before**
concluding anything about any artifact, and refuses naming the platform and the
remedy. Without that control, all twelve come back `fail` — twelve failures
about twelve binaries are twelve wrong diagnoses of one condition.

    $ mount | grep binfmt        -> (binfmt_misc not mounted)
    $ docker run --rm --platform linux/arm64 arm64v8/busybox:latest /bin/true
    rc=255   exec /bin/true: exec format error

The refusal is reachable from the suite **without an arm64 image**, driven with
exactly that status and text.

`--board cx3576` on a host that cannot build the cx3576 factory root refuses
naming the build command rather than reporting anything about an artifact.

### The refusals, each with its control

| refusal | driven by | control |
|---------|-----------|---------|
| no image | `readFactoryRoot` against an empty directory | a directory with both files is read |
| record present, archive absent | record written alone | as above |
| register vs pins disagree | the `crun` entry dropped | with it, the same counter moves |
| a feature stage declined | `# declined: containers` written into the real `rootfs-stages.txt` | the unmutated manifest runs |
| host cannot execute the image | fabricated `rc=255 exec format error` | `rc=0` is accepted |
| a manifest with no `# declined:` line | the line deleted | the parenthesised "none" form reads as `[]` |
| `smokeRun` does not call `unclaimedFaults` | the call removed | a positive control that moves the call count |
| the RESULT line stops naming the unclaimed | the names dropped | — |
| the FAIL line stops naming what failed | the name dropped | — |
| the PASS message stops carrying the reported line | the line dropped | — |

The register-vs-pins case asserts that **nothing was executed** — the fake
`Exec` counts its calls and the count is 0 — rather than only that an error was
thrown.

`smoke.test.ts` locks the counts on the INCOMPLETE line and on the FAIL line,
with a nothing-unclaimed control beside them. A guard whose removal changes no
test is not a guard: `conclude` filing an unasked artifact under `pass` has to
turn something red, and the conclusion alone does not move under that mutation.

## 12. Is the image the one this tree would build?

Nothing else in the register asks that. Every other check reads the image and
compares it against the board definition or against itself, and every one of
them passes as happily on an image built four commits ago — so a green run is a
statement about *some* image, in the present tense, and nothing in it says
which. `src/checks-freshness.ts` is the one check that dates the image, and it
dates it against **that board's own** artefacts:

| input | derived from |
|---|---|
| `_out/<board>/rootfs-verity.img` | `ctx.outDir`, which is the board under test |
| `mica-podman:out-<arch>/podman` | that board's own `MICA_ARCH` |

mtime, not a hash: the inputs are a squashfs and a directory of binaries, and
what is being caught is "you forgot to re-run the build".

**Every direction is a named result.** An input newer than the image is a
`FAIL:` naming which one; no input present at all is a `SKIP:`, because zero
comparisons made is the shape a green takes when it asserted nothing;
`MICA_VERIFY_ALLOW_STALE=1` — for a downloaded release image, whose source is not
this tree — is a second `SKIP:` that says so. Absent inputs are named in the
message in every direction, so a run that compared one input does not read like
a run that compared two.

### Why it is a check and not a preflight

It was a preflight once, and that is exactly how it was lost. The shell
verifier this package replaced carried the same guard in its prologue: it
printed `error:` on **stderr** and exited 1 before the first check ran. The
per-check parity gate that governed the port compared **conclusions** —
`src/parity.ts`'s `parseShellRun` ingests `PASS:`/`FAIL:`/`SKIP:` lines and the
`RESULT:` line and nothing else — so a preflight that publishes no conclusion
could not appear as a row, could not diverge, and could not even be counted
`unclaimed`. The port reached full parity with the guard absent, and no gate in
this tree noticed for two months; this section is
where it is written down.

Rebuilt as a register entry, its absence would now show up the way any other
check's would.

### The cross-board case, which is the point

The original implementation had a defect: its two inputs were written
down as the literals `_out/cx3576/rootfs-verity.img` and
`mica-podman:out-arm64/podman`, so an x64 run's freshness was decided by arm64
artefacts — it passed a stale x64 image and refused a fresh one whenever the
arm64 tree happened to be newer. A board-agnostic mtime comparison is the bug,
not the fix, so `src/checks-freshness.test.ts` plants that tree: x64's own
inputs older than the image, cx3576's and arm64's newer. The x64 run must pass.
The **control** runs the same tree as cx3576 and requires red — without it, a
check that simply never looked at the other board would satisfy the first case
for a reason nobody asked for.
