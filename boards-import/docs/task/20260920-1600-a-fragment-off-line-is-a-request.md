# 20260920-1600-a-fragment-off-line-is-a-request A fragment off-line is a request, and twenty had been denied

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 16:00

Found by sweeping rather than reasoning, after the coordinator asked one
question about a different file: does an absence read prove it reached the
file, or only that a grep found nothing?

## The two answers

`common/kernel/kernel-config-test.sh` proves its reach. Every read is guarded
by `[ -f ]` with its own refusal (lines 126, 151, 194, 228), and when a symbol
is not `=y` it prints the line it actually found rather than inferring from a
silent grep.

`common/kernel/floor-check.sh`, the one that runs over a RESOLVED config after
`olddefconfig`, did not. A tree with no `.config` was still refused -- the
first grep fails and the script exits -- but the message named the trust
anchor, so the verdict was right and the diagnosis was wrong. It now says so
itself, before any claim about the file's contents.

## The hole the question opened

That script only ever read the `=y` lines. The nine `# CONFIG_X is not set`
lines of `common/kernel/mica-required.fragment` were merged into the INPUT and
never looked at again, on any board.

**A fragment off-line is a request, not a fact.** `merge_config.sh` writes it
and `olddefconfig` grants it *unless something enabled `select`s the symbol* --
and nothing in this repository asked afterwards whether the request had been
granted.

The missing loop is now in `floor-check.sh` (FIT boards) and in both UEFI
kernel Dockerfiles: for each `# CONFIG_X is not set` line of the fragments,
refuse if the resolved config carries any `CONFIG_X=` line. Its negative half
is `tests/floor-check-fixtures.sh`, eight fixtures over synthetic source trees,
wired into `make check` as `floor-fixtures-test`.

The claim asserted is "no line turns it on", not "the literal off-line is
present": kconfig omits a symbol whose dependencies are unmet, so requiring the
off-line would refuse a kernel that is off in the stronger sense.

## What it found in the two recorded configs

Twenty requests had been denied. The recorded resolved configs of the two UEFI
boards are the only resolved configs in the tree, so this is the whole
measurable population; the FIT boards are covered from their next build on.

**uefi-x64, and it is a shared floor line: `CONFIG_CGROUP_NET_CLASSID=y`.**
`CONFIG_NET_CLS_CGROUP=y` arrives from that board's defconfig -- no fragment in
this tree states it, `grep -rn NET_CLS_CGROUP common boards` over the fragments
returns nothing -- and selects it. The arm64 defconfig has it off, s905x5m's
vendor config has it off, cx3576 builds no `NET_SCHED` at all. One floor, one
line, and the answer differed because of a file nobody here wrote. The
classifier is now named off in the shared fragment: `net_cls.classid` is a
cgroup v1 interface and no product mounts v1, so by the tier-2 test the
decision is OFF, and the honest repair is to switch off what selects it rather
than to weaken the line. `boards/uefi-x64/kernel/config/uefi-x64.config`
changes by exactly those two lines.

**uefi-arm64, 19 lines of the board fragment.** Deleting all nineteen and
re-recording changed the resolution in exactly one place:
`CONFIG_MDIO_BCM_UNIMAC` went from `m` to `y`. So eighteen were inert, and one
request had been *partly* granted -- a modular selector leaves kconfig free to
answer `m`, and it did. That line is now written as the value it resolves to,
`CONFIG_MDIO_BCM_UNIMAC=m`, and the recorded config is byte-identical to the
one the board released at `uefi-arm64.20260920-1536`.

## What this costs and what it does not

Nothing released changes meaning. `uefi-x64.20260920-1536` ships a kernel with
`CGROUP_NET_CLASSID=y`; the controller is cgroup v1 and unreachable on a v2
product, so the cost was the claim, not the behaviour. The claim was in that
release's notes and in
[20260920-0900-tier-two-uniformity-and-pstore](20260920-0900-tier-two-uniformity-and-pstore.md),
whose table recorded the symbol as `y` before the fragment line was added and
was never re-measured after.

That is the shape worth keeping: **the measurement was taken before the change
and reported as if it were the state after.** A fragment edit is not an
outcome, and until today nothing in this repository could tell the difference.
