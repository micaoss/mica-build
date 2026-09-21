# 20260920-0627-kernel-capabilities-beside-each-board The floor, made legible to another repository

- **status**: proposal
- **createdAt**: 2026-09-20 06:27
- **proposedBy**: tdpnmgkr, at the coordinator's authorisation (uj991oa2, 2026-09-20): write the feature-to-symbol mapping for `containers` with all three repositories named; nothing is turned on until the user decides
- **relatedTask**: 20260920-the-floor-and-the-declared-features

## Context

A product declares features (`mica-build:products/<product>/product.env`,
`FEATURES="micad mqtt containers ..."`). A board ships a kernel. Nothing
compares the two, and the consequence was measured on 2026-09-20: every
product of every board declares `containers`, and

- `CONFIG_MEMCG` is absent on uefi-x64, so a container's memory cannot be
  bounded there -- `podman run --memory` fails at the write to `memory.max`
  (mica-podman traced it), and `podman stats` reports an empty memory number
  with no warning;
- `CONFIG_CFS_BANDWIDTH` is absent on BOTH UEFI boards, so no `cpu.max` and no
  CPU quota.

Neither is a defect in any one repository. The floor
(`common/kernel/mica-required.fragment`) states what the SYSTEM needs and is
asserted against every board's resolved config; the feature list states what a
PRODUCT offers; nothing joins them.

## What this repository already has, and it is the half that works

The floor is asserted on the RESOLVED config, not on the committed one
(`common/kernel/floor-check.sh`, and the same three checks inline in the UEFI
Dockerfiles), and `kernel/config/<board>.config` is a reviewed input that the
build refuses to differ from. Measured while costing the symbols: adding one
line to a fragment made the build FAIL until every affected board's config was
re-recorded and the diff put up for review. **A floor change here cannot be
silent** -- which is the property the composer defect of the same evening
showed was missing elsewhere, and it is already built.

What is missing is only the join, and the join needs a vocabulary.

## Proposal

**1. A capability vocabulary, owned here, one line per capability.**
`common/kernel/capabilities.tsv`, rows `<capability> <symbol>[ <symbol>...]`,
where every symbol must be `=y` in the RESOLVED config for the board to
provide that capability -- `=y` and not `=m`, for the reason argued below. Only this
repository can say what a requirement means in a kernel config, so the
mapping lives here; the REQUIREMENTS come from the repository that makes the
call, named in a comment on each row.

The rows below are mica-podman's answers, taken whole on 2026-09-20 rather
than reconciled with the first draft: it traced podman 5.8.6, crun 1.29.1 and
netavark 2.1.0 at the pinned commits to the write or the syscall. Four of its
answers changed what this document had.

    container-runtime   CGROUP_PIDS CGROUPS CGROUP_BPF BPF_SYSCALL \
                        SECCOMP SECCOMP_FILTER OVERLAY_FS \
                        NAMESPACES PID_NS NET_NS IPC_NS UTS_NS
    container-memory    MEMCG                  # --memory -> memory.max
    container-cpu       CGROUP_SCHED FAIR_GROUP_SCHED CFS_BANDWIDTH   # --cpus -> cpu.max
    container-cpuset    CPUSETS                # --cpuset-cpus, --cpuset-mems
    container-io        BLK_CGROUP             # --blkio-weight -> io.weight
    container-io-device IOSCHED_BFQ BFQ_GROUP_IOSCHED   # --blkio-weight-device -> io.bfq.weight
    container-network   BRIDGE VETH            # netavark's netlink half

What changed, and why each correction matters more than the row it fixes:

- **`CGROUP_DEVICE` is gone.** It is the v1 device controller; on v2 crun
  compiles the device rules into a BPF program, so the requirement is
  `CGROUP_BPF` with `BPF_SYSCALL`. A row naming the v1 symbol would have
  passed for the wrong reason on every board.
- **`SECCOMP_FILTER` beside `SECCOMP`.** The profile podman applies is
  installed as a filter; `SECCOMP` alone is the framework.
- **`USER_NS` is gone from `container-runtime`.** A rootful container creates
  no user namespace unless `--userns` asks for one. It stays a true fact about
  every board and stops being a container requirement.
