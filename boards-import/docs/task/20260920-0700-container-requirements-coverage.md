# 20260920-0700-container-requirements-coverage The engine's requirement list against the four shipped kernels

- **status**: done
- **priority**: P2
- **owner**: tdpnmgkr
- **createdAt**: 2026-09-20 07:00

`mica-podman` traced podman 5.8.6, crun 1.29.1 and netavark 2.1.0 at the
pinned commits to the write or the syscall and produced a requirement list.
This is that list run against the four shipped configs -- a grep against a
specification instead of against a guess. Facts only; nothing is turned on.

## The five load-bearing requirements: satisfied on all four boards

These are reached by every container with no flag from the user, so a missing
one means no container runs on that board at all.

    requirement                          symbols                      uefi-x64 uefi-arm64 cx3576 s905x5m
    pids limit (default 2048)            CGROUP_PIDS                  y        y          y      y
    device rules as a BPF program        BPF_SYSCALL CGROUP_BPF       y        y          y      y
    the built-in seccomp profile         SECCOMP SECCOMP_FILTER       y        y          y      y
    storage.conf's forced overlay        OVERLAY_FS                   y        y          y      y
    netavark's bridge and veth           BRIDGE VETH                  y        y          y      y
    netavark's nftables ruleset          NF_TABLES NFT_NAT NFT_MASQ   y        y          y      y
                                         NF_NAT NF_CONNTRACK          y        y          y      y

**So containers run on every board.** The larger claim -- that a missing
load-bearing symbol would mean no container at all -- was worth checking as a
set and comes out clean.

## What the requirement list named that the earlier table did not

Five symbols, and one of them found a gap nobody had:

    SECCOMP_FILTER      y on all four   (SECCOMP alone is not enough: crun installs a filter)
    FAIR_GROUP_SCHED    y on all four   (cpu.weight)
    CPUSETS             y on all four   (cpuset.cpus, cpuset.mems)
    CGROUP_WRITEBACK    absent on uefi-x64 only -- it is selected by MEMCG with
                        BLK_CGROUP, so it follows the memory gap rather than being a
                        separate one
    IOSCHED_BFQ         SPLIT, see below

## The new gap, and its board split matches neither of the previous ones

    symbol          uefi-x64  uefi-arm64  cx3576  s905x5m
    IOSCHED_BFQ     not set   y           not set y
    BFQ_GROUP_IOSCHED  -      y           -       y

`io.bfq.weight` therefore exists on uefi-arm64 and s905x5m and not on uefi-x64
and cx3576 -- one generic board and one hardware board each side, which is
neither the "UEFI boards" split of `CFS_BANDWIDTH` and FUSE nor the "uefi-x64
only" split of `MEMCG`. `podman --blkio-weight` fails on two boards, and which
two could not have been guessed from either earlier finding. The other IO
schedulers (`MQ_IOSCHED_DEADLINE`, `MQ_IOSCHED_KYBER`) are built in
everywhere, so this is about the weight knob and not about IO working.

**My own mis-key, recorded because it is the aperture rule in a new form.**
The coordinator's relay named `CONFIG_BLK_DEV_BFQ` and I first grepped exactly
that, which reported ABSENT on all four and would have been a wrong finding of
a uniform gap. The symbol in these trees is `CONFIG_IOSCHED_BFQ`. A negative
result inherits the aperture of the query, and a wrong KEY is an aperture of
zero -- the same defect as a truncated grep, with nothing truncated.

**The procedure, because the warning alone would not have caught it:** a
UNIFORM answer from a query that NAMES something is the shape to re-ask with a
looser key, because a wrong key returns exactly that. What actually made me
re-ask was that "absent on all four" looked too tidy for a config question,
and "too tidy" is a weak signal to depend on; uniformity is the checkable
version of the same instinct. Here the looser key was a case-insensitive
search for `bfq`, and it produced the real split in one line.

## nf_tables at run time, not merely compiled

`NF_TABLES` is **built in** (`=y`) on all four boards, as are `NFT_NAT`,
`NFT_MASQ`, `NFT_CT`, `NFT_COMPAT`, `NF_NAT` and `NF_CONNTRACK`, so the
ruleset `nft` applies needs no module to be present. Two notes so nothing is
misread:

- the **iptables-legacy** path is modular on the two UEFI boards
  (`IP_NF_IPTABLES=m` and friends) and built in on the two hardware boards.
  It is not what netavark 2.1.0 uses. The modules do ship: uefi-arm64's
  `modules.tar` carries 232 modules including `ip_tables.ko`,
  `iptable_filter.ko`, `iptable_mangle.ko` and `iptable_nat.ko`, so this is a
  module that exists rather than a module that is missing.
- `NFT_CHAIN_NAT` is **not a symbol in these trees** -- it folded into
  `NFT_NAT` -- so its absence from a grep is not a gap. `NFT_REDIR` differs
  (not set on the UEFI boards, `y` on the hardware boards); netavark's port
  forwarding uses DNAT rather than redirect, so this is recorded and not
  claimed as a requirement.

## Where this leaves the floor question

The user's decision is about LIMITS, not about whether containers run:

    MEMCG            memory.max     missing on uefi-x64
    CFS_BANDWIDTH    cpu.max        missing on both UEFI boards
    IOSCHED_BFQ      io.bfq.weight  missing on uefi-x64 and cx3576
    CGROUP_WRITEBACK               follows MEMCG

Every one of these fails LOUDLY at the write when a flag asks for it, except
that `podman stats` reports an empty memory figure with no warning, which is
the one silent half. The cost of closing the first two on uefi-x64 is measured
in `20260920-the-floor-and-the-declared-features.md`: +69632 bytes, +0.46 %.

## Two corrections from mica-podman, 2026-09-20, after this was written

- **`CGROUP_DEVICE` is not a requirement and is struck from the table above.**
  It is the v1 device controller; on v2 crun compiles the rules into a BPF
  program, so the requirement is `CGROUP_BPF` with `BPF_SYSCALL`, both already
  `y` everywhere. The conclusion is unchanged and the reason is now the right
  one -- a row naming the v1 symbol would have passed for the wrong reason on
  all four boards.
- **The BFQ gap is narrower than this record first made it.** Plain
  `--blkio-weight` falls back from `io.bfq.weight` to `io.weight` with a
  rescale, so `IOSCHED_BFQ` is not needed for the common case. Missing it on
  uefi-x64 and cx3576 costs `--blkio-weight-device`, the PER-DEVICE form, and
  not `--blkio-weight`. The split and the symbol name stand; what shrinks is
  what it denies.

Also measured while answering the cgroup-v2 question the symbols cannot hold:
no board's `BOARD_CMDLINE_ARGS` mentions cgroups at all, and on the 6.12
boards (uefi-arm64, s905x5m) the v1 memory controller is not compiled --
`# CONFIG_MEMCG_V1 is not set` -- so a v1 hierarchy there would have no memory
limits at all rather than weaker ones.