- **`container-io` split in two.** Plain `--blkio-weight` FALLS BACK from
  `io.bfq.weight` to `io.weight` with a rescale, so BFQ is not required for
  the common case. That narrows the gap this repository found the same day:
  missing `IOSCHED_BFQ` on uefi-x64 and cx3576 costs `--blkio-weight-device`,
  not `--blkio-weight`.
- **`container-rootless` is dropped.** mica-podman recommends against
  rootless and the drafted symbols were wrong anyway: `FUSE_FS` is a proxy for
  fuse-overlayfs, which is a root-CONTENTS question, while the kernel half of
  rootless storage is unprivileged overlayfs. A row nobody can satisfy and
  nobody needs is one a later reader takes for a requirement.
- **The firewall half of the network is NOT in this table.** The netavark we
  ship links no nftables library and runs the `nft` BINARY, so a board with
  `NF_TABLES=y` and a root without `/usr/sbin/nft` fails identically and
  silently. That half belongs to the composed root, which is mica-build's.
  This table keeps only the netlink half, bridge and veth.

## The same table, read the other way: policy conditioned on a capability

The rows above answer "does this board PROVIDE capability X". There is a
second question with the same key and the opposite direction: "should this
board CARRY policy P", where P exists only because of X. The worked instance
is in `docs/task/20260920-0720-the-logo-vt-policy-is-cx3576s.md`: the logind
drop-in that keeps tty1 idle exists because cx3576 draws a kernel boot logo,
and it would be wrong on a board that draws none -- on uefi-x64 it would
remove a VT login that works to protect a logo that does not exist.

So when a policy file is conditioned on a capability, it should be SELECTED BY
THE SAME FLAG THAT PROVIDES THE CAPABILITY rather than copied per board: a
policy selected by its own precondition cannot outlive it. Today that means
the board's own overlay, because only one board has the capability; the moment
a second one does, the drop-in should move behind the flag that turns
`CONFIG_LOGO` on rather than be duplicated.

This is not proposed as machinery -- there is one instance and one instance
does not need a mechanism. It is written down so that the second instance is
recognised as the same shape instead of being solved again.

## The requirement this vocabulary CANNOT hold, named rather than omitted

**cgroup v2 must be the unified hierarchy at boot.** It selects podman's v2
validation branch over the v1 one that would silently discard limits, and it
is a property of boot and init, not of a kernel symbol: no `CONFIG_*`
expresses it and no capability row can. Saying so here is the point -- a
requirement a table cannot hold must be named as one, or the table reads as
complete.

What this repository can contribute to it, measured:

- **No board's forced command line mentions cgroups at all.** Every
  `BOARD_CMDLINE_ARGS` was checked: no `cgroup_no_v1`, no
  `systemd.unified_cgroup_hierarchy`, nothing. The hierarchy is whatever init
  chooses, and nothing in these kernels' command lines forces or forbids
  either mode. **Asserted since 2026-09-20** in
  `tests/board-contract-test.sh`, with the reason beside the rule rather than
  only the rule: a board carrying `systemd.unified_cgroup_hierarchy=0` would
  put podman on its v1 branch, where a memory limit is discarded with a
  warning and the container runs unbounded, and no capability row would see
  it. It held unasserted and was one `board.env` edit away; the negative path
  was verified by adding the word and watching the gate refuse.
- **On the 6.12 boards the v1 memory controller is not compiled at all**:
  `# CONFIG_MEMCG_V1 is not set` on uefi-arm64 and s905x5m. So if anything
  ever mounted v1 there, memory limits would be silently absent -- exactly the
  failure mica-podman warns about, one layer lower. On cx3576 the symbol does
  not exist (Linux 6.1, where the split predates it) and on uefi-x64 there is
  no `MEMCG` to have a v1 half of.

`display`, added 2026-09-20 because it would PASS today -- a capability check
added while everything agrees is one nobody has to defend, and `BOARD_FEATURES`
declares `display` on exactly the two boards whose kernels can render:

    display             VT VT_CONSOLE FRAMEBUFFER_CONSOLE FB \
                        (DRM_ROCKCHIP|AMLOGIC_DRM|DRM_I915|DRM_VIRTIO_GPU|FB_EFI)
    display-input       INPUT_KEYBOARD HID HID_GENERIC USB_HID

The parenthesised group is an ANY-OF: the display driver is board-specific by
nature and a fixed list would have to be edited for every new board, so the
row form needs one alternation. Splitting the input half out is deliberate --
a board can render without a keyboard path, and the two failures look nothing
alike to a person standing in front of it.

**And the limit of the whole mechanism, stated here rather than discovered
later: a capability row is a NECESSARY condition, not a proof of function.**
uefi-x64 is the worked example: it has `FB_EFI=y` and
`FRAMEBUFFER_CONSOLE=y`, so this row would pass, and yet
`DRM_FBDEV_EMULATION` is not set while `DRM_I915` is built in, and a DRM
driver taking over the device usually removes the EFI framebuffer. Whether a
VT survives that handover is a runtime fact no config expresses. A capability
check catches a board that CANNOT do a thing; only a bench or a guest proves
that it DOES.

**And the same shape one layer down, for whoever builds the runtime
counterpart of this table: THE CONTROLLER LIST IS A NECESSARY CONDITION FOR A
LIMIT AND NOT A PROOF OF ONE.** Measured in a booted uefi-x64 guest on
2026-09-20: `/sys/fs/cgroup/cgroup.controllers` lists `cpu`, and `cpu.max`
does not exist, because `CFS_BANDWIDTH` is what creates the knob rather than
what enables the controller. The obvious runtime probe -- read the controller
list once, conclude the limit works -- is authoritative-looking and wrong for
exactly the case this table was written to catch. A runtime check must assert
the KNOB FILE (`memory.max`, `cpu.max`, `pids.max`, `io.max`), never the
controller name.

**2. Each board's kernel component publishes what it provides.** The build
already has the resolved config in hand where the floor is asserted; it emits
`kernel/capabilities.tsv` there -- the capability names from the vocabulary
that the resolved config satisfies -- and `outputs.tsv` lists it like any
other component file. A consumer then reads capabilities from the component
it already pins, with no rebuild and no second source of truth.

**3. The comparison lives in mica-build, not here.** This repository cannot
know which products declare what, and a release run here builds one board.
`mica-build` joins `FEATURES` against the pinned board's
`kernel/capabilities.tsv` and refuses a product whose feature has no
capability behind it. That is the same shape as the pool check that catches a
duplicated package: the repository that sees both sides owns the refusal.

## The division of ownership this rests on

- **mica-podman** states what the engine and its helpers call -- it traced
  crun to the `memory.max` write, and the `[confirm]` rows are the same
  question asked four more times.
- **mica-build** owns the feature list and the join, and says which products
  declare what.
- **mica-boards** owns the vocabulary and the emission: turning "a memory
  limit must be enforceable" into `CONFIG_MEMCG`, and proving it against the
  resolved config of each board.

## What it would cost here

- one file (`common/kernel/capabilities.tsv`), one generator in the build
  where the floor is already asserted, one `outputs.tsv` row per board, one
  test;
- `common/kernel/` is in every board's kernel inputs, so all four kernels
  rebuild at the next release after it lands. Their bytes should not change:
  emitting a file into the component does not alter the kernel, and that is
  checkable by layer comparison at the first release;
- no symbol is turned on by this proposal. It makes a gap VISIBLE and
  refusable; closing a gap is a separate decision with its own cost, measured
  for the two known ones: `CONFIG_MEMCG` + `CONFIG_CFS_BANDWIDTH` on uefi-x64
  is +69632 bytes of bzImage (+0.46 %), five config lines, a changed
  `modules.tar`, and re-recorded configs for review. Boot-time cost is
  unmeasured and belongs on a bench.

## Open questions for the user

1. Should a product whose declared feature has no capability behind it be
   REFUSED, or published with the gap recorded? Refusal is the honest default
   and it would stop `uefi-x64-dev` today.
2. Are the two known gaps closed (turn the symbols on) or declared (the
   feature is not offered on that board)? The measurement above is the cost of
   the first; the second costs nothing and says so out loud.
3. `container-rootless` is drafted because it was asked about, not because it
   is wanted. mica-podman records rootless as unsupported today.
